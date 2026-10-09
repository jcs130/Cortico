import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { MinecraftWorld } from '../../../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS, type MinecraftConfigSection } from '../../../src/worlds/minecraft/config.ts';
import {
  narrateWorld, narrateWorldSegments, snapshotFingerprint, snapshotFromBot, worldDelta,
  type WorldSnapshot,
} from '../../../src/worlds/minecraft/terrain.ts';
import { FakeHost } from '../../helpers/fake-host.ts';

const require = createRequire(import.meta.url);
const dependency = (name: string) => require(require.resolve(name, { paths: [require.resolve('mineflayer')] }));

/** 实际 Mineflayer 健康、经验插件与原版窗口；不创建网络连接。 */
function nativeVitals() {
  const registry = dependency('prismarine-registry')('1.20.6');
  const windows = dependency('prismarine-windows')('1.20.6');
  const Item = dependency('prismarine-item')(registry);
  const client = Object.assign(new EventEmitter(), { write() {} });
  const inventory = windows.createWindow(0, 'minecraft:inventory', 'Inventory');
  const bot = Object.assign(new EventEmitter(), {
    _client: client, registry, inventory,
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0),
      yaw: 0, onGround: true, effects: {} },
    entities: {}, players: {}, game: { dimension: 'overworld', gameMode: 'survival' },
    time: { timeOfDay: 1000 }, rainState: 0, heldItem: null,
    blockAt: () => null, findBlocks: () => [],
    health: undefined as number | undefined, food: undefined as number | undefined,
    experience: undefined as { level: number | null; points: number | null; progress: number | null } | undefined,
  });
  require('mineflayer/lib/plugins/health.js')(bot, { respawn: false });
  require('mineflayer/lib/plugins/experience.js')(bot);
  const health = (hp: number, food: number) => client.emit('update_health', {
    health: hp, food, foodSaturation: 0,
  });
  const experience = (level: number) => client.emit('experience', {
    level, totalExperience: 0, experienceBar: 0,
  });
  const snapshot = () => snapshotFromBot(bot, { scanBlocks: false, invSynced: false });
  return { bot, client, inventory, Item, registry, health, experience, snapshot };
}

type WorldInternals = {
  hookBotEvents(bot: unknown): void;
  reportWorldDelta(): void;
  lastReported: WorldSnapshot | null;
  lastLevel: number | null;
};

function observing(rig: ReturnType<typeof nativeVitals>) {
  const cfg = structuredClone(MINECRAFT_DEFAULTS) as MinecraftConfigSection;
  cfg.host = 'example.test';
  const world = new MinecraftWorld({ cfg });
  const host = new FakeHost();
  Object.assign(world, { host, bridge: { bot: rig.bot, connected: true, invSynced: false } });
  const internal = world as unknown as WorldInternals;
  internal.hookBotEvents(rig.bot);
  return { world, host, internal };
}

describe('Minecraft authoritative initial body readings', () => {
  it('keeps offhand food quantities separate from the main inventory and projects both reserves', () => {
    const rig = nativeVitals();
    rig.inventory.updateSlot(36, new rig.Item(rig.registry.itemsByName.bread.id, 2));
    rig.inventory.updateSlot(45, new rig.Item(rig.registry.itemsByName.golden_apple.id, 3));
    const snapshot = rig.snapshot();
    expect(snapshot.inventory.some(item => item.name === 'golden_apple')).toBe(false);
    expect(snapshot.equipment.find(item => item.slot === 'offhand')).toMatchObject({ name: 'golden_apple', count: 3 });
    const { world } = observing(rig);
    Object.assign(world, { snapshot: () => ({ ...rig.snapshot(), invSynced: true }) });
    const project = () => (world as unknown as { renderSnapshotEvent(): string | null }).renderSnapshotEvent();
    expect(project()).toContain('特殊食物：金苹果×3');
    expect((world as unknown as { requestFactsCache: { text: string } }).requestFactsCache.text).toContain('常规 2 个');
    const before = snapshotFingerprint(rig.snapshot());
    rig.inventory.updateSlot(45, new rig.Item(rig.registry.itemsByName.golden_apple.id, 2));
    expect(snapshotFingerprint(rig.snapshot())).not.toBe(before);
  });

  it('keeps native first-spawn readings unknown and displays already received armor', () => {
    const rig = nativeVitals();
    rig.inventory.updateSlot(6, new rig.Item(rig.registry.itemsByName.iron_chestplate.id, 1));
    let spawned: WorldSnapshot | null = null;
    rig.bot.once('spawn', () => { spawned = rig.snapshot(); });
    rig.health(20, 9);
    expect(spawned).toMatchObject({ health: null, food: null, xpLevel: null });
    const text = narrateWorld(spawned!);
    expect(text).toContain('生命正在从服务器同步');
    expect(text).toContain('饥饿正在从服务器同步');
    expect(text).toContain('经验正在从服务器同步');
    expect(text).toContain('铁胸甲');
    expect(text).not.toContain('生命 20/20');
    expect(text).not.toContain('饥饿 20/20');
    expect(text).not.toContain('经验 0 级');
    expect(rig.snapshot()).toMatchObject({ health: 20, food: 9, xpLevel: null });
  });

  it('receives health before experience without making either field wait for the other', () => {
    const rig = nativeVitals();
    rig.health(8, 9);
    const body = narrateWorld(rig.snapshot());
    expect(body).toContain('生命 8/20');
    expect(body).toContain('饥饿 9/20');
    expect(body).toContain('经验正在从服务器同步');
    rig.experience(49);
    expect(rig.snapshot()).toMatchObject({ health: 8, food: 9, xpLevel: 49 });
    expect(narrateWorld(rig.snapshot())).toContain('经验 49 级');
  });

  it('treats real zero health, hunger and experience packets as confirmed values', () => {
    const rig = nativeVitals();
    rig.health(0, 0);
    rig.experience(0);
    const snapshot = rig.snapshot();
    expect(snapshot).toMatchObject({ health: 0, food: 0, xpLevel: 0 });
    const text = narrateWorld(snapshot);
    expect(text).toContain('生命 0/20');
    expect(text).toContain('饥饿 0/20');
    expect(text).toContain('经验 0 级');
    expect(text).not.toContain('正在从服务器同步');
  });

  it('preserves independent known fields while unavailable and invalid readings remain unknown', () => {
    const rig = nativeVitals();
    rig.bot.health = 7;
    rig.experience(0);
    expect(rig.snapshot()).toMatchObject({ health: 7, food: null, xpLevel: 0 });
    expect(narrateWorld(rig.snapshot())).toContain('饥饿正在从服务器同步');
    Object.assign(rig.bot, { health: NaN, food: Infinity, experience: { level: '0' } });
    expect(rig.snapshot()).toMatchObject({ health: null, food: null, xpLevel: null });
  });

  it('uses the first confirmed hunger reading as a baseline and reports later category changes', () => {
    const rig = nativeVitals();
    const unknown = rig.snapshot();
    rig.health(20, 9);
    const first = rig.snapshot();
    expect(worldDelta(unknown, first, 24).notes).toEqual([]);
    rig.health(20, 5);
    expect(worldDelta(first, rig.snapshot(), 24).notes).toEqual(['快饿坏了(饥饿 5/20)']);
    expect(worldDelta(first, unknown, 24).notes).toEqual([]);
  });

  it('refreshes body and equipment segments when unknown values first become known', () => {
    const rig = nativeVitals();
    const unknown = rig.snapshot();
    rig.health(20, 20);
    const body = rig.snapshot();
    rig.experience(0);
    const known = rig.snapshot();
    const segment = (s: WorldSnapshot, key: string) => narrateWorldSegments(s).find(row => row.key === key)!;
    expect(snapshotFingerprint(body)).not.toBe(snapshotFingerprint(unknown));
    expect(segment(body, 'body').cmp).not.toBe(segment(unknown, 'body').cmp);
    expect(snapshotFingerprint(known)).not.toBe(snapshotFingerprint(body));
    expect(segment(known, 'equip').cmp).not.toBe(segment(body, 'equip').cmp);
    rig.experience(1);
    expect(snapshotFingerprint(rig.snapshot())).toBe(snapshotFingerprint(known));
  });

  it('does not reuse a previous connection body or experience on a new bot', () => {
    const old = nativeVitals();
    old.health(6, 3);
    old.experience(49);
    expect(old.snapshot()).toMatchObject({ health: 6, food: 3, xpLevel: 49 });
    const next = nativeVitals();
    expect(next.snapshot()).toMatchObject({ health: null, food: null, xpLevel: null });
    next.health(20, 9);
    next.experience(0);
    expect(next.snapshot()).toMatchObject({ health: 20, food: 9, xpLevel: 0 });
  });
});

describe('Minecraft World initial readings and change baselines', () => {
  it('delivers initial authoritative body and experience facts without fabricated hunger or level changes', () => {
    const rig = nativeVitals();
    const { host, internal } = observing(rig);
    internal.reportWorldDelta();
    rig.health(20, 9);
    rig.experience(49);
    internal.reportWorldDelta();
    expect(host.events.map(event => event.text)).toEqual([
      '[Minecraft] 身体状态已同步：生命 20/20，饥饿 9/20。',
      '[Minecraft] 经验已同步，当前 49 级。',
    ]);
    expect(host.pushOpts.every(opts => opts?.trigger === 'piggyback')).toBe(true);
    expect(internal.lastReported).toMatchObject({ health: 20, food: 9, xpLevel: 49 });
    rig.health(20, 5);
    internal.reportWorldDelta();
    rig.experience(50);
    expect(host.events.map(event => event.text).slice(2)).toEqual([
      '[Minecraft] 快饿坏了(饥饿 5/20)', '[Minecraft] 升到 50 级了。',
    ]);
  });

  it('hooks World observations during native spawn before the health assignment and still delivers the first body fact', () => {
    const rig = nativeVitals();
    let host: FakeHost | undefined;
    let first: WorldSnapshot | undefined;
    rig.bot.once('spawn', () => {
      first = rig.snapshot();
      host = observing(rig).host;
    });
    rig.health(20, 9);
    expect(first).toMatchObject({ health: null, food: null, xpLevel: null });
    expect(host?.events.map(event => event.text)).toEqual([
      '[Minecraft] 身体状态已同步：生命 20/20，饥饿 9/20。',
    ]);
  });

  it('advances only the unknown body baseline and preserves cumulative movement reporting', () => {
    const rig = nativeVitals();
    const { host, internal } = observing(rig);
    const threshold = MINECRAFT_DEFAULTS.world.moveThreshold;
    internal.reportWorldDelta();
    rig.bot.entity.position.x += threshold / 2;
    rig.health(20, 9);
    internal.reportWorldDelta();
    expect(internal.lastReported?.position.x).toBe(0.5);
    expect(internal.lastReported?.food).toBe(9);
    rig.bot.entity.position.x += threshold / 2;
    internal.reportWorldDelta();
    expect(host.events.filter(event => event.type === 'minecraft.world').map(event => event.text)).toEqual([
      `[Minecraft] 往东走了 ${threshold} 格,现在在 (${threshold + 0.5}, 64, 0.5)`,
    ]);
  });

  it('publishes real initial zero experience and only later growth is a level-up', () => {
    const rig = nativeVitals();
    const { host } = observing(rig);
    rig.experience(0);
    rig.experience(0);
    rig.experience(1);
    expect(host.events.map(event => event.text)).toEqual([
      '[Minecraft] 经验已同步，当前 0 级。', '[Minecraft] 升到 1 级了。',
    ]);
  });

  it('clears the old connection level baseline before observing a new bot', () => {
    const old = nativeVitals();
    const { world, host, internal } = observing(old);
    old.experience(49);
    const next = nativeVitals();
    Object.assign(world, { bridge: { bot: next.bot, connected: true, invSynced: false } });
    internal.hookBotEvents(next.bot);
    expect(internal.lastLevel).toBeNull();
    next.experience(50);
    expect(host.events.at(-1)?.text).toBe('[Minecraft] 经验已同步，当前 50 级。');
    expect(host.events.map(event => event.text).join('\n')).not.toContain('升到');
  });
});
