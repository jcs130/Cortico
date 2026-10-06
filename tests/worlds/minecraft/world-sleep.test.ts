import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { MinecraftWorld } from '../../../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS, type MinecraftConfigSection } from '../../../src/worlds/minecraft/config.ts';
import { FakeHost } from '../../helpers/fake-host.ts';

function rig() {
  const cfg = structuredClone(MINECRAFT_DEFAULTS) as MinecraftConfigSection;
  cfg.host = 'example.test';
  cfg.port = 25565;
  const world = new MinecraftWorld({ cfg });
  const host = new FakeHost();
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(),
    inventory: Object.assign(new EventEmitter(), { items: () => [] }),
    entity: { position: new Vec3(10, 64, -3) },
    game: { dimension: 'overworld' as string | null },
    time: { timeOfDay: 14000, day: 12, age: 280000 } as Record<string, unknown>,
    findBlock: () => ({ name: 'red_bed', position: new Vec3(11, 64, -3) }),
    health: 20,
  });
  Object.assign(world, { host });
  (world as unknown as { hookBotEvents(bot: unknown): void }).hookBotEvents(bot);
  return { bot, host, world };
}

describe('Minecraft World sleep observations', () => {
  it('wakes the main loop on actual sleep and preserves the bed spawn point', () => {
    const { bot, host, world } = rig();
    bot.emit('sleep');
    expect(host.events.filter(event => event.type === 'minecraft.sleep')).toHaveLength(1);
    expect(host.events.at(-1)).toMatchObject({
      source: 'minecraft', type: 'minecraft.sleep', text: '[Minecraft] 躺下睡了。',
      meta: { sleeping: true, world: 'example.test:25565', dimension: 'minecraft:overworld',
        timeOfDay: 14000, gameDay: 12, worldAge: 280000 },
    });
    expect(host.pushOpts.at(-1)?.trigger).toBe('debounce');
    const spawn = world.logConsole().entries().find(entry => entry.event === 'spawn-point');
    expect(spawn?.msg).toContain('(11, 64, -3) minecraft:overworld [bed]');
    expect(spawn?.data).toMatchObject({ from: 'sleep 事件' });
  });

  it('captures separate sleep and wake readings across the skipped night', () => {
    const { bot, host } = rig();
    bot.emit('sleep');
    Object.assign(bot.time, { timeOfDay: 0, day: 13, age: 280101 });
    bot.emit('wake');
    const sleep = host.events.filter(event => event.type === 'minecraft.sleep' || event.type === 'minecraft.wake');
    expect(sleep.map(event => event.type)).toEqual(['minecraft.sleep', 'minecraft.wake']);
    expect(sleep[0].meta).toMatchObject({ sleeping: true, timeOfDay: 14000, gameDay: 12, worldAge: 280000 });
    expect(sleep[1]).toMatchObject({ text: '[Minecraft] 醒了。',
      meta: { sleeping: false, timeOfDay: 0, gameDay: 13, worldAge: 280101 } });
    expect(host.pushOpts.at(-1)?.trigger).toBe('piggyback');
  });

  it('reports observed daytime sleep and the actual dimension without inferring night', () => {
    const { bot, host } = rig();
    bot.time.timeOfDay = 5000;
    bot.game.dimension = 'custom:moon';
    bot.emit('sleep');
    expect(host.events.at(-1)?.meta).toMatchObject({ sleeping: true, dimension: 'custom:moon', timeOfDay: 5000, gameDay: 12 });
  });

  it.each([
    { timeOfDay: null, day: null, age: null },
    { timeOfDay: undefined, day: undefined, age: undefined },
    { timeOfDay: NaN, day: Infinity, age: -1 },
    { timeOfDay: 24000, day: 1.5, age: Number.MAX_SAFE_INTEGER + 1 },
    { timeOfDay: '14000', day: '12', age: '280000' },
  ])('keeps unavailable or invalid protocol time readings unknown: %j', time => {
    const { bot, host } = rig();
    bot.time = time;
    bot.game.dimension = null;
    bot.emit('sleep');
    expect(host.events.at(-1)?.meta).toEqual({ sleeping: true, world: 'example.test:25565', dimension: null,
      timeOfDay: null, gameDay: null, worldAge: null });
  });
});
