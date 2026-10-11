import 'ses';
import {parentPort, workerData} from 'node:worker_threads';
import {procedureProgram} from '../../../src/protocol/procedure-program.mjs';

lockdown();
let serial=0;
const pending=new Map();
parentPort.on('message',message=>{
  const request=pending.get(message.id);
  if(!request)return;
  pending.delete(message.id);
  message.error?request.reject(new Error(message.error)):request.resolve(harden(message.result));
});
const rpc=(scope,method,args)=>new Promise((resolve,reject)=>{
  const id=++serial;pending.set(id,{resolve,reject});parentPort.postMessage({kind:'rpc',id,scope,method,args});
});
try{
  const program=procedureProgram(workerData.graph,{
    maxInvocations:32,
    onInvocation:event=>parentPort.postMessage({kind:'invocation',event}),
    capabilities:scope=>({document:harden({read:()=>rpc(scope,'read',[]),replace:(before,after)=>rpc(scope,'replace',[before,after])})}),
  });
  const result=await program.run(workerData.params);
  parentPort.postMessage({kind:'done',result});
}catch(error){parentPort.postMessage({kind:'done',error:String(error)});}
