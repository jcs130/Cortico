import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
const probe=vi.hoisted(()=>({gate:false,active:0,peak:0,releases:[] as (()=>void)[]}));
vi.mock('node:fs/promises',async original=>{
  const actual=await original<typeof import('node:fs/promises')>();
  return {...actual,readFile:async(...args:Parameters<typeof actual.readFile>)=>{
    if(!probe.gate||!String(args[0]).includes('action-records'))return actual.readFile(...args);
    probe.active++;probe.peak=Math.max(probe.peak,probe.active);
    try{await new Promise<void>(done=>probe.releases.push(done));return await actual.readFile(...args);}
    finally{probe.active--;}
  }};
});
import {ActionLedger} from '../src/core/ledger.ts';
import type {ActionRecord} from '../src/core/types.ts';
const dirs:string[]=[];
const record=(i:number,patch:Partial<ActionRecord>={}):ActionRecord=>({id:'record-'+i,requestId:'request-'+i,key:'key-'+i,kind:'speech',avatarId:null,status:'completed',createdAt:i,updatedAt:i,command:{text:'receipt '+i},...patch});
const name=(id:string)=>createHash('sha256').update(id).digest('hex')+'.json';
async function fixture(rows:ActionRecord[],snapshot:ActionRecord[]=[]){
  const dir=await mkdtemp(join(tmpdir(),'stage-startup-'));dirs.push(dir);
  await mkdir(join(dir,'action-records'));await writeFile(join(dir,'actions.json'),JSON.stringify(snapshot));
  await Promise.all(rows.map(r=>writeFile(join(dir,'action-records',name(r.id)),JSON.stringify(r))));
  return dir;
}
afterEach(async()=>{
  probe.gate=false;for(const done of probe.releases.splice(0))done();probe.active=0;probe.peak=0;
  for(const dir of dirs.splice(0)){expect(resolve(dir).startsWith(resolve(tmpdir())+sep+'stage-startup-')).toBe(true);await rm(dir,{recursive:true,force:true});}
});
it('recovers independent receipts concurrently with a bounded number of open reads',async()=>{
  const dir=await fixture(Array.from({length:40},(_,i)=>record(i))),ledger=new ActionLedger(dir);
  probe.gate=true;const pending=ledger.start();void pending.catch(()=>{});
  try{await vi.waitFor(()=>expect(probe.active).toBeGreaterThan(1),{timeout:600});expect(probe.peak).toBeLessThanOrEqual(8);}
  finally{probe.gate=false;for(const done of probe.releases.splice(0))done();await pending;}
  expect(ledger.actions.size).toBe(40);expect(ledger.result('record-39')).toEqual(record(39));
});
it('keeps the newest snapshot or receipt and preserves restart uncertainty without replay',async()=>{
  const dir=await fixture([record(1,{updatedAt:3}),record(2,{updatedAt:4,status:'playing'}),record(3,{updatedAt:1})],
    [record(1,{updatedAt:2,status:'queued'}),record(3,{updatedAt:5,evidence:{device:'ended'}})]);
  const ledger=new ActionLedger(dir);await ledger.start();
  expect(ledger.actions.size).toBe(3);expect(ledger.result('record-1').status).toBe('completed');
  expect(ledger.result('record-2')).toMatchObject({status:'failed',evidence:{reason:expect.stringContaining('not replayed')}});
  expect(ledger.result('record-3')).toMatchObject({updatedAt:5,evidence:{device:'ended'}});
});
it('fails closed on corrupt identity without writing a partial snapshot',async()=>{
  const original=[record(99)],dir=await fixture(Array.from({length:20},(_,i)=>record(i)),original);
  await writeFile(join(dir,'action-records',name('wrong-name')),JSON.stringify(record(40)));
  const ledger=new ActionLedger(dir);
  await expect(ledger.start()).rejects.toThrow('Action record identity mismatch');
  expect(ledger.actions.size).toBe(0);expect(JSON.parse(await readFile(join(dir,'actions.json'),'utf8'))).toEqual(original);
});
