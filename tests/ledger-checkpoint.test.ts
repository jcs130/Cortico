import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const probe=vi.hoisted(()=>({reads:0,failArchive:false,failSnapshot:false}));
vi.mock('node:fs/promises',async original=>{
  const actual=await original<typeof import('node:fs/promises')>();
  return {...actual,readFile:async(...args:Parameters<typeof actual.readFile>)=>{
    if(/[\\/]action-records[\\/]/.test(String(args[0])))probe.reads++;
    return actual.readFile(...args);
  },rename:async(...args:Parameters<typeof actual.rename>)=>{
    if(probe.failArchive&&String(args[1]).includes('action-record-archives'))throw Error('archive failure');
    if(probe.failSnapshot&&String(args[1]).endsWith('actions.json'))throw Error('snapshot failure');
    return actual.rename(...args);
  }};
});
import {ActionLedger} from '../src/core/ledger.ts';
const dirs:string[]=[];
async function fixture(){const d=await mkdtemp(join(tmpdir(),'stage-checkpoint-'));dirs.push(d);return d;}
afterEach(async()=>{probe.reads=0;probe.failArchive=false;probe.failSnapshot=false;for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
it('reads legacy receipts once, retains them and restores only subsequent deltas',async()=>{
 const d=await fixture();await mkdir(join(d,'action-records'));
 const rows=Array.from({length:48},(_,i)=>({id:'old-'+i,requestId:'request-'+i,key:'key',kind:'speech',avatarId:null,status:'completed',createdAt:i,updatedAt:i,command:{text:'old'}}));
 await writeFile(join(d,'actions.json'),JSON.stringify(rows));
 for(const r of rows)await writeFile(join(d,'action-records',createHash('sha256').update(r.id).digest('hex')+'.json'),JSON.stringify(r));
 const first=new ActionLedger(d);await first.start();expect(probe.reads).toBe(48);
 const archives=await readdir(join(d,'action-record-archives'));expect(archives).toHaveLength(1);
 expect(await readdir(join(d,'action-record-archives',archives[0]))).toHaveLength(48);
 expect(await readdir(join(d,'action-records'))).toEqual([]);
 const fresh=await first.submit('fresh','speech',null,{text:'fresh'});await first.update(fresh.record.id,'completed',{device:'ended'});
 probe.reads=0;const second=new ActionLedger(d);await second.start();expect(probe.reads).toBe(1);
 expect(second.actions.size).toBe(49);expect(second.result(fresh.record.id).evidence).toEqual({device:'ended'});
 expect((await second.submit('fresh','speech',null,{text:'fresh'})).reused).toBe(true);
 await second.close();probe.reads=0;const third=new ActionLedger(d);await third.start();expect(probe.reads).toBe(0);expect(third.actions.size).toBe(49);
});
it.each(['snapshot','archive'])('recovers from a failed %s checkpoint without replay or loss',async where=>{
 const d=await fixture(),first=new ActionLedger(d);await first.start();
 const fresh=await first.submit('fresh','speech',null,{});await first.update(fresh.record.id,'completed',{device:'ended'});
 probe.failSnapshot=where==='snapshot';probe.failArchive=where==='archive';
 await expect(first.close()).rejects.toThrow('failure');
 expect(await readdir(join(d,'action-records'))).toHaveLength(1);
 probe.failSnapshot=false;probe.failArchive=false;
 const second=new ActionLedger(d);await second.start();expect(second.result(fresh.record.id)).toMatchObject({status:'completed',evidence:{device:'ended'}});
});
it('does not accept a missing checkpoint after receipt rotation as an empty history',async()=>{
 const d=await fixture(),first=new ActionLedger(d);await first.start();await first.submit('pending','speech',null,{});await first.close();
 await rm(join(d,'actions.json'));
 await expect(new ActionLedger(d).start()).rejects.toThrow('checkpoint missing');
});
it('recovers after rotation and before recreation of the active receipt folder',async()=>{
 const d=await fixture(),first=new ActionLedger(d);await first.start();const r=await first.submit('pending','speech',null,{});await first.close();
 await rm(join(d,'action-records'),{recursive:true});
 const second=new ActionLedger(d);await second.start();expect(second.result(r.record.id).status).toBe('failed');
 expect(second.result(r.record.id).evidence?.reason).toContain('not replayed');
});
