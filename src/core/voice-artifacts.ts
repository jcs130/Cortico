import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {wavInfo} from './wav.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type VoiceArtifact={requestId:string;fingerprint:string;state:'rendering'|'ready'|'failed';
  createdAt:string;sha256?:string;bytes?:number;durationMs?:number;sampleRate?:number;
  voice:string|null;text?:string;generationComplete:boolean|null;reason?:string};
const digest=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
/** A finite, independently validated WAV. No segmentation, clipping, rate tricks or text-completion claim. */
export function gameVoiceWav(bytes:Buffer):Buffer {
  if(bytes.length>4*1024*1024)throw Error('Voice artifact exceeds 4MiB');
  const info=wavInfo(bytes);
  if(info.format!==1||info.bits!==16||![1,2].includes(info.channels)||info.sampleRate<8000||info.sampleRate>96000
    ||info.durationMs<100||info.durationMs>30000||info.dataSize%(info.channels*2))throw Error('Game voice requires PCM16 WAV, 0.1–30s, mono/stereo');
  const pcm=bytes.subarray(info.dataOffset,info.dataOffset+info.dataSize),header=Buffer.alloc(44);
  header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);
  header.writeUInt16LE(1,20);header.writeUInt16LE(info.channels,22);header.writeUInt32LE(info.sampleRate,24);
  header.writeUInt32LE(info.sampleRate*info.channels*2,28);header.writeUInt16LE(info.channels*2,32);header.writeUInt16LE(16,34);
  header.write('data',36);header.writeUInt32LE(pcm.length,40);return Buffer.concat([header,pcm]);
}
/** Durable request IDs prevent reconnect/HTTP retries from cloning a line twice. No player or broadcast output here. */
export class VoiceArtifacts {
  private readonly inFlight=new Map<string,Promise<VoiceArtifact>>();
  constructor(private readonly directory:string,private readonly render:(text:string,requestId:string,signal:AbortSignal)=>Promise<{bytes:Buffer;voice:string;generationComplete:boolean|null}>){}
  private key(id:string){if(!UUID.test(id))throw Error('Artifact requestId must be a UUID');return join(this.directory,id);}
  private async metadata(id:string):Promise<VoiceArtifact|null>{
    try {const row=JSON.parse(await readFile(this.key(id)+'.json','utf8'));if(row.requestId!==id||!['ready','rendering','failed'].includes(row.state))throw Error('Invalid voice artifact ledger');return row;}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
  }
  private async save(row:VoiceArtifact){await mkdir(this.directory,{recursive:true});const file=this.key(row.requestId)+'.json',temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(row));await rename(temp,file);}
  async read(id:string){const row=await this.metadata(id);if(!row||row.state!=='ready')throw Error('Audio artifact unavailable; do not regenerate an unknown request');
    const bytes=await readFile(this.key(id)+'.wav');if(bytes.length!==row.bytes||digest(bytes)!==row.sha256)throw Error('Audio artifact integrity mismatch');
    return {metadata:row,bytes};}
  async create(id:string,text:string,signal:AbortSignal){
    this.key(id);if(typeof text!=='string'||!text.trim()||text.length>2000)throw Error('Artifact requires one full speakable line');
    const fingerprint=digest(JSON.stringify(['text',text]));
    const pending=this.inFlight.get(id);if(pending){const row=await pending;if(row.fingerprint!==fingerprint)throw Error('Artifact requestId content conflict');return row;}
    const job=this.createOnce(id,text,fingerprint,signal);this.inFlight.set(id,job);
    try{return await job;}finally{this.inFlight.delete(id);}
  }
  private async createOnce(id:string,text:string,fingerprint:string,signal:AbortSignal){
    const old=await this.metadata(id);if(old){if(old.fingerprint!==fingerprint)throw Error('Artifact requestId content conflict');if(old.state!=='ready')throw Error('Prior synthesis failed/unknown; do not replay automatically');return old;}
    const row:VoiceArtifact={requestId:id,fingerprint,state:'rendering',createdAt:new Date().toISOString(),text,voice:null,generationComplete:null};
    await this.save(row);
    try {signal.throwIfAborted();const result=await this.render(text,id,signal);signal.throwIfAborted();
      const bytes=gameVoiceWav(result.bytes),info=wavInfo(bytes);await writeFile(this.key(id)+'.wav',bytes,{flag:'wx'});
      Object.assign(row,{state:'ready',voice:result.voice,sha256:digest(bytes),bytes:bytes.length,durationMs:info.durationMs,sampleRate:info.sampleRate,generationComplete:result.generationComplete});
      await this.save(row);return row;
    }catch(error){row.state='failed';row.reason=String(error).slice(0,240);await this.save(row);throw error;}
  }
  async import(id:string,input:Buffer){
    this.key(id);if(this.inFlight.has(id))throw Error('Artifact request already rendering');
    gameVoiceWav(input);const bytes=Buffer.from(input),fingerprint=digest(JSON.stringify(['wav',digest(input)]));
    // Reserve before the first await so concurrent PUT/POST cannot replace an artifact.
    const job=(async()=>{const old=await this.metadata(id);if(old){if(old.fingerprint!==fingerprint)throw Error('Artifact requestId content conflict');if(old.state!=='ready')throw Error('Prior artifact unknown');return old;}
      const info=wavInfo(bytes),row:VoiceArtifact={requestId:id,fingerprint,state:'rendering',createdAt:new Date().toISOString(),voice:null,generationComplete:null};
      await this.save(row);await writeFile(this.key(id)+'.wav',bytes,{flag:'wx'});
      Object.assign(row,{state:'ready',sha256:digest(bytes),bytes:bytes.length,durationMs:info.durationMs,sampleRate:info.sampleRate});await this.save(row);return row;})();
    this.inFlight.set(id,job);try{return await job;}finally{this.inFlight.delete(id);}
  }
}
