import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { describe, expect, it } from 'vitest';
import { installOwnedFishing, ownedFishingBobber } from '../../../src/worlds/minecraft/fishing.ts';
import { findBobber } from '../../../src/worlds/minecraft/skills-gather.ts';

const require = createRequire(import.meta.url);
const upstream = require('mineflayer/lib/plugins/fishing.js') as (bot: unknown) => void;
const registry = minecraftData('1.20.6');
const mineflayerRequire = createRequire(require.resolve('mineflayer'));
const Entity = mineflayerRequire('prismarine-entity')('1.20.6') as new (id: number) => {
  id: number; position: Vec3; name?: string;
};

function connection(fixed = true) {
  const client = new EventEmitter();
  let uses = 0;
  const bot = Object.assign(new EventEmitter(), {
    _client: client, registry, entity: new Entity(9), entities: {} as Record<number, InstanceType<typeof Entity>>,
    supportFeature: registry.supportFeature, activateItem: () => { uses++; }, fish: async () => {},
  });
  upstream(bot);
  if (fixed) installOwnedFishing(bot as never);
  const spawn = (id: number, owner: number, position: Vec3) => {
    const entity = new Entity(id);
    Object.assign(entity, { name: 'fishing_bobber', position });
    bot.entities[id] = entity;
    client.emit('spawn_entity', { entityId: id, type: registry.entitiesByName.fishing_bobber.id, objectData: owner });
  };
  const bite = (position: Vec3, old = false) => client.emit('world_particles', old
    ? { particleId: registry.particlesByName.bubble.id, particles: 6, ...position }
    : { particle: { type: 'fishing' }, amount: 6, ...position });
  return { bot, client, spawn, bite, uses: () => uses };
}

describe('fishing ownership', () => {
  it('replays the upstream foreign-hook early-reel defect and leaves the fixed cast waiting', async () => {
    for (const fixed of [false, true]) {
      const r = connection(fixed);
      let caught = false;
      const cast = r.bot.fish().then(() => { caught = true; });
      r.spawn(20, 11, new Vec3(2, 63, 0));
      r.spawn(21, 9, new Vec3(6, 63, 0));
      r.bite(new Vec3(2, 63, 0));
      await Promise.resolve(); await Promise.resolve();
      expect(caught).toBe(!fixed);
      expect(r.uses()).toBe(fixed ? 1 : 2);
      if (fixed) {
        expect(findBobber(r.bot as never)?.id).toBe(21);
        r.bite(new Vec3(6, 63, 0));
      }
      await cast;
      expect(caught).toBe(true);
      expect(r.uses()).toBe(2);
    }
  });

  it('a foreign destroy or vertically separated bite cannot finish the current cast', async () => {
    const r = connection();
    let caught = false;
    const cast = r.bot.fish().then(() => { caught = true; });
    r.spawn(20, 11, new Vec3(6, 63, 0));
    r.spawn(21, 9, new Vec3(6, 63, 0));
    r.client.emit('entity_destroy', { entityIds: [20] });
    r.bite(new Vec3(6, 68, 0));
    await Promise.resolve();
    expect(caught).toBe(false);
    expect(ownedFishingBobber(r.bot as never)?.id).toBe(21);
    r.bite(new Vec3(6, 63, 0), true);
    await cast;
    expect(caught).toBe(true);
  });

  it('recast, own-hook destruction and disconnect each cancel only their active cast', async () => {
    const r = connection();
    const first = r.bot.fish();
    const firstRejected = expect(first).rejects.toThrow('calling bot.fish() again');
    r.spawn(21, 9, new Vec3(6, 63, 0));
    const second = r.bot.fish();
    const secondRejected = expect(second).rejects.toThrow('Fishing cancelled');
    expect(findBobber(r.bot as never)).toBeNull();
    r.spawn(22, 9, new Vec3(5, 63, 0));
    r.client.emit('entity_destroy', { entityIds: [21] });
    expect(findBobber(r.bot as never)?.id).toBe(22);
    r.client.emit('entity_destroy', { entityIds: [22] });
    await firstRejected; await secondRejected;
    const third = r.bot.fish();
    const thirdRejected = expect(third).rejects.toThrow('connection ended');
    r.bot.emit('end');
    await thirdRejected;
    expect(ownedFishingBobber(r.bot as never)).toBeNull();
    expect(r.client.listenerCount('spawn_entity')).toBe(1); // Upstream listener remains dormant.
  });
});
