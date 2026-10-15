import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {CortiV} from '../../bots/cortiv/persona/persona.ts';
import {documentProcedureFixture} from '../cormini/document-procedure-fixture.ts';

describe('procedural learning evidence',()=>{
  it('keeps failed assumptions, adopts only assessed executions, pins compositions and restores versions after restart',async()=>{
    const f=documentProcedureFixture();
    const code=`const before=await document.read();const edit=await document.replace('pink',params.after);
      return {before,edit,after:await document.read()};`;
    const child=await f.save('replace-phrase',code,null);
    const parentCode=`return await methods.run('edit',params);`;
    const parent=await f.save('document-change',parentCode,null,{edit:{handle:child.handle,revision:child.revision}});
    const draft=await f.call('procedure_find',{id:'document-change'});
    expect(draft.evidence).toEqual([]);
    expect(draft.version.author).toMatchObject({kind:'agent',role:'main',callId:expect.any(String)});
    const validated=await f.run(parent,true);
    expect(validated.status).toBe('validated');
    expect(validated.trace).toEqual([]);
    expect(readFileSync(f.file,'utf8')).toBe('white cat');
    expect(await f.raw('procedure_review',{id:'document-change',revision:parent.revision,execution:validated.executionId,
      outcome:'achieved',assessment:'Syntax only',context:'Offline'})).toMatchObject({failed:true,text:expect.stringContaining('validation')});
    const first=await f.run(parent);
    expect(first.status).toBe('completed');
    expect(first.result).toMatchObject({before:'white cat',after:'white cat'});
    const review=await f.call('procedure_review',{id:'document-change',revision:parent.revision,execution:first.executionId,
      outcome:'not-achieved',assessment:'The requested phrase was absent; actual document stayed unchanged',
      context:'Observed white cat; incorrectly assumed pink',measurements:{'edits-count':0}});
    expect(await f.raw('procedure_adopt',{id:'document-change',revision:parent.revision,review:review.id,expectedAdopted:null,reason:'trial'}))
      .toMatchObject({failed:true});
    const repaired=await f.save('replace-phrase',code.replace("'pink'","params.before"),child.revision);
    expect((await f.call('procedure_find',{id:'document-change'})).version.dependencies.edit.revision).toBe(child.revision);
    const revised=await f.save('document-change',parentCode,parent.revision,{edit:{handle:repaired.handle,revision:repaired.revision}});
    const second=await f.run(revised);
    expect(second.result).toMatchObject({before:'white cat',after:'orange cat'});
    expect(readFileSync(f.file,'utf8')).toBe('orange cat');
    const assessed=await f.call('procedure_review',{id:'document-change',revision:revised.revision,execution:second.executionId,
      outcome:'achieved',assessment:'Used the observed phrase and read back the changed file',
      context:'Same local UTF-8 fixture; this sample verifies the exact replacement only',comparison:review.id,measurements:{'edits-count':1}});
    const adopted=await f.call('procedure_adopt',{id:'document-change',revision:revised.revision,review:assessed.id,expectedAdopted:null,reason:'Observed exact replacement'});
    expect(adopted.previous).toBeNull();
    expect(await f.raw('procedure_adopt',{id:'document-change',revision:revised.revision,review:assessed.id,expectedAdopted:null,reason:'stale selection'}))
      .toMatchObject({failed:true,text:expect.stringContaining('changed')});
    const detail=await f.call('procedure_find',{id:'document-change',execution:second.executionId,call:2});
    expect(detail.trace).toMatchObject({method:'replace',result:{before:'white cat',after:'orange cat'}});
    expect((await f.call('procedure_find',{id:'document-change',review:review.id})).outcome).toBe('not-achieved');
    const restored=new CortiV({memoryDir:f.memoryDir});restored.attach(f.api);
    const lookup=restored.declareSessions().find(s=>s.id==='main')!.tools().find(t=>t.name==='procedure_find')!;
    const found=JSON.parse(String(await lookup.handler({id:'document-change'},{role:'main',log:f.api.log})));
    expect(found.entry.adopted).toBe(revised.revision);
    expect(found.version.dependencies.edit.revision).toBe(repaired.revision);
    expect(found.evidence).toHaveLength(1);
    const committedIndex=JSON.parse(execFileSync('git',['show','HEAD:procedures/index.json'],{cwd:f.memoryDir,encoding:'utf8'}));
    expect(committedIndex['document-change'].adopted).toBe(revised.revision);
    const observed=JSON.parse(readFileSync(join(f.memoryDir,found.evidence[0]),'utf8'));
    expect(observed.event).toMatchObject({source:'document',run:'fixture-run',cursor:expect.any(Number)});
    expect(observed.receiptHash).toBe(createHash('sha256').update(f.api.blob(observed.receipt)!.bytes).digest('hex'));
  });
});
