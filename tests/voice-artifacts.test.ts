import {afterEach,describe,it,expect,vi} from 'vitest';
import {createServer} from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {VoiceService} from '../src/core/voice.ts';
import {VoiceArtifacts,gameVoiceWav} from '../src/core/voice-artifacts.ts';
import {AvatarStageServer} from '../src/server.ts';
const cleanups:(()=>unknown|Promise<unknown>)[]=[];
afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f();vi.restoreAllMocks();vi.unstubAllGlobals();});
function wav(seconds=.3,finite=false){const b=Buffer.alloc(44+Math.round(seconds*44100)*2);b.write('RIFF');b.writeUInt32LE(finite?b.length-8:0xffffffff,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(44100,24);b.writeUInt32LE(88200,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(finite?b.length-44:0xffffffff,40);return b;}
async function fixture(options:{missingVoice?:boolean;long?:boolean}={}){
 const dir=await mkdtemp(join(tmpdir(),'stage-game-voice-'));cleanups.push(()=>rm(dir,{recursive:true,force:true}));
 const requests:any[]=[],events:any[]=[];let active=0,maxActive=0;
 const provider=createServer(async(req,res)=>{
   if(req.url==='/health'){res.setHeader('Content-Type','application/json');res.end('{"status":"ok"}');return;}
   if(req.url==='/v1/voices'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(options.missingVoice?['yui']:['cormy']));return;}
   const parts:Buffer[]=[];for await(const p of req)parts.push(Buffer.from(p));requests.push(JSON.parse(Buffer.concat(parts).toString()));active++;maxActive=Math.max(maxActive,active);
   res.writeHead(200,{'Content-Type':'audio/wav'});const bytes=wav(options.long?31:.3);res.write(bytes.subarray(0,44));
   setTimeout(()=>{active--;res.end(bytes.subarray(44));},12);
 });
 await new Promise<void>(ok=>provider.listen(0,'127.0.0.1',ok));cleanups.push(()=>new Promise<void>(ok=>{provider.closeAllConnections();provider.close(()=>ok());}));
 const voice={url:'http://127.0.0.1:'+(provider.address() as any).port+'/v1/speak',model:'drama-3',voice:'cormy',voices:['cormy'],
   synthesisTransport:'drama-rs-wav' as const,segmentMaxChars:0,requireWavCompletion:false,extraBody:{top_k:4097,max_new:2048}};
 const service=new VoiceService(()=>voice,join(dir,'voice'),(id,status,data)=>events.push({id,status,...data}));await service.start();cleanups.push(()=>service.stop());
 return {dir,service,voice,requests,events,maxActive:()=>maxActive};
}
class Output extends EventEmitter {headersSent=false;destroyed=false;chunks:Buffer[]=[];writeHead(){this.headersSent=true;}write(bytes:Uint8Array){this.chunks.push(Buffer.from(bytes));return true;}end(){}destroy(){this.destroyed=true;this.emit('close');}}
describe('game synthesis and optional livestream mirror',()=>{
 it('synthesizes a full line once without claiming the audio owner or interrupting audience speech',async()=>{const f=await fixture(),id=randomUUID();f.service.queue('audience','观众朋友们好。');
   const before=f.service.status().current;const artifact=await f.service.artifacts.create(id,'小鱼，等一下，我在坐标 Z=-302。',new AbortController().signal);
   expect(f.requests).toEqual([{text:'小鱼，等一下，我在坐标 Z=-302。',voice:'cormy',stream:true,split:false,top_k:4097,max_new:2048}]);
   expect(f.service.status().current).toEqual(before);expect(f.events).toEqual([]);expect(artifact.generationComplete).toBeNull();
   const audio=await f.service.artifacts.read(id);expect(audio.bytes.readUInt32LE(4)).toBe(audio.bytes.length-8);expect(audio.metadata.sha256).toBe(createHash('sha256').update(audio.bytes).digest('hex'));
   await f.service.artifacts.create(id,'小鱼，等一下，我在坐标 Z=-302。',new AbortController().signal);expect(f.requests.length).toBe(1);
   await expect(f.service.artifacts.create(id,'改成别的话。',new AbortController().signal)).rejects.toThrow(/conflict/);
 });
 it('reuses the exact artifact for broadcast playback with no second clone request',async()=>{const f=await fixture(),id=randomUUID();await f.service.artifacts.create(id,'可米、桐人和结衣一起出发。',new AbortController().signal);
   const artifact=await f.service.artifacts.read(id);f.service.queueArtifact('mirror',artifact);const output=new Output();await f.service.stream('mirror',output as any);
   expect(Buffer.concat(output.chunks)).toEqual(artifact.bytes);expect(f.requests.length).toBe(1);expect(f.events.some(e=>e.status==='transport-complete')).toBe(true);
   expect(f.events.some(e=>e.status==='playing'||e.status==='completed')).toBe(false);
 });
 it('retains durable IDs across restart and serializes different TTS jobs',async()=>{const f=await fixture(),signal=new AbortController().signal,id=randomUUID();
   await Promise.all([f.service.artifacts.create(id,'第一句。',signal),f.service.artifacts.create(randomUUID(),'第二句。',signal)]);expect(f.maxActive()).toBe(1);
   const store=new VoiceArtifacts(join(f.dir,'voice','voice-artifacts'),async()=>{throw Error('must not resynthesize');});expect((await store.create(id,'第一句。',signal)).state).toBe('ready');
 });
 it('unknown cormy fails instead of falling back; overlong audio is never uploaded or silently clipped',async()=>{const missing=await fixture({missingVoice:true});await expect(missing.service.artifacts.create(randomUUID(),'你好。',new AbortController().signal)).rejects.toThrow(/unavailable/);expect(missing.requests.length).toBe(0);
   const long=await fixture({long:true}),id=randomUUID();await expect(long.service.artifacts.create(id,'太长的声音。',new AbortController().signal)).rejects.toThrow(/30s/);
   await expect(long.service.artifacts.create(id,'太长的声音。',new AbortController().signal)).rejects.toThrow(/failed\/unknown/);expect(long.requests.length).toBe(1);
 });
 it('cancellation does not make a partial line ready or replay it',async()=>{const f=await fixture(),abort=new AbortController(),id=randomUUID();abort.abort();
   await expect(f.service.artifacts.create(id,'不要播放。',abort.signal)).rejects.toThrow();await expect(f.service.artifacts.read(id)).rejects.toThrow(/unavailable/);expect(f.requests.length).toBe(0);
 });
 it('imports existing WAV exactly and never invokes TTS',async()=>{const f=await fixture(),id=randomUUID(),bytes=wav(.3,true);await f.service.artifacts.import(id,bytes);expect((await f.service.artifacts.read(id)).bytes).toEqual(bytes);expect(f.requests.length).toBe(0);expect(()=>gameVoiceWav(Buffer.from('mp3'))).toThrow();});
 it('serves the explicit HTTP audio producer without any renderer; no implicit broadcast',async()=>{const f=await fixture();const server=new AvatarStageServer({port:0,dataDir:join(f.dir,'server'),avatars:[],voice:f.voice},event=>f.events.push(event));
   await server.start();cleanups.push(()=>server.stop());const id=randomUUID(),body=JSON.stringify({requestId:id,text:'这是附近游戏语音。'});
   const response=await fetch(server.url+'/api/voice-artifacts',{method:'POST',headers:{'Content-Type':'application/json'},body});expect(response.status).toBe(200);expect(response.headers.get('x-voice-generation-complete')).toBe('null');const bytes=Buffer.from(await response.arrayBuffer());expect(bytes.toString('ascii',0,4)).toBe('RIFF');
   expect(server.stage.status().audioOwner).toBeNull();expect([...server.stage.ledger.actions.values()].length).toBe(0);expect(f.events.some(e=>e.type==='command')).toBe(false);
   const mirror=await fetch(server.url+'/api/voice-artifacts/'+id+'/broadcast',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});expect(mirror.status).toBe(400);expect(f.requests.length).toBe(1);
   const logs=JSON.parse(await readFile(join(f.dir,'server','voice-artifacts',id+'.json'),'utf8'));
   expect(logs.state).toBe('ready');
   const imported=randomUUID();const put=await fetch(server.url+'/api/voice-artifacts/'+imported,{method:'PUT',headers:{'Content-Type':'audio/wav'},body:new Uint8Array(bytes)});expect(put.status).toBe(200);expect(f.requests.length).toBe(1);
 });
});
