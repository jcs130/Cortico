import { expect, it, vi } from 'vitest';
import { CommentaryLane, COMMENTARY_DEFAULTS, type SpeechAvailability } from '../src/core/commentary.ts';
import { speechRecords } from '../src/core/speech-records.ts';
// @ts-expect-error Browser renderer module.
import { createMediaPlayer } from '../web/desktop-player.js';

const frame = (script: string) => JSON.stringify({evidence:[1],kind:'observation',timeframe:'recent',script});
it('speaks the first validated record before the model completes and retains one continuation', async () => {
  const now=100000, speech:SpeechAvailability={observedAtMs:now,idleSinceMs:90000,busy:false,ttsReady:true,queueRevision:0};
  let update!:(text:string)=>void, finish!:(r:{text:string})=>void;
  const spoken:string[]=[];
  const lane=new CommentaryLane({config:()=>({...COMMENTARY_DEFAULTS,enabled:true,sources:'game',idleSec:1}),
    availability:()=>({live:true,active:true,speech}),now:()=>now,
    request:(_brief,tap)=>{update=tap!;return new Promise(r=>{finish=r;});},
    perform:async text=>{spoken.push(text);speech.queueRevision!++;speech.busy=true;speech.foregroundActionId='audio-'+spoken.length;return {accepted:true,actionId:speech.foregroundActionId};},log:()=>{}});
  lane.observe({cursor:1,ts:new Date(now).toISOString(),source:'game',type:'game.snapshot',origin:'external',text:'路旁发现村庄'});
  lane.tick();update(frame('刚才路旁有一座村庄。').slice(0,-1));await Promise.resolve();expect(spoken).toEqual([]);
  update(frame('刚才路旁有一座村庄。'));await vi.waitFor(()=>expect(spoken).toHaveLength(1));
  // New telemetry cannot erase a correctly dated observation.
  lane.observe({cursor:2,ts:new Date(now).toISOString(),source:'game',type:'game.snapshot',origin:'external',text:'正在向前走'});
  finish({text:frame('刚才路旁有一座村庄。')+'\n'+frame('那边的房子挺有意思。')});
  await new Promise(r=>setTimeout(r,0));
  expect(spoken).toHaveLength(1);
  speech.busy=false;speech.idleSinceMs=90000;speech.foregroundActionId=undefined;lane.tick();
  await vi.waitFor(()=>expect(spoken).toHaveLength(2));
  lane.stop();
});
it('never speaks incomplete objects and bounds output while respecting escaped braces',()=>{
  const text=frame('他说：“{你好}”。');expect(speechRecords(text.slice(0,-1))).toEqual([]);
  expect(speechRecords(text+'\n{"script":')).toEqual([text]);
  expect(()=>speechRecords('x'.repeat(8193))).toThrow('budget');
});
it('starts the stage-owned desktop player before the last PCM bytes and cancels queued samples',async()=>{
  const bytes=Buffer.alloc(44+24000);bytes.write('RIFF');bytes.writeUInt32LE(24036,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(24000,24);bytes.writeUInt32LE(48000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(24000,40);
  let producer!:ReadableStreamDefaultController<Uint8Array>;
  const stream=new ReadableStream<Uint8Array>({start(c){producer=c;}}), nodes:any[]=[], receipts:any[]=[];
  const context={state:'running',currentTime:0,destination:{},resume:async()=>{},createBuffer:()=>({copyToChannel(){}}),
    createBufferSource:()=>{const n={connect(){},disconnect(){},start(){},stop:vi.fn()};nodes.push(n);return n;}};
  const player=createMediaPlayer({send:(r:any)=>receipts.push(r),onMouth:()=>{},onText:()=>{},onActions:()=>{},onEnd:()=>{},context:()=>context,
    fetchAudio:async()=>new Response(stream,{headers:{'content-type':'audio/wav'}})});
  const playing=player.play({id:'one',source:'avatar-stage',kind:'speech',url:'/audio',text:'你好。'});
  producer.enqueue(bytes);await vi.waitFor(()=>expect(nodes.length).toBeGreaterThan(0));
  context.currentTime=.1;await vi.waitFor(()=>expect(receipts.some(r=>r.state==='playing')).toBe(true));
  expect(receipts.some(r=>r.state==='completed')).toBe(false);
  player.cancel();await playing;
  expect(receipts.at(-1).state).toBe('cancelled');expect(nodes.every(n=>n.stop.mock.calls.length===1)).toBe(true);
});
