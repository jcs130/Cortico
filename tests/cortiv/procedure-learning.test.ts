import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {CortiV} from '../../bots/cortiv/persona/persona.ts';
import type {WorldHost} from '../../src/core/types.ts';
import {methodHarness, methodEnded} from '../worlds/minecraft/method-harness.ts';
import {procedureMemoryFixture} from '../cormini/procedure-memory-fixture.ts';

describe('Minecraft procedural learning evidence',()=>{
  it('keeps failed assumptions, adopts only assessed executions, pins compositions and restores versions after restart',async()=>{
    const f=procedureMemoryFixture(),r=methodHarness();
    r.host.blob=f.api.blob;
    r.host.pushEvent=async e=>{
      const event=f.persist(e as unknown as Parameters<WorldHost['pushEvent']>[0]);r.host.events.push(event);return event;
    };
    const save=(id:string,code:string,base:string|null,dependencies={})=>f.call('procedure_save',{
      id,code,base,dependencies,adapter:'minecraft-method/v1',description:'Reach the requested local tile; returns action and observations',
      conditions:['Offline flat ground; north wall; south clear; inspect fresh results']});
    const run=async(ref:unknown,validate=false)=>{
      const reply=await r.world.tools().find(t=>t.name==='mc_script')!.handler({procedure:ref,params:{target:[0,64,2]},validate},
        {role:'main',callId:'fixture-execution',log:r.host.log});
      expect(typeof reply).toBe('string');return methodEnded(r,r.runner.read().at(-1)!.id);
    };
    try{
      r.set(0,64,-1,'stone');r.set(0,65,-1,'stone');
      const code=`const before=await mc.state();const action=await mc.do([{skill:'control',keys:['forward'],durationMs:500,
        yawDeg:0,expect:{near:params.target,within:1}}]);return {before:before.snapshot.position,action,after:action.state.snapshot.position};`;
      const child=await save('local-step',code,null);
      const parentCode=`return await methods.run('step',params);`;
      const parent=await save('local-route',parentCode,null,{step:{handle:child.handle,revision:child.revision}});
      const draft=await f.call('procedure_find',{id:'local-route'});
      expect(draft.evidence).toEqual([]);
      expect(draft.version.author).toMatchObject({kind:'agent',role:'main',callId:expect.any(String)});
      const validated=await run({handle:parent.handle,revision:parent.revision},true);
      expect(validated.status).toBe('validated');
      expect(await f.raw('procedure_review',{id:'local-route',revision:parent.revision,execution:validated.procedure!.executionId,
        outcome:'achieved',assessment:'Syntax only',context:'Offline'})).toMatchObject({failed:true,text:expect.stringContaining('validation')});
      const first=await run({handle:parent.handle,revision:parent.revision});
      expect(first.status).toBe('completed');
      expect(first.result).toMatchObject({action:{done:false,kind:'blocked'}});
      const review=await f.call('procedure_review',{id:'local-route',revision:parent.revision,execution:first.procedure!.executionId,
        outcome:'not-achieved',assessment:'The north wall stopped movement; actual action was blocked',context:'Target south; incorrectly selected north',
        measurements:{'target-reached':0}});
      expect(await f.raw('procedure_adopt',{id:'local-route',revision:parent.revision,review:review.id,expectedAdopted:null,reason:'trial'}))
        .toMatchObject({failed:true});
      const repaired=await save('local-step',code.replace('yawDeg:0','yawDeg:180'),child.revision);
      expect((await f.call('procedure_find',{id:'local-route'})).version.dependencies.step.revision).toBe(child.revision);
      const revised=await save('local-route',parentCode,parent.revision,{step:{handle:repaired.handle,revision:repaired.revision}});
      const second=await run({handle:revised.handle,revision:revised.revision});
      expect(second.result).toMatchObject({action:{done:true,kind:'done'}});
      expect(r.bot.entity.position.z).toBeGreaterThan(1.5);
      const assessed=await f.call('procedure_review',{id:'local-route',revision:revised.revision,execution:second.procedure!.executionId,
        outcome:'achieved',assessment:'Selected the observed clear south direction and reached the requested tile',
        context:'Same fixture north wall; this sample verifies the local repair only',comparison:review.id,measurements:{'target-reached':1}});
      const adopted=await f.call('procedure_adopt',{id:'local-route',revision:revised.revision,review:assessed.id,expectedAdopted:null,reason:'Observed target reached under stated conditions'});
      expect(adopted.previous).toBeNull();
      expect(await f.raw('procedure_adopt',{id:'local-route',revision:revised.revision,review:assessed.id,expectedAdopted:null,reason:'stale selection'}))
        .toMatchObject({failed:true,text:expect.stringContaining('changed')});
      const detail=await f.call('procedure_find',{id:'local-route',execution:second.procedure!.executionId,call:2});
      expect(detail.trace).toMatchObject({method:'do',result:{done:true,taskId:2}});
      const record=await f.call('procedure_find',{id:'local-route',review:review.id});expect(record.outcome).toBe('not-achieved');
      const restored=new CortiV({memoryDir:f.memoryDir});restored.attach(f.api);
      const lookup=restored.declareSessions().find(s=>s.id==='main')!.tools().find(t=>t.name==='procedure_find')!;
      const found=JSON.parse(String(await lookup.handler({id:'local-route'},{role:'main',log:f.api.log})));
      expect(found.entry.adopted).toBe(revised.revision);
      expect(found.version.dependencies.step.revision).toBe(repaired.revision);
      expect(found.evidence).toHaveLength(1);
      const committedIndex=JSON.parse(execFileSync('git',['show','HEAD:procedures/index.json'],{cwd:f.memoryDir,encoding:'utf8'}));
      expect(committedIndex['local-route'].adopted).toBe(revised.revision);
      const observed=JSON.parse(readFileSync(join(f.memoryDir,found.evidence[0]),'utf8'));
      expect(observed.event).toMatchObject({source:'minecraft',run:'fixture-run',cursor:expect.any(Number)});
      expect(observed.receiptHash).toBe(createHash('sha256').update(f.api.blob(observed.receipt)!.bytes).digest('hex'));
    }finally{r.close();}
  });

});
