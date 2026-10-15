import {randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {PROCEDURE_RECEIPT_MIME, PROCEDURE_RECEIPT_SCHEMA, resolveProcedure,
  type ProcedureInvocation, type ProcedureReceipt, type ProcedureReference} from '../../src/protocol/procedure.ts';
import {procedureMemoryFixture} from './procedure-memory-fixture.ts';

/** Real SES composition and file effects, with an adapter-owned receipt delivered to the Persona. */
export function documentProcedureFixture() {
  const f=procedureMemoryFixture(),file=join(f.dir,'document.txt');
  writeFileSync(file,'white cat');
  const save=(id:string,code:string,base:string|null,dependencies={})=>f.call('procedure_save',{
    id,adapter:'document-edit/v1',description:'Replace an exact observed document phrase; return before/after text',
    conditions:['Single local UTF-8 text fixture; exact-match replacement only'],code,base,dependencies});
  const run=async(root:ProcedureReference,validate=false):Promise<ProcedureReceipt>=>{
    const startedAt=new Date().toISOString(),trace:unknown[]=[],invocations=new Map<number,ProcedureInvocation>();
    const worker=new Worker(new URL('../protocol/fixtures/procedure-worker.mjs',import.meta.url),
      {workerData:{graph:resolveProcedure(root,'document-edit/v1',f.api.blob),params:{before:'white',after:'orange'},validate}});
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
        const call:{method:string;procedure:unknown;startedAt:string;endedAt?:string;result?:unknown;error?:string}=
          {method:message.method,procedure:message.scope,startedAt:new Date().toISOString()};
        try{
          const before=readFileSync(file,'utf8');
          if(message.method==='read')call.result=before;
          else if(message.method==='replace'){
            writeFileSync(file,before.replace(message.args[0],message.args[1]));
            call.result={before,after:readFileSync(file,'utf8')};
          }else throw new Error('unsupported document capability');
          call.endedAt=new Date().toISOString();trace.push(call);
          worker.postMessage({id:message.id,result:call.result});
        }catch(error){call.error=String(error);trace.push(call);worker.postMessage({id:message.id,error:call.error});}
      });
    }).finally(()=>worker.terminate());
    const receipt:ProcedureReceipt={schema:PROCEDURE_RECEIPT_SCHEMA,executionId:randomUUID(),root,adapter:'document-edit/v1',
      mode:validate?'validation':'execution',status:terminal.error?'failed':validate?'validated':'completed',
      startedAt,endedAt:new Date().toISOString(),invocations:[...invocations.values()],trace,...terminal};
    f.persist({source:'document',type:'document.method',ts:receipt.endedAt,text:'Observed fixture document execution',
      meta:{procedureReceipt:receipt},blobs:[{bytes:Buffer.from(JSON.stringify(receipt)),mime:PROCEDURE_RECEIPT_MIME,fallbackText:'document receipt'}]});
    return receipt;
  };
  return {...f,file,save,run};
}
