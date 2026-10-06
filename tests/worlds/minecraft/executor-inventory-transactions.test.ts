import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from 'mineflayer';
import { craftBot, makeExecutorOn, V, waitUntil } from './executor-harness.ts';
import { InventoryClickSyncError } from '../../../src/worlds/minecraft/inventory-click-sync.ts';

const quarantined = vi.hoisted(() => new WeakSet<object>());
const recoverCursor = vi.hoisted(() => new WeakMap<object, () => Promise<void>>());
// The protocol module is tested with real window packets separately. Here its
// barrier is controlled so orchestration can be tested independently of latency.
vi.mock('../../../src/worlds/minecraft/inventory-click-sync.ts', async (original) => {
  const module = await original<typeof import('../../../src/worlds/minecraft/inventory-click-sync.ts')>();
  return { ...module, async resumeInventoryCursor(bot: Bot): Promise<void> {
    const recover = recoverCursor.get(bot);
    if (recover) await recover();
    else await module.resumeInventoryCursor(bot);
  }, assertInventoryClicksReady(bot: Bot): void {
    if (quarantined.has(bot)) throw new module.InventoryClickSyncError('库存等待服务端回灌', 'quarantined');
  } };
});

beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));
afterEach(() => vi.useRealTimers());

describe('unresolved inventory transactions in an action batch', () => {
  it('does not label old materials returned from a grid as newly crafted products', async () => {
    const bot = craftBot({ logs: 1, gain: 'real' });
    let bag = [{ type: 1, count: 1, name: 'acacia_log' }];
    bot.inventory.items = () => bag;
    bot.craft = async (_recipe, count) => {
      bot.crafts.push(count);
      // One log is consumed, while three old grid materials are returned.
      bag = [{ type: 1, count: 3, name: 'acacia_log' }, { type: 2, count: 4, name: 'acacia_planks' }];
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'acacia_planks', count: 4 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].text).toContain('合成出来:金合欢木板×4');
    expect(reports[0].text).toContain('此外库存净增:金合欢原木×2(不计作本次产物)');
    expect(reports[0].text).not.toContain('合成出来:金合欢原木');
  });

  it('restores a late cursor stack before admission becomes a false missing-material failure', async () => {
    const bot = craftBot({ logs: 0, gain: 'real' });
    const cursor = { type: 1, count: 64, name: 'acacia_log' };
    const inventory = Object.assign(bot.inventory, { selectedItem: cursor as typeof cursor | null });
    let bag: Array<typeof cursor> = [];
    inventory.items = () => bag;
    let restored = false;
    recoverCursor.set(bot, async () => {
      restored = true;
      bag = [{ ...cursor }];
      inventory.selectedItem = null;
    });
    bot.craft = async (_recipe, count) => {
      expect(restored).toBe(true);
      bot.crafts.push(count);
      bag = [{ ...cursor, count: 63 }, { type: 2, count: 4, name: 'acacia_planks' }];
    };
    const { exec, reports } = makeExecutorOn(bot);
    const receipt = exec.submit([{ skill: 'craft', item: 'acacia_planks', count: 4 }]);
    expect(receipt).not.toContain('这一单我没接');
    await waitUntil(() => reports.length === 1, 8000);
    expect(bot.crafts).toEqual([1]);
    expect(inventory.selectedItem).toBeNull();
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).not.toContain('凑不齐');
  });

  it('does not retry a pending craft because stock looks sufficient; walking and chat continue', async () => {
    const bot = craftBot({ logs: 4, planks: 8, gain: 'real' });
    const said: string[] = [];
    const clicks: number[] = [];
    Object.assign(bot, { chat: (text: string) => said.push(text) });
    bot.pathfinder.goto = async (goal?: { x?: number; y?: number; z?: number }) => {
      bot.entity.position = new V(goal?.x ?? 8, goal?.y ?? 64, goal?.z ?? 0);
    };
    bot.craft = async (_recipe, count) => {
      clicks.push(count);
      quarantined.add(bot);
      throw new InventoryClickSyncError('点击未确认，保留游标', 'quarantined');
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'craft', item: 'acacia_planks', count: 4 },
      { skill: 'craft', item: 'acacia_planks', count: 8 },
      { skill: 'goto', at: [8, 64, 0] },
      { skill: 'chat', text: '先看看周围' },
    ]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(clicks).toEqual([1]);
    expect(said).toEqual(['先看看周围']);
    expect(bot.entity.position.x).toBe(8);
    expect(reports[0].text).toContain('点击未确认，保留游标');
    expect(reports[0].text).toContain('库存等待服务端回灌');
    expect(reports[0].text).not.toContain('技能报受阻但期望已达成');
  });

  it('keeps a confirmed rollback as a failed action even when old stock meets the expectation', async () => {
    const bot = craftBot({ logs: 4, planks: 8, gain: 'real' });
    const original = bot.craft;
    let calls = 0;
    bot.craft = async (recipe, count) => {
      if (++calls === 1) throw new InventoryClickSyncError('服务端回滚该次点击', 'rollback');
      await original(recipe, count);
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'craft', item: 'acacia_planks', count: 4 },
      { skill: 'craft', item: 'acacia_planks', count: 4 },
    ]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(calls).toBe(2);
    expect(bot.crafts).toEqual([1]);
    expect(reports[0].text).toContain('服务端回滚该次点击');
    expect(reports[0].text).toContain('合成出来:金合欢木板×4');
    expect(reports[0].text).not.toContain('技能报受阻但期望已达成');
  });

  it('permits a later craft after authoritative recovery without resuming the whole loop', async () => {
    const bot = craftBot({ logs: 4, gain: 'real' });
    quarantined.add(bot);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'craft', item: 'acacia_planks', count: 4 }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(bot.crafts).toEqual([]);
    expect(reports[0].kind).toBe('blocked');
    quarantined.delete(bot);
    exec.submit([{ skill: 'craft', item: 'acacia_planks', count: 4 }]);
    await waitUntil(() => reports.length === 2, 8000);
    expect(bot.crafts).toEqual([1]);
    expect(reports[1].kind).toBe('done');
  });
});
