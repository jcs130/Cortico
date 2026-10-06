import { describe, expect, it, vi } from 'vitest';
import { ChestBook } from '../../../src/worlds/minecraft/chests.ts';
import { findContainers, orderForStow, orderForTake, rememberNonStorageMenu,
  recentStorageRouteFailure, rememberChest, rememberStorageAccessFailure, rememberStorageWriteFailure, rememberWindow,
  storageSkipReason } from '../../../src/worlds/minecraft/containers.ts';
import { V, chestBot, makeExecutorOn, makeExecutorWith, waitUntil } from './executor-harness.ts';
import { skillStow, skillTakeAt } from '../../../src/worlds/minecraft/skills-container.ts';

describe('automatic chest selection', () => {
  it('skips a selection window on subsequent storage plans and can choose another chest', () => {
    const claim = { x: 2, y: 64, z: 0, name: 'chest', d: 2 };
    const storage = { x: 7, y: 64, z: 0, name: 'chest', d: 7 };
    const bot = { game: { dimension: 'overworld' }, registry: { itemsByName: {} } } as never;
    const found = [claim, storage];
    expect(orderForStow(found, {} as never, bot, 'cobblestone')).toEqual(found);
    rememberNonStorageMenu(bot, claim);
    expect(orderForStow(found, {} as never, bot, 'cobblestone')).toEqual([storage]);
    expect(orderForStow([claim], {} as never, bot, 'dirt')).toEqual([]);
  });
  it('records a chest shaped claim GUI as a menu and rejects storage plans before enqueue', () => {
    const { bot } = chestBot({ inv: { dirt: 2 } });
    const cell = { x: 2, y: 64, z: 0 };
    const book = new ChestBook(null);
    const seen = rememberWindow(bot as never, { chests: book } as never, cell, 'chest',
      { title: '个人试炼奖励箱选择菜单' } as never);
    expect(seen).toContain('不能当储物箱');
    expect(book.get('overworld', cell)).toBeUndefined();
    const { exec } = makeExecutorOn(bot);
    const explicit = exec.submit([
      { skill: 'use', at: [2, 64, 0] },
      { skill: 'stow', item: 'dirt', count: 1, into: 'open' },
    ]);
    expect(explicit).toContain('这一单我没接');
    expect(explicit).toContain('选择菜单');
    const automatic = exec.submit([{ skill: 'stow', item: 'dirt', count: 1 }]);
    expect(automatic).toContain('这一单我没接');
    expect(automatic).toContain('已有访问或存入失败记录');
    expect(exec.currentTask).toBeNull();
    const discard = exec.submit([
      { skill: 'toss', item: 'dirt', count: 1 },
      { skill: 'toss', item: 'stone', count: 1 },
    ]);
    expect(discard).toContain('这一单我没接');
    expect(discard).toContain('原地抛出 2 类物品');
    expect(exec.currentTask).toBeNull();
  });
  it('retries an unreachable container after the player changes approach', () => {
    const { bot } = chestBot();
    const deep = { x: 3, y: 40, z: 0, distanceTo: () => 24 };
    bot.findBlocks = () => [deep] as never;
    bot.blockAt = () => ({ name: 'chest' }) as never;
    expect(findContainers(bot as never, 32)).toHaveLength(1);
    rememberStorageAccessFailure(bot as never, deep, '寻路未前进');
    expect(storageSkipReason(bot as never, deep, 'dirt')).toContain('寻路未前进');
    expect(orderForStow(findContainers(bot as never, 32), {} as never, bot as never, 'dirt')).toEqual([]);
    bot.entity.position = new V(9, 64, 0);
    expect(storageSkipReason(bot as never, deep, 'dirt')).toBeNull();
    expect(orderForStow(findContainers(bot as never, 32), {} as never, bot as never, 'dirt')).toHaveLength(1);
    expect(recentStorageRouteFailure(bot as never, deep)).toContain('寻路未前进');
    const { exec } = makeExecutorOn(bot);
    expect(exec.submit([{ skill: 'goto', at: [3, 40, 0] }])).toContain('这处容器刚才寻路失败');
  });
  it('tracks item-specific write refusals without disabling other items', () => {
    const { bot } = chestBot();
    const chest = { x: 2, y: 64, z: 0 };
    rememberStorageWriteFailure(bot as never, chest, 'dirt', '服务端拒绝');
    expect(storageSkipReason(bot as never, chest, 'dirt')).toContain('服务端拒绝');
    expect(storageSkipReason(bot as never, chest, 'stone')).toBeNull();
  });
  it('clears a no-room refusal after a real window observation shows a free slot', () => {
    const { bot } = chestBot();
    const chest = { x: 2, y: 64, z: 0 };
    rememberStorageWriteFailure(bot as never, chest, 'iron_boots', '那一边没空位了');
    rememberStorageWriteFailure(bot as never, chest, 'dirt', '服务端保护拒绝');
    const book = new ChestBook(null);
    rememberChest({ chests: book } as never, bot as never, chest,
      { containerItems: () => [{ name: 'dirt', count: 1 }], inventoryStart: 27 });
    expect(storageSkipReason(bot as never, chest, 'iron_boots')).toBeNull();
    expect(storageSkipReason(bot as never, chest, 'dirt')).toContain('服务端保护拒绝');
  });
  it('requires a full stack to leave a confirmed full chest before storing new gear', () => {
    const { bot } = chestBot({ inv: { iron_boots: 2 }, box: { dirt: 2 } });
    Object.assign(bot.registry.itemsByName, { iron_boots: { stackSize: 1 } });
    const chest = { x: 2, y: 64, z: 0 };
    const book = new ChestBook(null);
    book.remember('overworld', chest, [{ name: 'dirt', count: 2 }, { name: 'iron_boots', count: 1 }], 27, 27);
    rememberStorageWriteFailure(bot as never, chest, 'iron_boots', '那一边没空位了');
    const { exec } = makeExecutorWith(bot, book);
    const partial = exec.submitDetailed([
      { skill: 'use', at: [2, 64, 0] },
      { skill: 'take', item: 'dirt', count: 1, from: 'open' },
      { skill: 'stow', item: 'iron_boots', count: 2, into: 'open' },
    ]);
    expect(partial.accepted).toBe(false);
    expect(partial.receipt).toContain('只从一堆取走一件通常仍占原格');
    const complete = exec.submitDetailed([
      { skill: 'use', at: [2, 64, 0] },
      { skill: 'take', item: 'dirt', count: 2, from: 'open' },
      { skill: 'stow', item: 'iron_boots', count: 1, into: 'open' },
    ]);
    expect(complete.accepted).toBe(true);
    exec.shutdown();
  });
  it('rejects a full-chest exchange that refills every slot it just freed', () => {
    const { bot } = chestBot({ inv: { iron_boots: 2 }, box: { dirt: 2 } });
    Object.assign(bot.registry.itemsByName, { iron_boots: { stackSize: 1 } });
    const chest = { x: 2, y: 64, z: 0 };
    const book = new ChestBook(null);
    book.remember('overworld', chest, [{ name: 'dirt', count: 2 }], 27, 27);
    const { exec } = makeExecutorWith(bot, book);
    const receipt = exec.submitDetailed([
      { skill: 'use', at: [2, 64, 0] },
      { skill: 'take', item: 'dirt', count: 2, from: 'open' },
      { skill: 'stow', item: 'iron_boots', count: 1, into: 'open' },
      { skill: 'stow', item: 'iron_boots', count: 1, into: 'open' },
    ]);
    expect(receipt.accepted).toBe(false);
    expect(receipt.receipt).toContain('只保证空出 0 格');
    expect(receipt.receipt).toContain('勿再存回原箱');
  });
  it('rechecks a menu observation when the block at that position changes', () => {
    const { bot } = chestBot();
    const cell = { x: 2, y: 64, z: 0 };
    rememberNonStorageMenu(bot as never, cell);
    expect(storageSkipReason(bot as never, cell)).toContain('选择菜单');
    bot.blockAt = () => ({ name: 'barrel' }) as never;
    expect(storageSkipReason(bot as never, cell)).toBeNull();
  });
  it('tries another visible container after the first path fails', async () => {
    const { bot, box } = chestBot({ inv: { cobblestone: 4 } });
    const blocked = new V(6, 64, 0);
    const reachable = new V(12, 64, 0);
    bot.findBlocks = () => [blocked, reachable];
    bot.blockAt = (p: V) => ({ name: 'chest', position: p, boundingBox: 'block' }) as never;
    bot.pathfinder.goto = (async (goal: { x: number; y: number; z: number }) => {
      if (goal.x === blocked.x) throw new Error('no route');
      bot.entity.position = new V(goal.x, goal.y, goal.z);
    }) as never;
    const result = await skillStow(bot as never,
      { skill: 'stow', item: 'cobblestone', count: 4 }, { aborted: () => false, taskId: 1 } as never);
    expect(result).toContain('存了圆石×4');
    expect(box.get('cobblestone')).toBe(4);
    bot.entity.position = new V(0.5, 64, 0.5);
    expect(storageSkipReason(bot as never, blocked, 'cobblestone')).toContain('no route');
  });
  it('stores only in the explicitly named chest and never falls back to another', async () => {
    const { bot, box } = chestBot({ inv: { cobblestone: 4 } });
    bot.pathfinder.goto = (async (goal: { x: number; y: number; z: number }) => {
      bot.entity.position = new V(goal.x, goal.y, goal.z);
    }) as never;
    await expect(skillStow(bot as never,
      { skill: 'stow', item: 'cobblestone', count: 4, at: [5, 64, 0] },
      { aborted: () => false, taskId: 1 } as never)).rejects.toThrow('不是储物箱');
    expect(box.get('cobblestone')).toBeUndefined();
    const result = await skillStow(bot as never,
      { skill: 'stow', item: 'cobblestone', count: 4, at: [2, 64, 0] },
      { aborted: () => false, taskId: 2 } as never);
    expect(result).toContain('(2, 64, 0)');
    expect(box.get('cobblestone')).toBe(4);
  });
  it('refuses goto plus stow before walking to a nearby coordinate without a confirmed container', () => {
    const { bot } = chestBot({ inv: { cobblestone: 4 } });
    const { exec } = makeExecutorOn(bot);
    const receipt = exec.submit([
      { skill: 'goto', at: [5, 64, 0] },
      { skill: 'stow', item: 'cobblestone', count: 4, at: [5, 64, 0] },
    ]);
    expect(receipt).toContain('这一单我没接');
    expect(receipt).toContain('实际是空气，不是储物箱');
    expect(exec.currentTask).toBeNull();
  });
  it('drops a remembered chest coordinate when a loaded block there is now foliage', async () => {
    const { bot } = chestBot({ inv: { cobblestone: 4 } });
    const cell = { x: 5, y: 64, z: 0 };
    const book = new ChestBook(null);
    book.remember('overworld', cell, [{ name: 'bread', count: 4 }], 1, 27);
    bot.pathfinder.goto = (async (goal: { x: number; y: number; z: number }) => {
      bot.entity.position = new V(goal.x, goal.y, goal.z);
    }) as never;
    bot.blockAt = (p: V) => ({ name: p.x === 5 ? 'oak_leaves' : 'air', position: p }) as never;
    await expect(skillTakeAt(bot as never, { skill: 'take', item: 'bread', count: 4, at: [5, 64, 0] },
      { aborted: () => false, taskId: 1, chests: book } as never))
      .rejects.toThrow('已从仓储账移除这个过期坐标');
    expect(book.get('overworld', cell)).toBeUndefined();
  });
  it('moves consecutive items into one explicit chest with a single open window', async () => {
    vi.useFakeTimers();
    const { bot, box } = chestBot({ inv: { cobblestone: 4, coal: 3 } });
    let openings = 0;
    const open = bot.openContainer;
    bot.openContainer = async (...args: Parameters<typeof open>) => {
      openings++;
      return open(...args);
    };
    const { exec, reports } = makeExecutorOn(bot);
    exec.submit([
      { skill: 'stow', item: 'cobblestone', count: 4, at: [2, 64, 0] },
      { skill: 'stow', item: 'coal', count: 3, at: [2, 64, 0] },
    ]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('done');
    expect(box.get('cobblestone')).toBe(4);
    expect(box.get('coal')).toBe(3);
    expect(openings).toBe(1);
    vi.useRealTimers();
  });
  it('checks a nearby unseen chest before taking a long detour to a remembered one', () => {
    const book = new ChestBook(null);
    const near = { x: 0, y: 64, z: 4, name: 'chest', d: 4 };
    const far = { x: 20, y: 64, z: 0, name: 'chest', d: 20 };
    book.remember('overworld', far, [{ name: 'dirt', count: 16 }], 1, 27);
    const order = orderForTake([near, far], { chests: book } as never,
      { game: { dimension: 'overworld' } } as never, 'dirt');
    expect(order).toEqual([near, far]);
  });
});
