import { afterEach, describe, expect, it, vi } from 'vitest';
import { DreamTaskQueue, DreamTaskStoppedError, DreamTaskTimeoutError, dreamDelay } from '../../bots/cortiv/persona/dream-task-queue.ts';

afterEach(() => vi.useRealTimers());
const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

describe('background task lifetime', () => {
  it('serializes jobs and rejects work beyond the pending capacity', async () => {
    vi.useFakeTimers();
    const queue = new DreamTaskQueue();
    const order: string[] = [];
    let release!: () => void;
    const errors: unknown[] = [];
    const options = { timeoutMs: 1000, maxPendingTasks: 1, onError: (error: unknown) => errors.push(error) };
    expect(queue.enqueue(async () => { order.push('first'); await new Promise<void>(resolve => { release = resolve; }); }, options)).toBe(true);
    expect(queue.enqueue(async () => { order.push('second'); }, options)).toBe(true);
    expect(queue.enqueue(async () => { order.push('overflow'); }, options)).toBe(false);
    await flush();
    expect(order).toEqual(['first']);
    expect(queue.state().queuedTasks).toHaveLength(1);
    release(); await flush();
    expect(order).toEqual(['first', 'second']);
    expect(queue.state().currentTask).toBeNull();
    expect(queue.state().lastOutcome?.status).toBe('completed');
    expect(errors).toEqual([]);
  });

  it('counts waiting time and settles cancelled upstream work without waiting for a response', async () => {
    vi.useFakeTimers();
    const queue = new DreamTaskQueue();
    const signals: AbortSignal[] = [];
    const errors: unknown[] = [];
    const never = async (signal: AbortSignal): Promise<void> => { signals.push(signal); await new Promise(() => {}); };
    queue.enqueue(never, { timeoutMs: 40, maxPendingTasks: 1, onError: error => errors.push(error) });
    queue.enqueue(never, { timeoutMs: 50, maxPendingTasks: 1, onError: error => errors.push(error) });
    await flush();
    await vi.advanceTimersByTimeAsync(40);
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(signals[1].aborted).toBe(true);
    expect(errors).toHaveLength(2);
    expect(errors.every(error => error instanceof DreamTaskTimeoutError)).toBe(true);
    expect(queue.state().currentTask).toBeNull();
    expect(queue.state().lastOutcome?.status).toBe('timedout');
  });

  it('expires queued work before it starts and preserves its terminal evidence', async () => {
    vi.useFakeTimers();
    const queue = new DreamTaskQueue();
    let queuedRan = false;
    const errors: unknown[] = [];
    queue.enqueue(async () => new Promise(() => {}), { timeoutMs: 100, maxPendingTasks: 1, onError: error => errors.push(error) });
    queue.enqueue(async () => { queuedRan = true; }, { timeoutMs: 10, maxPendingTasks: 1, onError: error => errors.push(error) });
    await vi.advanceTimersByTimeAsync(10);
    expect(queuedRan).toBe(false);
    expect(queue.state().queuedTasks).toEqual([]);
    expect(queue.state().lastOutcome?.status).toBe('timedout');
    queue.stop(); await flush();
  });

  it('stop cancels the active task and queued tasks; restart accepts new work', async () => {
    vi.useFakeTimers();
    const queue = new DreamTaskQueue();
    const errors: unknown[] = [];
    let oldSignal!: AbortSignal;
    let queuedRan = false;
    let restartedRan = false;
    const options = { timeoutMs: 1000, maxPendingTasks: 1, onError: (error: unknown) => errors.push(error) };
    queue.enqueue(async signal => { oldSignal = signal; await dreamDelay(500, signal); }, options);
    queue.enqueue(async () => { queuedRan = true; }, options);
    await flush(); queue.stop(); await flush();
    expect(oldSignal.aborted).toBe(true);
    expect(queuedRan).toBe(false);
    expect(errors).toHaveLength(2);
    expect(errors.every(error => error instanceof DreamTaskStoppedError)).toBe(true);
    expect(queue.state().currentTask).toBeNull();
    expect(queue.enqueue(async () => {}, options)).toBe(false);
    queue.start();
    expect(queue.enqueue(async () => { restartedRan = true; }, options)).toBe(true);
    await flush(); expect(restartedRan).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
