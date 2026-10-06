import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { taggedCraftChoice } from '../../../src/worlds/minecraft/tagged-crafting.ts';
import { precheckStep } from '../../../src/worlds/minecraft/precheck.ts';

const require = createRequire(import.meta.url);
const registry = require('minecraft-data')('1.20.6') as {
  version: { minecraftVersion: string };
  itemsByName: Record<string, { id: number; name: string; stackSize: number }>;
  items: Record<number, { name: string }>;
};

function botWith(wood: Array<[string, number]>, version = '1.20.6') {
  return {
    registry: { ...registry, version: { minecraftVersion: version } },
    inventory: { items: () => wood.map(([name, count]) => ({
      name, count, type: registry.itemsByName[name].id,
    })) },
  } as never;
}

describe('1.20.6 官方标签配方', () => {
  it('木棍由两块木板生成，木锄的柄两格同列', () => {
    const oak = registry.itemsByName.oak_planks.id;
    const stick = registry.itemsByName.stick.id;
    const sticks = taggedCraftChoice(botWith([['oak_planks', 6], ['stick', 1]]), 'stick');
    expect(sticks?.recipe?.inShape).toEqual([[{ id: oak }], [{ id: oak }]]);
    const hoe = taggedCraftChoice(botWith([['oak_planks', 4], ['stick', 5]]), 'wooden_hoe');
    expect(hoe?.recipe?.inShape).toEqual([
      [{ id: oak }, { id: oak }],
      [null, { id: stick }],
      [null, { id: stick }],
    ]);
  });

  it('箱子接受云杉木板，而不是误报只认橡木', () => {
    const bot = botWith([['spruce_planks', 8]]);
    const choice = taggedCraftChoice(bot, 'chest');
    expect(choice?.recipe?.requiresTable).toBe(true);
    expect(choice?.recipe?.inShape?.flat().map((cell) => cell?.id ?? null)).toEqual([
      37, 37, 37,
      37, null, 37,
      37, 37, 37,
    ]);
    expect(precheckStep(bot, { skill: 'craft', item: 'chest', count: 1 }, {
      resolve: () => null, cellsOf: () => null, blockAt: () => null,
    })).toBeNull();
  });

  it('能混用多种木板；材料不足时按标签说明缺口', () => {
    const mixed = taggedCraftChoice(botWith([['oak_planks', 4], ['spruce_planks', 4]]), 'chest');
    const cells = mixed?.recipe?.inShape?.flat().filter((cell): cell is { id: number } => !!cell) ?? [];
    expect(cells).toHaveLength(8);
    expect(cells.filter((cell) => cell.id === 36)).toHaveLength(4);
    expect(cells.filter((cell) => cell.id === 37)).toHaveLength(4);
    const short = taggedCraftChoice(botWith([['spruce_planks', 4]]), 'chest');
    expect(short?.recipe).toBeNull();
    expect(short?.needs).toContain('任意木板×8');
  });

  it('按版本使用导出的配方数据', () => {
    expect(taggedCraftChoice(botWith([['spruce_planks', 8]], '1.21.1'), 'chest')).toBeNull();
  });
});
