import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { skillPickup } from '../../../src/worlds/minecraft/skills-container.ts';
import { Aborted, type SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';
import type { Bot } from 'mineflayer';
import { makeExecutorOn, waitUntil } from './executor-harness.ts';

beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));
afterEach(() => vi.useRealTimers());

function rig(full = false) {
  const bag = full ? Array.from({ length: 36 }, (_, type) => ({ name: `item_${type}`, type, count: 1 })) : [];
  const drops: Record<string, { name: string; position: Vec3; getDroppedItem(): { name: string; count: number } }> = {
    1: { name: 'item', position: new Vec3(2, 64, 0), getDroppedItem: () => ({ name: 'coal', count: 1 }) },
  };
  const walked: Array<[number, number, number]> = [];
  const bot = {
    bag, walked, entities: drops, health: 20, players: {},
    entity: { id: 9, position: new Vec3(0, 64, 0) },
    registry: { items: {}, itemsByName: {} },
    inventory: { items: () => bag },
    equip: async () => {}, lookAt: async () => {}, setControlState: () => {},
    pathfinder: {
      stop() {}, setGoal() {},
      goto: async (goal: { x: number; y: number; z: number }) => {
        walked.push([goal.x, goal.y, goal.z]);
        bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
      },
    },
  };
  return bot;
}

describe('pickup inventory postcondition', () => {
  it('reports blocked when approaching a persistent drop yields nothing and does not revisit it', async () => {
    const bot = rig(true);
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'pickup', item: 'coal' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('一样都没进包');
    expect(reports[0].text).toContain('36/36,空 0 格');
    expect(bot.walked).toHaveLength(1);
    expect(bot.bag).toHaveLength(36);
  });

  it('continues to a different drop after the nearest one produces no inventory gain', async () => {
    const bot = rig();
    bot.entities[2] = { name: 'item', position: new Vec3(4, 64, 0), getDroppedItem: () => ({ name: 'coal', count: 2 }) };
    const walk = bot.pathfinder.goto;
    bot.pathfinder.goto = async (goal) => {
      await walk(goal);
      if (goal.x === 4) { bot.bag.push({ name: 'coal', type: 1, count: 2 }); delete bot.entities[2]; }
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'pickup', item: 'coal' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('捡了 煤炭×2');
    expect(bot.walked.map(at => at[0])).toEqual([2, 4]);
  });

  it('allows a matching stack to grow even when all inventory slots are occupied', async () => {
    const bot = rig(true);
    bot.bag[0] = { name: 'coal', type: 1, count: 4 };
    const walk = bot.pathfinder.goto;
    bot.pathfinder.goto = async (goal) => { await walk(goal); bot.bag[0].count++; delete bot.entities[1]; };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'pickup', item: 'coal' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(bot.bag).toHaveLength(36);
    expect(bot.bag[0].count).toBe(5);
  });

  it('reports the requested item as blocked when only another item is collected', async () => {
    const bot = rig();
    const walk = bot.pathfinder.goto;
    bot.pathfinder.goto = async (goal) => { await walk(goal); bot.bag.push({ name: 'dirt', type: 2, count: 3 }); delete bot.entities[1]; };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'pickup', item: 'coal' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没捡到煤炭');
    expect(reports[0].text).toContain('泥土×3');
  });

  it('keeps an empty scene as a noop rather than a failed collection attempt', async () => {
    const bot = rig();
    delete bot.entities[1];
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([{ skill: 'pickup', item: 'coal' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('这一步没什么可做的');
    expect(bot.walked).toHaveLength(0);
  });

  it('propagates a cancelled route without approaching another dropped item', async () => {
    const bot = rig();
    let aborted = false;
    bot.pathfinder.goto = async () => { aborted = true; throw new Aborted(); };
    const result = skillPickup(bot as unknown as Bot, { aborted: () => aborted } as SkillContext, 'coal');
    const cancelled = expect(result).rejects.toBeInstanceOf(Aborted);
    await vi.advanceTimersByTimeAsync(1000);
    await cancelled;
    expect(bot.bag).toHaveLength(0);
  });
});
