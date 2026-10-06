import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { MinecraftWorld } from '../../../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS } from '../../../src/worlds/minecraft/config.ts';
import { parseSteps } from '../../../src/worlds/minecraft/executor.ts';
import { FakeHost } from '../../helpers/fake-host.ts';
import { makeExecutor, SLOW } from './executor-harness.ts';

function rig() {
  let release!: () => void;
  const { bot, exec, reports } = makeExecutor(new Promise<void>((resolve) => { release = resolve; }));
  bot.entity.position = new Vec3(0, 64, 0);
  const world = new MinecraftWorld({ cfg: structuredClone(MINECRAFT_DEFAULTS) });
  Object.assign(world, { host: new FakeHost(), executor: exec, bridge: { bot } });
  exec.submit([SLOW]);
  const submit = (args: Record<string, unknown>) => (world as any).enqueueTool('mc_do', args, parseSteps);
  return { bot, exec, reports, world, submit, release, dispose: () => { exec.shutdown(); release(); } };
}

afterEach(() => vi.useRealTimers());

describe('MinecraftWorld immediate plain chat', () => {
  it('speaks during a running task and preserves queued work through completion', async () => {
    vi.useFakeTimers();
    const { bot, exec, reports, submit, release, dispose } = rig();
    try {
      exec.submit([{ skill: 'chat', text: '抵达后再说' }], 'append');
      const before = exec.status();
      const receipt = submit({ steps: [{ skill: 'chat', text: '你好，我正走过去' }] });
      expect(receipt).toContain('已发送');
      expect(bot.said).toEqual(['你好，我正走过去']);
      expect(exec.status()).toEqual(before);
      expect(reports).toEqual([]);
      release();
      await vi.advanceTimersByTimeAsync(100);
      expect(bot.said).toEqual(['你好，我正走过去', '抵达后再说']);
      expect(exec.status().running).toBeNull();
      expect(reports.map((report) => report.taskId)).toEqual([1, 2]);
    } finally { dispose(); }
  });

  it.each(['/msg Alex 你好', '/tell Player_2 hello', '/w .萌萌 我在钓鱼', '/msg Alex /mycli help'])(
    'sends a complete vanilla whisper during a running body task: %s', text => {
      vi.useFakeTimers();
      const { bot, exec, submit, dispose } = rig();
      try {
        exec.submit([{ skill: 'chat', text: '忙完之后再说' }], 'append');
        const before = exec.status();
        expect(submit({ steps: [{ skill: 'chat', text }] })).toContain('已发送');
        expect(bot.said).toEqual([text]);
        expect(exec.status()).toEqual(before);
      } finally { dispose(); }
    });

  it.each([
    { steps: [{ skill: 'chat', text: '/mycli help' }] },
    { steps: [{ skill: 'chat', text: '/warp Alex' }] },
    { steps: [{ skill: 'chat', text: '/msg Alex' }] },
    { steps: [{ skill: 'chat', text: '/msg @a 大家好' }] },
    { steps: [{ skill: 'chat', text: '/minecraft:msg Alex 私聊内容' }] },
    { steps: [{ skill: 'chat', text: '/tell Alex 稍后私聊' }], queue: 'append' },
    { steps: [{ skill: 'chat', text: '/w Alex 到了再说', needs: [] }] },
    { steps: [{ skill: 'chat', text: '/msg Alex 先后有序' }, { skill: 'chat', text: '第二句' }] },
    { steps: [{ skill: 'chat', text: '抵达之后说' }], queue: 'append' },
    { steps: [{ skill: 'chat', text: '抵达之后说', needs: [] }] },
    { steps: [{ skill: 'chat', text: '第一句' }, { skill: 'chat', text: '第二句' }] },
  ])('keeps commands and explicitly ordered chat behind the running body task: %j', (args) => {
    const { bot, exec, submit, dispose } = rig();
    try {
      const before = exec.status().running;
      const receipt = submit(args);
      expect(receipt).toContain('排进队尾');
      expect(bot.said).toEqual([]);
      expect(exec.status().running).toMatchObject({ id: before!.id, label: before!.label });
      expect(exec.status().waiting).toHaveLength(1);
    } finally { dispose(); }
  });

  it.each(['x'.repeat(257), '第一行\n第二行', '颜色§a文本'])('rejects invalid chat without changing task state: %s', (text) => {
    const { bot, exec, submit, dispose } = rig();
    try {
      const before = exec.status();
      const receipt = submit({ steps: [{ skill: 'chat', text }] });
      expect(typeof receipt === 'string' ? receipt : receipt.text).toContain('没有发送');
      expect(bot.said).toEqual([]);
      expect(exec.status()).toMatchObject({ running: { id: before.running!.id }, waiting: before.waiting });
    } finally { dispose(); }
  });

  it('reports a send error without cancelling current or pending tasks', () => {
    const { bot, exec, submit, dispose } = rig();
    try {
      exec.submit([{ skill: 'chat', text: '稍后发送' }], 'append');
      const before = exec.status();
      bot.chat = () => { throw new Error('socket closed'); };
      expect(submit({ steps: [{ skill: 'chat', text: '你好' }] })).toMatchObject({
        failed: true, text: expect.stringContaining('socket closed'),
      });
      expect(exec.status()).toMatchObject({ running: { id: before.running!.id }, waiting: before.waiting });
    } finally { dispose(); }
  });

  it('preserves normalization warnings for unsupported chat fields', () => {
    const { bot, submit, dispose } = rig();
    try {
      const receipt = submit({ steps: [{ skill: 'chat', text: '你好', whisper: 'Alex' }] });
      expect(bot.said).toEqual(['你好']);
      expect(receipt).toContain('whisper');
    } finally { dispose(); }
  });

  it('disconnection is a failed send and does not enqueue a delayed surprise message', () => {
    const { world, bot, exec, submit, dispose } = rig();
    try {
      Object.assign(world, { bridge: { bot: null } });
      const before = exec.status();
      expect(submit({ steps: [{ skill: 'chat', text: '你好' }] })).toMatchObject({
        failed: true, text: expect.stringContaining('聊天未发送'),
      });
      expect(bot.said).toEqual([]);
      expect(exec.status()).toMatchObject({ running: { id: before.running!.id }, waiting: before.waiting });
    } finally { dispose(); }
  });
});
