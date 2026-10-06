import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { useOnce } from '../../../src/worlds/minecraft/skills-interact.ts';
import { parseSteps } from '../../../src/worlds/minecraft/skills.ts';
import { resolveAt } from '../../../src/worlds/minecraft/cell-facts.ts';
import type { SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';
import type { SkillCall } from '../../../src/worlds/minecraft/skills.ts';
import { blockAtCell } from '../../../src/worlds/minecraft/cell-facts.ts';
import { precheckStep, type PrecheckDeps } from '../../../src/worlds/minecraft/precheck.ts';

const { navigation } = vi.hoisted(() => ({ navigation: vi.fn() }));
vi.mock('../../../src/worlds/minecraft/travel.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/worlds/minecraft/travel.ts')>(),
  reachCell: navigation,
}));

const AT: [number, number, number] = [10, 63, 0];
const NAVIGATION = 'navigation reached';
type UseCall = Extract<SkillCall, { skill: 'use' }>;

function rig(item = 'wheat_seeds', target: string | null = 'grass_block', above = 'air') {
  const stack = { name: item, type: 1, count: 8 };
  const items = [stack];
  const blocks = new Map<string, string | null>([['10,63,0', target], ['10,64,0', above]]);
  const activate = vi.fn(async (block: { name: string; position: Vec3 }) => {
    if (bot.heldItem?.name.endsWith('_hoe')) {
      blocks.set(`${block.position.x},${block.position.y},${block.position.z}`, 'farmland');
    }
  });
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) },
    _client: { write: () => {} },
    heldItem: stack, inventory: { items: () => items }, registry: { foodsByName: {} },
    equip: vi.fn(async (item: typeof stack) => { Object.assign(bot, { heldItem: item }); }),
    blockAt: (position: Vec3) => {
      const key = `${position.x},${position.y},${position.z}`;
      const name = blocks.has(key) ? blocks.get(key)! : 'air';
      return name === null ? null : { name, position, getProperties: () => ({}) };
    },
    activateBlock: activate, lookAt: vi.fn(async () => undefined), activateItem: vi.fn(),
    waitForTicks: vi.fn(async () => undefined),
  } as unknown as Bot;
  const ctx = { aborted: () => false } as SkillContext;
  return { bot, ctx, blocks, activate, stack, items,
    run: (patch: Partial<UseCall> = {}) => useOnce(bot, { skill: 'use', item, at: AT, ...patch }, ctx) };
}

beforeEach(() => {
  vi.useFakeTimers();
  navigation.mockReset();
  navigation.mockRejectedValue(new Error(NAVIGATION));
});
afterEach(() => vi.useRealTimers());

describe('known block use prerequisites precede travel', () => {
  it.each(['water', 'lava'])('a flooded crop cell containing %s preserves seeds and sends no movement or use', async (liquid) => {
    for (const item of ['wheat_seeds', 'beetroot_seeds', 'carrot', 'potato', 'melon_seeds', 'pumpkin_seeds',
      'torchflower_seeds', 'pitcher_pod', 'nether_wart']) {
      const r = rig(item, item === 'nether_wart' ? 'soul_sand' : 'farmland', liquid);
      const deps: PrecheckDeps = { resolve: (at) => resolveAt(r.bot, at as never),
        blockAt: (at) => blockAtCell(r.bot, at), cellsOf: () => null };
      expect(precheckStep(r.bot, { skill: 'use', item, at: AT }, deps))
        .toMatchObject({ level: 'hard', rule: 'use.seedFlooded' });
      await expect(r.run()).rejects.toThrow('(10, 64, 0)');
      expect(navigation).not.toHaveBeenCalled();
      expect(r.activate).not.toHaveBeenCalled();
      expect(r.bot.activateItem).not.toHaveBeenCalled();
      expect(r.stack.count).toBe(8);
    }
  });

  it('a crop cell flooded during travel is rechecked before consuming a seed', async () => {
    const r = rig('wheat_seeds', 'farmland');
    navigation.mockImplementation(async () => { r.blocks.set('10,64,0', 'water'); });
    await expect(r.run()).rejects.toThrow('占住了作物格');
    expect(navigation).toHaveBeenCalledOnce();
    expect(r.activate).not.toHaveBeenCalled();
    expect(r.stack.count).toBe(8);
  });

  it('an empty bucket aimed at soil reports the liquid cell above without using the item', async () => {
    const r = rig('bucket', 'farmland', 'water');
    navigation.mockResolvedValue(undefined);
    await expect(r.run()).rejects.toThrow('上方 (10, 64, 0)');
    expect(r.activate).not.toHaveBeenCalled();
    expect(r.bot.activateItem).not.toHaveBeenCalled();
    expect(r.stack.count).toBe(8);
  });

  it.each(['wheat_seeds', 'beetroot_seeds', 'carrot', 'potato', 'melon_seeds', 'pumpkin_seeds',
    'torchflower_seeds', 'pitcher_pod', 'nether_wart'])('loaded wrong soil for %s sends neither navigation nor use', async (item) => {
    const r = rig(item);
    await expect(r.run()).rejects.toThrow('尚未导航');
    expect(navigation).not.toHaveBeenCalled();
    expect(r.activate).not.toHaveBeenCalled();
  });

  it.each(['wooden_hoe', 'iron_hoe', 'diamond_hoe'])('wrong loaded block or covered soil blocks %s before travel', async (item) => {
    const wrong = rig(item, 'stone');
    await expect(wrong.run()).rejects.toThrow('不是锄头能翻的土格');
    const covered = rig(item, 'grass_block', 'crafting_table');
    await expect(covered.run()).rejects.toThrow('头上盖着');
    expect(navigation).not.toHaveBeenCalled();
    expect(wrong.activate).not.toHaveBeenCalled(); expect(covered.activate).not.toHaveBeenCalled();
  });

  it('reports the original mixed input and resolved absolute coordinates without changing numeric string semantics', async () => {
    const r = rig(); r.blocks.set('0,-1,0', 'stone');
    const bad = ['~', '-1', '~'] as [string, string, string];
    expect(resolveAt(r.bot, bad)).toEqual({ x: 0, y: -1, z: 0 });
    expect(resolveAt(r.bot, ['~', '~-1', '~'])).toEqual({ x: 0, y: 63, z: 0 });
    expect(parseSteps([{ skill: 'use', item: 'wheat_seeds', at: bad }])).not.toHaveProperty('error');
    const failure = await r.run({ at: bad }).catch((error: Error) => error.message);
    expect(failure).toContain('["~","-1","~"]'); expect(failure).toContain('(0, -1, 0)');
    expect(failure).toContain('数字字符串）是绝对坐标'); expect(failure).toContain('Y分量"~-1"表示脚下1格');
    expect(navigation).not.toHaveBeenCalled();
  });

  it('unknown, unloaded, and off-table item targets continue through the existing navigation path', async () => {
    for (const r of [rig('wheat_seeds', null), rig('iron_hoe', null), rig('custom_wand', 'stone')]) {
      await expect(r.run()).rejects.toThrow(NAVIGATION);
      expect(r.activate).not.toHaveBeenCalled();
    }
    expect(navigation).toHaveBeenCalledTimes(3);
  });

  it('rechecks the target after navigation; a changed loaded block does not send use', async () => {
    const r = rig('wheat_seeds', 'farmland');
    navigation.mockImplementation(async () => { r.blocks.set('10,63,0', 'stone'); });
    await expect(r.run()).rejects.toThrow('要对耕地使用');
    expect(navigation).toHaveBeenCalledOnce(); expect(r.activate).not.toHaveBeenCalled();
  });

  it('an initially unloaded target still travels, then reports unknown if it remains unavailable', async () => {
    const r = rig('wheat_seeds', null);
    navigation.mockResolvedValue(undefined);
    await expect(r.run()).rejects.toThrow('所在区块没加载');
    expect(navigation).toHaveBeenCalledOnce(); expect(r.activate).not.toHaveBeenCalled();
  });

  it('a failed prerequisite hoe cannot make a seed operation navigate on the unchanged soil', async () => {
    const hoe = rig('iron_hoe', 'grass_block', 'crafting_table');
    await expect(hoe.run()).rejects.toThrow('头上盖着');
    const seed = rig(); // The preceding hoe failed; the actual target is still grass_block.
    await expect(seed.run()).rejects.toThrow('要对耕地使用');
    expect(navigation).not.toHaveBeenCalled();
    expect(hoe.activate).not.toHaveBeenCalled(); expect(seed.activate).not.toHaveBeenCalled();
  });

  it('a successful preceding hoe leaves real farmland usable; upper-air alignment is retained', async () => {
    const r = rig('iron_hoe', 'grass_block');
    navigation.mockResolvedValue(undefined);
    const hoed = r.run();
    await vi.advanceTimersByTimeAsync(500);
    expect(await hoed).toContain('耕地');
    expect(r.blocks.get('10,63,0')).toBe('farmland');
    const seed = { name: 'wheat_seeds', type: 2, count: 8 };
    r.items.push(seed);
    r.activate.mockClear();
    navigation.mockClear();
    r.activate.mockImplementation(async () => { r.blocks.set('10,64,0', 'wheat'); seed.count--; });
    const pending = r.run({ item: 'wheat_seeds', at: [10, 64, 0] });
    await vi.advanceTimersByTimeAsync(500);
    const receipt = await pending;
    expect(receipt).toContain('实际对准下方'); expect(receipt).toContain('小麦');
    expect(navigation).toHaveBeenCalledOnce(); expect(r.activate).toHaveBeenCalledOnce();
    expect(r.activate.mock.calls[0][0].position).toEqual(new Vec3(10, 63, 0));
  });

  it('preserves separate sign writing, bed interaction, and directed thrown-item semantics', async () => {
    const sign = rig('wheat_seeds', 'oak_sign');
    await expect(sign.run({ text: '我的农田' })).rejects.toThrow(NAVIGATION);
    const bed = rig('wheat_seeds', 'red_bed');
    await expect(bed.run()).rejects.toThrow(NAVIGATION);
    expect(navigation).toHaveBeenCalledTimes(2);
    const thrown = rig('snowball', 'stone');
    const pending = thrown.run();
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toContain('扔了');
    expect(thrown.bot.activateItem).toHaveBeenCalledOnce();
    expect(navigation).toHaveBeenCalledTimes(2);
  });
});
