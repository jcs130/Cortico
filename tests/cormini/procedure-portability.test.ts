import {randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {describe, expect, it} from 'vitest';
import {CortiV} from '../../bots/cortiv/persona/persona.ts';
import {PROCEDURE_RECEIPT_MIME, PROCEDURE_RECEIPT_SCHEMA, resolveProcedure, type ProcedureReceipt} from '../../src/protocol/procedure.ts';
import {procedureMemoryFixture} from './procedure-memory-fixture.ts';

describe('portable procedural execution and adoption',()=>{
  it('executes a non-game adapter, restores the preferred version and explicitly rolls back after a comparable revision',async()=>{
    const f=procedureMemoryFixture(),file=join(f.dir,'document.txt');
    writeFileSync(file,'white cat');
    const save=(id:string,code:string,base:string|null,dependencies={})=>f.call('procedure_save',{
      id,adapter:'document-edit/v1',description:'Replace an exact observed document phrase; return before/after text',
      conditions:['Single local UTF-8 text fixture; exact-match replacement only'],code,base,dependencies});
    const run=async(root:{handle:string;revision:string})=>{
      const startedAt=new Date().toISOString(),trace:unknown[]=[],invocations=new Map<number,any>();
      const worker=new Worker(new URL('../protocol/fixtures/procedure-worker.mjs',import.meta.url),
        {workerData:{graph:resolveProcedure(root,'document-edit/v1',f.api.blob),params:{before:'white',after:'orange'}}});
      const terminal=await new Promise<{result?:unknown;error?:string}>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('procedure fixture timed out')),5000);
        worker.on('error',error=>{clearTimeout(timer);reject(error);});
        worker.on('message',message=>{
          if(message.kind==='done'){clearTimeout(timer);resolve(message);return;}
          if(message.kind==='invocation'){
            const previous=invocations.get(message.event.invocation);
            invocations.set(message.event.invocation,{...previous,...message.event,
              startedAt:previous?.startedAt??new Date().toISOString(),...(message.event.status!=='running'?{endedAt:new Date().toISOString()}:{})});
            return;
          }
          if(message.kind!=='rpc')return;
          const call:any={method:message.method,procedure:message.scope,startedAt:new Date().toISOString()};
          try{
            const before=readFileSync(file,'utf8');
            if(message.method==='read')call.result=before;
            else if(message.method==='replace'){
              const after=before.replace(message.args[0],message.args[1]);
              writeFileSync(file,after);call.result={before,after:readFileSync(file,'utf8')};
            }else throw new Error('unsupported document capability');
            call.endedAt=new Date().toISOString();trace.push(call);
            worker.postMessage({id:message.id,result:call.result});
          }catch(error){call.error=String(error);trace.push(call);worker.postMessage({id:message.id,error:call.error});}
        });
      }).finally(()=>worker.terminate());
      const receipt:ProcedureReceipt={schema:PROCEDURE_RECEIPT_SCHEMA,executionId:randomUUID(),root,adapter:'document-edit/v1',
        mode:'execution',status:terminal.error?'failed':'completed',startedAt,endedAt:new Date().toISOString(),
        invocations:[...invocations.values()],trace,...terminal};
      f.persist({source:'document',type:'document.method',ts:receipt.endedAt,text:'Observed fixture document execution',
        meta:{procedureReceipt:receipt},blobs:[{bytes:Buffer.from(JSON.stringify(receipt)),mime:PROCEDURE_RECEIPT_MIME,fallbackText:'document receipt'}]});
      return receipt;
    };
    const child=await save('replace-phrase','const before=await document.read();const edit=await document.replace(params.before,params.after);return {before,edit,after:await document.read()};',null);
    const first=await save('document-change',"return await methods.run('edit',params);",null,{edit:{handle:child.handle,revision:child.revision}});
    const result=await run(first);
    expect(result.status).toBe('completed');
    expect(readFileSync(file,'utf8')).toBe('orange cat');
    expect(result.trace).toHaveLength(3);
    expect(result.invocations.map(i=>i.status)).toEqual(['completed','completed']);
    const assessed=await f.call('procedure_review',{id:'document-change',revision:first.revision,execution:result.executionId,
      outcome:'achieved',assessment:'Actual file changed from white cat to orange cat; exact replacement observed',
      context:'One local text fixture; does not validate arbitrary document formats',measurements:{'edits-count':1}});
    await f.call('procedure_adopt',{id:'document-change',revision:first.revision,review:assessed.id,expectedAdopted:null,reason:'Observed exact replacement'});
    const second=await save('document-change',"const result=await methods.run('edit',params);return {result,version:2};",first.revision,
      {edit:{handle:child.handle,revision:child.revision}});
    writeFileSync(file,'white cat');
    const secondResult=await run(second);
    expect(readFileSync(file,'utf8')).toBe('orange cat');
    const secondReview=await f.call('procedure_review',{id:'document-change',revision:second.revision,execution:secondResult.executionId,
      outcome:'achieved',assessment:'Same exact replacement with extra return metadata; no measured speed improvement',
      context:'Same reset fixture; two deterministic test samples',comparison:assessed.id});
    await f.call('procedure_adopt',{id:'document-change',revision:second.revision,review:secondReview.id,expectedAdopted:first.revision,reason:'Observed metadata contract'});
    const rollback=await f.call('procedure_adopt',{id:'document-change',revision:first.revision,review:assessed.id,expectedAdopted:second.revision,reason:'Restore simpler observed return contract'});
    expect(rollback.previous).toBe(second.revision);
    const restored=new CortiV({memoryDir:f.memoryDir});restored.attach(f.api);
    const tool=restored.declareSessions().find(s=>s.id==='main')!.tools().find(t=>t.name==='procedure_find')!;
    const selected=JSON.parse(String(await tool.handler({id:'document-change'},{role:'main',log:f.api.log})));
    expect(selected.version.revision).toBe(first.revision);
    expect(selected.version.dependencies.edit.revision).toBe(child.revision);
    writeFileSync(file,'white cat');
    expect((await run({handle:selected.handle,revision:selected.version.revision})).status).toBe('completed');
    expect(readFileSync(file,'utf8')).toBe('orange cat');
  });
});
