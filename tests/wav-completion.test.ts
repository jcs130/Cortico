import {afterEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assertWavComplete} from '../src/core/wav.ts';
import {VoiceService} from '../src/core/voice.ts';
import {streamSpeechSegments} from '../src/core/speech-segments.ts';

const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllGlobals();for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
function response(stop?:string){return new Response(Buffer.alloc(48),{headers:{'content-type':'audio/wav',...(stop===undefined?{}:{'X-Speech-Stop':stop})}});}
class Output extends EventEmitter {headersSent=false;code=0;writeHead(code:number){this.headersSent=true;this.code=code;}write(){return true;}end(){}destroy(){this.emit('close');}}

it('requires an explicit WAV completion when configured and keeps generic headerless compatibility',()=>{
  expect(assertWavComplete(response('complete'),true)).toBe('complete');
  expect(assertWavComplete(response())).toBeNull();
  expect(()=>assertWavComplete(response(),true)).toThrow('completion');
});
it.each(['max_seconds','model_limit','error'])('rejects a HTTP 200 WAV whose generation ended with %s',async stop=>{
  expect(()=>assertWavComplete(response(stop))).toThrow('generation incomplete: '+stop);
  const directory=await mkdtemp(join(tmpdir(),'stage-wav-stop-'));dirs.push(directory);const events:any[]=[];let upstreamSignal!:AbortSignal;
  vi.stubGlobal('fetch',async(_url:any,init:any)=>{upstreamSignal=init.signal;return response(stop);});
  const voice=new VoiceService(()=>({url:'http://fixture.invalid/speech',model:'fixture',voice:'a',requireWavCompletion:true}),directory,(id,status,data)=>events.push({id,status,data}));await voice.start();
  try { voice.queue('incomplete','一条未完成的语音。');const out=new Output();await voice.stream('incomplete',out as any);
    expect(out.code).toBe(502);expect(upstreamSignal.aborted).toBe(true);
    expect(voice.status().last).toMatchObject({status:'failed',wavStop:stop});
    expect(events.some(e=>['transport-complete','playing','ended','completed'].includes(e.status))).toBe(false);
  } finally { await voice.stop(); }
});
it('also checks terminal headers before consuming audio through the optional legacy segmented transport',async()=>{
  const request=vi.fn(async()=>response('model_limit')),write=vi.fn(async()=>{});
  await expect(streamSpeechSegments({text:'第一句话。第二句话。',maxChars:8,requireWavCompletion:true,signal:new AbortController().signal,request,
    failure:async()=>Error('unexpected'),begin:()=>{},write})).rejects.toThrow('model_limit');
  expect(request).toHaveBeenCalledOnce();expect(write).not.toHaveBeenCalled();
});
