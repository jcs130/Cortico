import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from 'mineflayer';
import type { SkillCall } from '../../../src/worlds/minecraft/skills.ts';
import { Executor, type TaskReport } from '../../../src/worlds/minecraft/executor.ts';
import { MinecraftLog } from '../../../src/worlds/minecraft/log.ts';
import { log, makeExecutorOn, nextTaskId, V, waitUntil } from './executor-harness.ts';

type Stack = { name: string; type: number; count: number; metadata: number; slot: number };
type Window = {
  id: number; title: string; inventoryStart: number; inventoryEnd: number;
  slots: Array<Stack | null>; items(): Stack[]; updateSlot(slot: number, item: Stack | null): void;
};
const require = createRequire(import.meta.url);
const dependency = createRequire(require.resolve('mineflayer'));
const windows = dependency('prismarine-windows')('1.20.6') as {
  createWindow(id: number, type: string, title: string): Window;
};
const Item = dependency('prismarine-item')('1.20.6') as {
  fromNotch(packet: unknown): Stack;
};
const registry = require('minecraft-data')('1.20.6') as Bot['registry'];

/** Real 1.20.6 windows keep window 0 unchanged until container close. */
function rig(opts: {
  bag?: Record<string, number>; box?: Record<string, number>; opens?: boolean; openDelayMs?: number;
  afterTransfer?: (r: ReturnType<typeof rig>, source: number, dest: number, before: Stack) => void;
} = {}) {
  const inventory = windows.createWindow(0, 'minecraft:inventory', 'Inventory');
  const win = windows.createWindow(7, 'minecraft:generic_9x3', 'Warehouse');
  const events = new EventEmitter();
  const client = Object.assign(new EventEmitter(), { write() {} });
  const stack = (name: string, count: number): Stack => Item.fromNotch({
    itemId: registry.itemsByName[name].id, itemCount: count, components: [],
  });
  let opens = 0;
  const closed: Window[] = [];
  const transfers: Array<[number, number]> = [];
  Object.entries(opts.bag ?? { compass: 1, bread: 8, arrow: 6 }).forEach(([name, count], i) => {
    inventory.updateSlot(9 + i, stack(name, count));
  });
  Object.entries(opts.box ?? {}).forEach(([name, count], i) => win.updateSlot(i, stack(name, count)));
  const bot = {
    entity: { id: 1, position: new V(0.5, 64, 0.5) },
    game: { dimension: 'overworld' }, health: 20, entities: {}, registry, inventory, _client: client,
    on: events.on.bind(events), removeListener: events.removeListener.bind(events),
    currentWindow: null as Window | null, heldItem: null as Stack | null,
    pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    blockAt: (pos: V) => ({ name: pos.x === 2 && pos.y === 64 && pos.z === 0 ? 'chest' : 'air',
      position: pos, boundingBox: pos.x === 2 ? 'block' : 'empty' }),
    findBlocks: () => [], lookAt: async () => {},
    equip: async (item: Stack) => { bot.heldItem = item; },
    unequip: async () => { bot.heldItem = null; },
    activateBlock: async () => { if (opts.openDelayMs) setTimeout(open, opts.openDelayMs); else open(); },
    activateItem: () => { if (opts.openDelayMs) setTimeout(open, opts.openDelayMs); else open(); },
    deactivateItem: () => {},
    chat: () => { setTimeout(open, opts.openDelayMs ?? 100); },
    closeWindow: (window: Window) => {
      closed.push(window);
      for (let i = 0; i < 36; i++) {
        const item = window.slots[window.inventoryStart + i];
        inventory.updateSlot(inventory.inventoryStart + i, item ? stack(item.name, item.count) : null);
      }
      if (bot.currentWindow === window) bot.currentWindow = null;
      events.emit('windowClose', window);
    },
    transfer: async (options: { window: Window; itemType: number; count: number;
      sourceStart: number; sourceEnd: number; destStart: number; destEnd: number }) => {
      expect(options.window).toBe(bot.currentWindow);
      const source = win.slots.findIndex((item, i) => i >= options.sourceStart && i < options.sourceEnd
        && item?.type === options.itemType);
      const dest = win.slots.findIndex((item, i) => i >= options.destStart && i < options.destEnd && item === null);
      if (dest < 0) throw new Error('no empty slot');
      const before = { ...win.slots[source]! };
      const amount = Math.min(before.count, options.count);
      win.updateSlot(source, before.count > amount ? stack(before.name, before.count - amount) : null);
      win.updateSlot(dest, stack(before.name, amount));
      transfers.push([source, dest]);
      opts.afterTransfer?.(result, source, dest, before);
    },
  };
  const open = (): void => {
    if (opts.opens === false) return;
    opens++;
    for (let i = 0; i < 36; i++) {
      const item = inventory.slots[inventory.inventoryStart + i];
      win.updateSlot(win.inventoryStart + i, item ? stack(item.name, item.count) : null);
    }
    bot.currentWindow = win;
    // Native open establishes the object, then complete contents make windowOpen ready.
    client.emit('open_window', { windowId: win.id, inventoryType: 2, windowTitle: win.title });
    client.emit('window_items', { windowId: win.id, items: [...win.slots] });
    events.emit('windowOpen', win);
  };
  const result = { bot, win, inventory, open, stack, closed, transfers, events, get opens() { return opens; } };
  return result;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('container item labels and registry IDs', () => {
  it.each(['牛排', 'Steak', 'steak'])('returns the real ID for %s and accepts a subsequent explicit take', async (label) => {
    const r = rig({ box: { cooked_beef: 48 } });
    const { exec, reports } = makeExecutorOn(r.bot);
    exec.submit([{ skill: 'use', item: 'compass' }, { skill: 'take', item: label, count: 4, from: 'open' }]);
    await waitUntil(() => reports.length === 1, 8000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('对应当前物品 ID:cooked_beef');
    expect(reports[0].text).toContain('牛排(cooked_beef)×48');
    expect(r.transfers).toHaveLength(0);
    expect(r.inventory.items().some(item => item.name === 'cooked_beef')).toBe(false);

    exec.submit([{ skill: 'use', item: 'compass' }, { skill: 'take', item: 'cooked_beef', count: 4, from: 'open' }]);
    await waitUntil(() => reports.length === 2, 8000);
    expect(reports[1].kind).toBe('done');
    expect(r.inventory.items().find(item => item.name === 'cooked_beef')?.count).toBe(4);
    expect(r.win.slots.slice(0, r.win.inventoryStart).find(item => item?.name === 'cooked_beef')?.count).toBe(44);
  });
});

describe('Executor container window dependencies', () => {
  it.each(['block', 'item', 'command'] as const)('keeps one %s-opened window through an explicit stow dependency chain', async (opener) => {
    const r = rig();
    const { exec, reports } = makeExecutorOn(r.bot);
    const first: SkillCall = opener === 'block' ? { skill: 'use', at: [2, 64, 0] }
      : opener === 'item' ? { skill: 'use', item: 'compass' }
        : { skill: 'chat', text: '/warehouse open' };
    expect(exec.submitDetailed([
      first,
      { skill: 'stow', item: 'bread', count: 8, into: 'open', needs: [1] },
      { skill: 'stow', item: 'arrow', count: 6, into: 'open', needs: [2] },
    ]).accepted).toBe(true);
    await waitUntil(() => reports.length === 1, 8_000);
    expect(reports[0].kind).toBe('done');
    expect(r.win.slots.slice(0, 27).filter(Boolean).map((it) => [it!.name, it!.count]))
      .toEqual([['bread', 8], ['arrow', 6]]);
    expect(r.inventory.items().map((item) => item.name)).toEqual(['compass']);
    expect(r.opens).toBe(1);
    expect(r.closed).toEqual([r.win]);
    expect(r.bot.currentWindow).toBeNull();
  });

  it.each(['block', 'item', 'command'] as const)('waits for a fresh %s window instead of adopting the existing container', async (opener) => {
    const r = rig({ openDelayMs: 100 });
    const previous = windows.createWindow(6, 'minecraft:generic_9x3', 'Previously opened warehouse');
    previous.updateSlot(27, r.stack('bread', 8));
    r.bot.currentWindow = previous;
    const { exec, reports } = makeExecutorOn(r.bot);
    const first: SkillCall = opener === 'block' ? { skill: 'use', at: [2, 64, 0] }
      : opener === 'item' ? { skill: 'use', item: 'compass' }
        : { skill: 'chat', text: '/warehouse open' };
    exec.submit([first, { skill: 'stow', item: 'bread', count: 8, into: 'open', needs: [1] }]);
    // A delayed ready notification for the baseline object is not a fresh open.
    setTimeout(() => r.events.emit('windowOpen', previous), 50);
    await waitUntil(() => reports.length === 1, 5_000);
    expect(reports[0].kind).toBe('done');
    expect(r.opens).toBe(1);
    expect(r.transfers).toHaveLength(1);
    expect(r.closed).toEqual([r.win]);
    expect(previous.slots[27]?.count).toBe(8);
    expect(r.win.slots[0]?.name).toBe('bread');
    expect(r.bot.currentWindow).toBeNull();
    expect(r.events.listenerCount('windowOpen')).toBe(0);
  });

  it.each(['block', 'item', 'command'] as const)('fails a %s opener that leaves only the pre-existing window', async (opener) => {
    const r = rig({ opens: false });
    const previous = windows.createWindow(6, 'minecraft:generic_9x3', 'Previously opened warehouse');
    previous.updateSlot(27, r.stack('bread', 8));
    r.bot.currentWindow = previous;
    const { exec, reports } = makeExecutorOn(r.bot);
    const first: SkillCall = opener === 'block' ? { skill: 'use', at: [2, 64, 0] }
      : opener === 'item' ? { skill: 'use', item: 'compass' }
        : { skill: 'chat', text: '/warehouse open' };
    exec.submit([first, { skill: 'stow', item: 'bread', count: 8, into: 'open', needs: [1] }]);
    setTimeout(() => r.events.emit('windowOpen', previous), 50);
    await waitUntil(() => reports.length === 1, 5_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没有打开新的');
    expect(reports[0].text).toContain('跳过');
    expect(r.transfers).toEqual([]);
    expect(r.closed).toEqual([]);
    expect(previous.slots[27]?.count).toBe(8);
    expect(r.bot.currentWindow).toBe(previous);
    expect(r.events.listenerCount('windowOpen')).toBe(0);
  });

  it.each(['block', 'item', 'command'] as const)('does not adopt a second %s window with the same numeric id', async (opener) => {
    const r = rig({ openDelayMs: 100 });
    const replacement = windows.createWindow(r.win.id, 'minecraft:generic_9x3', 'Same id, different object');
    replacement.updateSlot(27, r.stack('bread', 8));
    const reports: TaskReport[] = [];
    const diag = new MinecraftLog();
    const diagnostic = vi.spyOn(diag, 'write');
    const exec = new Executor({ getBot: () => r.bot as never, log, diag,
      nextId: nextTaskId(), report: (report) => reports.push(report) });
    const first: SkillCall = opener === 'block' ? { skill: 'use', at: [2, 64, 0] }
      : opener === 'item' ? { skill: 'use', item: 'compass' }
        : { skill: 'chat', text: '/warehouse open' };
    exec.submit([first, { skill: 'stow', item: 'bread', count: 8, into: 'open', needs: [1] }]);
    const replace = (window: Window): void => {
      if (window !== r.win) return;
      r.bot.currentWindow = replacement;
      r.events.emit('windowOpen', replacement);
    };
    // Register after submit so the executor observes A before the incompatible B arrives.
    r.events.on('windowOpen', replace);
    await waitUntil(() => reports.length === 1, 5_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('窗口已关闭或被替换');
    expect(r.transfers).toEqual([]);
    expect(r.closed).toEqual([]);
    expect(r.bot.currentWindow).toBe(replacement);
    expect(replacement.slots[27]?.count).toBe(8);
    const candidate = diagnostic.mock.calls.map(([entry]) => entry).find((entry) => entry.event === 'hold-window-candidate');
    const mismatch = diagnostic.mock.calls.map(([entry]) => entry).find((entry) => entry.event === 'hold-window-mismatch');
    expect(candidate?.data).toMatchObject({ step: 1, source: 'open-packet', windowId: r.win.id });
    expect(mismatch?.data).toMatchObject({ step: 1, source: 'window-open', windowId: r.win.id, heldWindowId: null,
      candidateWindowId: r.win.id });
    expect(mismatch?.data?.windowInstance).not.toBe(mismatch?.data?.candidateWindowInstance);
    expect(mismatch?.data?.candidateWindowInstance).toBe(candidate?.data?.windowInstance);
    expect(diagnostic.mock.calls.some(([entry]) => entry.event === 'hold-window-bound')).toBe(false);
    expect(mismatch?.data).not.toHaveProperty('slots');
    r.events.removeListener('windowOpen', replace);
    expect(r.events.listenerCount('windowOpen')).toBe(0);
  });

  it('settles each needs/expect step before a take → stow → take chain consumes the same window', async () => {
    const r = rig({ box: { diamond: 3 } });
    const { exec, reports } = makeExecutorOn(r.bot);
    const submission = exec.submitDetailed([
      { skill: 'chat', text: '/warehouse open' },
      { skill: 'take', item: 'diamond', count: 2, from: 'open', needs: [1],
        expect: { has: { item: 'diamond', count: 2 } } },
      { skill: 'stow', item: 'bread', count: 8, into: 'open', needs: [2] },
      { skill: 'take', item: 'diamond', count: 1, from: 'open', needs: [3],
        expect: { has: { item: 'diamond', count: 3 } } },
    ]);
    expect(submission.accepted, submission.receipt).toBe(true);
    await waitUntil(() => reports.length === 1, 8_000);
    expect(reports[0].kind).toBe('done');
    expect(r.inventory.items().filter((item) => item.name === 'diamond').reduce((n, it) => n + it.count, 0)).toBe(3);
    expect(r.closed).toEqual([r.win]);
    expect(r.transfers).toHaveLength(3);
  });

  it.each(['item', 'command'] as const)('fails a %s opener with no window and skips dependent empty operations', async (opener) => {
    const r = rig({ opens: false });
    const { exec, reports } = makeExecutorOn(r.bot);
    const first: SkillCall = opener === 'item' ? { skill: 'use', item: 'compass' }
      : { skill: 'chat', text: '/warehouse open' };
    expect(exec.submitDetailed([
      first,
      { skill: 'stow', item: 'bread', count: 8, into: 'open', needs: [1] },
      { skill: 'stow', item: 'arrow', count: 6, into: 'open', needs: [2] },
    ]).accepted).toBe(true);
    await waitUntil(() => reports.length === 1, 5_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没有打开');
    expect(reports[0].text).toContain('跳过');
    expect(reports[0].text).not.toContain('做成的');
    expect(r.transfers).toEqual([]);
  });

  it('preserves standalone use observation when an item has no observable side effect', async () => {
    const r = rig({ opens: false });
    const { exec, reports } = makeExecutorOn(r.bot);
    exec.submit([{ skill: 'use', item: 'compass' }]);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(reports[0].text).toContain('没有登记的使用效果');
  });

  it('closes a rolled-back window and does not run the dependent transfer', async () => {
    const r = rig({ afterTransfer: (r, source, dest, before) => {
      setTimeout(() => { r.win.updateSlot(dest, null); r.win.updateSlot(source, before); }, 200);
    } });
    const { exec, reports } = makeExecutorOn(r.bot);
    exec.submit([
      { skill: 'chat', text: '/warehouse open' },
      { skill: 'stow', item: 'bread', count: 8, into: 'open', needs: [1] },
      { skill: 'stow', item: 'arrow', count: 6, into: 'open', needs: [2] },
    ]);
    await waitUntil(() => reports.length === 1, 5_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('rolled-back');
    expect(r.transfers).toHaveLength(1);
    expect(r.closed).toEqual([r.win]);
    expect(r.inventory.items().find((item) => item.name === 'bread')?.count).toBe(8);
  });

  it('cannot confirm a transfer from a replacement window and does not close that window', async () => {
    const replacement = windows.createWindow(8, 'minecraft:generic_9x3', 'Other warehouse');
    const r = rig({ afterTransfer: (r) => {
      setTimeout(() => { r.bot.currentWindow = replacement; }, 200);
    } });
    const { exec, reports } = makeExecutorOn(r.bot);
    exec.submit([
      { skill: 'chat', text: '/warehouse open' },
      { skill: 'stow', item: 'bread', count: 8, into: 'open', needs: [1] },
      { skill: 'stow', item: 'arrow', count: 6, into: 'open', needs: [2] },
    ]);
    await waitUntil(() => reports.length === 1, 5_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('窗口已关闭或被替换');
    expect(r.transfers).toHaveLength(1);
    expect(r.closed).toEqual([]);
    expect(r.bot.currentWindow).toBe(replacement);
  });

  it.each(['stow', 'take'] as const)('stops an independent %s batch when its directly opened window is replaced', async (kind) => {
    const replacement = windows.createWindow(8, 'minecraft:generic_9x3', 'Other warehouse');
    const r = rig({ box: { diamond: 2, iron_ingot: 3 }, afterTransfer: (r) => {
      r.bot.currentWindow = replacement;
    } });
    replacement.updateSlot(0, r.stack('iron_ingot', 3));
    replacement.updateSlot(27, r.stack('arrow', 6));
    r.open(); // The task starts from an existing window, without a use/chat opener.
    const { exec, reports } = makeExecutorOn(r.bot);
    const steps: SkillCall[] = kind === 'stow'
      ? [{ skill: 'stow', item: 'bread', count: 8, into: 'open' },
        { skill: 'stow', item: 'arrow', count: 6, into: 'open' }]
      : [{ skill: 'take', item: 'diamond', count: 2, from: 'open' },
        { skill: 'take', item: 'iron_ingot', count: 3, from: 'open' }];
    expect(exec.submitDetailed(steps).accepted).toBe(true);
    await waitUntil(() => reports.length === 1, 5_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('窗口已关闭或被替换');
    expect(r.transfers).toHaveLength(1);
    expect(r.closed).toEqual([]);
    expect(replacement.slots[0]?.count).toBe(3);
    expect(replacement.items().find((item) => item.name === 'arrow')?.count).toBe(6);
    expect(r.bot.currentWindow).toBe(replacement);
  });

  it('stops compacting at a replacement and does not let the next independent open step use it', async () => {
    const r = rig({ box: { bread: 2 } });
    r.win.updateSlot(1, r.stack('bread', 2));
    r.win.updateSlot(2, r.stack('bread', 2));
    const replacement = windows.createWindow(8, 'minecraft:generic_9x3', 'Other warehouse');
    replacement.updateSlot(27, r.stack('arrow', 6));
    let moves = 0;
    Object.assign(r.bot, { moveSlotItem: async (source: number, dest: number) => {
      expect(r.bot.currentWindow).toBe(r.win);
      const count = r.win.slots[source]!.count;
      r.win.updateSlot(dest, r.stack('bread', r.win.slots[dest]!.count + count));
      r.win.updateSlot(source, null);
      moves++;
      r.bot.currentWindow = replacement;
    } });
    r.open();
    const { exec, reports } = makeExecutorOn(r.bot);
    expect(exec.submitDetailed([
      { skill: 'compact' },
      { skill: 'stow', item: 'arrow', count: 6, into: 'open' },
    ]).accepted).toBe(true);
    await waitUntil(() => reports.length === 1, 5_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('窗口已关闭或被替换');
    expect(moves).toBe(1);
    expect(r.transfers).toEqual([]);
    expect(r.closed).toEqual([]);
    expect(replacement.items().find((item) => item.name === 'arrow')?.count).toBe(6);
    expect(r.bot.currentWindow).toBe(replacement);
  });

  it('releases a normally closed original window before an intentional new opener in the same task', async () => {
    const r = rig();
    const nextWindow = windows.createWindow(8, 'minecraft:generic_9x3', 'Next warehouse');
    r.open();
    r.bot.chat = () => {
      r.inventory.items().forEach((item, i) => nextWindow.updateSlot(27 + i, r.stack(item.name, item.count)));
      r.bot.currentWindow = nextWindow;
      r.events.emit('windowOpen', nextWindow);
      r.bot._client.emit('window_items', { windowId: nextWindow.id, items: [...nextWindow.slots] });
    };
    const { exec, reports } = makeExecutorOn(r.bot);
    expect(exec.submitDetailed([
      { skill: 'compact' },
      { skill: 'chat', text: '/warehouse next' },
      { skill: 'compact', needs: [2] },
    ]).accepted).toBe(true);
    await waitUntil(() => reports.length === 1, 5_000);
    expect(reports[0].kind).toBe('done');
    expect(r.closed).toEqual([r.win, nextWindow]);
    expect(r.bot.currentWindow).toBeNull();
  });

  it('blocks a replacement between dependent steps without operating or closing the replacement', async () => {
    const r = rig();
    const replacement = windows.createWindow(8, 'minecraft:generic_9x3', 'Other warehouse');
    replacement.updateSlot(27, r.stack('arrow', 6));
    const reports: TaskReport[] = [];
    const diag = new MinecraftLog();
    const write = diag.write.bind(diag);
    diag.write = (entry) => {
      write(entry);
      if (entry.event === 'done' && (entry.data?.call as SkillCall | undefined)?.skill === 'stow') {
        r.bot.currentWindow = replacement;
      }
    };
    const exec = new Executor({ getBot: () => r.bot as never, log, diag,
      nextId: nextTaskId(), report: (report) => reports.push(report) });
    exec.submit([
      { skill: 'chat', text: '/warehouse open' },
      { skill: 'stow', item: 'bread', count: 8, into: 'open', needs: [1] },
      { skill: 'stow', item: 'arrow', count: 6, into: 'open', needs: [2] },
    ]);
    await waitUntil(() => reports.length === 1, 5_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('不能把后续操作改投另一窗口');
    expect(r.transfers).toHaveLength(1);
    expect(r.closed).toEqual([]);
    expect(replacement.items().find((item) => item.name === 'arrow')?.count).toBe(6);
    expect(r.bot.currentWindow).toBe(replacement);
  });

  it.each(['block', 'item'] as const)('keeps the first identity when a %s opener is replaced during settling', async (opener) => {
    const r = rig();
    const replacement = windows.createWindow(8, 'minecraft:generic_9x3', 'Other warehouse');
    replacement.updateSlot(27, r.stack('bread', 8));
    const { exec, reports } = makeExecutorOn(r.bot);
    const first: SkillCall = opener === 'block' ? { skill: 'use', at: [2, 64, 0],
      expect: { has: { item: 'bread', count: 1 } } }
      : { skill: 'use', item: 'compass', expect: { has: { item: 'bread', count: 1 } } };
    exec.submit([first, { skill: 'stow', item: 'bread', count: 8, into: 'open', needs: [1] }]);
    setTimeout(() => { r.bot.currentWindow = replacement; }, 100);
    await waitUntil(() => reports.length === 1, 5_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('窗口已关闭或被替换');
    expect(r.transfers).toEqual([]);
    expect(r.closed).toEqual([]);
    expect(r.bot.currentWindow).toBe(replacement);
  });

  it('does not let sufficient stock in a replacement window overturn an unconfirmed take', async () => {
    const replacement = windows.createWindow(8, 'minecraft:generic_9x3', 'Other warehouse');
    const r = rig({ box: { diamond: 2 }, afterTransfer: (r) => {
      replacement.updateSlot(27, r.stack('diamond', 20));
      setTimeout(() => { r.bot.currentWindow = replacement; }, 200);
    } });
    const { exec, reports } = makeExecutorOn(r.bot);
    exec.submit([
      { skill: 'chat', text: '/warehouse open' },
      { skill: 'take', item: 'diamond', count: 1, from: 'open', needs: [1],
        expect: { has: { item: 'diamond', count: 1 } } },
      { skill: 'stow', item: 'bread', count: 8, into: 'open', needs: [2] },
    ]);
    await waitUntil(() => reports.length === 1, 5_000);
    expect(reports[0].kind).toBe('blocked');
    expect(r.transfers).toHaveLength(1);
    expect(r.closed).toEqual([]);
    expect(r.bot.currentWindow).toBe(replacement);
  });

  it('releases a retained window when the task is cancelled during confirmation', async () => {
    const r = rig();
    const { exec, reports } = makeExecutorOn(r.bot);
    exec.submit([
      { skill: 'chat', text: '/warehouse open' },
      { skill: 'stow', item: 'bread', count: 8, into: 'open', needs: [1] },
      { skill: 'stow', item: 'arrow', count: 6, into: 'open', needs: [2] },
    ]);
    await waitUntil(() => r.transfers.length === 1);
    exec.clear(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.transfers).toHaveLength(1);
    expect(r.closed).toEqual([r.win]);
    expect(r.bot.currentWindow).toBeNull();
    expect(reports).toHaveLength(1);
    expect(reports[0].kind).toBe('cancelled');
    expect(r.events.listenerCount('windowOpen')).toBe(0);
  });

  it.each(['block', 'item', 'command'] as const)('closes the original window when cancelled during %s opening', async (opener) => {
    const r = rig({ openDelayMs: 100 });
    const { exec, reports } = makeExecutorOn(r.bot);
    const first: SkillCall = opener === 'block' ? { skill: 'use', at: [2, 64, 0] }
      : opener === 'item' ? { skill: 'use', item: 'compass' }
        : { skill: 'chat', text: '/warehouse open' };
    exec.submit([first, { skill: 'stow', item: 'bread', count: 8, into: 'open', needs: [1] }]);
    r.bot.on('windowOpen', () => exec.clear(true));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(r.closed).toEqual([r.win]);
    expect(r.transfers).toEqual([]);
    expect(r.bot.currentWindow).toBeNull();
    expect(reports).toHaveLength(1);
    expect(reports[0].kind).toBe('cancelled');
    expect(r.events.listenerCount('windowOpen')).toBe(1);
  });

  it('does not perform the dependent transfer after a window inventory expectation fails', async () => {
    const r = rig({ box: { diamond: 2 } });
    const { exec, reports } = makeExecutorOn(r.bot);
    exec.submit([
      { skill: 'chat', text: '/warehouse open' },
      { skill: 'take', item: 'diamond', count: 1, from: 'open', needs: [1],
        expect: { has: { item: 'diamond', count: 2 } } },
      { skill: 'stow', item: 'bread', count: 8, into: 'open', needs: [2] },
    ]);
    await waitUntil(() => reports.length === 1, 5_000);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('核验:落空');
    expect(r.transfers).toHaveLength(1);
    expect(r.closed).toEqual([r.win]);
    expect(r.inventory.items().find((item) => item.name === 'bread')?.count).toBe(8);
  });
});
