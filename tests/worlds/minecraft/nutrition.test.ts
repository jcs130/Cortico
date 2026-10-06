import { describe, expect, it, vi } from 'vitest';
import { chooseRoutineFood, renderFoodReserveReadout } from '../../../src/worlds/minecraft/nutrition.ts';
import { MinecraftWorld } from '../../../src/worlds/minecraft/world.ts';
import { Vec3 } from 'vec3';

const foods = {
  bread: { foodPoints: 5, saturation: 6 },
  cooked_beef: { foodPoints: 8, saturation: 12.8 },
  rotten_flesh: { foodPoints: 4, saturation: 0.8 },
  golden_apple: { foodPoints: 4, saturation: 9.6 },
  pufferfish: { foodPoints: 1, saturation: 0.2 },
};

describe('routine nutrition', () => {
  it('reports carried reserves separately from risky and special food, combining stacks', () => {
    const readout = renderFoodReserveReadout([
      { name: 'bread', count: 2 }, { name: 'bread', count: 3 },
      { name: 'rotten_flesh', count: 32 }, { name: 'golden_apple', count: 1 },
      { name: 'wheat', count: 64 }, { name: 'bread', count: -1 },
    ], foods, true);
    expect(readout).toContain('常规 5 个（bread×5');
    expect(readout).toContain('合计 25 点');
    expect(readout).toContain('有风险或特殊副作用：rotten_flesh×32');
    expect(readout).toContain('特殊食物：golden_apple×1');
    expect(readout).not.toContain('wheat×');
  });

  it('reports missing reserves even while fed, and distinguishes unsynchronized or unknown food data', () => {
    expect(renderFoodReserveReadout([{ name: 'rotten_flesh', count: 32 }], foods, true)).toContain('常规 0 个');
    expect(renderFoodReserveReadout([], foods, false)).toContain('数量未知');
    expect(renderFoodReserveReadout([], {}, true)).toContain('未分类');
  });
  it('eats ordinary bread at 16 hunger even when rotten flesh and rare supplies are present', () => {
    expect(chooseRoutineFood(16, [
      { name: 'rotten_flesh', count: 2 }, { name: 'golden_apple', count: 1 },
      { name: 'cooked_beef', count: 1 }, { name: 'bread', count: 2 },
    ], foods)).toBe('bread');
  });

  it('waits while fed, then uses rotten flesh only to avoid starvation with no safe food', () => {
    const bag = [{ name: 'rotten_flesh', count: 2 }, { name: 'pufferfish', count: 1 }];
    expect(chooseRoutineFood(16, bag, foods)).toBeNull();
    expect(chooseRoutineFood(6, bag, foods)).toBe('rotten_flesh');
  });

  it('does not spend golden apples for routine hunger or trust invalid hunger readings', () => {
    expect(chooseRoutineFood(8, [{ name: 'golden_apple', count: 2 }], foods)).toBeNull();
    expect(chooseRoutineFood(Number.NaN, [{ name: 'bread', count: 1 }], foods)).toBeNull();
  });

  it('requests a safe handoff for routine food and does not duplicate a pending meal', () => {
    const submitDetailed = vi.fn(() => ({ accepted: true, receipt: 'queued' }));
    const executor = { status: () => ({ running: { id: 1 }, waiting: [], hold: null }),
      hasPendingEat: vi.fn(() => false), submitDetailed };
    const world = Object.assign(Object.create(MinecraftWorld.prototype) as MinecraftWorld, {
      lastAutoEatAttemptAt: 0, bridge: { invSynced: true }, combat: { active: false },
      executor, diag: { write: vi.fn() }, connectionGeneration: 1,
    });
    const bot = { food: 16, entity: { onGround: true, position: new Vec3(0, 64, 0) },
      blockAt: () => ({ name: 'air' }), registry: { foodsByName: foods },
      inventory: { items: () => [{ name: 'rotten_flesh', count: 1 }, { name: 'bread', count: 2 }] } };
    (world as unknown as { autoEatTick(bot: unknown): void }).autoEatTick(bot);
    expect(submitDetailed).toHaveBeenCalledWith([{ skill: 'eat', item: 'bread' }], 'afterCheckpoint');

    Object.assign(world, { lastAutoEatAttemptAt: 0 });
    executor.hasPendingEat.mockReturnValue(true);
    (world as unknown as { autoEatTick(bot: unknown): void }).autoEatTick(bot);
    expect(submitDetailed).toHaveBeenCalledTimes(1);
  });
});
