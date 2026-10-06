import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/core/types.ts';
import { installMineflayerFixes } from '../../../src/worlds/minecraft/mineflayer-fixes.ts';
import { clickInventoryConfirmed, inventoryClickState, INVENTORY_CLICK_CONFIRM_MS } from '../../../src/worlds/minecraft/inventory-click-sync.ts';
import { inventoryReadConfirmed } from '../../../src/worlds/minecraft/inventory-window-sync.ts';
import { consumeHeldFood, EAT_SETTLE_MS } from '../../../src/worlds/minecraft/skills-craft.ts';

const require = createRequire(import.meta.url);
const dependency = createRequire(require.resolve('mineflayer'));
const log = { child() { return this; }, info() {}, warn() {}, error() {}, debug() {}, trace() {}, emit() {} } as unknown as Logger;
type Packet = Record<string, any>;
type ComponentItem = NonNullable<Bot['heldItem']> & { componentMap: Map<string, { data: unknown }> };

/** Native inventory/health plugins receive packets through the real 1.20.6 play codec. */
function protocolInventory(initial = true) {
  const registry = dependency('prismarine-registry')('1.20.6');
  const Item = dependency('prismarine-item')(registry);
  const protocol = dependency('minecraft-protocol');
  const serializer = protocol.createSerializer({ state: 'play', isServer: true, version: '1.20.6' });
  const deserializer = protocol.createDeserializer({ state: 'play', isServer: false, version: '1.20.6' });
  const client = new EventEmitter() as EventEmitter & { write(name: string, packet: Packet): void };
  const sent: Array<{ name: string; packet: Packet }> = [];
  client.write = (name, packet) => { sent.push({ name, packet: structuredClone(packet) }); };
  const bot = Object.assign(new EventEmitter(), {
    registry, version: '1.20.6', _client: client, supportFeature: registry.supportFeature,
    QUICK_BAR_START: 36, entity: { id: 1, position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, effects: {} },
    game: { dimension: 'overworld', gameMode: 'survival' }, blockAt: () => null,
    craft: async () => {}, placeBlock: async () => {},
  }) as unknown as Bot;
  require('mineflayer/lib/plugins/inventory.js')(bot, { hideErrors: true });
  require('mineflayer/lib/plugins/health.js')(bot, { respawn: false });
  installMineflayerFixes(bot, log);
  bot.quickBarSlot = 0;
  const raw = (name: string, count = 1): Packet => Item.toNotch(new Item(registry.itemsByName[name].id, count));
  const receive = (name: string, params: Packet): Packet => {
    const data = deserializer.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data;
    client.emit(data.name, data.params);
    return data.params;
  };
  const full = (window = bot.inventory, entries: Array<[number, string, number]> = [], stateId = 70): void => {
    const items = Array.from({ length: window.slots.length }, () => Item.toNotch(null));
    for (const [slot, name, count] of entries) items[slot] = raw(name, count);
    receive('window_items', { windowId: window.id, stateId, items, carriedItem: Item.toNotch(null) });
  };
  const direct = (slot: number, name: string | null, count = 1, stateId = 0): Packet => receive('set_slot', {
    windowId: 254, slot, stateId, item: name === null ? Item.toNotch(null) : raw(name, count),
  });
  const open = (id = 2): NonNullable<Bot['currentWindow']> => {
    receive('open_window', { windowId: id, inventoryType: 2, windowTitle: { type: 'string', value: 'Container' } });
    return bot.currentWindow!;
  };
  if (initial) full();
  receive('update_health', { health: 20, food: 6, foodSaturation: 0 });
  return { bot, client, Item, raw, receive, direct, full, open, sent };
}

afterEach(() => vi.useRealTimers());

describe('1.20.6 direct PlayerInventory updates', () => {
  const slots = Array.from({ length: 41 }, (_, raw) => [raw,
    raw < 9 ? 36 + raw : raw < 36 ? raw : raw < 40 ? 44 - raw : 45]);
  it.each(slots)('wire slot %i updates player window slot %i', (rawSlot, windowSlot) => {
    const r = protocolInventory();
    const packet = r.direct(rawSlot, 'bread', 2);
    expect(packet.windowId).toBe(254);
    expect(r.bot.inventory.slots[windowSlot]?.name).toBe('bread');
    expect(r.bot.inventory.slots[windowSlot]?.count).toBe(2);
    expect(r.bot.inventory.slots.filter(Boolean)).toHaveLength(1);
    expect(r.bot.inventory.slots).toHaveLength(46);
    expect(r.bot.inventory.selectedItem).toBeNull();
    expect(r.bot.currentWindow).toBeNull();
  });

  it('preserves real item components, signed-ID compatibility and empty-slot removal', () => {
    const r = protocolInventory();
    const item = { ...r.raw('bread', 2), addedComponentCount: 1,
      components: [{ type: 'custom_name', data: { type: 'string', value: '夜宵' } }] };
    r.receive('set_slot', { windowId: 254, stateId: 0, slot: 0, item });
    const named = r.bot.heldItem as ComponentItem | null;
    expect(named?.componentMap.get('custom_name')?.data).toEqual({ type: 'string', value: '夜宵' });
    r.client.emit('set_slot', { windowId: -2, stateId: 0, slot: 0, item: r.raw('bread', 1) });
    expect(r.bot.heldItem?.count).toBe(1);
    r.direct(0, null);
    expect(r.bot.heldItem).toBeNull();
  });

  it.each([-1, 41, 45, 32767, 1.5, undefined])('ignores invalid player slot %s without changing any slot or cursor', (slot) => {
    const r = protocolInventory();
    r.full(r.bot.inventory, [[36, 'bread', 2], [45, 'shield', 1]]);
    r.receive('set_slot', { windowId: 255, stateId: 80, slot: -1, item: r.raw('emerald', 3) });
    const before = r.bot.inventory.slots.map((item) => item?.name ?? null);
    r.client.emit('set_slot', { windowId: 254, stateId: 0, slot, item: r.raw('stone', 1) });
    expect(r.bot.inventory.slots.map((item) => item?.name ?? null)).toEqual(before);
    expect(r.bot.inventory.slots).toHaveLength(46);
    expect(r.bot.inventory.selectedItem?.count).toBe(3);
  });

  it('does not use a direct-update revision even before the first active-window revision', () => {
    const r = protocolInventory(false);
    const seen: number[] = [];
    r.client.on('set_slot', (p) => { seen.push(p.stateId); });
    r.receive('set_slot', { windowId: 9, stateId: 900, slot: 0, item: r.raw('stone', 1) });
    r.direct(0, 'bread', 1, 0);
    expect(seen).toEqual([900, 900]);
  });

  it.each([undefined, NaN, -10, 36.5])('does not write a hotbar slot when its mapped index is invalid (%s)', (hotbarStart) => {
    const r = protocolInventory();
    (r.bot.inventory as unknown as { hotbarStart: number | undefined }).hotbarStart = hotbarStart;
    const before = Object.getOwnPropertyNames(r.bot.inventory.slots);
    r.direct(0, 'bread', 1);
    expect(r.bot.inventory.slots.filter(Boolean)).toHaveLength(0);
    expect(Object.getOwnPropertyNames(r.bot.inventory.slots)).toEqual(before);
  });

  it('mirrors only main and hotbar slots into the open window and retains its revision', () => {
    const r = protocolInventory();
    r.full(r.bot.inventory, [[36, 'bread', 2]]);
    const window = r.open();
    const hotbarSlot = window.inventoryStart + 27;
    r.full(window, [[hotbarSlot, 'bread', 2]], 91);
    const seen: Array<[number, number, number]> = [];
    r.client.on('set_slot', (p) => { seen.push([p.windowId, p.slot, p.stateId]); });
    r.direct(0, 'bread', 1);
    expect(window.slots[hotbarSlot]?.count).toBe(1);
    expect(r.bot.inventory.slots[36]?.count).toBe(1);
    expect(window.slots[hotbarSlot]).not.toBe(r.bot.inventory.slots[36]);
    expect(window.slots[hotbarSlot]?.slot).toBe(hotbarSlot);
    expect(r.bot.inventory.slots[36]?.slot).toBe(36);
    r.direct(9, 'emerald', 3);
    expect(window.slots[window.inventoryStart]?.name).toBe('emerald');
    r.direct(39, 'diamond_helmet');
    r.direct(40, 'shield');
    expect(window.slots.filter((item): item is NonNullable<typeof item> => item !== null)
      .map((item) => item.name)).toEqual(['emerald', 'bread']);
    expect(seen).toEqual([[2, hotbarSlot, 91], [0, 36, 91], [2, window.inventoryStart, 91],
      [0, 9, 91], [0, 5, 91], [0, 45, 91]]);
    r.bot.closeWindow(window);
    expect(r.bot.inventory.slots[36]?.count).toBe(1);
    expect(r.bot.inventory.slots[9]?.count).toBe(3);
    expect(r.bot.inventory.slots[5]?.name).toBe('diamond_helmet');
    expect(r.bot.inventory.slots[45]?.name).toBe('shield');
  });

  it('a held-item listener closing the window cannot copy the previous food quantity back', () => {
    const r = protocolInventory();
    r.full(r.bot.inventory, [[36, 'bread', 2]]);
    const window = r.open();
    r.full(window, [[window.inventoryStart + 27, 'bread', 2]]);
    r.bot.once('heldItemChanged', () => r.bot.closeWindow(window));
    r.direct(0, 'bread', 1);
    expect(r.bot.currentWindow).toBeNull();
    expect(r.bot.heldItem?.count).toBe(1);
  });

  it('a partial container stays unconfirmed while its direct player update survives close', () => {
    const r = protocolInventory();
    r.full(r.bot.inventory, [[36, 'bread', 2], [10, 'emerald', 4]]);
    const window = r.open();
    r.receive('window_items', { windowId: window.id, stateId: 80,
      items: Array.from({ length: window.inventoryStart }, () => r.Item.toNotch(null)),
      carriedItem: r.Item.toNotch(null) });
    r.direct(0, 'bread', 1);
    expect(inventoryReadConfirmed(r.bot)).toBe(false);
    r.bot.closeWindow(window);
    expect(r.bot.inventory.slots[36]?.count).toBe(1);
    expect(r.bot.inventory.slots[10]?.count).toBe(4);
    expect(inventoryReadConfirmed(r.bot)).toBe(false);
  });

  it('direct slot updates do not confirm a pending click or replace the -1 click barrier', async () => {
    vi.useFakeTimers();
    const r = protocolInventory();
    r.full(r.bot.inventory, [[9, 'bread', 2], [36, 'bread', 2]]);
    const click = clickInventoryConfirmed(r.bot, 9, 0, 0);
    const rejected = expect(click).rejects.toMatchObject({ reason: 'quarantined' });
    r.direct(0, 'bread', 1);
    expect(inventoryClickState(r.bot).phase).toBe('pending');
    expect(r.sent.filter((p) => p.name === 'window_click')[0].packet.stateId).toBe(-1);
    await vi.advanceTimersByTimeAsync(INVENTORY_CLICK_CONFIRM_MS);
    await rejected;
    expect(inventoryClickState(r.bot).phase).toBe('quarantined');
    expect(r.bot.inventory.slots[36]?.count).toBe(1);
  });

  it('a delayed unsent native click restores the new direct authority rather than the old full snapshot', async () => {
    vi.useFakeTimers();
    const r = protocolInventory();
    r.full(r.bot.inventory, [[36, 'bread', 2]]);
    (r.bot as Bot & { lastDigTime: Date }).lastDigTime = new Date();
    const click = clickInventoryConfirmed(r.bot, 36, 0, 0);
    const rejected = expect(click).rejects.toMatchObject({ reason: 'window-replaced' });
    await vi.advanceTimersByTimeAsync(50);
    const replacement = r.open();
    const hotbarSlot = replacement.inventoryStart + 27;
    r.full(replacement, [[hotbarSlot, 'bread', 2]], 81);
    r.direct(0, 'bread', 1);
    await rejected;
    await vi.advanceTimersByTimeAsync(500);
    expect(r.sent.filter((p) => p.name === 'window_click')).toHaveLength(0);
    expect(inventoryClickState(r.bot).phase).toBe('ready');
    expect(replacement.slots[hotbarSlot]?.count).toBe(1);
    r.bot.closeWindow(replacement);
    expect(r.bot.heldItem?.count).toBe(1);
  });

  it('native consume accepts delayed wire inventory deduction after the independent health update', async () => {
    vi.useFakeTimers();
    const r = protocolInventory();
    r.full(r.bot.inventory, [[36, 'rotten_flesh', 2]]);
    const eat = consumeHeldFood(r.bot, 'rotten_flesh');
    r.receive('update_health', { health: 20, food: 10, foodSaturation: 0 });
    r.receive('entity_status', { entityId: 1, entityStatus: 9 });
    await vi.advanceTimersByTimeAsync(500);
    expect(r.bot.heldItem?.count).toBe(2);
    r.direct(0, 'rotten_flesh', 1);
    await vi.advanceTimersByTimeAsync(250);
    await expect(eat).resolves.toContain('饥饿 6 → 10/20');
    expect(r.sent.filter((p) => p.name === 'use_item')).toHaveLength(1);
    expect(r.bot.heldItem?.count).toBe(1);
  });

  it('health improvement without food deduction still fails the causal eat check', async () => {
    vi.useFakeTimers();
    const r = protocolInventory();
    r.full(r.bot.inventory, [[36, 'rotten_flesh', 2]]);
    const eat = consumeHeldFood(r.bot, 'rotten_flesh');
    const rejected = expect(eat).rejects.toThrow('没吃进去');
    r.receive('update_health', { health: 20, food: 10, foodSaturation: 0 });
    r.receive('entity_status', { entityId: 1, entityStatus: 9 });
    await vi.advanceTimersByTimeAsync(EAT_SETTLE_MS + 100);
    await rejected;
    expect(r.bot.heldItem?.count).toBe(2);
  });
});
