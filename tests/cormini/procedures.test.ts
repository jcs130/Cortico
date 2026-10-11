import {describe, expect, it} from 'vitest';
import {PROCEDURE_RECEIPT_MIME, PROCEDURE_RECEIPT_SCHEMA} from '../../src/protocol/procedure.ts';
import {procedureMemoryFixture} from './procedure-memory-fixture.ts';

describe('procedural Memory evidence',()=>{
  it('rejects unmanaged overwrites, stale candidate saves and invented or lost evidence',async()=>{
    const f=procedureMemoryFixture();
    const args={id:'constructor',adapter:'document-edit/v1',description:'Return observed document contents',conditions:[],code:'return 1;',base:null};
    const candidate=await f.call('procedure_save',args);
    expect((await f.call('procedure_find',{id:'constructor'})).version.revision).toBe(candidate.revision);
    expect(await f.raw('procedure_save',args)).toMatchObject({failed:true,text:expect.stringContaining('changed')});
    for(const path of ['procedures/index.json','./procedures/index.json','drafts/../procedures/index.json','PROCEDURES/index.json']){
      expect(String(await f.raw('write_file',{path,content:'{}'}))).toContain('方法管理器');
      expect(String(await f.raw('append_file',{path,content:'fake'}))).toContain('方法管理器');
    }
    expect(await f.raw('procedure_review',{id:'constructor',revision:candidate.revision,execution:'00000000-0000-0000-0000-000000000001',
      outcome:'achieved',assessment:'Invented',context:'No execution'})).toMatchObject({failed:true});
    expect((await f.call('procedure_find',{query:'document',adapter:'document-edit/v1'})).entries).toHaveLength(1);
    const receipt={schema:PROCEDURE_RECEIPT_SCHEMA,executionId:'00000000-0000-0000-0000-000000000002',root:{handle:candidate.handle,revision:candidate.revision},
      adapter:'document-edit/v1',mode:'execution',status:'completed',startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),invocations:[],trace:[],result:{contents:'observed'}};
    const event=f.persist({source:'document',type:'document.method',ts:new Date().toISOString(),text:'Fixture observed document run',
      meta:{procedureReceipt:receipt},blobs:[{bytes:Buffer.from(JSON.stringify(receipt)),mime:PROCEDURE_RECEIPT_MIME,fallbackText:'receipt'}]});
    const reviewed=await f.call('procedure_review',{id:'constructor',revision:candidate.revision,execution:receipt.executionId,
      outcome:'achieved',assessment:'Read observed contents',context:'Document fixture; one sample'});
    f.logs.clear();
    expect(await f.raw('procedure_adopt',{id:'constructor',revision:candidate.revision,review:reviewed.id,expectedAdopted:null,reason:'missing receipt'}))
      .toMatchObject({failed:true,text:expect.stringContaining('unverified')});
    expect((await f.call('procedure_find',{id:'constructor',execution:receipt.executionId})).unverified).toContain('unavailable');
    expect(event.blobs![0].handle.startsWith('log:')).toBe(true);
  });
});
