import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {splitSynthesisText,streamSpeechSegments} from '../src/core/speech-segments.ts';
import {VoiceService} from '../src/core/voice.ts';
import {wavInfo} from '../src/core/wav.ts';
import {spokenText,validatePronunciations} from '../src/core/speech-text.ts';
const directories:string[]=[];
afterEach(async()=>{vi.unstubAllGlobals();for(const p of directories.splice(0))await rm(p,{recursive:true,force:true});});
function wav(value=100,rate=44100){const b=Buffer.alloc(44+32);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(32,40);for(let p=44;p<b.length;p+=2)b.writeInt16LE(value,p);return b;}
class Output extends EventEmitter {headersSent=false;chunks:Buffer[]=[];status=0;writeHead(status:number){this.headersSent=true;this.status=status;}write(b:Uint8Array){this.chunks.push(Buffer.from(b));return true;}end(){}destroy(){this.emit('close');}}
describe('short sentence synthesis',()=>{
 it('preserves speakers without replaying delivery or point events in subsequent requests',()=>{
  const parts=splitSynthesisText('<|speaker:0|>[warm]你好朋友，继续向前走吧。<|speaker:1|>你好。继续出发吧！',8);
  expect(parts).toEqual(['<|speaker:0|>[warm]你好朋友，','<|speaker:0|>继续向前走吧。','<|speaker:1|>你好。继续出发吧！']);
  expect(parts.join('').match(/\[warm\]/g)).toHaveLength(1);
  expect(splitSynthesisText('😀'.repeat(9)+'。',8)).toEqual(['😀'.repeat(8),'😀。']);
  expect(()=>splitSynthesisText('hello',0)).toThrow('8–160');
 });
 it('packs tiny sentences and protects names rather than clipping the 24th character',()=>{
  expect(splitSynthesisText('语音测试。你好，我是可米。',24,['可米'])).toEqual(['语音测试。你好，我是可米。']);
  const sentence='Coobot 和 DeepFish，你们好呀，我是可米。';
  expect(splitSynthesisText(sentence,24,['Coobot','DeepFish','可米'])).toEqual([sentence]);
  const text='一二三四五六七八九十一二三四五六七八九十Coobot来了。';
  const parts=splitSynthesisText(text,24,['Coobot']);
  expect(parts.join('')).toBe(text);expect(parts.some(x=>x.includes('Coobot'))).toBe(true);
  expect(()=>splitSynthesisText('an_unbreakable_identifier',8)).toThrow('segment budget');
 });
 it('keeps an explicitly supplied phoneme span atomic without asserting backend support',()=>{
  const name='<|phoneme_start|>ke3<|phoneme_end|><|phoneme_start|>mi3<|phoneme_end|>';
  const text='你好朋友，欢迎来到这里。'+name+'也来了。';
  const parts=splitSynthesisText(text,8);expect(parts.join('')).toBe(text);expect(parts.some(x=>x.includes(name))).toBe(true);
 });
 it('uses explicit plain spoken names only, leaving different usernames and controls unchanged',()=>{
  const map={Coobot:'Coo bot',DeepFish:'Deep Fish','可米':'可米'};
  expect(spokenText('谢谢Coobot，DeepFish也来了，可米！Coobot2和MyCoobot是其他名字。',map)).toBe('谢谢Coo bot，Deep Fish也来了，可米！Coobot2和MyCoobot是其他名字。');
  expect(spokenText('[ask Coobot]Coobot你好。',map)).toBe('[ask Coobot]Coo bot你好。');
  expect(spokenText('DeepFish也来了。')).toBe('DeepFish也来了。');
  expect(()=>validatePronunciations({name:'<|phoneme_start|>x<|phoneme_end|>'})).toThrow('plain spoken words');
  expect(()=>validatePronunciations({name:'[laughs]'})).toThrow('plain spoken words');
  expect(()=>validatePronunciations(null as any)).toThrow('object');
 });
 it('forwards one PCM stream and starts each request only after the previous body reaches EOF',async()=>{
  const controller=new AbortController(),chunks:Buffer[]=[],calls:any[]=[],first=wav(100),second=wav(200);let active=0,maxActive=0;
  const bytes=await streamSpeechSegments({text:'第一句话很好。第二句话也好。',maxChars:8,signal:controller.signal,
   request:async(text,id)=>{maxActive=Math.max(maxActive,++active);calls.push({text,id,written:chunks.length});const b=calls.length===1?first:second;return new Response(new ReadableStream({async start(c){await new Promise(r=>setTimeout(r,5));c.enqueue(b.subarray(0,30));c.enqueue(b.subarray(30));active--;c.close();}}),{headers:{'content-type':'audio/wav'}})},
   failure:async()=>Error('unexpected HTTP failure'),begin:vi.fn(),write:async b=>{chunks.push(Buffer.from(b))}});
  expect(maxActive).toBe(1);expect(calls.map(x=>x.text)).toEqual(['第一句话很好。','第二句话也好。']);expect(calls[1].written).toBe(2);
  expect(new Set(calls.map(x=>x.id)).size).toBe(2);
  const out=Buffer.concat(chunks);expect(bytes).toBe(44+64);expect(wavInfo(out).dataSize).toBe(64);
  expect(out.subarray(44)).toEqual(Buffer.concat([first.subarray(44),second.subarray(44)]));
 });
 it('stops before the next sentence when cancelled and rejects incompatible WAV formats',async()=>{
  const controller=new AbortController(),request=vi.fn(async()=>new Response(wav(),{headers:{'content-type':'audio/wav'}}));let writes=0;
  await expect(streamSpeechSegments({text:'第一句话很好。第二句话也好。',maxChars:8,signal:controller.signal,request,failure:async()=>Error('bad'),begin:()=>{},write:async()=>{if(++writes===2)controller.abort();}})).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
  let count=0;await expect(streamSpeechSegments({text:'第一句话很好。第二句话也好。',maxChars:8,signal:new AbortController().signal,request:async()=>new Response(wav(100,++count===1?44100:24000),{headers:{'content-type':'audio/wav'}}),failure:async()=>Error('bad'),begin:()=>{},write:async()=>{}})).rejects.toThrow('sample rate changed');
 });
 it('sends configured backend fields without an auth key and preserves original playback completion',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'stage-short-'));directories.push(directory);
  const events:any[]=[],wires:any[]=[];
  vi.stubGlobal('fetch',async(_url:any,init:any)=>{wires.push({body:JSON.parse(init.body),headers:new Headers(init.headers)});return new Response(wav(),{headers:{'content-type':'audio/wav'}})});
  const voice=new VoiceService(()=>({url:'http://fixture.invalid/speech',model:'fixture',voice:'private',segmentMaxChars:24,extraBody:{max_seconds:10,top_k:4097,voice:'must-not-win',input:'must-not-win'}}),directory,(id,status,data)=>events.push({id,status,data}));await voice.start();
  voice.queue('original','第一句。第二句。');const output=new Output();await voice.stream('original',output as any);
  expect(wires.map(x=>x.body)).toEqual([{model:'fixture',input:'第一句。第二句。',voice:'private',response_format:'wav',max_seconds:10,top_k:4097}]);
  expect(wires.every(x=>!x.headers.has('authorization'))).toBe(true);
  expect(events.filter(x=>x.status==='streaming')).toHaveLength(1);expect(events.at(-1)).toMatchObject({id:'original',status:'transport-complete'});
  expect(events.some(x=>['playing','completed','ended'].includes(x.status))).toBe(false);
  expect(voice.status().current).toMatchObject({id:'original',phase:'awaiting-playback'});voice.finish('original');expect(voice.status().current).toBeNull();await voice.stop();
 });
 it('keeps original dialogue but applies configured plain pronunciation at the final request boundary',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'stage-names-'));directories.push(directory);const bodies:any[]=[];
  vi.stubGlobal('fetch',async(_url:any,init:any)=>{bodies.push(JSON.parse(init.body));return new Response(wav(),{headers:{'content-type':'audio/wav'}})});
  const voice=new VoiceService(()=>({url:'http://fixture.invalid/speech',model:'fixture',voice:'private',segmentMaxChars:24,pronunciations:{DeepFish:'Deep Fish','可米':'可米'}}),directory,()=>{});await voice.start();
  const original='DeepFish，你好，我是可米。';expect(voice.validate(original).text).toBe(original);
  voice.queue('same-action',original);await voice.stream('same-action',new Output() as any);
  expect(bodies).toHaveLength(1);expect(bodies[0]).toMatchObject({input:'Deep Fish，你好，我是可米。',voice:'private'});
  expect(voice.status().current?.id).toBe('same-action');await voice.stop();
 });
 it('waits for an interrupted request to settle before starting the next utterance',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'stage-serial-'));directories.push(directory);let active=0,maxActive=0,calls=0;
  vi.stubGlobal('fetch',async(_url:any,init:any)=>{maxActive=Math.max(maxActive,++active);calls++;if(calls===1)return new Promise<Response>((_ok,fail)=>{init.signal.addEventListener('abort',()=>{setTimeout(()=>{active--;fail(init.signal.reason)},20)},{once:true})});active--;return new Response(wav(),{headers:{'content-type':'audio/wav'}})});
  const voice=new VoiceService(()=>({url:'http://fixture.invalid/speech',model:'fixture',voice:'private',segmentMaxChars:24}),directory,()=>{});await voice.start();
  voice.queue('old','旧一句。');const first=voice.stream('old',new Output() as any);await vi.waitFor(()=>expect(calls).toBe(1));
  voice.queue('new','新一句。');const second=voice.stream('new',new Output() as any);await Promise.all([first,second]);
  expect(calls).toBe(2);expect(maxActive).toBe(1);await voice.stop();
 });
 it('keeps the original single-WAV transport when the default segment limit is zero',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'stage-unsplit-'));directories.push(directory);const bodies:any[]=[];
  vi.stubGlobal('fetch',async(_url:any,init:any)=>{bodies.push(JSON.parse(init.body));return new Response(wav(),{headers:{'content-type':'audio/wav'}})});
  const voice=new VoiceService(()=>({url:'http://fixture.invalid/speech',model:'fixture',voice:'private',segmentMaxChars:0}),directory,()=>{});await voice.start();
  voice.queue('original','第一句。第二句。');const out=new Output();await voice.stream('original',out as any);
  expect(bodies).toHaveLength(1);expect(bodies[0]).toMatchObject({input:'第一句。第二句。',speed:1});expect(Buffer.concat(out.chunks)).toEqual(wav());await voice.stop();
 });
});
