import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach} from 'vitest';
import {CortiV} from '../../bots/cortiv/persona/persona.ts';
import {GitWorkspaceMemory} from '../../bots/cormini/persona/memory.ts';
import {LogBlobStore} from '../../src/core/blobs.ts';
import {JsonlEventStore} from '../../src/core/event-store.ts';
import type {WorldHost} from '../../src/core/types.ts';
import {makeFakeHarnessApi} from '../core/helpers.ts';

const dirs: string[]=[];
afterEach(()=>dirs.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true})));
export function procedureMemoryFixture() {
  const dir=mkdtempSync(join(tmpdir(),'procedure-memory-')); dirs.push(dir);
  const memoryDir=join(dir,'workspace'), memory=new GitWorkspaceMemory({memoryDir});
  const logs=new LogBlobStore(join(dir,'data'));
  const events=new JsonlEventStore({dataDir:join(dir,'data'),run:'fixture-run'});
  const api=makeFakeHarnessApi({blob:handle=>logs.read(handle)??memory.blobs.get(handle)});
  const persona=new CortiV({memoryDir});persona.attach(api);
  const tools=persona.declareSessions().find(s=>s.id==='main')!.tools();
  let serial=0;
  const raw=(name:string,args:Record<string,unknown>)=>tools.find(t=>t.name===name)!.handler(args,
    {role:'main',callId:`fixture-call-${++serial}`,log:api.log});
  const call=async(name:string,args:Record<string,unknown>)=>{
    const result=await raw(name,args);
    if(typeof result!=='string') throw new Error(result.text);
    return JSON.parse(result.slice(result.indexOf('{'))) as any;
  };
  const persist=(input:Parameters<WorldHost['pushEvent']>[0])=>{
    const {blobs,...e}=input;
    const refs=blobs?.map(b=>'bytes' in b?{handle:logs.put(b.bytes,b.mime),mime:b.mime,name:b.name,fallbackText:b.fallbackText}
      :{...b,mime:logs.read(b.handle)?.mime??'application/octet-stream'});
    const event=events.append({...e,origin:e.origin??'external',blobs:refs});
    persona.onDelivery({events:[event]});return event;
  };
  return {dir,memoryDir,memory,logs,events,api,persona,tools,raw,call,persist};
}
