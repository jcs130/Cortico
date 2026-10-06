import { describe, expect, it, vi } from 'vitest';
import { MinecraftWorld } from '../../../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS } from '../../../src/worlds/minecraft/config.ts';
import { parseSteps } from '../../../src/worlds/minecraft/executor.ts';
import { FakeHost } from '../../helpers/fake-host.ts';
import { chestBot, makeExecutorOn } from './executor-harness.ts';

describe('MinecraftWorld refusals remain scoped to an observed intent', () => {
  it('repeated empty finds reject only that nearby search, preserving chat, new work and schemas', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const bot = Object.assign(chestBot().bot, { chat: vi.fn() });
    bot.findBlocks = () => [];
    const { exec, reports } = makeExecutorOn(bot);
    const world = new MinecraftWorld({ cfg: structuredClone(MINECRAFT_DEFAULTS) });
    Object.assign(world, { host: new FakeHost(), executor: exec, bridge: { bot } });
    const submit = (steps: unknown) => (world as any).enqueueTool('mc_do', { steps }, parseSteps);
    const schemas = world.tools().map(({ handler: _handler, ...schema }) => schema);
    const find = { skill: 'find' as const, target: 'chest', distance: 16 };
    try {
      for (let i = 1; i <= 3; i++) {
        // Separate actual observations from the existing short inspection hold.
        vi.setSystemTime(start + (i - 1) * 120_000);
        exec.submit([find]);
        await vi.waitFor(() => expect(reports).toHaveLength(i));
        expect(reports.at(-1)?.kind).toBe('done');
      }
      const queue = exec.status();
      const refused = submit([find]);
      expect(refused).toMatchObject({ failed: true, endsTurn: true,
        text: expect.stringContaining('已连续 3 次没找到') });
      expect(refused).not.toHaveProperty('retryAfterMs');
      expect(exec.status()).toEqual(queue);
      expect(submit([{ skill: 'chat', text: '/msg Alex 我换个地方看看' }])).toContain('已发送');
      expect(bot.chat).toHaveBeenCalledWith('/msg Alex 我换个地方看看');
      expect(submit([{ skill: 'goto', at: [80, 64, 0] }])).toContain('任务#');
      expect(world.tools().map(({ handler: _handler, ...schema }) => schema)).toEqual(schemas);
    } finally { exec.shutdown(); vi.useRealTimers(); }
  });

  it('a blocked spell ends this wake but does not block another available spell', () => {
    const world = new MinecraftWorld({ cfg: structuredClone(MINECRAFT_DEFAULTS) });
    const bot = Object.assign(chestBot().bot, { chat: vi.fn() });
    Object.assign(world, { host: new FakeHost(), bridge: { bot } });
    vi.spyOn((world as any).combatSpells, 'manualCastBlock')
      .mockImplementation((spell: unknown) => spell === 'star_arrow' ? 'star_arrow 冷却还需约 3 秒' : null);
    const refused = (world as any).castSpell({ spell: 'star_arrow' });
    expect(refused).toMatchObject({ failed: true, endsTurn: true });
    expect(refused).not.toHaveProperty('retryAfterMs');
    expect(refused.text).not.toContain('本工具');
    expect((world as any).castSpell({ spell: 'frost_ring' })).toContain('已发送');
    expect(bot.chat).toHaveBeenCalledWith('/mycli cast frost_ring');
  });
});
