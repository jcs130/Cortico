import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { manaSnapshotFromText, mergeViewerSkillState, mergeViewerSpellCatalogue, parseSkillsPayload, spellCatalogueFromText, viewerItem, viewerPlayerAbsorption, viewerTradeList, windowSnapshot } from '../../../src/worlds/minecraft/viewer-state.ts';

describe('viewer mana text fallback', () => {
  it('accepts an explicit current/max snapshot, but not a spell cost', () => {
    expect(manaSnapshotFromText('魔力不足：当前 4/30，需要 7。')).toEqual({ current: 4, max: 30 });
    expect(manaSnapshotFromText('Mana: 12/30')).toEqual({ current: 12, max: 30 });
    expect(manaSnapshotFromText('霜环，7 魔力/30 秒冷却')).toBeNull();
  });
});

it('reads remaining absorption hearts from the 1.20.6 player metadata field', () => {
  const metadata = { 15: 4 };
  expect(viewerPlayerAbsorption(metadata, mcData.entitiesByName.player.metadataKeys)).toBe(4);
  expect(viewerPlayerAbsorption({ 15: 2.5 })).toBe(2.5);
  expect(viewerPlayerAbsorption({ 15: -4 })).toBe(0);
});

const require = createRequire(import.meta.url);
const Item = createRequire(require.resolve('mineflayer'))('prismarine-item')('1.20.6') as {
  fromNotch(packet: unknown): unknown;
};
const mcData = require('minecraft-data')('1.20.6') as { itemsByName: {
  player_head: { id: number }; diamond_sword: { id: number };
  emerald: { id: number }; bread: { id: number };
}; entitiesByName: { player: { metadataKeys: string[] } } };
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

  it('keeps a merchant trade list with its matching open window', () => {
    const notch = (id: number, count: number) => ({ itemId: id, itemCount: count,
      components: [], removeComponents: [] });
    const trades = viewerTradeList({ windowId: 9, villagerLevel: 2, experience: 24,
      isRegularVillager: true, trades: [
        { inputItem1: notch(mcData.itemsByName.emerald.id, 3), inputItem2: null,
          outputItem: notch(mcData.itemsByName.bread.id, 2),
          nbTradeUses: 1, maximumNbTradeUses: 8, specialPrice: -1, xp: 3 },
        { inputItem1: notch(mcData.itemsByName.emerald.id, 5), inputItem2: null,
          outputItem: notch(mcData.itemsByName.bread.id, 1),
          nbTradeUses: 8, maximumNbTradeUses: 8, tradeDisabled: true },
      ] }, (packet) => packet ? viewerItem(Item.fromNotch(packet)) : null);
    expect(trades).toMatchObject({ windowId: 9, level: 2, offers: [
      { input: { name: 'emerald', count: 3 }, output: { name: 'bread', count: 2 },
        realPrice: 2, disabled: false },
      { disabled: true, uses: 8, maxUses: 8 },
    ] });
    const merchant = windows.createWindow(9, 'minecraft:merchant', 'Farmer');
    expect(windowSnapshot(merchant, new Map(), viewerItem, trades)?.trades).toEqual(trades);
    expect(windowSnapshot(windows.createWindow(10, 'minecraft:merchant', 'Other'),
      new Map(), viewerItem, trades)?.trades).toBeNull();
  });
});

describe('skill telemetry', () => {
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, mana: { current: 42, max: 80 },
    skills: [{ id: 'farming', name: '耕作', level: 12, xp: 78, requiredXp: 120 }],
    abilities: [{ id: 'treecapitator', name: '连锁砍树', level: 2, cooldownMs: 1500 }] }));

  it('accepts only a bounded namespaced payload', () => {
    expect(parseSkillsPayload('mcagent:state', payload)).toMatchObject({
      mana: { current: 42, max: 80 }, skills: [{ id: 'farming' }],
      abilities: [{ id: 'treecapitator' }],
    });
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

  it('extracts the server-listed spells already visible in system chat', () => {
    expect(spellCatalogueFromText('战斗咏唱：星芒箭(starbolt，自动锁敌、4 魔力)、霜环(frostnova，7 魔力)；仅攻击怪物。'))
      .toMatchObject([{ id: 'starbolt', name: '星芒箭', manaCost: 4 },
        { id: 'frostnova', name: '霜环', manaCost: 7 }]);
    expect(spellCatalogueFromText('探索咏唱：跃空(leap，4 魔力/8 秒，需站在地上)'))
      .toMatchObject([{ id: 'leap', cooldownMs: 8_000, manaCost: 4 }]);
    expect(spellCatalogueFromText('星芒箭命中僵尸（4 魔力）')).toBeNull();
  });

  it('accepts an icon and remaining cooldown without trusting arbitrary asset paths', () => {
    const state = parseSkillsPayload('mcagent:state', Buffer.from(JSON.stringify({ schemaVersion: 1,
      mana: { current: 3, max: 30 }, abilities: [
        { id: 'leap', name: '跃空', cooldownMs: 8_000, cooldownRemainingMs: 3_500,
          manaCost: 4, icon: 'minecraft:feather' },
        { id: 'frostnova', name: '霜环', icon: '../secret' },
      ] })));
    expect(state?.abilities[0]).toMatchObject({ icon: 'feather', cooldownRemainingMs: 3_500 });
    expect(state?.abilities[1]).not.toHaveProperty('icon');
  });

  it('keeps the two channels\' cooldown meanings separate and replaces the official roster', () => {
    const packet = (channel: string, body: object) =>
      parseSkillsPayload(channel, Buffer.from(JSON.stringify({ schemaVersion: 1, ...body })))!;
    const legacy = packet('mcviewer:state', { mana: { current: 5, max: 30 },
      skills: [{ id: 'sorcery', name: '魔法', level: 4, xp: 10, requiredXp: 20 }],
      abilities: [{ id: 'starbolt', name: '星芒箭', cooldownMs: 1750, manaCost: 4 }] });
    expect(legacy.abilities[0]).toMatchObject({ cooldownMs: null, cooldownRemainingMs: 1750 });
    const official = packet('mcagent:state', { mana: { current: 23, max: 32 },
      abilities: [{ id: 'mycli:starbolt', name: '星芒箭', level: 1,
        cooldownMs: 3000, cooldownRemainingMs: 1750, icon: 'minecraft:amethyst_shard' }] });
    const merged = mergeViewerSkillState(legacy, official, 'mcagent:state', false);
    expect(merged.abilities).toMatchObject([{ id: 'mycli:starbolt', manaCost: 4,
      icon: 'amethyst_shard', cooldownMs: 3000, cooldownRemainingMs: 1750 }]);
    expect(merged.skills).toMatchObject([{ id: 'sorcery', level: 4 }]);
    const laterLegacy = mergeViewerSkillState(merged, packet('mcviewer:state', { mana: { current: 2, max: 30 },
      abilities: [{ id: 'oldspell', name: '旧技能', cooldownMs: 500 }] }), 'mcviewer:state', true);
    expect(laterLegacy.mana).toEqual({ current: 23, max: 32 });
    expect(laterLegacy.abilities).toEqual(merged.abilities);
    const cleared = mergeViewerSkillState(laterLegacy,
      packet('mcagent:state', { mana: null, abilities: [] }), 'mcagent:state', true);
    expect(cleared.mana).toBeNull();
    expect(cleared.abilities).toEqual([]);
    expect(mergeViewerSpellCatalogue(cleared,
      [{ id: 'starbolt', name: '星芒箭', level: null, cooldownMs: 3000, manaCost: 4 }], true).abilities)
      .toEqual([]);
  });

  it('accepts the current 25-ability server snapshot within the byte limit', () => {
    const abilities = Array.from({ length: 25 }, (_, index) => ({
      id: `mycli:skill_${index}`, name: `技能${index}`, level: 1,
      cooldownMs: 3000, cooldownRemainingMs: 0, icon: 'minecraft:amethyst_shard',
    }));
    const state = parseSkillsPayload('mcagent:state', Buffer.from(JSON.stringify({ schemaVersion: 1,
      mana: { current: 20, max: 20 }, abilities })));
    expect(state?.abilities).toHaveLength(25);
    expect(state?.abilities[24]).toMatchObject({ id: 'mycli:skill_24', icon: 'amethyst_shard',
      cooldownMs: 3000, cooldownRemainingMs: 0 });
  });

  it('keeps a longer private roster and the entire chat catalogue', () => {
    const catalogue = `战斗咏唱：${Array.from({ length: 40 }, (_, index) =>
      `技能${index}(spell_${index},4 魔力/3秒)`).join('、')}`;
    const parsed = spellCatalogueFromText(catalogue);
    expect(parsed).toHaveLength(40);
    expect(mergeViewerSpellCatalogue(null, parsed!, false).abilities).toHaveLength(40);
    const abilities = Array.from({ length: 160 }, (_, index) => ({
      id: `mycli:spell_${index}`, name: `技能${index}`, level: 1,
      cooldownMs: 3000, cooldownRemainingMs: 0,
    }));
    const state = parseSkillsPayload('mcagent:state', Buffer.from(JSON.stringify({
      schemaVersion: 1, mana: { current: 20, max: 20 }, abilities,
    })));
    expect(state?.abilities).toHaveLength(160);
    expect(state?.abilities.at(-1)?.id).toBe('mycli:spell_159');
  });
});
