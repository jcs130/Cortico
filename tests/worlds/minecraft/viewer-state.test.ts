import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { manaSnapshotFromText, parseSkillsPayload, viewerItem, windowSnapshot } from '../../../src/worlds/minecraft/viewer-state.ts';

describe('viewer mana text fallback', () => {
  it('accepts an explicit current/max snapshot, but not a spell cost', () => {
    expect(manaSnapshotFromText('魔力不足：当前 4/30，需要 7。')).toEqual({ current: 4, max: 30 });
    expect(manaSnapshotFromText('Mana: 12/30')).toEqual({ current: 12, max: 30 });
    expect(manaSnapshotFromText('霜环，7 魔力/30 秒冷却')).toBeNull();
  });
});

const require = createRequire(import.meta.url);
const Item = createRequire(require.resolve('mineflayer'))('prismarine-item')('1.20.6') as {
  fromNotch(packet: unknown): unknown;
};
const mcData = require('minecraft-data')('1.20.6') as { itemsByName: {
  player_head: { id: number }; diamond_sword: { id: number };
} };
const windows = createRequire(require.resolve('mineflayer'))('prismarine-windows')('1.20.6') as {
  createWindow(id: number, type: string, title: string): {
    id: number; type: string; title: string; slots: unknown[]; inventoryStart: number; hotbarStart: number;
    updateSlot(slot: number, item: unknown): void;
  };
};

describe('viewer window state', () => {
  it('preserves a 1.20.6 player head name and profile through Mineflayer item decoding', () => {
    const hash = 'a'.repeat(64);
    const item = Item.fromNotch({ itemId: mcData.itemsByName.player_head.id, itemCount: 1,
      components: [
        { type: 'custom_name', data: { type: 'compound', value: {
          text: { type: 'string', value: '' },
          extra: { type: 'list', value: { type: 'compound', value: [
            { text: { type: 'string', value: '大背包' } },
          ] } },
        } } },
        { type: 'profile', data: { properties: [{ name: 'textures', value: Buffer.from(JSON.stringify({
          textures: { SKIN: { url: `http://textures.minecraft.net/texture/${hash}` } },
        })).toString('base64') }] } },
      ], removeComponents: [] });
    expect(viewerItem(item)).toMatchObject({ name: 'player_head', displayName: '大背包',
      customName: '大背包', headTextureHash: hash });
  });

  it('marks a 1.20.6 component enchanted sword without marking the plain sword', () => {
    const plain = Item.fromNotch({ itemId: mcData.itemsByName.diamond_sword.id, itemCount: 1,
      components: [], removeComponents: [] });
    const enchanted = Item.fromNotch({ itemId: mcData.itemsByName.diamond_sword.id, itemCount: 1,
      components: [{ type: 'enchantments', data: { enchantments: [{ id: 15, level: 2 }], showTooltip: true } }],
      removeComponents: [] });
    expect(viewerItem(plain)?.enchanted).toBeUndefined();
    expect(viewerItem(enchanted)?.enchanted).toBe(true);
  });

  it('maps a real 1.20.6 furnace window and its four progress properties', () => {
    const window = windows.createWindow(4, 'minecraft:furnace', 'Furnace');
    window.updateSlot(0, { name: 'iron_ore', type: 1, count: 3, displayName: 'Iron Ore', metadata: 0 });
    window.updateSlot(2, { name: 'iron_ingot', type: 2, count: 1, displayName: 'Iron Ingot', metadata: 0 });
    const state = windowSnapshot(window, new Map([[0, 40], [1, 80], [2, 30], [3, 200]]));
    expect(state).toMatchObject({ id: 4, type: 'minecraft:furnace', inventoryStart: 3,
      hotbarStart: 30, containerCount: 3, furnace: { burn: .5, cook: .15 } });
    expect(state?.slots[0]).toMatchObject({ name: 'iron_ore', count: 3 });
    expect(state?.slots[2]).toMatchObject({ name: 'iron_ingot' });
    expect(state?.slots).toHaveLength(39);
  });

  it('keeps chest contents separate from player slots', () => {
    const window = windows.createWindow(7, 'minecraft:generic_9x3', '{"text":"村庄仓库"}');
    window.updateSlot(26, { name: 'bread', type: 3, count: 4, displayName: 'Bread', metadata: 0 });
    window.updateSlot(27, { name: 'pickaxe', type: 4, count: 1, displayName: 'Pickaxe', metadata: 0 });
    const state = windowSnapshot(window);
    expect(state).toMatchObject({ title: '村庄仓库', containerCount: 27, inventoryStart: 27, hotbarStart: 54 });
    expect(state?.slots[26]).toMatchObject({ name: 'bread' });
    expect(state?.slots[27]).toMatchObject({ name: 'pickaxe' });
    expect(state?.furnace).toBeNull();
  });
});

describe('skill telemetry', () => {
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, mana: { current: 42, max: 80 },
    skills: [{ id: 'farming', name: '耕作', level: 12, xp: 78, requiredXp: 120 }],
    abilities: [{ id: 'treecapitator', name: '连锁砍树', level: 2, cooldownMs: 1500 }] }));

  it('accepts only a bounded namespaced payload', () => {
    expect(parseSkillsPayload('mcagent:state', payload)).toMatchObject({ mana: { current: 42, max: 80 } });
    expect(parseSkillsPayload('mcagent:state', Buffer.from(JSON.stringify({ schemaVersion: 1,
      mana: { current: 4, max: 30 } })))).toMatchObject({ mana: { current: 4, max: 30 }, skills: [] });
    expect(parseSkillsPayload('mcagent:state', Buffer.from(JSON.stringify({ schemaVersion: 1,
      mana: null })))).toMatchObject({ mana: null, skills: [] });
    expect(parseSkillsPayload('mcagent:state', Buffer.from(JSON.stringify({ schemaVersion: 1,
      mana: { current: '4', max: 30 } })))).toBeNull();
    expect(parseSkillsPayload('mcagent:state', Buffer.from(JSON.stringify({ schemaVersion: 1,
      mana: { current: 31, max: 30 } })))).toBeNull();
    expect(parseSkillsPayload('corti:viewer_state', payload)).toMatchObject({
      mana: { current: 42, max: 80 }, skills: [{ id: 'farming', level: 12 }],
      abilities: [{ id: 'treecapitator', cooldownMs: 1500 }],
    });
    expect(parseSkillsPayload('other:channel', payload)).toBeNull();
    expect(parseSkillsPayload('corti:viewer_state', Buffer.alloc(16_385))).toBeNull();
    expect(parseSkillsPayload('corti:viewer_state', Buffer.from('{'))).toBeNull();
  });
});
