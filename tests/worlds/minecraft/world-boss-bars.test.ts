import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { MinecraftWorld } from '../../../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS } from '../../../src/worlds/minecraft/config.ts';
import { FakeHost } from '../../helpers/fake-host.ts';

const require = createRequire(import.meta.url);
function rig() {
  const registry = require(require.resolve('prismarine-registry', { paths: [require.resolve('mineflayer')] }))('1.20.6');
  const client = new EventEmitter();
  const bot = Object.assign(new EventEmitter(), { registry, _client: client });
  require('mineflayer/lib/plugins/boss_bar.js')(bot, { version: '1.20.6' });
  const world = new MinecraftWorld({ cfg: { ...structuredClone(MINECRAFT_DEFAULTS), host: 'example.test' } });
  const host = new FakeHost();
  Object.assign(world, { host, bridge: { bot, connected: true } });
  (world as unknown as { hookBotEvents(bot: unknown): void }).hookBotEvents(bot);
  const packet = (entityUUID: string, action: number, extra: object = {}) => client.emit('boss_bar', { entityUUID, action, ...extra });
  const create = (id: string, title: string) => packet(id, 0, { title, health: 1, color: 0, dividers: 0, flags: 0 });
  const progress = () => host.events.filter(event => event.text.includes('状态条进度为'));
  return { packet, create, progress, host };
}

describe('Minecraft state-bar progress delivery', () => {
  it('a countdown title changing every second retains the same progress baseline', () => {
    const { packet, create, progress } = rig();
    create('countdown', 'Village activity 1:00');
    for (let second = 1; second <= 60; second++) {
      packet('countdown', 3, { title: `Village activity 0:${60-second}` });
      packet('countdown', 2, { health: (60-second)/60 });
    }
    expect(progress().map(event => Number(event.text.match(/进度为 (\d+)%/)?.[1]))).toEqual([75,50,25,0]);
    expect(progress()[0].text).toContain('Village activity 0:45');
  });

  it('bars with identical titles and a deleted bar recreated with the same id have independent baselines', () => {
    const { packet, create, progress } = rig();
    create('one', 'Activity'); create('two', 'Activity');
    packet('one', 2, { health: .5 });
    packet('two', 2, { health: .75 });
    expect(progress()).toHaveLength(2);
    packet('one', 1);
    create('one', 'Activity');
    packet('one', 2, { health: .75 });
    expect(progress()).toHaveLength(3);
  });
});
