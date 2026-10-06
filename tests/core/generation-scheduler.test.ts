import { afterEach, describe, expect, it } from 'vitest';
import { GenerationScheduler } from '../../src/core/generation-scheduler.ts';

describe('provider generation scheduling', () => {
  const live: GenerationScheduler[] = [];
  afterEach(() => { for (const scheduler of live.splice(0)) scheduler.stop(); });
  const makeScheduler = (): GenerationScheduler => {
    const scheduler = new GenerationScheduler(); live.push(scheduler); return scheduler;
  };

  it('aborts background generation immediately and holds retries until every foreground lease releases', async () => {
    const scheduler = makeScheduler();
    const background = await scheduler.background('shared', scheduler.signal);
    const finishBatch = scheduler.foreground('shared');
    const finishRequest = scheduler.foreground('shared');
    expect(background.signal.aborted).toBe(true);
    expect(background.yielded()).toBe(true);
    background.release();
    let resumed = false;
    const retry = scheduler.background('shared', scheduler.signal).then(lease => { resumed = true; return lease; });
    finishRequest();
    await Promise.resolve();
    expect(resumed).toBe(false);
    finishBatch();
    (await retry).release();
    expect(resumed).toBe(true);
  });

  it('serializes background requests in arrival order while allowing independent providers', async () => {
    const scheduler = makeScheduler();
    const first = await scheduler.background('shared', scheduler.signal);
    const order: string[] = [];
    const second = scheduler.background('shared', scheduler.signal).then(lease => { order.push('second'); return lease; });
    const third = scheduler.background('shared', scheduler.signal).then(lease => { order.push('third'); return lease; });
    const independent = await scheduler.background('independent', scheduler.signal);
    const foreground = scheduler.foreground('independent');
    expect(first.signal.aborted).toBe(false);
    independent.release(); foreground();
    first.release();
    const secondLease = await second;
    expect(order).toEqual(['second']);
    secondLease.release();
    (await third).release();
    expect(order).toEqual(['second', 'third']);
  });

  it('removes cancelled waits and lets the next queued request proceed', async () => {
    const scheduler = makeScheduler();
    const release = scheduler.foreground('shared');
    const controller = new AbortController();
    const cancelled = scheduler.background('shared', controller.signal);
    const rejected = expect(cancelled).rejects.toThrow('Cancelled wait');
    const next = scheduler.background('shared', scheduler.signal);
    controller.abort(new Error('Cancelled wait'));
    await rejected;
    release();
    (await next).release();
  });

  it('bounds provider waiting and releases both waiting and active requests on shutdown', async () => {
    const scheduler = makeScheduler();
    const foreground = scheduler.foreground('shared');
    await expect(scheduler.background('shared', scheduler.signal, 10)).rejects.toThrow('timeout');
    const waiting = scheduler.background('shared', scheduler.signal);
    const rejected = expect(waiting).rejects.toThrow('Core stopped');
    const active = await scheduler.background('independent', scheduler.signal);
    scheduler.stop();
    await rejected;
    expect(active.signal.aborted).toBe(true);
    active.release(); foreground();
    await expect(scheduler.background('shared', scheduler.signal)).rejects.toThrow('Core stopped');
  });
});
