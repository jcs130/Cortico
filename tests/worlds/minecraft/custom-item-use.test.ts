import { describe, expect, it } from 'vitest';
import { invItemNamed } from '../../../src/worlds/minecraft/inventory.ts';
import { useOnce } from '../../../src/worlds/minecraft/skills-interact.ts';
import { stowIntoOpenWindow } from '../../../src/worlds/minecraft/skills-container.ts';
import { describeSkill } from '../../../src/worlds/minecraft/receipt.ts';

describe('server named items', () => {
  it('uses the named head rather than another player head and reports its opened window', async () => {
    const plain = { name: 'player_head', type: 1, count: 1 };
    const backpack = { name: 'player_head', type: 1, count: 1,
      components: [{ type: 'custom_name', data: '{"text":"大背包"}' }] };
    const items = [plain, backpack];
    const bot = {
      _client: { write: () => {} },
      inventory: { items: () => items },
      registry: { foodsByName: {} },
      heldItem: null as typeof plain | typeof backpack | null,
      currentWindow: null as object | null,
      equip: async (item: typeof plain | typeof backpack, dest: string) => {
        expect(dest).toBe('hand');
        bot.heldItem = item;
      },
      activateItem: () => {
        bot.currentWindow = { id: 5, type: 'minecraft:generic_9x3', title: '{"text":"随身仓库"}',
          inventoryStart: 27, hotbarStart: 54,
          slots: [{ name: 'diamond', type: 2, displayName: 'Diamond', count: 3 },
            ...Array.from({ length: 53 }, () => null)] };
      },
      deactivateItem: () => undefined,
    };
    expect(invItemNamed(bot as never, 'player_head')).toBe(plain);
    expect(invItemNamed(bot as never, '大背包')).toBe(backpack);
    const receipt = await useOnce(bot as never, { skill: 'use', item: '大背包' }, { aborted: () => false } as never);
    expect(bot.heldItem).toBe(backpack);
    expect(receipt).toContain('用了大背包;打开了随身仓库');
    expect(receipt).toContain('Diamond×3');
    expect(receipt).toContain('占用 1/27 格，空 26 格');
  });
  it('reports capacity and omitted occupied slots for a full portable container, excluding player slots', async () => {
    const held = { name: 'player_head', type: 1, count: 1 };
    const stock = { name: 'cobblestone', type: 2, count: 64, displayName: 'Cobblestone' };
    const bot = {
      _client: { write: () => {} }, inventory: { items: () => [held] }, registry: { foodsByName: {} },
      heldItem: held, currentWindow: null as object | null,
      equip: async () => undefined,
      activateItem: () => {
        bot.currentWindow = { id: 5, type: 'minecraft:generic_9x6', title: 'Portable store',
          inventoryStart: 54, hotbarStart: 81,
          slots: [...Array.from({ length: 54 }, () => ({ ...stock })),
            { name: 'bread', type: 3, count: 4, displayName: 'Bread' }, ...Array.from({ length: 35 }, () => null)] };
      },
      deactivateItem: () => undefined,
    };
    const receipt = await useOnce(bot as never, { skill: 'use', item: 'player_head' }, { aborted: () => false } as never);
    expect(receipt).toContain('占用 54/54 格，空 0 格');
    expect(receipt).toContain('另 46 个非空槽位未列出');
    expect(receipt).not.toContain('Bread×4');
  });
  it('reports the skill compass as a selection menu, not chest contents', async () => {
    const compass = { name: 'compass', type: 1, count: 1,
      components: [{ type: 'custom_name', data: '{"text":"技能罗盘"}' }] };
    const bot = {
      _client: { write: () => {} },
      inventory: { items: () => [compass] }, registry: { foodsByName: {} },
      heldItem: compass, currentWindow: null as object | null,
      equip: async () => undefined,
      activateItem: () => {
        bot.currentWindow = { id: 5, type: 'minecraft:generic_9x3', title: '{"text":"✦ 技能罗盘"}',
          inventoryStart: 27, hotbarStart: 54,
          slots: [{ name: 'ender_pearl', type: 2, displayName: '归乡', count: 1 },
            ...Array.from({ length: 53 }, () => null)] };
      },
      deactivateItem: () => undefined,
    };
    const receipt = await useOnce(bot as never, { skill: 'use', item: '技能罗盘' }, { aborted: () => false } as never);
    expect(receipt).toContain('技能罗盘选择菜单');
    expect(receipt).toContain('图标是菜单选项');
    expect(receipt).toContain('不能用 take from:"open"');
    expect(receipt).not.toContain('里面有');
  });
});

describe('opened custom container', () => {
  it('does not deposit into a trial reward claim menu', async () => {
    const copper = { name: 'raw_copper', type: 2, count: 8, slot: 54, metadata: 0 };
    const win = { id: 6, title: '个人试炼奖励箱选择菜单', inventoryStart: 54, inventoryEnd: 90,
      slots: Array.from({ length: 90 }, () => null), items: () => [copper] };
    let transferred = 0;
    const bot = {
      inventory: { items: () => [copper] }, registry: {}, currentWindow: win as typeof win | null,
      transfer: async () => { transferred++; },
      closeWindow: () => { bot.currentWindow = null; },
    };
    await expect(stowIntoOpenWindow(bot as never,
      { skill: 'stow', item: 'raw_copper', count: 8, into: 'open' }, { aborted: () => false } as never))
      .rejects.toThrow('领奖或选择菜单');
    expect(transferred).toBe(0);
    expect(bot.currentWindow).toBeNull();
  });
  it('puts stock into the open window and confirms the player inventory after closing', async () => {
    expect(describeSkill({ skill: 'stow', item: 'bread', count: 32, into: 'open' }))
      .toContain('当前打开的容器');
    const bread = { name: 'bread', type: 2, count: 32, slot: 54, metadata: 0 };
    let playerItems = [bread];
    let windowItems = [bread];
    const slots = Array.from({ length: 90 }, () => null) as Array<typeof bread | null>;
    const win = { id: 5, type: 'minecraft:generic_9x6', title: '个人试炼奖励箱', slots,
      inventoryStart: 54, inventoryEnd: 90, items: () => windowItems };
    const bot = {
      inventory: { items: () => playerItems }, registry: {}, currentWindow: null as typeof win | null,
      transfer: async (opts: { window: typeof win; itemType: number; count: number; destStart: number }) => {
        expect(opts.window).toBe(win);
        expect(opts.destStart).toBe(0);
        expect(opts.itemType).toBe(bread.type);
        slots[0] = { ...bread, count: opts.count, slot: 0 };
        windowItems = [];
      },
      closeWindow: (current: typeof win) => {
        expect(current).toBe(win);
        playerItems = windowItems;
        bot.currentWindow = null;
      },
    };
    setTimeout(() => { bot.currentWindow = win; }, 50);
    const result = await stowIntoOpenWindow(bot as never,
      { skill: 'stow', item: 'bread', count: 32, into: 'open' }, { aborted: () => false } as never);
    expect(result).toContain('存了面包×32');
    expect(slots[0]?.count).toBe(32);
    expect(bot.currentWindow).toBeNull();
  });
});
