import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamPcmSse } from "../src/core/pcm-sse.ts";
import { VoiceService } from "../src/core/voice.ts";
import { wavInfo } from "../src/core/wav.ts";

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const frame = (value: unknown, ending="\n\n") => "data: " + JSON.stringify(value) + ending;
const delta = (b=Buffer.from([1,0,2,0])) => frame({ type: "speech.audio.delta", audio: b.toString("base64") });
const done = (stop="complete", samples=2) => frame({ type:"speech.audio.done", seed:20261021, samples, stop });
const response = (text: string) => new Response(text, { headers:{"content-type":"text/event-stream"} });
async function forward(text: string) { const out: Buffer[]=[]; const result=await streamPcmSse({response:response(text), sampleRate:44100, signal:new AbortController().signal, begin:()=>{}, write:async b=>{out.push(Buffer.from(b))} }); return {result,out:Buffer.concat(out)}; }
class Output extends EventEmitter { chunks:Buffer[]=[]; headersSent=false; writeHead(){this.headersSent=true;} write(b:Uint8Array){this.chunks.push(Buffer.from(b));return true;}end(){}destroy(){this.emit('close');} }

describe("one-context native PCM streaming", () => {
  it("forwards PCM before provider completion and preserves one WAV envelope", async () => {
    const writes:Buffer[]=[],log:string[]=[];
    const stream=new ReadableStream({async start(c){ c.enqueue(new TextEncoder().encode(delta())); await new Promise(r=>setTimeout(r,15));log.push('done-sent');c.enqueue(new TextEncoder().encode(done()));c.close(); }});
    const result=await streamPcmSse({response:new Response(stream,{headers:{'content-type':'text/event-stream'}}),sampleRate:44100,signal:new AbortController().signal,begin:()=>log.push('begin'),write:async b=>{writes.push(Buffer.from(b));log.push(writes.length===1?'header':'pcm');}});
    expect(log.indexOf('pcm')).toBeLessThan(log.indexOf('done-sent'));expect(result).toMatchObject({samples:2,frames:1,seed:20261021,stop:'complete',bytes:48});
    const wav=Buffer.concat(writes);expect(wavInfo(wav)).toMatchObject({sampleRate:44100,channels:1,bits:16,dataSize:4});expect(wav.subarray(44)).toEqual(Buffer.from([1,0,2,0]));
  });
  it("handles arbitrary network splits, CRLF and SSE comments without corrupting PCM",async()=>{
    const text=': ping\r\n\r\n'+delta().replaceAll('\n','\r\n')+done().replaceAll('\n','\r\n');const bytes=new TextEncoder().encode(text);
    const stream=new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=3)c.enqueue(bytes.slice(i,i+3));c.close();}});
    const out:Buffer[]=[];const result=await streamPcmSse({response:new Response(stream,{headers:{'content-type':'text/event-stream'}}),sampleRate:44100,signal:new AbortController().signal,begin:()=>{},write:async b=>{out.push(Buffer.from(b))}});
    expect(result.samples).toBe(2);expect(Buffer.concat(out).subarray(44)).toEqual(Buffer.from([1,0,2,0]));
  });
  it("never treats provider truncation, missing terminal or sample mismatch as complete",async()=>{
    await expect(forward(delta()+done('max_seconds'))).rejects.toThrow('generation incomplete: max_seconds');
    await expect(forward(delta())).rejects.toThrow('without confirmed audio completion');
    await expect(forward(delta()+done('complete',9))).rejects.toThrow('sample count');
    await expect(forward(done())).rejects.toThrow('without confirmed audio completion');
    await expect(forward(delta()+done()+delta())).rejects.toThrow('after completion');
  });
  it("rejects malformed audio and observes cancellation before forwarding more data",async()=>{
    await expect(forward(frame({type:'speech.audio.delta',audio:'bad!'}))).rejects.toThrow('base64');
    await expect(forward(delta(Buffer.from([1]))+done())).rejects.toThrow('Unaligned');
    const c=new AbortController();await expect(streamPcmSse({response:response(delta()+done()),sampleRate:44100,signal:c.signal,begin:()=>{},write:async()=>{c.abort();}})).rejects.toThrow();
  });
  it("sends one backend request for the original full sentence with a fixed configured seed",async()=>{
    const directory=await mkdtemp(join(tmpdir(),'stage-native-'));dirs.push(directory);const bodies:any[]=[],events:any[]=[];
    vi.stubGlobal('fetch',async(_url:any,init:any)=>{bodies.push(JSON.parse(init.body));return response(delta()+done());});
    const voice=new VoiceService(()=>({url:'http://fixture.invalid/speech',model:'fixture',voice:'private',synthesisTransport:'pcm-sse',pcmSampleRate:44100,segmentMaxChars:0,extraBody:{seed:20261021,max_seconds:10,top_k:4097}}),directory,(id,status,data)=>events.push({id,status,data}));await voice.start();
    const text='一条完整的台词，保持同一次生成，不重新克隆。';voice.queue('same-action',text);await voice.stream('same-action',new Output() as any);
    expect(bodies).toEqual([{model:'fixture',input:text,voice:'private',response_format:'pcm',stream_format:'sse',seed:20261021,max_seconds:10,top_k:4097}]);
    expect(voice.status().last).toMatchObject({id:'same-action',status:'transport-complete',nativeStream:{input:text,seed:20261021,stop:'complete',samples:2}});
    expect(events.some(x=>['playing','completed','ended'].includes(x.status))).toBe(false);await voice.stop();
  });
  it("retains an incomplete native stop as failed and rejects independent client segmentation",async()=>{
    const directory=await mkdtemp(join(tmpdir(),'stage-native-limit-'));dirs.push(directory);const events:any[]=[];
    vi.stubGlobal('fetch',async()=>response(delta()+done('max_seconds')));
    const config={url:'http://fixture.invalid/speech',model:'fixture',voice:'private',synthesisTransport:'pcm-sse' as const,pcmSampleRate:44100,segmentMaxChars:0};
    const voice=new VoiceService(()=>config,directory,(id,status,data)=>events.push({id,status,data}));await voice.start();voice.queue('limited','一个长句。');await voice.stream('limited',new Output() as any);
    expect(voice.status().last).toMatchObject({status:'failed',nativeStream:{stop:'max_seconds'}});expect(events.some(x=>x.status==='transport-complete')).toBe(false);
    config.segmentMaxChars=24;expect(()=>voice.validate('不应独立切开。')).toThrow('one synthesis context');await voice.stop();
  });
});
