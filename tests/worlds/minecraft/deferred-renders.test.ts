import { describe, expect, it } from 'vitest';
import { DeferredRenders } from '../../../src/worlds/minecraft/deferred-renders.ts';

describe('deferred IPC ticket identity', () => {
  it('drops an older ticket instead of attaching a new task body to old metadata', async () => {
    const renders = new DeferredRenders();
    const oldId = renders.arm('task.queue', () => 'task 10');
    const newId = renders.arm('task.queue', () => 'task 11');
    expect(await renders.render('task.queue', oldId)).toBeNull();
    expect(await renders.render('task.queue', newId)).toBe('task 11');
    expect(await renders.render('task.queue', newId)).toBeNull();
  });

  it('retains a newly armed ticket while an original asynchronous render settles', async () => {
    const renders = new DeferredRenders();
    let release!: (text: string) => void;
    const id = renders.arm('task.queue', () => new Promise(resolve => { release = resolve; }));
    const pending = renders.render('task.queue', id);
    const next = renders.arm('task.queue', () => ({ text: 'next task' }));
    release('original task');
    expect(await pending).toBe('original task');
    expect(await renders.render('task.queue', next)).toBe('next task');
  });

  it('keeps independent event types and consumes errors without replaying a callback', async () => {
    const renders = new DeferredRenders();
    const world = renders.arm('world.snapshot', () => 'world');
    const queue = renders.arm('task.queue', () => { throw new Error('lost connection'); });
    await expect(renders.render('task.queue', queue)).rejects.toThrow('lost connection');
    expect(await renders.render('task.queue', queue)).toBeNull();
    expect(await renders.render('world.snapshot', world)).toBe('world');
  });
});
