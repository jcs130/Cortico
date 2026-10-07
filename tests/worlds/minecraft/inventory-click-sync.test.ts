import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { clickInventoryConfirmed, installInventoryClickSync, inventoryClickState,
  INVENTORY_CLICK_CONFIRM_MS, InventoryClickSyncError, resumeInventoryCursor } from '../../../src/worlds/minecraft/inventory-click-sync.ts';
import { installMineflayerFixes } from '../../../src/worlds/minecraft/mineflayer-fixes.ts';
import { inventoryReadConfirmed } from '../../../src/worlds/minecraft/inventory-window-sync.ts';
import type { Bot } from 'mineflayer';
import type { Logger } from '../../../src/core/types.ts';

const require = createRequire(import.meta.url);
const dependency = (name: string) => require(require.resolve(name, { paths: [require.resolve('mineflayer')] }));
const log = { child() { return this; }, info() {}, warn() {}, error() {}, debug() {}, trace() {}, emit() {} } as unknown as Logger;

function inventoryServer(options: { delay?: number; deny?: boolean; silent?: boolean; version?: string } = {}) {
  const registry = require('minecraft-data')(options.version ?? '1.20.6');
  const Item = dependency('prismarine-item')(registry);
  const windows = dependency('prismarine-windows')(registry.version.minecraftVersion);
  const inventory = windows.createWindow(0, 'minecraft:inventory', 'Inventory');
  const server = windows.createWindow(0, 'minecraft:inventory', 'Inventory');
  const client = new EventEmitter() as EventEmitter & { write(name: string, packet: Record<string, any>): void };
  const bot = Object.assign(new EventEmitter(), {
    registry, version: registry.version.minecraftVersion, inventory, currentWindow: null,
    supportFeature: (feature: string) => registry.supportFeature(feature), _client: client,
    closeWindow() {}, blockAt: () => null, craft: async () => {}, placeBlock: async () => {},
    clickWindow: async (_slot: number, _button: number, _mode: number) => {},
  }) as unknown as Bot;
  const sent: Array<Record<string, any>> = [];
  const full = () => client.emit('window_items', { windowId: 0, stateId: ++stateId,
    items: server.slots.map((item: unknown) => Item.toNotch(item)), carriedItem: Item.toNotch(server.selectedItem) });
  let stateId = 70;
  client.on('window_items', (packet) => {
    const target = bot.currentWindow ?? bot.inventory;
    if (packet.windowId !== target.id) return;
    packet.items.forEach((raw: unknown, slot: number) => target.updateSlot(slot, Item.fromNotch(raw)));
  });
  client.write = (name, packet) => {
    if (name !== 'window_click') return;
    sent.push(structuredClone(packet));
    if (!options.deny) {
      server.acceptClick({ slot: packet.slot, mode: packet.mode, mouseButton: packet.mouseButton,
        item: server.slots[packet.slot] });
      if (packet.slot === 0) for (let slot = 1; slot <= 4; slot++) server.updateSlot(slot, null);
      const material = server.slots[1];
      server.updateSlot(0, material?.type === registry.itemsByName.cherry_log?.id
        ? new Item(registry.itemsByName.cherry_planks.id, 4) : null);
    }
    if (!options.silent) setTimeout(full, options.delay ?? 5);
  };
  bot.clickWindow = async (slot, mouseButton, mode) => {
    const target = bot.currentWindow ?? bot.inventory;
    const changed = (target as unknown as { acceptClick(click: unknown): number[] })
      .acceptClick({ slot, mouseButton, mode, item: target.slots[slot] });
    client.write('window_click', { windowId: target.id, stateId, slot, mouseButton, mode,
      changedSlots: changed.map((location: number) => ({ location, item: Item.toNotch(target.slots[location]) })),
      cursorItem: Item.toNotch(target.selectedItem) });
  };
  const seed = (slot: number, name: string, count: number) => {
    inventory.updateSlot(slot, new Item(registry.itemsByName[name].id, count));
    server.updateSlot(slot, new Item(registry.itemsByName[name].id, count));
  };
  installInventoryClickSync(bot);
  return { bot, client, inventory, server, sent, full, seed, Item, windows, registry };
}

afterEach(() => vi.useRealTimers());

describe('server inventory click snapshots', () => {
  it('a 927 ms response completes before any next click, without confusing the 64-item cursor with loss', async () => {
    vi.useFakeTimers();
    const rig = inventoryServer({ delay: 927 });
    rig.seed(18, 'cherry_log', 64);
    const first = clickInventoryConfirmed(rig.bot, 18, 0, 0);
    expect(rig.inventory.selectedItem.count).toBe(64);
    expect(inventoryReadConfirmed(rig.bot)).toBe(false);
    await expect(rig.bot.clickWindow(1, 1, 0)).rejects.toBeInstanceOf(InventoryClickSyncError);
    await vi.advanceTimersByTimeAsync(926);
    expect(inventoryClickState(rig.bot).phase).toBe('pending');
    expect(rig.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(inventoryClickState(rig.bot).phase).toBe('ready');
    expect(inventoryReadConfirmed(rig.bot)).toBe(true);
    expect(rig.server.selectedItem.count).toBe(64);
    const restore = resumeInventoryCursor(rig.bot);
    await vi.runAllTimersAsync();
    await restore;
    expect(rig.inventory.selectedItem).toBeNull();
    expect(rig.server.selectedItem).toBeNull();
    expect(rig.server.slots.filter(Boolean).reduce((sum: number, item: { count: number }) => sum + item.count, 0)).toBe(64);
  });

  it('unrelated offhand or result slots do not confirm an optimistic source pickup', async () => {
    vi.useFakeTimers();
    const rig = inventoryServer({ silent: true });
    rig.seed(18, 'cherry_log', 64);
    const click = clickInventoryConfirmed(rig.bot, 18, 0, 0);
    rig.client.emit('set_slot', { windowId: 0, slot: 45, stateId: 80, item: { itemCount: 0 } });
    rig.client.emit('set_slot', { windowId: 0, slot: 0, stateId: 81, item: { itemCount: 0 } });
    expect(inventoryClickState(rig.bot).phase).toBe('pending');
    rig.full();
    await click;
  });

  it('a complete rollback updates the cursor and rejects the operation instead of accepting existing inventory', async () => {
    vi.useFakeTimers();
    const rig = inventoryServer({ deny: true });
    rig.seed(18, 'cherry_log', 64);
    const click = clickInventoryConfirmed(rig.bot, 18, 0, 0);
    const rejected = expect(click).rejects.toMatchObject({ code: 'inventory-click-sync', reason: 'rollback' });
    await vi.runAllTimersAsync();
    await rejected;
    expect(rig.inventory.selectedItem).toBeNull();
    expect(rig.inventory.slots[18].count).toBe(64);
    expect(inventoryClickState(rig.bot).phase).toBe('ready');
  });

  it('timeout quarantines every outgoing inventory click until a complete authoritative read restores it', async () => {
    vi.useFakeTimers();
    const rig = inventoryServer({ silent: true });
    rig.seed(18, 'cherry_log', 64);
    const click = clickInventoryConfirmed(rig.bot, 18, 0, 0);
    const rejected = expect(click).rejects.toMatchObject({ reason: 'quarantined' });
    await vi.advanceTimersByTimeAsync(INVENTORY_CLICK_CONFIRM_MS);
    await rejected;
    expect(inventoryReadConfirmed(rig.bot)).toBe(false);
    await expect(clickInventoryConfirmed(rig.bot, 1, 1, 0)).rejects.toBeInstanceOf(InventoryClickSyncError);
    expect(() => rig.client.write('window_click', { windowId: 0, slot: 1 })).toThrow(InventoryClickSyncError);
    expect(rig.sent).toHaveLength(1);
    rig.full();
    expect(inventoryReadConfirmed(rig.bot)).toBe(true);
    expect(inventoryClickState(rig.bot).phase).toBe('ready');
    expect(rig.inventory.selectedItem.count).toBe(64);
  });

  it.each([-1, 255])('cursor packet %i updates server authority even when Mineflayer ignores the window ID', (windowId) => {
    const rig = inventoryServer();
    const raw = rig.Item.toNotch(new rig.Item(rig.registry.itemsByName.cherry_log.id, 64));
    rig.client.emit('set_slot', { windowId, slot: -1, stateId: 90, item: raw });
    expect(rig.inventory.selectedItem.count).toBe(64);
    rig.client.emit('set_slot', { windowId, slot: -1, stateId: 91, item: { itemCount: 0 } });
    expect(rig.inventory.selectedItem).toBeNull();
  });

  it('a partial virtual-container snapshot does not release a pending transaction', async () => {
    vi.useFakeTimers();
    const rig = inventoryServer({ silent: true });
    rig.seed(18, 'cherry_log', 2);
    const click = clickInventoryConfirmed(rig.bot, 18, 0, 0);
    rig.client.emit('window_items', { windowId: 0, stateId: 91, items: [], carriedItem: { itemCount: 0 } });
    expect(inventoryClickState(rig.bot).phase).toBe('pending');
    rig.full(); await click;
  });

  it('same numeric ID with a new window object is rejected between two clicks', async () => {
    vi.useFakeTimers();
    const rig = inventoryServer();
    rig.seed(18, 'cherry_log', 2);
    const original = rig.inventory;
    const click = clickInventoryConfirmed(rig.bot, 18, 0, 0, original);
    await vi.runAllTimersAsync(); await click;
    rig.bot.currentWindow = rig.windows.createWindow(0, 'minecraft:inventory', 'New');
    await expect(clickInventoryConfirmed(rig.bot, 1, 1, 0, original)).rejects.toMatchObject({ reason: 'window-replaced' });
    expect(rig.sent).toHaveLength(1);
  });

  it('server close rejects the pending click and requires a new complete active window read', async () => {
    const rig = inventoryServer({ silent: true });
    rig.seed(18, 'cherry_log', 2);
    const click = clickInventoryConfirmed(rig.bot, 18, 0, 0);
    rig.client.emit('close_window', { windowId: 0 });
    await expect(click).rejects.toMatchObject({ reason: 'window-replaced' });
    expect(inventoryClickState(rig.bot).phase).toBe('quarantined');
    rig.full();
    expect(inventoryClickState(rig.bot).phase).toBe('ready');
  });

  it('an NBT-format rollback with the same quantity but another item is rejected', async () => {
    vi.useFakeTimers();
    const rig = inventoryServer({ silent: true, version: '1.17.1' });
    rig.seed(18, 'oak_log', 2);
    const click = clickInventoryConfirmed(rig.bot, 18, 0, 0);
    rig.server.selectedItem = new rig.Item(rig.registry.itemsByName.birch_log.id, 2);
    const rejected = expect(click).rejects.toMatchObject({ reason: 'rollback' });
    rig.full(); await rejected;
  });

  it('craft uses real server products after delayed snapshots and leaves no cursor or crafting material', async () => {
    vi.useFakeTimers();
    const rig = inventoryServer({ delay: 927 });
    rig.seed(18, 'cherry_log', 64);
    installMineflayerFixes(rig.bot, log);
    const recipe = { ingredients: [{ id: rig.registry.itemsByName.cherry_log.id }],
      result: { id: rig.registry.itemsByName.cherry_planks.id, count: 4 }, requiresTable: false };
    const craft = rig.bot.craft(recipe as never, 2);
    await vi.runAllTimersAsync(); await craft;
    expect(rig.server.slots.filter((item: any) => item?.name === 'cherry_planks').reduce((sum: number, item: any) => sum + item.count, 0)).toBe(8);
    expect(rig.server.slots.filter((item: any) => item?.name === 'cherry_log').reduce((sum: number, item: any) => sum + item.count, 0)).toBe(62);
    expect(rig.server.selectedItem).toBeNull();
    expect(rig.server.slots.slice(1, 5).filter(Boolean)).toHaveLength(0);
  });

  it('unconfirmed pickup does not send finally cleanup or start the next craft attempt', async () => {
    vi.useFakeTimers();
    const rig = inventoryServer({ silent: true });
    rig.seed(18, 'cherry_log', 64);
    installMineflayerFixes(rig.bot, log);
    const recipe = { ingredients: [{ id: rig.registry.itemsByName.cherry_log.id }],
      result: { id: rig.registry.itemsByName.cherry_planks.id, count: 4 }, requiresTable: false };
    const first = rig.bot.craft(recipe as never, 2);
    const rejected = expect(first).rejects.toMatchObject({ code: 'inventory-click-sync' });
    await vi.runAllTimersAsync(); await rejected;
    await expect(rig.bot.craft(recipe as never, 1)).rejects.toMatchObject({ code: 'inventory-click-sync' });
    expect(rig.sent).toHaveLength(1);
    expect(rig.inventory.selectedItem.count).toBe(64);
    expect(rig.server.selectedItem.count).toBe(64);
  });

  it.each([false, true])('full inventory rejects the whole server product before pickup (explicit grid: %s)', async (explicitGrid) => {
    vi.useFakeTimers();
    const rig = inventoryServer();
    for (let slot = rig.inventory.inventoryStart; slot < rig.inventory.inventoryEnd; slot++) rig.seed(slot, 'stone', 64);
    rig.seed(18, 'cherry_log', 64);
    // One slot has room for only one of the four server-produced planks.
    rig.seed(19, 'cherry_planks', 63);
    installMineflayerFixes(rig.bot, log);
    const craft = rig.bot.craft({ ingredients: [{ id: rig.registry.itemsByName.cherry_log.id }],
      result: { id: explicitGrid ? null : rig.registry.itemsByName.cherry_planks.id, count: 4 }, requiresTable: false } as never, 1);
    const rejected = expect(craft).rejects.toThrow('背包容量不足');
    await vi.runAllTimersAsync(); await rejected;
    expect(rig.sent.filter(packet => packet.slot === 0)).toHaveLength(0);
    expect(rig.server.selectedItem).toBeNull();
    expect(rig.server.slots[18].count).toBe(64);
    expect(rig.server.slots[19].count).toBe(63);
    expect(rig.server.slots.slice(1, 5).filter(Boolean)).toHaveLength(0);
  });

  it('full inventory can craft when the consumed ingredient frees a slot', async () => {
    vi.useFakeTimers();
    const rig = inventoryServer();
    for (let slot = rig.inventory.inventoryStart; slot < rig.inventory.inventoryEnd; slot++) rig.seed(slot, 'stone', 64);
    rig.seed(18, 'cherry_log', 1);
    installMineflayerFixes(rig.bot, log);
    const craft = rig.bot.craft({ ingredients: [{ id: rig.registry.itemsByName.cherry_log.id }],
      result: { id: rig.registry.itemsByName.cherry_planks.id, count: 4 }, requiresTable: false } as never, 1);
    await vi.runAllTimersAsync(); await craft;
    expect(rig.server.slots[18].name).toBe('cherry_planks');
    expect(rig.server.slots[18].count).toBe(4);
    expect(rig.server.selectedItem).toBeNull();
  });

  it('craft product fills several compatible partial stacks before completing', async () => {
    vi.useFakeTimers();
    const rig = inventoryServer();
    for (let slot = rig.inventory.inventoryStart; slot < rig.inventory.inventoryEnd; slot++) rig.seed(slot, 'stone', 64);
    rig.seed(18, 'cherry_log', 64);
    rig.seed(19, 'cherry_planks', 62);
    rig.seed(20, 'cherry_planks', 62);
    installMineflayerFixes(rig.bot, log);
    const craft = rig.bot.craft({ ingredients: [{ id: rig.registry.itemsByName.cherry_log.id }],
      result: { id: rig.registry.itemsByName.cherry_planks.id, count: 4 }, requiresTable: false } as never, 1);
    await vi.runAllTimersAsync(); await craft;
    expect(rig.server.slots[19].count).toBe(64);
    expect(rig.server.slots[20].count).toBe(64);
    expect(rig.server.selectedItem).toBeNull();
    expect(rig.inventory.selectedItem).toBeNull();
  });

  it('component-bearing stacks do not provide capacity for an ordinary craft product', async () => {
    vi.useFakeTimers();
    const rig = inventoryServer();
    for (let slot = rig.inventory.inventoryStart; slot < rig.inventory.inventoryEnd; slot++) rig.seed(slot, 'stone', 64);
    rig.seed(18, 'cherry_log', 64);
    rig.seed(19, 'cherry_planks', 4);
    for (const window of [rig.inventory, rig.server]) {
      window.slots[19].components = [{ type: 'custom_name', data: 'Decorative planks' }];
    }
    installMineflayerFixes(rig.bot, log);
    const craft = rig.bot.craft({ ingredients: [{ id: rig.registry.itemsByName.cherry_log.id }],
      result: { id: rig.registry.itemsByName.cherry_planks.id, count: 4 }, requiresTable: false } as never, 1);
    const rejected = expect(craft).rejects.toThrow('背包容量不足');
    await vi.runAllTimersAsync(); await rejected;
    expect(rig.sent.filter(packet => packet.slot === 0)).toHaveLength(0);
    expect(rig.server.selectedItem).toBeNull();
    expect(rig.server.slots[19].count).toBe(4);
  });

  it('each craft round checks capacity again and returns the next round materials', async () => {
    vi.useFakeTimers();
    const rig = inventoryServer();
    for (let slot = rig.inventory.inventoryStart; slot < rig.inventory.inventoryEnd; slot++) rig.seed(slot, 'stone', 64);
    rig.seed(18, 'cherry_log', 64);
    rig.seed(19, 'cherry_planks', 60);
    installMineflayerFixes(rig.bot, log);
    const craft = rig.bot.craft({ ingredients: [{ id: rig.registry.itemsByName.cherry_log.id }],
      result: { id: rig.registry.itemsByName.cherry_planks.id, count: 4 }, requiresTable: false } as never, 2);
    await Promise.all([expect(craft).rejects.toThrow('背包容量不足'), vi.runAllTimersAsync()]);
    expect(rig.sent.filter(packet => packet.slot === 0)).toHaveLength(1);
    expect(rig.server.slots[18].count).toBe(63);
    expect(rig.server.slots[19].count).toBe(64);
    expect(rig.server.selectedItem).toBeNull();
    expect(rig.server.slots.slice(1, 5).filter(Boolean)).toHaveLength(0);
  });

  it('a real Mineflayer hotbar delay cannot click a replacement window and releases its unsent reservation after settling', async () => {
    vi.useFakeTimers();
    const registry = dependency('prismarine-registry')('1.20.6');
    const Item = dependency('prismarine-item')(registry);
    const client = new EventEmitter() as EventEmitter & { write(name: string, packet: unknown): void };
    const sent: unknown[] = [];
    client.write = (name, packet) => { if (name === 'window_click') sent.push(packet); };
    const bot = Object.assign(new EventEmitter(), { registry, version: '1.20.6', _client: client,
      supportFeature: registry.supportFeature, QUICK_BAR_START: 36, entity: { id: 1 } }) as unknown as Bot;
    require('mineflayer/lib/plugins/inventory.js')(bot, { hideErrors: true });
    const initial = new Array(46).fill(null);
    initial[36] = new Item(registry.itemsByName.cherry_log.id, 4);
    client.emit('window_items', { windowId: 0, stateId: 50, items: initial.map(Item.toNotch), carriedItem: Item.toNotch(null) });
    installInventoryClickSync(bot);
    (bot as Bot & { lastDigTime: Date }).lastDigTime = new Date();
    const delayed = clickInventoryConfirmed(bot, 36, 0, 0);
    const rejected = expect(delayed).rejects.toMatchObject({ reason: 'window-replaced' });
    await vi.advanceTimersByTimeAsync(50);
    client.emit('open_window', { windowId: 2, inventoryType: 'minecraft:generic_9x3', windowTitle: 'Replacement' });
    const replacement = bot.currentWindow!;
    const items = new Array(replacement.slots.length).fill(null);
    items[36] = new Item(registry.itemsByName.cherry_log.id, 4);
    client.emit('window_items', { windowId: 2, stateId: 60, items: items.map(Item.toNotch), carriedItem: Item.toNotch(null) });
    client.emit('window_items', { windowId: 2, stateId: 61,
      items: [Item.toNotch(new Item(registry.itemsByName.emerald.id, 7))],
      carriedItem: Item.toNotch(new Item(registry.itemsByName.cherry_log.id, 3)) });
    client.emit('set_slot', { windowId: 2, stateId: 62, slot: 36,
      item: Item.toNotch(new Item(registry.itemsByName.diamond_sword.id, 1)) });
    client.emit('set_slot', { windowId: 255, stateId: 63, slot: -1,
      item: Item.toNotch(new Item(registry.itemsByName.cherry_log.id, 2)) });
    await rejected;
    expect(inventoryClickState(bot).phase).toBe('quarantined');
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toHaveLength(0);
    expect(inventoryClickState(bot).phase).toBe('ready');
    expect(bot.currentWindow).toBe(replacement);
    expect(replacement.slots[36]?.name).toBe('diamond_sword');
    expect(replacement.slots[0]?.name).toBe('emerald');
    expect(replacement.slots[0]?.count).toBe(7);
    expect(replacement.selectedItem?.name).toBe('cherry_log');
    expect(replacement.selectedItem?.count).toBe(2);
  });
});
