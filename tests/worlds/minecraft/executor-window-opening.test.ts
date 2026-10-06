import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from 'mineflayer';
import type { SkillCall } from '../../../src/worlds/minecraft/skills.ts';
import { Executor, type TaskReport } from '../../../src/worlds/minecraft/executor.ts';
import { MinecraftLog } from '../../../src/worlds/minecraft/log.ts';
import { log, nextTaskId, V, waitUntil } from './executor-harness.ts';

const require = createRequire(import.meta.url);
const dependency = createRequire(require.resolve('mineflayer'));
type Window = NonNullable<Bot['currentWindow']>;

/** Native Mineflayer consumes decoded server packets and emits real window object lifecycles. */
function rig() {
  const registry = dependency('prismarine-registry')('1.20.6');
  const Item = dependency('prismarine-item')(registry);
  const protocol = dependency('minecraft-protocol');
  const serializer = protocol.createSerializer({ state: 'play', isServer: true, version: '1.20.6' });
  const parser = protocol.createDeserializer({ state: 'play', isServer: false, version: '1.20.6' });
  const client = new EventEmitter() as EventEmitter & { write(name: string, packet: unknown): void };
  const sent: Array<{ name: string; packet: unknown }> = [];
  let onUse = (): void => {};
  client.write = (name, packet) => {
    sent.push({ name, packet });
    if (name === 'use_item' || name === 'block_place') onUse();
  };
  const bot = Object.assign(new EventEmitter(), { registry, version: '1.20.6', _client: client,
    supportFeature: registry.supportFeature, QUICK_BAR_START: 36,
    entity: { id: 1, position: new V(0.5, 64, 0.5), yaw: 0, pitch: 0 },
    game: { dimension: 'overworld', gameMode: 'survival' }, health: 20, food: 20, entities: {},
    pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    blockAt: (p: V) => ({ name: p.x === 2 && p.y === 64 && p.z === 0 ? 'chest' : 'air', position: p,
      boundingBox: p.x === 2 ? 'block' : 'empty' }),
    findBlocks: () => [], lookAt: async () => {}, swingArm: () => client.write('arm_animation', { hand: 0 }),
  }) as unknown as Bot;
  require('mineflayer/lib/plugins/inventory.js')(bot, { hideErrors: true });
  const item = (name: string, count: number) => new Item(registry.itemsByName[name].id, count);
  const emit = (name: string, packet: object): void => {
    client.emit('packet', packet, { name });
    client.emit(name, packet);
  };
  const initial = new Array(bot.inventory.slots.length).fill(null);
  initial[36] = item('compass', 1);
  initial[9] = item('bread', 8);
  emit('window_items', { windowId: 0, stateId: 1, items: initial.map(Item.toNotch), carriedItem: Item.toNotch(null) });
  bot.quickBarSlot = 0;
  const updateInventorySlot = bot.inventory.updateSlot.bind(bot.inventory) as
    (slot: number, stack: Bot['heldItem']) => void;
  bot.equip = async (stack) => {
    const selected = typeof stack === 'number' ? bot.inventory.items().find((item) => item.type === stack) : stack;
    if (!selected) throw new Error('no fixture item to equip');
    if (bot.heldItem === selected) return;
    updateInventorySlot(36, selected);
    bot.quickBarSlot = 0;
  };
  bot.unequip = async () => { updateInventorySlot(36, null); };
  const opened: Window[] = [];
  bot.on('windowOpen', (window) => { opened.push(window); });
  const closed: Window[] = [];
  const nativeClose = bot.closeWindow.bind(bot);
  bot.closeWindow = (window) => { closed.push(window); nativeClose(window); };
  const transfers: Window[] = [];
  let afterTransfer = (): void => {};
  bot.transfer = async (options) => {
    const window = options.window ?? bot.currentWindow!;
    transfers.push(window);
    const source = window.slots.findIndex((stack, i) => i >= options.sourceStart && i < options.sourceEnd
      && stack?.type === options.itemType);
    const destination = window.slots.findIndex((stack, i) => i >= options.destStart && i < options.destEnd && !stack);
    if (source < 0 || destination < 0) throw new Error('no transfer slot');
    const before = window.slots[source]!;
    const count = Math.min(before.count, options.count ?? 1);
    emit('set_slot', { windowId: window.id, stateId: 3, slot: source,
      item: Item.toNotch(before.count > count ? item(before.name, before.count - count) : null) });
    emit('set_slot', { windowId: window.id, stateId: 4, slot: destination, item: Item.toNotch(item(before.name, count)) });
    afterTransfer();
  };
  const open = (options: { id?: number; type?: string; title?: unknown; contents?: boolean } = {}): Window => {
    emit('open_window', { windowId: options.id ?? 40, inventoryType: options.type ?? 'minecraft:generic_9x6',
      windowTitle: options.title ?? { text: 'Backpack', color: 'aqua' } });
    const window = bot.currentWindow!;
    if (options.contents !== false) full(window);
    return window;
  };
  const wireOpen = (title: unknown): Window => {
    const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'open_window', params: {
      windowId: 40, inventoryType: 5, windowTitle: title,
    } })).data;
    emit(decoded.name, decoded.params);
    const window = bot.currentWindow!;
    full(window);
    return window;
  };
  const full = (window: Window): void => {
    const contents = new Array(window.slots.length).fill(null);
    contents[0] = item('golden_apple', 46);
    for (let i = 0; i < 36; i++) contents[window.inventoryStart + i] = bot.inventory.slots[9 + i];
    emit('window_items', { windowId: window.id, stateId: 2,
      items: contents.map(Item.toNotch), carriedItem: Item.toNotch(null) });
  };
  bot.chat = () => onUse();
  const diag = new MinecraftLog();
  const diagnostic = vi.spyOn(diag, 'write');
  const reports: TaskReport[] = [];
  const exec = new Executor({ getBot: () => bot, report: (report) => reports.push(report), log,
    diag, nextId: nextTaskId() });
  return { bot, client, emit, open, wireOpen, full, opened, closed, transfers, sent, reports, exec, diagnostic,
    set onUse(value: () => void) { onUse = value; },
    set afterTransfer(value: () => void) { afterTransfer = value; } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const take: SkillCall = { skill: 'take', item: 'golden_apple', count: 1, from: 'open', needs: [1] };

describe('Executor native opening candidates', () => {
  it('accepts same-ID 1.20.6 wire title encodings before any transfer and binds the final object', async () => {
    const r = rig();
    let latest: Window;
    r.onUse = () => {
      r.wireOpen({ type: 'string', value: '§bBackpack' });
      latest = r.wireOpen({ type: 'compound', name: '', value: {
        text: { type: 'string', value: 'Backpack' }, color: { type: 'string', value: 'aqua' },
      } });
    };
    r.exec.submit([{ skill: 'use', item: 'compass' }, take]);
    await waitUntil(() => r.reports.length === 1, 8_000);
    expect(r.reports[0].kind, r.reports[0].text).toBe('done');
    expect(r.opened).toHaveLength(2);
    expect(r.transfers).toEqual([latest!]);
    expect(r.closed).toEqual([latest!]);
    expect(r.bot.inventory.items().find((stack) => stack.name === 'golden_apple')?.count).toBe(1);
    expect(r.diagnostic.mock.calls.some(([event]) => event.event === 'hold-window-mismatch')).toBe(false);
  });

  it('accepts delayed decoration-only resends during one opener without adding a settle delay', async () => {
    const r = rig();
    let latest: Window;
    r.onUse = () => {
      r.open({ title: { text: 'Backpack', color: 'aqua' } });
      setTimeout(() => { latest = r.open({ title: JSON.stringify({ text: 'Backpack', bold: true }) }); }, 10);
    };
    r.exec.submit([{ skill: 'use', item: 'compass' }, take]);
    await waitUntil(() => r.reports.length === 1, 8_000);
    expect(r.reports[0].kind, r.reports[0].text).toBe('done');
    expect(r.transfers).toEqual([latest!]);
    expect(r.closed).toEqual([latest!]);
  });

  it.each(['block', 'item', 'command'] as const)('settles two compatible native %s opens before binding and taking', async (opener) => {
    const r = rig();
    let latest: Window;
    r.onUse = () => {
      r.open();
      latest = r.open();
    };
    const first: SkillCall = opener === 'block' ? { skill: 'use', at: [2, 64, 0] }
      : opener === 'item' ? { skill: 'use', item: 'compass' } : { skill: 'chat', text: '/warehouse open' };
    expect(r.exec.submitDetailed([first, take]).accepted).toBe(true);
    await waitUntil(() => r.reports.length === 1, 8_000);
    expect(r.opened).toHaveLength(2);
    expect(r.opened[0]).not.toBe(r.opened[1]);
    expect(r.opened[0].id).toBe(r.opened[1].id);
    expect(r.reports[0].kind, r.reports[0].text).toBe('done');
    expect(r.transfers).toEqual([latest!]);
    expect(r.closed).toEqual([latest!]);
    expect(r.bot.inventory.items().find((stack) => stack.name === 'golden_apple')?.count).toBe(1);
    expect(latest!.slots[0]?.count).toBe(45);
    const bound = r.diagnostic.mock.calls.map(([event]) => event).filter((event) => event.event === 'hold-window-bound');
    expect(bound).toHaveLength(1);
    expect(bound[0].data).toMatchObject({ source: 'opener-result', windowId: 40, windowInstance: 2 });
  });

  it('ignores a stale native ready notification for A after B has already become current', async () => {
    const r = rig();
    let latest: Window;
    r.onUse = () => {
      r.open({ contents: false });
      latest = r.open({ contents: false });
      r.full(latest);
    };
    r.exec.submit([{ skill: 'use', item: 'compass' }, take]);
    await waitUntil(() => r.reports.length === 1, 8_000);
    expect(r.opened).toHaveLength(2);
    expect(r.opened[0]).not.toBe(latest!);
    expect(r.reports[0].kind).toBe('done');
    expect(r.transfers).toEqual([latest!]);
  });

  it('does not use native cached ready contents without a new complete read for this opening', async () => {
    const r = rig();
    const cached = new Array(90).fill({ itemCount: 0 });
    r.emit('window_items', { windowId: 40, stateId: 2, items: cached, carriedItem: { itemCount: 0 } });
    r.onUse = () => { r.open({ contents: false }); };
    r.exec.submit([{ skill: 'use', item: 'compass' }, take]);
    await waitUntil(() => r.reports.length === 1, 8_000);
    expect(r.opened).toHaveLength(1);
    expect(r.reports[0].kind).toBe('blocked');
    expect(r.transfers).toEqual([]);
    expect(r.bot.inventory.items().map((stack) => stack.name)).toEqual(['bread', 'compass']);
    expect(r.closed).toEqual([]);
    expect(r.diagnostic.mock.calls.some(([event]) => event.event === 'hold-window-close-deferred')).toBe(true);
  });

  it('keeps an unknown cached object blocked across tasks until its actual complete read arrives', async () => {
    const r = rig();
    r.emit('window_items', { windowId: 40, stateId: 2,
      items: new Array(90).fill({ itemCount: 0 }), carriedItem: { itemCount: 0 } });
    r.onUse = () => { r.open({ contents: false }); };
    r.exec.submit([{ skill: 'use', item: 'compass' }, take]);
    await waitUntil(() => r.reports.length === 1, 8_000);
    const unknown = r.bot.currentWindow!;
    r.exec.submit([{ ...take, needs: undefined }]);
    await waitUntil(() => r.reports.length === 2, 8_000);
    expect(r.reports[1].kind).toBe('blocked');
    expect(r.transfers).toEqual([]);
    expect(r.closed).toEqual([]);
    expect(r.bot.currentWindow).toBe(unknown);
    r.full(unknown);
    r.exec.submit([{ ...take, count: 2, needs: undefined }]);
    await waitUntil(() => r.reports.length === 3, 8_000);
    expect(r.reports[2].kind).toBe('done');
    expect(r.transfers).toEqual([unknown]);
    expect(r.bot.inventory.items().find((stack) => stack.name === 'golden_apple')?.count).toBe(2);
  });

  it.each(['id', 'type'] as const)('rejects an incompatible %s while the opener is still settling', async (changed) => {
    const r = rig();
    let replacement: Window;
    r.onUse = () => {
      r.open();
      replacement = r.open(changed === 'id' ? { id: 41 } : { type: 'minecraft:generic_9x3' });
    };
    r.exec.submit([{ skill: 'use', item: 'compass', expect: { has: { item: 'bread', count: 1 } } }, take]);
    await waitUntil(() => r.reports.length === 1, 8_000);
    expect(r.reports[0].kind).toBe('blocked');
    expect(r.transfers).toEqual([]);
    expect(r.closed).toEqual([]);
    expect(r.bot.currentWindow).toBe(replacement!);
  });

  it('accepts a same-ID wire retitle before commitment and uses only its fresh complete contents', async () => {
    const r = rig();
    let latest: Window;
    r.onUse = () => {
      r.wireOpen({ type: 'compound', name: '', value: {
        text: { type: 'string', value: 'Visitor的大背包' }, color: { type: 'string', value: 'aqua' },
      } });
      latest = r.wireOpen({ type: 'string', value: '§b大背包' });
    };
    r.exec.submit([{ skill: 'use', item: 'compass' }, take]);
    await waitUntil(() => r.reports.length === 1, 8_000);
    expect(r.reports[0].kind, r.reports[0].text).toBe('done');
    expect(r.transfers).toEqual([latest!]);
    expect(r.closed).toEqual([latest!]);
    expect(r.bot.inventory.items().find((stack) => stack.name === 'golden_apple')?.count).toBe(1);
  });

  it('does not treat a retitled object with only cached contents as ready', async () => {
    const r = rig();
    r.onUse = () => {
      r.open({ title: { text: 'Initial title' } });
      r.open({ title: { text: 'Updated title' }, contents: false });
    };
    r.exec.submit([{ skill: 'use', item: 'compass' }, take]);
    await waitUntil(() => r.reports.length === 1, 8_000);
    expect(r.reports[0].kind).toBe('blocked');
    expect(r.transfers).toEqual([]);
    expect(r.closed).toEqual([]);
  });

  it.each([false, true])('does not adopt a compatible reopen after close, first contents=%s', async (contents) => {
    const r = rig();
    let replacement: Window;
    r.onUse = () => {
      r.open({ contents });
      r.emit('close_window', { windowId: 40 });
      replacement = r.open();
    };
    r.exec.submit([{ skill: 'use', item: 'compass' }, take]);
    await waitUntil(() => r.reports.length === 1, 8_000);
    expect(r.reports[0].kind).toBe('blocked');
    expect(r.transfers).toEqual([]);
    expect(r.closed).toEqual([]);
    expect(r.bot.currentWindow).toBe(replacement!);
  });

  it('does not replace an already committed window after the first transfer', async () => {
    const r = rig();
    r.onUse = () => { r.open(); };
    let replacement: Window;
    r.afterTransfer = () => { replacement = r.open(); };
    r.exec.submit([{ skill: 'use', item: 'compass' }, take,
      { skill: 'stow', item: 'bread', count: 8, into: 'open', needs: [2] }]);
    await waitUntil(() => r.reports.length === 1, 8_000);
    expect(r.reports[0].kind).toBe('blocked');
    expect(r.transfers).toHaveLength(1);
    expect(r.transfers[0]).not.toBe(replacement!);
    expect(r.closed).toEqual([]);
    expect(r.bot.currentWindow).toBe(replacement!);
  });

  it('does not let an existing inventory expectation overturn an opener error', async () => {
    const r = rig();
    r.onUse = () => { r.open(); throw new Error('opening rejected'); };
    r.exec.submit([{ skill: 'use', item: 'compass', expect: { has: { item: 'bread', count: 1 } } }, take]);
    await waitUntil(() => r.reports.length === 1, 8_000);
    expect(r.reports[0].kind).toBe('blocked');
    expect(r.transfers).toEqual([]);
    expect(r.closed).toEqual([r.opened[0]]);
    expect(r.diagnostic.mock.calls.some(([event]) => event.event === 'hold-window-bound')).toBe(false);
  });

  it.each([undefined, []])('keeps a failed opener boundary for a tail with needs=%j', async (needs) => {
    const r = rig();
    let replacement: Window;
    r.onUse = () => { r.open(); replacement = r.open({ id: 41, title: 'Other warehouse' }); };
    r.exec.submit([{ skill: 'use', item: 'compass' }, { ...take, needs },
      { skill: 'stow', item: 'bread', count: 8, into: 'open', needs: [] }]);
    await waitUntil(() => r.reports.length === 1, 8_000);
    expect(r.reports[0].kind).toBe('blocked');
    expect(r.transfers).toEqual([]);
    expect(r.closed).toEqual([]);
    expect(r.bot.currentWindow).toBe(replacement!);
  });

  it('allows an explicit successful new opener to establish a new lease after an earlier opening failed', async () => {
    const r = rig();
    let uses = 0;
    let latest: Window;
    r.onUse = () => {
      uses++;
      if (uses === 1) { r.open(); r.open({ id: 42, title: 'Other warehouse' }); }
      else latest = r.open({ id: 41, title: 'New warehouse' });
    };
    r.exec.submit([{ skill: 'use', item: 'compass' }, { ...take, needs: [] },
      { skill: 'chat', text: '/warehouse next', needs: [] }, { ...take, needs: [3] }]);
    await waitUntil(() => r.reports.length === 1, 8_000);
    expect(r.reports[0].kind).toBe('blocked');
    expect(r.transfers).toEqual([latest!]);
    expect(r.closed).toEqual([latest!]);
    expect(r.bot.inventory.items().find((stack) => stack.name === 'golden_apple')?.count).toBe(1);
  });

  it('fails and closes only its current candidate when the opener expectation fails', async () => {
    const r = rig();
    r.onUse = () => { r.open(); r.open(); };
    r.exec.submit([{ skill: 'use', item: 'compass', expect: { has: { item: 'diamond', count: 1 } } }, take]);
    await waitUntil(() => r.reports.length === 1, 8_000);
    expect(r.reports[0].kind).toBe('blocked');
    expect(r.transfers).toEqual([]);
    expect(r.closed).toEqual([r.opened[1]]);
    expect(r.diagnostic.mock.calls.some(([event]) => event.event === 'hold-window-bound')).toBe(false);
  });

  it('cancels opening without binding or transferring and releases packet listeners', async () => {
    const r = rig();
    r.onUse = () => { r.open(); setTimeout(() => r.exec.clear(true), 100); };
    r.exec.submit([{ skill: 'use', item: 'compass' }, take]);
    await waitUntil(() => r.reports.length === 1, 8_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(r.reports[0].kind).toBe('cancelled');
    expect(r.transfers).toEqual([]);
    expect(r.closed).toEqual([r.opened[0]]);
    expect(r.bot.listenerCount('windowClose')).toBe(0);
    // Two native handlers plus one per-Bot authority guard remain; task listeners are gone.
    expect(r.client.listenerCount('window_items')).toBe(3);
    expect(r.client.listenerCount('open_window')).toBe(1);
    expect(r.client.listenerCount('end')).toBe(0);
  });

  it('rejects an opener that crosses a dimension before ownership is committed', async () => {
    const r = rig();
    r.onUse = () => { r.open(); r.bot.game.dimension = 'the_nether'; };
    r.exec.submit([{ skill: 'use', item: 'compass' }, take]);
    await waitUntil(() => r.reports.length === 1, 8_000);
    expect(r.reports[0].kind).toBe('blocked');
    expect(r.transfers).toEqual([]);
    expect(r.closed).toEqual([r.opened[0]]);
  });

  it('rejects a connection end during opening before ownership is committed', async () => {
    const r = rig();
    r.onUse = () => { r.open(); r.client.emit('end', 'closed'); };
    r.exec.submit([{ skill: 'use', item: 'compass' }, take]);
    await waitUntil(() => r.reports.length === 1, 8_000);
    expect(r.reports[0].kind).toBe('blocked');
    expect(r.transfers).toEqual([]);
    expect(r.closed).toEqual([r.opened[0]]);
  });
});
