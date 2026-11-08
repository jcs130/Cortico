import {afterEach, expect, it} from 'vitest';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {AvatarStageServer} from '../src/server.ts';
const dirs:string[]=[],servers:AvatarStageServer[]=[];
async function fixture(){
 const dataDir=await mkdtemp(join(tmpdir(),'stage-progress-'));dirs.push(dataDir);
 const server=new AvatarStageServer({dataDir,port:0,avatars:[]});servers.push(server);return {dataDir,server};
}
afterEach(async()=>{
 for(const s of servers.splice(0))await s.stop();
 for(const d of dirs.splice(0)){expect(resolve(d).startsWith(resolve(tmpdir())+sep+'stage-progress-')).toBe(true);await rm(d,{recursive:true,force:true});}
});
it('reports the awaited startup boundary and announces HTTP readiness only after listening',async()=>{
 const {server}=await fixture(),phases:string[]=[];
 await server.start(p=>phases.push(p));
 expect(phases).toEqual(['avatars','ledger-snapshot','ledger-receipts','ledger-checkpoint','voice-catalogue','music-ledger','stage-ready','http-listen','http-ready']);
 expect((await fetch(server.url+'/api/state')).status).toBe(200);
});
it('does not claim readiness or silently drop corrupt recovery records',async()=>{
 const {server,dataDir}=await fixture(),phases:string[]=[];
 await mkdir(join(dataDir,'action-records'));
 await writeFile(join(dataDir,'action-records','0'.repeat(64)+'.json'),'{');
 await expect(server.start(p=>phases.push(p))).rejects.toThrow();
 expect(phases).toEqual(['avatars','ledger-snapshot','ledger-receipts']);
});
