import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { observeViewerFishingCatch, viewerDroppedItem,
  type ViewerFishingCatch } from '../../../src/worlds/minecraft/viewer-fishing.ts';
import { viewerItem } from '../../../src/worlds/minecraft/viewer-state.ts';

function setup() {
  let time = 1000;
  let clockReads = 0;
  const protocol = Object.assign(new EventEmitter(), { write: (_name: string, _params?: Record<string, unknown>) => {} });
  const bot = Object.assign(new EventEmitter(), {
    _client: protocol, entity: { id: 7, position: { x: 0, y: 64, z: 0 } },
    entities: {} as Record<number, any>, heldItem: { name: 'fishing_rod' },
    registry: { entitiesByName: { fishing_bobber: { internalId: 129,
      metadataKeys: [...Array(9).fill(''), 'biting'] }, item: { internalId: 58 } },
    particlesByName: { fishing: { id: 30 }, bubble: { id: 3 } } },
    inventory: Object.assign(new EventEmitter(), { slots: Array(46).fill(null), inventoryStart: 9 }),
  });
  const events: ViewerFishingCatch[] = [];
  const originalWrite = protocol.write;
  const dispose = observeViewerFishingCatch(bot as never, event => events.push(event), viewerItem,
    () => { clockReads++; return time; });
  const hook = (owner = 7) => {
    bot.entities[100] = { id: 100, name: 'fishing_bobber', position: { x: 5, y: 63, z: 0 }, metadata: [] };
    protocol.emit('spawn_entity', { entityId: 100, type: 129, objectData: owner, x: 5, y: 63, z: 0 });
  };
  const bite = () => protocol.emit('world_particles', {
    particle: { type: 'fishing' }, amount: 6, x: 5, y: 63, z: 0,
  });
  const reel = () => { time += 50; protocol.write('use_item', { hand: 0 }); };
  const spawnLoot = (item: unknown, options: { x?: number; velocity?: { x: number; y: number; z: number }; id?: number } = {}) => {
    time += 50;
    const id = options.id ?? 101;
    bot.entities[id] = { id, name: 'item', position: { x: options.x ?? 5, y: 63, z: 0 },
      velocity: options.velocity ?? { x: -.5, y: .25, z: 0 }, getDroppedItem: () => item };
    protocol.emit('spawn_entity', { entityId: id, type: 58, x: options.x ?? 5, y: 63, z: 0 });
    bot.emit('itemDrop', bot.entities[id]);
  };
  const collect = (collectorEntityId = 7, id = 101, count = 1) => {
    time += 50;
    protocol.emit('collect', { collectedEntityId: id, collectorEntityId, pickupItemCount: count });
  };
  const gain = (item: unknown, slot = 9) => {
    bot.inventory.slots[slot] = item;
    bot.inventory.emit('updateSlot', slot, null, item);
  };
  return { bot, protocol, events, originalWrite, hook, bite, reel, spawnLoot, collect, gain, dispose,
    clockReads: () => clockReads,
    advance: (ms: number) => { time += ms; } };
}

const cod = { name: 'cod', type: 776, displayName: 'Cod', count: 1 };

describe('viewer fishing catch observation', () => {
  it('requires collect plus matching inventory growth and publishes once', () => {
    const s = setup();
    s.hook(); s.bite(); s.reel(); s.spawnLoot(cod); s.collect();
    expect(s.events).toEqual([]);
    s.gain(cod);
    expect(s.events).toMatchObject([{ seq: 1, item: { name: 'cod', count: 1 }, count: 1,
      position: { x: 5, y: 63, z: 0 } }]);
    s.bot.inventory.emit('updateSlot', 9); s.collect();
    expect(s.events).toHaveLength(1);
    s.dispose();
  });

  it('accepts vanilla junk and treasure, preserving component names and glint', () => {
    const s = setup();
    const treasure = { name: 'enchanted_book', type: 912, displayName: 'Enchanted Book', count: 1,
      components: [{ type: 'custom_name', data: '{"text":"海底的书"}' },
        { type: 'enchantments', data: { enchantments: [{ id: 3, level: 2 }] } }] };
    s.hook(); s.bite(); s.reel(); s.spawnLoot(treasure); s.gain(treasure); s.collect();
    expect(s.events[0]?.item).toMatchObject({ name: 'enchanted_book', customName: '海底的书',
      displayName: '海底的书', enchanted: true, components: treasure.components });
    const junk = { name: 'rotten_flesh', type: 861, count: 1 };
    s.hook(); s.bite(); s.reel(); s.spawnLoot(junk, { id: 102 }); s.collect(7, 102); s.gain(junk, 10);
    expect(s.events.map(event => event.item.name)).toEqual(['enchanted_book', 'rotten_flesh']);
    s.dispose();
  });

  it('compares the baseline when the catch merges into an existing stack', () => {
    const s = setup();
    s.gain({ ...cod, count: 7 });
    s.hook(); s.bite(); s.reel(); s.spawnLoot(cod); s.collect();
    s.gain({ ...cod, count: 7 });
    expect(s.events).toEqual([]);
    s.gain({ ...cod, count: 8 });
    expect(s.events[0]?.count).toBe(1);
    s.dispose();
  });

  it('observes a synchronous reel before the bite particle listener runs', () => {
    const s = setup();
    s.hook(); s.reel(); s.bite(); s.spawnLoot(cod); s.collect(); s.gain(cod);
    expect(s.events).toHaveLength(1);
    s.dispose();
  });

  it.each(['other-owner', 'no-bite', 'no-reel', 'falling-drop', 'far-spawn', 'other-collector'])
  ('does not report unrelated item pickup: %s', reason => {
    const s = setup();
    s.hook(reason === 'other-owner' ? 8 : 7);
    if (reason !== 'no-bite') s.bite();
    if (reason !== 'no-reel') s.reel();
    s.spawnLoot(cod, reason === 'falling-drop' ? { velocity: { x: 0, y: -.1, z: 0 } }
      : reason === 'far-spawn' ? { x: 15 } : {});
    s.collect(reason === 'other-collector' ? 8 : 7); s.gain(cod);
    expect(s.events).toEqual([]);
    s.dispose();
  });

  it('does not accept malformed particles as a bite', () => {
    const s = setup();
    s.hook();
    s.protocol.emit('world_particles', { amount: 6, x: 5, y: 63, z: 0 });
    s.reel(); s.spawnLoot(cod); s.collect(); s.gain(cod);
    expect(s.events).toEqual([]);
    s.dispose();
  });

  it('uses metadata biting state and keeps the reel receipt after hook removal', () => {
    const s = setup();
    s.hook();
    s.bot.entities[100].metadata[9] = true;
    s.bot.emit('entityUpdate', s.bot.entities[100]);
    s.reel(); s.protocol.emit('entity_destroy', { entityIds: [100] });
    s.spawnLoot(cod); s.collect(); s.gain(cod);
    expect(s.events).toHaveLength(1);
    s.dispose();
  });

  it('tracks the moving hook and reads spawn velocity ignored by Mineflayer', () => {
    const s = setup();
    s.hook();
    s.bot.entities[100].position.x = 8;
    s.bot.emit('entityMoved', s.bot.entities[100]);
    s.protocol.emit('world_particles', { particle: { type: 'fishing' }, amount: 6, x: 8, y: 63, z: 0 });
    s.reel();
    s.bot.entities[101] = { id: 101, name: 'item', position: { x: 8, y: 63, z: 0 },
      velocity: { x: 0, y: 0, z: 0 }, getDroppedItem: () => cod };
    s.protocol.emit('spawn_entity', { entityId: 101, type: 58, x: 8, y: 63, z: 0,
      velocity: { x: -6400, y: 2400, z: 0 } });
    s.collect(); s.gain(cod);
    expect(s.events).toHaveLength(1);
    s.dispose();
  });

  it('expires delayed loot and resets pending catches on respawn or disconnect', () => {
    for (const reset of ['expired', 'respawn', 'end']) {
      const s = setup();
      s.hook(); s.bite(); s.reel(); s.spawnLoot(cod); s.collect();
      if (reset === 'expired') s.advance(9000); else s.bot.emit(reset);
      s.gain(cod);
      expect(s.events).toEqual([]);
      s.dispose();
    }
  });

  it('detaches observers and restores the outgoing write after disposal', () => {
    const s = setup();
    s.dispose();
    expect(s.protocol.write).toBe(s.originalWrite);
    expect(s.protocol.eventNames()).toEqual([]);
    expect(s.bot.eventNames()).toEqual([]);
    expect(s.bot.inventory.eventNames()).toEqual([]);
    s.hook(); s.bite(); s.reel(); s.spawnLoot(cod); s.collect(); s.gain(cod);
    expect(s.events).toEqual([]);
  });

  it('restores the original writer when viewers disconnect in registration order', () => {
    const s = setup();
    const secondEvents: ViewerFishingCatch[] = [];
    const secondDispose = observeViewerFishingCatch(s.bot as never,
      event => secondEvents.push(event), viewerItem, () => 1000);
    const sharedWrite = s.protocol.write;
    s.dispose();
    expect(s.protocol.write).toBe(sharedWrite);
    s.hook(); s.bite(); s.reel(); s.spawnLoot(cod); s.collect(); s.gain(cod);
    expect(s.events).toEqual([]);
    expect(secondEvents).toHaveLength(1);
    secondDispose();
    expect(s.protocol.write).toBe(s.originalWrite);
    expect(s.protocol.eventNames()).toEqual([]);
    expect(s.bot.eventNames()).toEqual([]);
    expect(s.bot.inventory.eventNames()).toEqual([]);
  });

  it('shares one outgoing wrapper and restores it when newer viewers disconnect first', () => {
    const s = setup();
    const sharedWrite = s.protocol.write;
    const secondDispose = observeViewerFishingCatch(s.bot as never, () => {}, viewerItem);
    expect(s.protocol.write).toBe(sharedWrite);
    secondDispose();
    expect(s.protocol.write).toBe(sharedWrite);
    s.hook(); s.bite(); s.reel(); s.spawnLoot(cod); s.collect(); s.gain(cod);
    expect(s.events).toHaveLength(1);
    s.dispose();
    expect(s.protocol.write).toBe(s.originalWrite);
  });

  it('preserves later foreign wrappers while disposed fishing callbacks remain inactive', () => {
    const s = setup();
    const sharedWrite = s.protocol.write;
    const sent: Array<{ name: string; params: Record<string, unknown> | undefined; receiver: unknown }> = [];
    const foreignWrite: typeof sharedWrite = function (this: typeof s.protocol, name, params) {
      sent.push({ name, params, receiver: this });
      sharedWrite.call(this, name, params);
    };
    s.protocol.write = foreignWrite;
    s.dispose();
    expect(s.protocol.write).toBe(foreignWrite);
    const reads = s.clockReads();
    const params = { hand: 0 };
    s.protocol.write('use_item', params);
    expect(s.clockReads()).toBe(reads);
    expect(sent).toEqual([{ name: 'use_item', params, receiver: s.protocol }]);
    const secondEvents: ViewerFishingCatch[] = [];
    const secondDispose = observeViewerFishingCatch(s.bot as never,
      event => secondEvents.push(event), viewerItem, () => 1000);
    s.dispose(); // An already removed viewer cannot remove a new registration.
    s.hook(); s.bite(); s.reel(); s.spawnLoot(cod); s.collect(); s.gain(cod);
    expect(secondEvents).toHaveLength(1);
    secondDispose();
    expect(s.protocol.write).toBe(foreignWrite);
    s.protocol.write('use_item', params);
    expect(s.clockReads()).toBe(reads);
    expect(sent).toHaveLength(3);
  });

  it('waits for item metadata and ignores non-item entities', () => {
    expect(viewerDroppedItem({ name: 'experience_orb', getDroppedItem: () => cod }, viewerItem)).toBeNull();
    expect(viewerDroppedItem({ name: 'item', getDroppedItem: () => { throw Error('no metadata'); } }, viewerItem)).toBeNull();
  });
});
