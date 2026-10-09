import { afterEach, describe, expect, it } from 'vitest';
import { methodHarness, methodEnded } from './method-harness.ts';

const rigs: ReturnType<typeof methodHarness>[] = [];
afterEach(() => rigs.splice(0).forEach(rig => rig.close()));
const rig = () => { const r = methodHarness(); rigs.push(r); return r; };

describe('JavaScript methods through the Minecraft executor', () => {
  it('gets a real failed postcondition, then branches into a different route and measures progress', async () => {
    const r = rig();
    r.set(0, 64, -1, 'stone'); r.set(0, 65, -1, 'stone');
    const run = r.runner.start({ name: 'alternate route', code: `
      const before = await mc.state();
      const first = await mc.do([{skill:'control',keys:['forward'],durationMs:500,
        expect:{near:[0,64,-2],within:1}}]);
      if (first.done) throw new Error('wall unexpectedly passed');
      const second = await mc.do([{skill:'control',keys:['forward'],durationMs:500,yawDeg:180,
        expect:{near:[0,64,2],within:1}}]);
      return { before:before.snapshot.position, first, second };` });
    const ended = await methodEnded(r, run.id);
    expect(ended.status).toBe('completed');
    expect(ended.result).toMatchObject({ before: { z: 0.5 },
      first: { accepted: true, done: false, kind: 'blocked', taskId: 1, steps: [{ outcome: 'fail' }] },
      second: { accepted: true, done: true, kind: 'done', taskId: 2, steps: [{ outcome: 'ok' }] } });
    expect(r.bot.entity.position.z).toBeGreaterThan(1.5);
    expect(Object.values(r.keys).some(Boolean)).toBe(false);
    expect(r.host.events.some(event => event.type === 'minecraft.method')).toBe(true);
  });

  it('applies normal admission rules and waits for actual command execution', async () => {
    const r = rig();
    const run = r.runner.start({ name: 'admission', code: `
      const missing = await mc.do([{skill:'equip',item:'diamond_sword',to:'hand'}]);
      const message = await mc.do([{skill:'chat',text:'/test method'}]);
      return {missing,message};` });
    const ended = await methodEnded(r, run.id);
    expect(ended.result).toMatchObject({ missing: { accepted: true, done: false, kind: 'blocked' },
      message: { accepted: true, done: true, kind: 'done' } });
    expect(r.said).toEqual(['/test method']);
  });

  it('prepares then executes cast, diagonal flight and targeted teleport in one dependent action group', async () => {
    const r = rig();
    const originalChat = r.bot.chat;
    r.bot.chat = (text: string) => {
      originalChat(text);
      if (text === '/test flight') r.bot._client.emit('abilities', { flags: 4, flyingSpeed: 0.05 });
      if (text === '/test blink 4 64 0') setTimeout(() => r.bot.entity.position.set(4.5, 64, 0.5), 50);
    };
    const run = r.runner.start({ name: 'combination', code: `
      const plan = await mc.flightPlan({points:[{at:[2,66,0],land:false}],budgetMs:5000});
      if (!plan.complete || !plan.steps) throw new Error(plan.reason || 'route unverified');
      const flight = plan.steps.map(step=>({...step,needs:step.needs ? step.needs.map(n=>n+1) : [1]}));
      const result = await mc.do([{skill:'chat',text:params.cast},...flight,
        {skill:'server_travel',command:params.blink,at:[4,64,0],within:1,needs:[flight.length+1]}]);
      return {done:result.done,kind:result.kind,position:result.state.snapshot.position};`,
      params: { cast: '/test flight', blink: '/test blink 4 64 0' } });
    const ended = await methodEnded(r, run.id);
    expect(ended).toMatchObject({ status: 'completed', result: { done: true, kind: 'done', position: { x: 4.5, y: 64 } } });
    expect(ended.trace.map(trace => trace.method)).toEqual(['flightPlan', 'do']);
    expect(r.said).toEqual(['/test flight', '/test blink 4 64 0']);
  });

  it('cancels only its owned task and releases keys while unrelated pending work still executes', async () => {
    const r = rig();
    const run = r.runner.start({ name: 'cancel', code: `await mc.do([{skill:'control',keys:['forward'],durationMs:2000}]);` });
    while (!r.keys.forward) await new Promise(resolve => setTimeout(resolve, 10));
    r.exec.submit([{ skill: 'chat', text: 'other work' }], 'append');
    r.runner.stop('new goal');
    expect((await methodEnded(r, run.id)).status).toBe('cancelled');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(r.keys.forward).toBe(false);
    expect(r.said).toEqual(['other work']);
    expect(r.exec.status().hold).toBeNull();
  });

  it('revokes a program when a new body task is admitted through the public tool', async () => {
    const r = rig();
    const run = r.runner.start({ name: 'old goal', code: `await mc.do([{skill:'control',keys:['forward'],durationMs:2000}]);` });
    while (!r.keys.forward) await new Promise(resolve => setTimeout(resolve, 10));
    const tool = r.world.tools().find(tool => tool.name === 'mc_do')!;
    await tool.handler({ steps: [{ skill: 'chat', text: 'new task' }], queue: 'append' }, {} as never);
    expect((await methodEnded(r, run.id)).status).toBe('cancelled');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(r.said).toEqual(['new task']);
    expect(r.keys.forward).toBe(false);
  });

  it('keeps environmental rescue holds when cancelling a suspended program', async () => {
    const r = rig();
    const run = r.runner.start({ name: 'suspended', code: `await mc.do([{skill:'control',keys:['forward'],durationMs:2000}]);` });
    while (!r.keys.forward) await new Promise(resolve => setTimeout(resolve, 10));
    const token = r.exec.pauseForEnvironment('test rescue');
    expect(r.runner.read(run.id)[0].status).toBe('running');
    r.exec.submit([{ skill: 'chat', text: 'after rescue' }], 'append');
    r.runner.stop('revoked');
    expect((await methodEnded(r, run.id)).status).toBe('cancelled');
    expect(r.exec.status().hold).toContain('test rescue');
    expect(r.said).toEqual([]);
    r.exec.resumeAfterEnvironment(token);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(r.said).toEqual(['after rescue']);
    expect(r.keys.forward).toBe(false);
  });
});
