import {it,expect,vi} from 'vitest';
import {AutoMusic,AUTO_MUSIC_DEFAULTS} from '../src/core/auto-music.ts';
function setup(){
  let now=1_000_000;let state:any={audioOwner:'desktop',audioRevision:7,actions:[],foreground:null};
  const play=vi.fn(async(_args:Record<string,unknown>,_id:string)=>({id:'song-action',status:'queued'}));
  const tracks=vi.fn(async()=>[{id:'one',instrumental:false},{id:'two',instrumental:false},{id:'bgm',instrumental:true}]);
  const log=vi.fn();const music=new AutoMusic({config:()=>({...AUTO_MUSIC_DEFAULTS,enabled:true}),state:()=>state,play,tracks,log,now:()=>now});
  const observe=(mode:any='travel')=>music.observe({source:'game',mode,observedAt:now,activityId:'task'});
  const advance=(ms:number,mode:any='travel')=>{for(let n=0;n<ms;n+=5000){now+=Math.min(5000,ms-n);observe(mode);}};
  return {music,play,tracks,log,observe,advance,state,now:()=>now};
}
it('plays a vocal song once after continuous travel, independent of model/body completion',async()=>{
 const f=setup();f.observe();f.advance(85000);await f.music.tick();expect(f.play).not.toHaveBeenCalled();
 f.advance(5000);await f.music.tick();await f.music.tick();expect(f.play).toHaveBeenCalledTimes(1);
 expect(f.play.mock.calls[0][0]).toMatchObject({trackId:'one',ifIdleRevision:7});
 expect(f.log.mock.calls[0][0]).toMatchObject({mode:'travel',completion:'requires-renderer-ended'});
});
it('waits for idle threshold, fresh observations and live presentation',async()=>{
 const f=setup();f.observe('idle');f.advance(115000,'idle');await f.music.tick();expect(f.play).not.toHaveBeenCalled();
 f.advance(5000,'idle');f.state.foreground='dialogue';await f.music.tick();expect(f.play).not.toHaveBeenCalled();
 f.state.foreground=null;f.state.waitingSpeech={id:'pending'};await f.music.tick();expect(f.play).not.toHaveBeenCalled();
 f.state.waitingSpeech=null;await f.music.tick();expect(f.play).toHaveBeenCalledTimes(1);
});
it('combat, stale sample, stop and a changed source reset or disable opportunities',async()=>{
 const f=setup();f.observe();f.advance(90000);f.observe('busy');await f.music.tick();expect(f.play).not.toHaveBeenCalled();
 f.observe();f.advance(85000);await f.music.tick();expect(f.play).not.toHaveBeenCalled();
 f.music.stop();f.advance(10000);await f.music.tick();expect(f.play).not.toHaveBeenCalled();
});
it('restored ledger enforces cooldown and rotates songs without repeating last track',async()=>{
 const f=setup();f.observe();f.advance(90000);
 f.state.actions=[{kind:'music-play',updatedAt:f.now(),command:{trackId:'one'},status:'completed'}];
 await f.music.tick();expect(f.play).not.toHaveBeenCalled();f.advance(300000);await f.music.tick();
 expect(f.play.mock.calls[0][0]).toMatchObject({trackId:'two'});
});
it('rechecks conversation admission after asynchronous catalog lookup and single-flights ticks',async()=>{
 const f=setup();f.observe();f.advance(90000);let resolve!:(x:any)=>void;
 f.tracks.mockImplementation(()=>new Promise(r=>resolve=r));const request=f.music.tick();await f.music.tick();
 f.state.foreground='new-speech';resolve([{id:'one'}]);await request;expect(f.play).not.toHaveBeenCalled();
});
it('an unknown/failed submission is not blindly repeated on every timer tick',async()=>{
 const f=setup();f.observe();f.advance(90000);f.play.mockRejectedValueOnce(Error('connection lost'));
 await f.music.tick();await f.music.tick();expect(f.play).toHaveBeenCalledTimes(1);expect(f.log.mock.calls[0][0].accepted).toBe(false);
});
