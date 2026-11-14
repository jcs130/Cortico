import {randomUUID} from 'node:crypto';

export interface PerformanceActivity { source:string; observedAt:number; mode:'travel'|'idle'|'busy'|'unavailable'; activityId:string }
export interface AutoMusicConfig { enabled:boolean; travelAfterSeconds:number; idleAfterSeconds:number; cooldownSeconds:number; volume:number }
export const AUTO_MUSIC_DEFAULTS:AutoMusicConfig={enabled:false,travelAfterSeconds:90,idleAfterSeconds:120,cooldownSeconds:300,volume:0.65};
export function readPerformanceActivity(value:unknown):PerformanceActivity|null {
  const v=value as PerformanceActivity;
  return v&&typeof v.source==='string'&&v.source.length<=100&&Number.isFinite(v.observedAt)
    &&['travel','idle','busy','unavailable'].includes(v.mode)&&typeof v.activityId==='string'&&v.activityId.length<=200?v:null;
}
/** Presentation only: no model request, body command, or invented claim of progress.
 * Playback ledger supplies restart/cooldown evidence; the host supplies fresh activity.
 */
export class AutoMusic {
  private activity:PerformanceActivity|null=null;
  private since=0;
  private pending=false;
  private retryAfter=0;
  private stopped=false;
  constructor(private ports:{config():AutoMusicConfig; state():Record<string,any>|null;
    tracks():Promise<{id:string;instrumental?:boolean}[]>;
    play(args:Record<string,unknown>,requestId:string):Promise<Record<string,any>>;
    log(data:Record<string,unknown>):void;now?():number}){}
  observe(value:unknown){
    const v=readPerformanceActivity(value),now=this.now();
    if(!v||v.observedAt>now+1000||now-v.observedAt>15000)return;
    if(this.activity&&v.observedAt<this.activity.observedAt)return;
    // Route steps can change during one long journey; mode/source are the continuity boundary.
    if(!this.activity||this.activity.source!==v.source||this.activity.mode!==v.mode||now-this.activity.observedAt>15000)this.since=now;
    this.activity=v;
  }
  private now(){return this.ports.now?.()??Date.now();}
  private eligible(){
    const now=this.now(),cfg=this.ports.config(),a=this.activity,s=this.ports.state();
    if(this.stopped||!cfg.enabled||!a||now-a.observedAt>15000||!['travel','idle'].includes(a.mode)
      ||!s||s.stopped||!s.audioOwner||s.foreground||s.waitingSpeech||now<this.retryAfter)return null;
    const songs=(s.actions??[]).filter((r:any)=>r.kind==='music-play').sort((a:any,b:any)=>b.updatedAt-a.updatedAt);
    const last=s.lastMusic??songs[0];
    if(last&&now-last.updatedAt<Math.max(30,cfg.cooldownSeconds)*1000)return null;
    const threshold=a.mode==='travel'?cfg.travelAfterSeconds:cfg.idleAfterSeconds;
    if(!Number.isFinite(threshold)||now-this.since<Math.max(10,threshold)*1000)return null;
    return {a,s,last,now,cfg};
  }
  async tick(){
    if(this.pending||!this.eligible())return;
    this.pending=true;
    try{
      const tracks=(await this.ports.tracks()).filter(t=>!t.instrumental);
      const ready=this.eligible();if(!ready)return;
      const previous=ready.last?.command?.trackId;
      const nextIndex=tracks.findIndex(t=>t.id===previous)+1;
      const track=tracks.length?tracks[nextIndex%tracks.length]:null;
      if(!track){this.retryAfter=this.now()+60000;return;}
      const requestId='avatar-auto-song-'+randomUUID();
      const result=await this.ports.play({action:'play',trackId:track.id,volume:ready.cfg.volume,
        ifIdleRevision:ready.s.audioRevision},requestId);
      // Failed admission must not spin or cut a newer conversation. No replay on unknown completion.
      this.retryAfter=this.now()+60000;
      this.ports.log({source:ready.a.source,mode:ready.a.mode,activityId:ready.a.activityId,
        observedAt:ready.a.observedAt,eligibleForMs:ready.now-this.since,trackId:track.id,requestId,
        actionId:result.id??null,status:result.status??null,accepted:['queued','playing','completed'].includes(result.status),
        reason:result.reason??null,completion:'requires-renderer-ended'});
    }catch(error){this.retryAfter=this.now()+60000;this.ports.log({error:String(error),accepted:false});}
    finally{this.pending=false;}
  }
  stop(){this.stopped=true;this.activity=null;}
}
