import {readFileSync, writeFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {CortiV} from '../../bots/cortiv/persona/persona.ts';
import {documentProcedureFixture} from './document-procedure-fixture.ts';

describe('portable procedural execution and adoption',()=>{
  it('executes a non-game adapter, restores the preferred version and explicitly rolls back after a comparable revision',async()=>{
    const f=documentProcedureFixture();
    const {file,save,run}=f;
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
