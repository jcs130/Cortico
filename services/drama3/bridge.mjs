/** Private local Drama3 gateway. Built with Fish Audio; no cloud fallback. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeSessionOptions } from './session-options.mjs';

const configPath = process.argv[2];
if (!configPath || !isAbsolute(configPath)) throw Error('An absolute service config is required');
const config = JSON.parse((await fs.readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
for (const key of ['executable','cudaDir','modelFile','referenceWav','referenceText','dataDir'])
  if (typeof config[key] !== 'string' || !isAbsolute(config[key])) throw Error('Missing absolute '+key);
for (const key of ['port','nativePort'])
  if (!Number.isInteger(config[key]) || config[key] < 1024 || config[key] > 65535) throw Error('Invalid '+key);
if (config.port === config.nativePort) throw Error('Separate bridge and native ports are required');
await fs.mkdir(config.dataDir, {recursive:true});
const transcript = await fs.readFile(config.referenceText, 'utf8');
const nativeConfig = join(config.dataDir, 'native.json');
await fs.writeFile(nativeConfig, JSON.stringify({
  host:'127.0.0.1',port:config.nativePort,backend:'cuda',threads:config.threads ?? 6,
  lazy_load:true,max_loaded_models:1,idle_unload_ms:0,ui:false,
  models:[{id:config.model,family:'fish_drama3',path:config.modelFile,task:'tts',mode:'streaming',
    session_options:nativeSessionOptions(config)}],
},null,2));

let native, nativeClosed=true, ready=false, warming, busy=false, stopping=false;
let finished = Promise.resolve(), writeTail=Promise.resolve();
const metrics = {startedAt:new Date().toISOString(),model:config.model,voice:config.voice,requests:[]};
const save = () => writeTail=writeTail.catch(()=>{}).then(async()=>{
  const target=join(config.dataDir,'metrics.json'), temp=target+'.tmp';
  await fs.writeFile(temp,JSON.stringify(metrics,null,2)); await fs.rename(temp,target);
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function header(size) {
  const b=Buffer.alloc(44); b.write('RIFF');b.writeUInt32LE(size===null?0xffffffff:size+36,4);
  b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
  b.writeUInt32LE(44100,24);b.writeUInt32LE(88200,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);
  b.write('data',36);b.writeUInt32LE(size===null?0xffffffff:size,40);return b;
}
async function ensureNative() {
  if (native && !nativeClosed) return;
  if (stopping) throw Error('Service is stopping');
  nativeClosed=false; ready=false;
  const child=spawn(config.executable,['--config',nativeConfig,'--no-ui'],{
    cwd:config.dataDir,windowsHide:true,env:{...process.env,PATH:config.cudaDir+';'+process.env.PATH},
    stdio:['ignore','pipe','pipe'],
  });
  native=child; metrics.nativePid=child.pid;
  child.stdout.pipe(createWriteStream(join(config.dataDir,'native.stdout.log'),{flags:'a'}));
  child.stderr.pipe(createWriteStream(join(config.dataDir,'native.stderr.log'),{flags:'a'}));
  child.once('error',e=>{nativeClosed=true;ready=false;metrics.nativeError=String(e);void save();});
  child.once('close',(code,signal)=>{
    if (native!==child) return; nativeClosed=true;ready=false;
    metrics.nativeExit={at:new Date().toISOString(),code,signal};void save();
  });
  for (let i=0;i<100;i++) {
    if (nativeClosed) throw Error('Native Drama3 exited before readiness');
    try { const r=await fetch('http://127.0.0.1:'+config.nativePort+'/health',{signal:AbortSignal.timeout(500)});
      if(r.ok)return;
    } catch {} await sleep(300);
  }
  throw Error('Native Drama3 listener timeout');
}
async function synth(text,onPCM,signal,label,requestId) {
  const row={requestId,label,at:new Date().toISOString(),text,firstPacketMs:null,bytes:0,complete:false};
  metrics.requests.push(row);if(metrics.requests.length>300)metrics.requests.shift();
  const start=performance.now();busy=true;
  let release;finished=new Promise(resolve=>release=resolve);
  try {
    await ensureNative();
    const timeout=AbortSignal.timeout(90000);
    const response=await fetch('http://127.0.0.1:'+config.nativePort+'/v1/audio/speech',{
      method:'POST',headers:{'Content-Type':'application/json'},signal:signal?AbortSignal.any([signal,timeout]):timeout,
      body:JSON.stringify({model:config.model,input:text,voice_ref:config.referenceWav,reference_text:transcript,
        response_format:'pcm',stream_format:'sse',max_tokens:768,seed:20261021,
        options:{temperature:1,top_p:.9,top_k:4097}}),
    });
    if(!response.ok||!response.body)throw Error('Native Drama3 HTTP '+response.status);
    const decoder=new TextDecoder();let buffer='';let done=false;const chunks=[];
    for await(const part of response.body) {
      buffer+=decoder.decode(part,{stream:true});let end;
      while((end=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);
        if(!line.startsWith('data:'))continue;
        const payload=line.slice(5).trim();if(payload==='[DONE]'){done=true;continue;}
        const event=JSON.parse(payload);
        if(event.type==='error')throw Error('Native Drama3 returned an error');
        if(event.type==='speech.audio.done'||event.type==='speech.done')done=true;
        if(event.type!=='speech.audio.delta')continue;
        const pcm=Buffer.from(event.audio,'base64');
        if(pcm.length%2)throw Error('Unaligned PCM16 packet');
        if(row.firstPacketMs===null)row.firstPacketMs=performance.now()-start;
        row.bytes+=pcm.length;chunks.push(pcm);await onPCM?.(pcm);
      }
    }
    if(!row.bytes)throw Error('No audio samples');
    row.audioSeconds=row.bytes/88200;row.complete=true;row.doneMarker=done;
    if(config.retainLatestAudio!==false) {
      const pcm=Buffer.concat(chunks);
      await fs.writeFile(join(config.dataDir,label==='warmup'?'warmup.wav':'latest.wav'),Buffer.concat([header(pcm.length),pcm]));
    }
    return row;
  } catch(error) {row.error=error.name+': '+error.message;throw error;}
  finally {row.wallMs=performance.now()-start;busy=false;release();await save();}
}
async function warm() {
  if(ready)return;
  if(warming)return warming;
  warming=(async()=>{await synth('本地语音演出已经准备好了。',null,null,'warmup','warm-'+randomUUID());
    ready=true;metrics.readyAt=new Date().toISOString();await save();})().finally(()=>warming=null);
  return warming;
}
const json=(res,status,data)=>res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(data));
const server=createServer(async(req,res)=>{
  try {
    if(req.headers.origin){json(res,403,{error:'Use the local stage service'});return;}
    if(req.method==='GET'&&req.url==='/health'){
      json(res,200,{ready,warming:!!warming,busy,nativeClosed,model:config.model,voice:config.voice,
        textFormat:'drama-3',idleUnload:false,pid:process.pid});return;
    }
    if(req.method==='GET'&&req.url==='/v1/audio/voices'){json(res,200,{voices:[config.voice]});return;}
    if(req.method==='GET'&&req.url==='/metrics'){json(res,200,metrics);return;}
    if(req.method==='POST'&&req.url==='/warm'){await warm();json(res,200,{ready});return;}
    if(req.method!=='POST'||req.url!=='/v1/audio/speech'){json(res,404,{error:'Not found'});return;}
    let input='';for await(const part of req){input+=part;if(Buffer.byteLength(input)>65536)throw Error('Request too large');}
    const body=JSON.parse(input);
    if(body.model!==config.model||body.voice!==config.voice){json(res,400,{error:'Configured Drama3 model and Cormy voice required'});return;}
    if(typeof body.input!=='string'||!body.input.trim()||body.input.length>2000){json(res,400,{error:'Expected 1–2000 characters'});return;}
    const abort=new AbortController();res.once('close',()=>{if(!res.writableEnded)abort.abort();});
    // Supersession can close the previous HTTP response a few milliseconds before its producer unwinds.
    if(busy)await Promise.race([finished,sleep(5000)]);
    abort.signal.throwIfAborted();
    if(!ready||busy){json(res,503,{error:'Local Drama3 not warm or previous synthesis still active'});return;}
    const requestId=randomUUID();let started=false;
    await synth(body.input,async pcm=>{
      if(!started){res.writeHead(200,{'Content-Type':'audio/wav','X-TTS-Request-Id':requestId,'Cache-Control':'no-store'});res.write(header(null));started=true;}
      if(!res.write(pcm))await once(res,'drain',{signal:abort.signal});
    },abort.signal,'speech',requestId);
    res.end();
  }catch(error){if(!res.headersSent)json(res,502,{error:error.message});else res.destroy();}
});
await new Promise((ok,fail)=>{server.once('error',fail);server.listen(config.port,'127.0.0.1',ok);});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{
  stopping=true;ready=false;server.close();if(native&&!nativeClosed)native.kill();await save();process.exit();
});
console.log(JSON.stringify({port:config.port,pid:process.pid,model:config.model,voice:config.voice,at:new Date().toISOString()}));
if(config.warmOnStart!==false)void warm().catch(e=>console.error('Drama3 warmup failed: '+e.message));
