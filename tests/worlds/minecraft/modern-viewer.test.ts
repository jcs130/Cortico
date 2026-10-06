import { describe, expect, it } from 'vitest';
import { ownEntity, recordFishingBobberOwner, viewerEntity, viewerItem, viewerMessageKind } from '../../../src/worlds/minecraft/modern-viewer.ts';

describe('modern viewer item state', () => {
  it('sends the selected weapon, offhand and armour with the world avatar', () => {
    const slots: unknown[] = Array(46).fill(null);
    slots[38] = { name: 'diamond_sword', type: 737, count: 1,
      components: [{ type: 'enchantments', data: { enchantments: [{ id: 16, level: 3 }] } }] };
    slots[45] = { name: 'shield', type: 908, count: 1 };
    const entity = { id: 8, position: { x: 1, y: 64, z: 2 }, width: .6, height: 1.8,
      yaw: 0, pitch: 0, equipment: [null, null, null, null,
        { name: 'diamond_chestplate', type: 812, count: 1 }, null] };
    const avatar = ownEntity({ entity, inventory: { slots, hotbarStart: 36 },
      quickBarSlot: 2, username: 'Viewer' } as never);
    expect(avatar.equipment).toMatchObject([
      { name: 'diamond_sword', enchanted: true }, { name: 'shield' }, null, null,
      { name: 'diamond_chestplate' }, null,
    ]);
  });

  it('keeps an individual name and profile component for the hotbar', () => {
    const head = {
      name: 'player_head', type: 1105, displayName: 'Player Head', count: 1,
      components: [
        { type: 'custom_name', data: '{"text":"大背包"}' },
        { type: 'profile', data: { properties: [{ name: 'textures', value: 'skin-data' }] } },
      ],
    };
    expect(viewerItem(head)).toMatchObject({
      name: 'player_head', displayName: '大背包', customName: '大背包',
      components: head.components,
    });
    expect(viewerItem({ name: 'player_head', type: 1105, displayName: 'Player Head' })?.displayName)
      .toBe('Player Head');
  });
});

describe('modern viewer message feed', () => {
  it('hides machine protection receipts while retaining chat and game notices', () => {
    const protect = { toString: () => 'MC_PROTECT {"action":"break","status":"deny"}' };
    expect(viewerMessageKind(protect, 'system')).toBeNull();
    expect(viewerMessageKind({ toString: () => 'MC_DUNGEON entrance x=1 y=2 z=3' }, 'system')).toBeNull();
    expect(viewerMessageKind({ toString: () => '{"schemaVersion":1,"action":"break"}' }, 'system')).toBeNull();
    expect(viewerMessageKind(protect, 'chat')).toBe('chat');
    expect(viewerMessageKind({ toString: () => '试炼场休息中' }, 'system')).toBe('system');
    expect(viewerMessageKind({ translate: 'commands.message.display.incoming',
      toString: () => 'Goddess 悄悄告诉你' }, 'system')).toBe('whisper');
  });
});

describe('modern viewer fishing bobber ownership', () => {
  it('passes the exact 1.20.6 spawn objectData owner to each bobber payload', () => {
    const owners = new Map<number, number>();
    const bobberTypeId = 129;
    recordFishingBobberOwner(owners, { entityId: 90, type: bobberTypeId, objectData: 2 }, bobberTypeId);
    recordFishingBobberOwner(owners, { entityId: 91, type: bobberTypeId, objectData: 1 }, bobberTypeId);
    const bot = { registry: { entitiesByName: { fishing_bobber: { width: .25, height: .25 } } } } as never;
    const bobber = (id: number) => ({ id, name: 'fishing_bobber', type: 'projectile',
      position: { x: 4, y: 63, z: 4 }, width: .25, height: .25, yaw: 0, pitch: 0 });
    expect(viewerEntity(bot, bobber(90) as never, owners).ownerEntityId).toBe(2);
    expect(viewerEntity(bot, bobber(91) as never, owners).ownerEntityId).toBe(1);
    expect(viewerEntity(bot, { ...bobber(90), name: 'arrow' } as never, owners)).not.toHaveProperty('ownerEntityId');
  });

  it('rejects invalid owners and clears stale IDs when another entity spawns', () => {
    const owners = new Map<number, number>();
    const bobberTypeId = 129;
    recordFishingBobberOwner(owners, { entityId: 90, type: bobberTypeId, objectData: 2 }, bobberTypeId);
    recordFishingBobberOwner(owners, { entityId: 90, type: 7, objectData: 3 }, bobberTypeId);
    expect(owners.has(90)).toBe(false);
    for (const owner of [0, -1, 90, 1.5, '2', Number.NaN]) {
      recordFishingBobberOwner(owners, { entityId: 90, type: bobberTypeId, objectData: owner }, bobberTypeId);
      expect(owners.has(90)).toBe(false);
    }
    recordFishingBobberOwner(owners, { entityId: 90, type: bobberTypeId, objectData: 3 }, bobberTypeId);
    expect(owners.get(90)).toBe(3);
    recordFishingBobberOwner(owners, { entityId: 90, type: bobberTypeId, objectData: null }, bobberTypeId);
    expect(owners.has(90)).toBe(false);
  });
});
