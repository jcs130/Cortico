import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import { describe, expect, it } from 'vitest';
import {
  installInventoryWindowSyncGuard, inventoryReadConfirmed,
} from '../../../src/worlds/minecraft/inventory-window-sync.ts';
import { bagNow } from '../../../src/worlds/minecraft/receipt.ts';

type Stack = { name: string; count: number; slot?: number } | null;
type FakeWindow = { id: number; inventoryStart: number; inventoryEnd: number; slots: Stack[] };

function rig() {
  const client = new EventEmitter();
  const inventory: FakeWindow & { items(): NonNullable<Stack>[] } = {
    id: 0, inventoryStart: 9, inventoryEnd: 45, slots: Array(46).fill(null),
    items() { return this.slots.slice(this.inventoryStart, this.inventoryEnd).filter((item): item is NonNullable<Stack> => !!item); },
  };
  const raw = {
    _client: client,
    inventory,
    currentWindow: null as FakeWindow | null,
    closeWindow(window: FakeWindow) {
      const offset = window.inventoryStart - inventory.inventoryStart;
      for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot++) {
        const item = window.slots[slot];
        if (item) item.slot = slot - offset;
        inventory.slots[slot - offset] = item;
      }
      raw.currentWindow = null;
    },
  };
  client.on('window_items', (packet: { windowId: number; items: Stack[] }) => {
    const window = packet.windowId === 0 ? inventory : raw.currentWindow;
    if (!window || window.id !== packet.windowId) return;
    for (let slot = 0; slot < packet.items.length; slot++) window.slots[slot] = packet.items[slot];
  });
  client.on('set_slot', (packet: { windowId: number; slot: number; item: Stack }) => {
    const window = packet.windowId === 0 ? inventory : raw.currentWindow;
    if (window?.id === packet.windowId) window.slots[packet.slot] = packet.item;
  });
  const bot = raw as unknown as Bot;
  installInventoryWindowSyncGuard(bot);
  const open = (id: number, containerSlots = 54): FakeWindow => {
    const window = { id, inventoryStart: containerSlots, inventoryEnd: containerSlots + 36,
      slots: Array<Stack>(containerSlots + 36).fill(null) };
    raw.currentWindow = window;
    return window;
  };
  const items = (window: FakeWindow, received: number, player: Array<[number, Stack]> = []): void => {
    const slots = Array<Stack>(received).fill(null);
    for (const [index, stack] of player) slots[window.inventoryStart + index] = stack;
    client.emit('window_items', { windowId: window.id, items: slots });
  };
  return { bot, client, inventory, open, items };
}

describe('Mineflayer partial container inventory', () => {
  it('preserves unreported player slots and marks the bag unknown', () => {
    const r = rig();
    r.inventory.slots[9] = { name: 'diamond_sword', count: 1, slot: 9 };
    r.inventory.slots[10] = { name: 'emerald', count: 10, slot: 10 };
    const window = r.open(1);
    r.items(window, 54);
    r.client.emit('set_slot', { windowId: 1, slot: 54, item: { name: 'bread', count: 4 } });

    expect(inventoryReadConfirmed(r.bot)).toBe(false);
    r.bot.closeWindow(window as never);
    expect(r.inventory.items().map((item) => [item.name, item.count])).toEqual([['bread', 4], ['emerald', 10]]);
    expect(bagNow(r.bot)).toContain('不能确认物品数量');
    expect(bagNow(r.bot)).not.toContain('空的');
  });

  it('accepts a complete empty player inventory as authoritative', () => {
    const r = rig();
    r.inventory.slots[9] = { name: 'diamond_sword', count: 1, slot: 9 };
    const window = r.open(2);
    r.items(window, 90);

    r.bot.closeWindow(window as never);
    expect(inventoryReadConfirmed(r.bot)).toBe(true);
    expect(r.inventory.items()).toEqual([]);
    expect(bagNow(r.bot)).toContain('空的');
  });

  it('accepts a later complete window 0 inventory after an incomplete window', () => {
    const r = rig();
    r.inventory.slots[9] = { name: 'diamond_sword', count: 1, slot: 9 };
    const virtual = r.open(5);
    r.items(virtual, 54);
    r.bot.closeWindow(virtual as never);
    expect(inventoryReadConfirmed(r.bot)).toBe(false);

    r.client.emit('window_items', { windowId: 0, items: Array<Stack>(46).fill(null) });
    expect(inventoryReadConfirmed(r.bot)).toBe(true);
    expect(r.inventory.items()).toEqual([]);
  });

  it('recovers from a partial virtual window after a complete physical chest read', () => {
    const r = rig();
    r.inventory.slots[9] = { name: 'diamond_sword', count: 1, slot: 9 };
    const virtual = r.open(3);
    r.items(virtual, 54);
    r.bot.closeWindow(virtual as never);
    expect(inventoryReadConfirmed(r.bot)).toBe(false);

    const chest = r.open(4);
    r.items(chest, 90, [[0, { name: 'diamond_sword', count: 1 }], [1, { name: 'arrow', count: 32 }]]);
    r.bot.closeWindow(chest as never);
    expect(inventoryReadConfirmed(r.bot)).toBe(true);
    expect(r.inventory.items().map((item) => item.name)).toEqual(['diamond_sword', 'arrow']);
  });
});
