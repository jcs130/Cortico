import { expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import definition from "../src/index.ts";
import { normalizeConfig } from "../src/core/config.ts";
import { PROTOCOL } from "../src/core/types.ts";
import { parseExtensionManifest } from "cortico/extensions/manifest.ts";
import { dryMountWorld } from "cortico/extensions/dry-mount.ts";
import { checkDescribe } from "cortico/extensions/describe-export.ts";

it('keeps conversation usable while advertising the configured observation policy',async()=>{
 const {AvatarStageWorld}=await import('../src/index.ts');
 const cfg={enabled:true,port:0,dataDir:'',avatars:[],speechObservationMaxAgeSeconds:15};
 const world=new AvatarStageWorld(()=>cfg);
 const voice=world.tools().find(t=>t.name==='avatar_voice')!;
 expect(voice.parameters).not.toHaveProperty('anyOf');
 expect(voice.parameters.required).not.toContain('observed_at');
 expect(voice.description).toContain('at most 15 seconds old');
 expect(voice.description).toContain('Ordinary conversation');
 cfg.speechObservationMaxAgeSeconds=0;
 expect(world.tools().find(t=>t.name==='avatar_voice')!.parameters).not.toHaveProperty('anyOf');
 expect(world.tools().find(t=>t.name==='avatar_control')!.parameters).not.toHaveProperty('anyOf');
});
it("returns a failed tool outcome when conditional speech was not admitted", async () => {
  const { createServer } = await import("node:http");
  const { AvatarStageWorld } = await import("../src/index.ts");
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((req, res) => {
    if (req.url === "/api/state") res.end(JSON.stringify({ protocol: PROTOCOL }));
    else if (req.url === "/events") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": ready\n\n"); }
    else if (req.url === "/api/call") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ protocol: PROTOCOL, result: { accepted: false, status: "skipped", reason: "Foreground changed" } })); }
    else res.writeHead(404).end();
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  const url = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port;
  const world = new AvatarStageWorld(() => ({ enabled: true, remoteUrl: url, port: 0, dataDir: "", avatars: [] }));
  try {
    await world.start({ pushEvent: async () => {} } as never);
    // Match the live Persona's coverage consumer; absent coverage used to throw.
    expect(world.requestFacts()?.snapshotTypes.map(type => ({ source: world.id, type }))).toEqual([]);
    const result = await world.tools().find(tool => tool.name === "avatar_voice")!.handler({ action: "speak", text: "旧稿。", ifIdleRevision: 1 }, { callId: "declined" } as never);
    expect(result).toEqual({ text: JSON.stringify({ accepted: false, status: "skipped", reason: "Foreground changed" }), failed: true });
  } finally { await world.stop(); for (const socket of sockets) socket.destroy(); await new Promise<void>(ok => server.close(() => ok())); }
});
it('admits explicitly cued audio through the public World tool even when optional desktop catalogue discovery fails', async () => {
  const {createServer}=await import('node:http');
  const {AvatarStageWorld}=await import('../src/index.ts');
  const {DesktopAudioRenderer}=await import('../src/desktop-audio.ts');
  const {DesktopPresentation}=await import('../src/desktop-presentation.ts');
  const start=vi.spyOn(DesktopAudioRenderer.prototype,'start').mockResolvedValue(undefined);
  const refresh=vi.spyOn(DesktopPresentation.prototype,'refresh').mockRejectedValue(Error('Optional catalogue is offline'));
  const calls:any[]=[];
  const server=createServer(async(req,res)=>{
    if(req.url==='/api/state')res.end(JSON.stringify({protocol:PROTOCOL}));
    else if(req.url==='/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': ready\n\n');}
    else if(req.url==='/api/call'){
      const parts=[];for await(const part of req)parts.push(part);calls.push(JSON.parse(Buffer.concat(parts).toString()));
      res.setHeader('content-type','application/json');res.end(JSON.stringify({protocol:PROTOCOL,result:{accepted:true,status:'queued',id:'speech'}}));
    }else res.writeHead(404).end();
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const world=new AvatarStageWorld(()=>({enabled:true,port:0,dataDir:'',avatars:[],
    remoteUrl:'http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port,
    presentation:{mode:'desktop-audio',url:'http://127.0.0.1:1'}}));
  try{
    await world.start({pushEvent:async()=>{}} as never);
    const result=await world.tools().find(t=>t.name==='avatar_voice')!.handler({action:'speak',text:'边走边说。',
      performance:{expression:'happy',bodyClip:'wave'}},{callId:'parallel-audio'} as never);
    expect(result).toBe(JSON.stringify({accepted:true,status:'queued',id:'speech'}));
    expect(calls).toHaveLength(1);expect(refresh).not.toHaveBeenCalled();
  }finally{
    await world.stop();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
    start.mockRestore();refresh.mockRestore();
  }
});
it('passes a copied ISO observation through the real World once and keeps stale speech out of its output', async () => {
  const { createServer } = await import('node:http');
  const { AvatarStageWorld } = await import('../src/index.ts');
  const calls: unknown[] = [], sockets = new Set<import('node:net').Socket>();
  const server = createServer(async (req, res) => {
    if (req.url === '/api/state') res.end(JSON.stringify({protocol:PROTOCOL}));
    else if (req.url === '/events') { res.writeHead(200, {'Content-Type':'text/event-stream'}); res.write(': ready\n\n'); }
    else if (req.url === '/api/call') {
      const chunks: Buffer[]=[]; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({protocol:PROTOCOL,result:{accepted:true,id:'fixture-speech'}}));
    } else res.writeHead(404).end();
  });
  server.on('connection', socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));
  const url='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
  const world=new AvatarStageWorld(()=>({enabled:true,remoteUrl:url,port:0,dataDir:'',avatars:[],speechObservationMaxAgeSeconds:15}));
  try {
    await world.start({pushEvent:async()=>{}} as never);
    const voice=world.tools().find(t=>t.name==='avatar_voice')!;
    const original={action:'speak',text:'刚刚到达入口。',observed_at:new Date(Date.now()-1000).toISOString()};
    const result=await voice.handler(original,{callId:'fresh-iso'} as never);
    expect(result).toBe(JSON.stringify({accepted:true,id:'fixture-speech'}));expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).not.toContain('observed_at');expect(original.observed_at).toBeTruthy();
    const reply=await voice.handler({action:'speak',text:'Hello, I can read your message.'},{callId:'conversation'} as never);
    expect(reply).toBe(JSON.stringify({accepted:true,id:'fixture-speech'}));expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1])).not.toContain('observed_at');
    const stale=await voice.handler({...original,observed_at:new Date(Date.now()-60_000).toISOString()},{callId:'stale-iso'} as never);
    expect(stale).toMatchObject({failed:true});expect(JSON.stringify(stale)).toContain('stale_speech_observation');expect(calls).toHaveLength(2);
  } finally {await world.stop();for(const socket of sockets)socket.destroy();await new Promise<void>(ok=>server.close(()=>ok()));}
});
it("passes Cortico 0.2.4 published manifest, dry-mount and self-description checks without network or services", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url)),
    scratchDir = await mkdtemp(join(tmpdir(), "avatar-framework-"));
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(Error("Network forbidden during offline inspection"));
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const manifest = parseExtensionManifest(pkg);
    expect(manifest.ok).toBe(true);
    const options = { scratchDir, packageDir: root };
    const mount = await dryMountWorld(definition, options);
    expect(mount.failures).toEqual([]);
    const describe = await checkDescribe(
      "world",
      definition,
      pkg.cortico.describe,
      options,
    );
    expect(describe.failures).toEqual([]);
    const world = definition.create({
      cfg: definition.defaults(),
      dataDir: scratchDir,
      botDir: scratchDir,
    } as any);
    expect(world.envPromptVars()).toEqual({});
    const voiceConfig = world.webUi?.().config?.find(group => group.id === "avatar-voice");
    expect(voiceConfig?.schema.properties?.["worlds.avatar-stage.voice.textFormat"]).toMatchObject({
      enum: ["plain", "drama-3"], "x-hot": false,
    });
    expect(JSON.stringify(world.webUi?.().promptDocs)).not.toContain(
      "stageFacts",
    );
    expect(await readFile(join(root, "src/prompt.md"), "utf8")).not.toContain(
      "{{stageFacts}}",
    );
    expect(() =>
      normalizeConfig(
        {
          port: 0,
          dataDir: scratchDir,
          avatars: [],
          music: {
            directory: "",
            generationUrl: "https://old.invalid",
            cloud: {
              provider: "fal",
              queueUrl: "https://archive.invalid",
              downloadHosts: [],
            },
          },
        },
        scratchDir,
      ),
    ).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
    await rm(scratchDir, { recursive: true, force: true });
  }
});

it("propagates tool cancellation and fences events when a remote stage stops", async () => {
  const {createServer}=await import('node:http');
  const {AvatarStageWorld}=await import('../src/index.ts');
  const sockets=new Set<import('node:net').Socket>();let stream:import('node:http').ServerResponse|undefined;
  let requested!:()=>void;const called=new Promise<void>(r=>requested=r);
  const server=createServer((req,res)=>{
    if(req.url==='/api/state')res.end(JSON.stringify({protocol:PROTOCOL,connected:true}));
    else if(req.url==='/events'){stream=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': connected\n\n');}
    else if(req.url==='/api/call'){requested();/* delayed response remains pending until cancellation */}
    else res.writeHead(404).end();
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));
  const url='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
  const world=new AvatarStageWorld(()=>({enabled:true,remoteUrl:url,port:0,dataDir:'',avatars:[]}));
  const events:unknown[]=[];
  try {
    await world.start({pushEvent:async (event:unknown)=>{events.push(event);}} as never);
    const abort=new AbortController();
    const action=world.tools().find(tool=>tool.name==='avatar_control')!.handler({action:'status'},{signal:abort.signal,callId:'fixture-cancel'} as never);
    await called;abort.abort(new Error('fixture cancellation'));
    const result=await action;expect(typeof result==='object'&&result.failed).toBe(true);
    await world.stop();
    const count=events.length;stream?.write('data: '+JSON.stringify({protocol:PROTOCOL,type:'avatar.action',at:Date.now(),data:{status:'completed'}})+'\n\n');
    await new Promise(ok=>setTimeout(ok,25));expect(events).toHaveLength(count);
    const stopped=await world.tools()[0].handler({action:'status'},{} as never);
    expect(typeof stopped==='object'&&stopped.failed).toBe(true);
  }finally{await world.stop();for(const socket of sockets)socket.destroy();await new Promise<void>(ok=>server.close(()=>ok()));}
});

it("a rejected configuration does not leave the World started",async()=>{
 const {AvatarStageWorld}=await import('../src/index.ts');let reject=true;
 const dataDir=await mkdtemp(join(tmpdir(),'stage-retry-'));
 const world=new AvatarStageWorld(()=>{if(reject)throw Error('invalid fixture configuration');return {enabled:true,port:0,dataDir,avatars:[]};});
 try {
  await expect(world.start({} as never)).rejects.toThrow('invalid fixture');
  reject=false;await world.start({pushEvent:async()=>{}} as never);
 }finally{await world.stop();await rm(dataDir,{recursive:true,force:true});}
});

it('keeps completed speech receipts without starting a narration feedback loop',async()=>{
 const {createServer}=await import('node:http');
 const {AvatarStageWorld}=await import('../src/index.ts');
 const sockets=new Set<import('node:net').Socket>();
 let stream:import('node:http').ServerResponse|undefined;
 const server=createServer((req,res)=>{
  if(req.url==='/api/state')res.end(JSON.stringify({protocol:PROTOCOL}));
  else if(req.url==='/events'){stream=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': ready\n\n');}
  else res.writeHead(404).end();
 });
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));
 const world=new AvatarStageWorld(()=>({enabled:true,remoteUrl:'http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port,port:0,dataDir:'',avatars:[]}));
 const pushed:{event:any;options:any}[]=[];
 try{
  await world.start({pushEvent:async(event:unknown,options:unknown)=>{pushed.push({event,options});}} as never);
  await vi.waitFor(()=>expect(stream).toBeDefined());
  const variants=[['speech','completed'],['speech','cancelled'],['presentation','completed'],['speech','failed'],['music-play','completed']];
  for(const [kind,status] of variants)stream!.write('data: '+JSON.stringify({protocol:PROTOCOL,type:'avatar.action',at:Date.now(),data:{id:kind+status,kind,status}})+'\n\n');
  await vi.waitFor(()=>expect(pushed).toHaveLength(5));
  expect(pushed.map(r=>r.options.trigger)).toEqual(['piggyback','piggyback','piggyback','flush','flush']);
  expect(pushed.map(r=>JSON.parse(r.event.text).status)).toEqual(variants.map(v=>v[1]));
 }finally{await world.stop();for(const socket of sockets)socket.destroy();await new Promise<void>(ok=>server.close(()=>ok()));}
});
