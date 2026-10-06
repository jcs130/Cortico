import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import {
  bearing, facingDegrees, pitchPhrase, snapshotFromBot,
} from '../../../src/worlds/minecraft/terrain.ts';

const dependency = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const injectPhysics = dependency('./lib/plugins/physics.js') as (
  bot: object, options: { physicsEnabled: boolean },
) => void;
const registry = dependency('minecraft-data')('1.20.6');

/** Install the real lookAt/look conversion without logging in or starting physics/network timers. */
function observationBot() {
  const write = vi.fn();
  const bot = Object.assign(new EventEmitter(), {
    _client: Object.assign(new EventEmitter(), { write }),
    registry,
    supportFeature: (name: string) => registry.supportFeature(name),
    entity: {
      position: new Vec3(-867, 65, 319), velocity: new Vec3(0, 0, 0),
      eyeHeight: 1.62, yaw: 0, pitch: 0, onGround: true,
    },
    entities: {}, players: {},
    game: { dimension: 'overworld', gameMode: 'survival' },
    health: 20, food: 20, oxygenLevel: 20,
    time: { timeOfDay: 1000 }, rainState: 0,
    heldItem: null, inventory: { items: () => [] },
    blockAt: () => null, findBlocks: () => [],
    world: { raycast: () => null },
    lookAt: async (_point: Vec3, _force: boolean): Promise<void> => {
      throw new Error('Physics plugin did not install lookAt');
    },
  });
  injectPhysics(bot, { physicsEnabled: false });
  return { bot, write };
}

describe('Mineflayer lookAt → world observation orientation', () => {
  it.each([
    [0, -10, 'north', 0], [10, -10, 'northeast', 45],
    [10, 0, 'east', 90], [10, 10, 'southeast', 135],
    [0, 10, 'south', 180], [-10, 10, 'southwest', 225],
    [-10, 0, 'west', 270], [-10, -10, 'northwest', 315],
  ] as const)('looking at offset (%s, %s) reports %s / %s°', async (dx, dz, direction, degrees) => {
    const { bot, write } = observationBot();
    await bot.lookAt(bot.entity.position.offset(dx, bot.entity.eyeHeight, dz), true);
    expect(snapshotFromBot(bot, { scanBlocks: false }).facing).toBe(direction);
    expect(facingDegrees(bot.entity.yaw)).toBe(degrees);
    expect(bearing(dx, dz)).toBe(direction);
    expect(write).not.toHaveBeenCalled();
    bot.emit('end');
  });

  it.each([
    [0, null], [8, '抬头往上看'], [20, '仰头看天'],
    [-8, '低头看着地面'], [-20, '几乎盯着脚下'],
  ] as const)('looking at eye-relative height %s reports %s', async (dy, phrase) => {
    const { bot } = observationBot();
    await bot.lookAt(bot.entity.position.offset(0, bot.entity.eyeHeight + dy, 10), true);
    expect(pitchPhrase(bot.entity.pitch)).toBe(phrase);
    bot.emit('end');
  });
});
