import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorldHost } from '../../../src/core/types.ts';
import { Executor, type TaskQueueTail, type TaskReport } from '../../../src/worlds/minecraft/executor.ts';
import { MinecraftWorld } from '../../../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS } from '../../../src/worlds/minecraft/config.ts';
import { FakeHost } from '../../helpers/fake-host.ts';
import { fakeBot, log, nextTaskId } from './executor-harness.ts';

const fishing = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../../src/worlds/minecraft/skills-gather.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/worlds/minecraft/skills-gather.ts')>(),
  skillFish: fishing.run,
}));

type Deferred = Parameters<WorldHost['pushDeferred']>[0];
function rig() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fishing.run.mockImplementation(async () => { await gate; return '钓鱼步骤已结束'; });
  const bot = fakeBot();
  const host = new FakeHost();
  const notices: Array<{ spec: Deferred; trigger?: string }> = [];
  Object.assign(host, { pushDeferred: (spec: Deferred, options?: { trigger?: string }) => {
    notices.push({ spec, trigger: options?.trigger });
  } });
  const world = new MinecraftWorld({ cfg: structuredClone(MINECRAFT_DEFAULTS) });
  let combat = false;
  const reports: TaskReport[] = [];
  const tailCalls: TaskQueueTail[] = [];
  const exec = new Executor({
    getBot: () => bot as never,
    log, nextId: nextTaskId(), precheck: () => false,
    report: (report) => reports.push(report),
    busyWith: () => combat ? '正在跟怪打' : null,
    onQueueTail: (notice) => {
      tailCalls.push(notice);
      (world as any).onQueueTail(notice);
    },
  });
  const snapshot = vi.fn(() => '[Minecraft] 当前世界快照');
  Object.assign(world, {
    host, executor: exec, bridge: { bot, connected: true },
    diag: { write: vi.fn() }, renderSnapshotEvent: snapshot,
  });
  return {
    exec, bot, notices, reports, tailCalls, snapshot, world, release,
    combat: (value: boolean) => { combat = value; },
    dispose: async () => { exec.shutdown(); release(); await vi.advanceTimersByTimeAsync(10); },
  };
}
afterEach(() => { vi.useRealTimers(); fishing.run.mockReset(); });

describe('Executor tail-step queue observation', () => {
  it('notifies while a grouped task waits for fishing and append preserves the running task', async () => {
    vi.useFakeTimers();
    const r = rig();
    try {
      r.exec.submit([{ skill: 'chat', text: '先打招呼' }, { skill: 'fish' }]);
      await vi.advanceTimersByTimeAsync(10);
      expect(r.tailCalls).toEqual([{ taskId: 1, stepIndex: 1, stepCount: 2 }]);
      const deferred = r.notices[0];
      expect(deferred.trigger).toBe('debounce');
      expect(deferred.spec.type).toBe('minecraft.task.queue');
      expect(deferred.spec.tags).toEqual(['snapshot']);
      expect(await deferred.spec.render()).toContain('正在执行最后一步');
      expect(r.snapshot).toHaveBeenCalledOnce();
      expect(r.exec.status().running).toMatchObject({ id: 1, stepIndex: 1 });
      expect(r.reports).toEqual([]);
      r.exec.submit([{ skill: 'chat', text: '下一组' }], 'append');
      expect(r.exec.status()).toMatchObject({ running: { id: 1 }, waiting: [{ id: 2 }] });
      expect(r.bot.said).toEqual(['先打招呼']);
      expect(await deferred.spec.render()).toBeNull();
      r.release();
      await vi.advanceTimersByTimeAsync(100);
      expect(r.bot.said).toEqual(['先打招呼', '下一组']);
      expect(r.reports.map((report) => report.taskId)).toEqual([1, 2]);
      expect(r.exec.status().running).toBeNull();
    } finally { await r.dispose(); }
  });

  it('filters a short step that has already finished before the batch is delivered', async () => {
    vi.useFakeTimers();
    const r = rig();
    try {
      r.exec.submit([{ skill: 'chat', text: '你好' }]);
      await vi.advanceTimersByTimeAsync(10);
      expect(r.tailCalls).toHaveLength(1);
      expect(await r.notices[0].spec.render()).toBeNull();
      expect(r.snapshot).not.toHaveBeenCalled();
    } finally { await r.dispose(); }
  });

  it('does not notify at a tail step when a later task is already queued', async () => {
    vi.useFakeTimers();
    const r = rig();
    try {
      r.exec.submit([{ skill: 'chat', text: '开始' }, { skill: 'fish' }]);
      r.exec.submit([{ skill: 'chat', text: '待办' }], 'append');
      await vi.advanceTimersByTimeAsync(10);
      expect(fishing.run).toHaveBeenCalledOnce();
      expect(r.exec.status().running).toMatchObject({ id: 1, stepIndex: 1 });
      expect(r.tailCalls).toEqual([]);
    } finally { await r.dispose(); }
  });

  it.each(['cancel', 'shutdown', 'combat'] as const)('drops a pending observation after %s', async (cause) => {
    vi.useFakeTimers();
    const r = rig();
    try {
      r.exec.submit([{ skill: 'fish' }]);
      await vi.advanceTimersByTimeAsync(10);
      expect(r.notices).toHaveLength(1);
      if (cause === 'cancel') r.exec.stopCurrent('操作员取消');
      else if (cause === 'shutdown') r.exec.shutdown();
      else r.combat(true);
      expect(await r.notices[0].spec.render()).toBeNull();
      expect(r.snapshot).not.toHaveBeenCalled();
    } finally { await r.dispose(); }
  });

  it('does not repeat after an environment hold and discards the original execution notice on resume', async () => {
    vi.useFakeTimers();
    const r = rig();
    try {
      r.exec.submit([{ skill: 'fish' }]);
      await vi.advanceTimersByTimeAsync(10);
      const notice = r.notices[0].spec;
      const token = r.exec.pauseForEnvironment('需要上浮');
      expect(await notice.render()).toBeNull();
      r.exec.resumeAfterEnvironment(token);
      await vi.advanceTimersByTimeAsync(10);
      expect(r.exec.status().running).toMatchObject({ id: 1 });
      expect(fishing.run).toHaveBeenCalledTimes(2);
      expect(r.tailCalls).toHaveLength(1);
      expect(await notice.render()).toBeNull();
    } finally { await r.dispose(); }
  });

  it('drops stale connection observations without inspecting a new world snapshot', async () => {
    vi.useFakeTimers();
    const r = rig();
    try {
      r.exec.submit([{ skill: 'fish' }]);
      await vi.advanceTimersByTimeAsync(10);
      Object.assign(r.world, { bridge: { bot: r.bot, connected: false } });
      expect(await r.notices[0].spec.render()).toBeNull();
      expect(r.snapshot).not.toHaveBeenCalled();
    } finally { await r.dispose(); }
  });
});
