import { afterEach, describe, expect, it } from 'vitest';
import { MethodRunner, METHOD_LIMITS, type MethodHost, type MethodRun } from '../../../src/worlds/minecraft/method-runner.ts';

const runners: MethodRunner[] = [];
afterEach(() => runners.splice(0).forEach(runner => runner.stop('测试结束')));

function rig(call: MethodHost['call'] = () => ({ observed: true })) {
  let finish!: (run: MethodRun) => void;
  const ended = new Promise<MethodRun>(resolve => { finish = resolve; });
  const runner = new MethodRunner({ call, onFinish: finish });
  runners.push(runner);
  return { runner, ended };
}

describe('agent-authored JavaScript methods', () => {
  it('branches on awaited World results and retains source identity and both results', async () => {
    let attempt = 0;
    const r = rig((method, args) => method === 'state' ? { y: 64 }
      : { done: ++attempt === 2, taskId: attempt, kind: attempt === 1 ? 'blocked' : 'done', target: args.steps });
    const code = `const before = await mc.state();
      let result = await mc.do([{skill:'flight',at:[0,before.y+2,0]}]);
      if (!result.done) result = await mc.do([{skill:'control',keys:['forward','jump'],durationMs:500}]);
      return { before, result, label: params.label };`;
    const accepted = r.runner.start({ name: 'route', code, params: { label: 'trial' } });
    expect(accepted.status).toBe('running');
    const run = await r.ended;
    expect(run).toMatchObject({ status: 'completed', sourceHash: accepted.sourceHash,
      result: { before: { y: 64 }, result: { done: true, taskId: 2 }, label: 'trial' } });
    expect(run.trace.map(trace => trace.result)).toMatchObject([{ y: 64 }, { kind: 'blocked' }, { kind: 'done' }]);
    expect(run.trace.every(trace => trace.startedAt && trace.endedAt)).toBe(true);
    const read = r.runner.read(run.id);
    read[0].trace.length = 0;
    expect(r.runner.read(run.id)[0].trace).toHaveLength(3);
    expect(r.runner.inspect()).toEqual([expect.objectContaining({ id: run.id, calls: 3 })]);
    expect(JSON.stringify(r.runner.inspect())).not.toContain('target');
    expect(r.runner.inspect(run.id, 2)).toMatchObject({ trace: { call: 2, result: { kind: 'blocked' } } });
    expect(() => r.runner.inspect(999)).toThrow('不在本次进程');
  });

  it('validates syntax without running even valid action code', async () => {
    const r = rig(() => { throw new Error('must not execute'); });
    r.runner.start({ name: 'draft', code: 'await mc.do([{skill:"chat",text:"hello"}]);', validate: true });
    expect(await r.ended).toMatchObject({ status: 'validated', trace: [], result: { valid: true } });
    const invalid = rig();
    invalid.runner.start({ name: 'invalid', code: 'const = ;', validate: true });
    expect(await invalid.ended).toMatchObject({ status: 'failed', trace: [] });
    const escaped = rig(() => { throw new Error('validation must not invoke World'); });
    escaped.runner.start({ name: 'escaped body', code: `}); mc.do([]); (async () => {`, validate: true });
    expect(await escaped.ended).toMatchObject({ status: 'failed', trace: [], error: '语法校验不可调用World' });
  });

  it('exposes only the SDK and JSON params, with hardened returned observations', async () => {
    const r = rig();
    r.runner.start({ name: 'capabilities', code: `
      const state = await mc.state(); let mutated = false;
      try { state.observed = false; } catch { mutated = true; }
      let escaped = false;
      try { escaped = !!({}).constructor.constructor('return process')(); } catch {}
      return { unavailable: [typeof process,typeof require,typeof fetch,typeof bot,typeof Worker],
        escaped, mutated, observed: state.observed };` });
    expect((await r.ended).result).toEqual({ unavailable: Array(5).fill('undefined'), escaped: false, mutated: true, observed: true });
  });

  it('terminates CPU loops outside the World thread and revokes the run', async () => {
    const r = rig();
    r.runner.start({ name: 'loop', code: 'while(true) {}', durationMs: 1000 });
    expect(await r.ended).toMatchObject({ status: 'failed', error: expect.stringContaining('超过1000毫秒') });
    expect(r.runner.stop()).toBe(false);
  });

  it('bounds calls and rejects concurrent or unawaited World actions', async () => {
    const quota = rig();
    quota.runner.start({ name: 'quota', code: `for(let i=0;i<${METHOD_LIMITS.calls + 1};i++) await mc.state();` });
    expect(await quota.ended).toMatchObject({ status: 'failed', trace: expect.any(Array) });
    expect(quota.runner.read()[0].trace).toHaveLength(METHOD_LIMITS.calls);
    for (const code of ['mc.do([]); return 1;', 'await Promise.all([mc.do([]),mc.do([])]);']) {
      const concurrent = rig((_method, _args, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve(null))));
      concurrent.runner.start({ name: 'unawaited', code });
      expect(await concurrent.ended).toMatchObject({ status: 'failed' });
    }
  });

  it('returns exceptions for agent repair and revokes outstanding calls on cancellation', async () => {
    const exception = rig(() => { throw new Error('actual contract rejected'); });
    exception.runner.start({ name: 'repair', code: `try { await mc.flightPlan({points:[]}); }
      catch(error) { return { reason:error.message, verified:false }; }` });
    expect((await exception.ended).result).toMatchObject({ reason: 'Error: actual contract rejected', verified: false });
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { entered = resolve; });
    let revoked = false;
    const cancel = rig((_method, _args, signal) => {
      entered(); return new Promise(resolve => signal.addEventListener('abort', () => { revoked = true; resolve(null); }));
    });
    cancel.runner.start({ name: 'cancel', code: 'await mc.do([]);' });
    await gate;
    expect(() => cancel.runner.start({ name: 'other', code: 'return 1;' })).toThrow('仍在运行');
    cancel.runner.stop('外部新目标');
    expect(await cancel.ended).toMatchObject({ status: 'cancelled', error: '外部新目标' });
    expect(revoked).toBe(true);
  });
});
