import {it,expect} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ActionLedger} from '../src/core/ledger.ts';

it('persists a new completed receipt without rewriting historical actions and recovers without clean shutdown',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stage-incremental-'));
 try{
  const old=Array.from({length:1000},(_,i)=>({id:'old-'+i,requestId:'old-request-'+i,key:'old',kind:'speech',avatarId:null,
   status:'completed',createdAt:i,updatedAt:i,command:{text:'old text'}}));
  await writeFile(join(dir,'actions.json'),JSON.stringify(old));
  const ledger=new ActionLedger(dir);await ledger.start();
  const before=await readFile(join(dir,'actions.json'),'utf8');
  const {record}=await ledger.submit('new-request','speech',null,{text:'new text'});
  await ledger.update(record.id,'completed',{device:'real ended'});
  expect(await readFile(join(dir,'actions.json'),'utf8')).toBe(before);
  const restarted=new ActionLedger(dir);await restarted.start();
  expect(restarted.actions.size).toBe(1001);
  expect(restarted.result(record.id)).toMatchObject({status:'completed',evidence:{device:'real ended'}});
  expect((await restarted.submit('new-request','speech',null,{text:'new text'})).reused).toBe(true);
  await restarted.close();
  expect(JSON.parse(await readFile(join(dir,'actions.json'),'utf8'))).toHaveLength(1001);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('does not resurrect a queued side record after restart or let it overwrite a newer rollback snapshot',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stage-incremental-'));
 try{
  const ledger=new ActionLedger(dir);await ledger.start();
  const {record}=await ledger.submit('pending','speech',null,{text:'do not replay'});
  const restarted=new ActionLedger(dir);await restarted.start();
  expect(restarted.result(record.id).status).toBe('failed');await restarted.close();
  const again=new ActionLedger(dir);await again.start();expect(again.result(record.id).status).toBe('failed');
  await again.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
