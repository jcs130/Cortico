import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDamageEvidence, observeDamage, type DamageEvidence } from '../../../src/worlds/minecraft/damage-evidence.ts';
import { Reflexes } from '../../../src/worlds/minecraft/executor.ts';

const require = createRequire(import.meta.url);
const dependency = createRequire(require.resolve('mineflayer'));
type Packet = Record<string, any>;

/** The native entities plugin receives the actual 1.20.6 wire packet shape. */
function fixture(installEarly = true) {
  const registry = dependency('prismarine-registry')('1.20.6');
  const protocol = dependency('minecraft-protocol');
  const codecs = (state: string) => ({
    serializer: protocol.createSerializer({ state, isServer: true, version: '1.20.6' }),
    parser: protocol.createDeserializer({ state, isServer: false, version: '1.20.6' }),
  });
  const play = codecs('play');
  const config = codecs('configuration');
  const client = Object.assign(new EventEmitter(), { write() {} });
  const bot = Object.assign(new EventEmitter(), {
    registry, version: '1.20.6', _client: client, supportFeature: registry.supportFeature,
    health: 20, food: 20, game: { dimension: 'overworld' },
    inventory: { items: () => [] }, blockAt: () => ({ name: 'air', boundingBox: 'empty', shapes: [] }),
    setControlState() {}, lookAt: async () => {}, equip: async () => {},
    pathfinder: { goal: null as unknown, setGoal(goal: unknown) { this.goal = goal; }, stop() {} },
  }) as unknown as Bot;
  require('mineflayer/lib/plugins/entities.js')(bot, {});
  bot.entity = { id: 1, name: 'player', type: 'player', position: new Vec3(0, 64, 0),
    height: 1.8, isValid: true, effects: {}, metadata: [] } as unknown as Bot['entity'];
  bot.entities[1] = bot.entity;
  const entity = (id: number, name: string, at = new Vec3(2, 64, 0)) => {
    const value = { id, name, type: registry.entitiesByName[name].type, position: at,
      height: registry.entitiesByName[name].height, isValid: true, metadata: [] } as unknown as Bot['entity'];
    bot.entities[id] = value;
    return value;
  };
  if (installEarly) installDamageEvidence(bot);
  const receive = (name: string, params: Packet, codec = play): Packet => {
    const data = codec.parser.parsePacketBuffer(codec.serializer.createPacketBuffer({ name, params })).data;
    client.emit(data.name, data.params);
    return data.params;
  };
  // Deliberately reordered registry: IDs must come from this connection, not static data.
  receive('registry_data', { id: 'minecraft:damage_type', entries: [
    { key: 'minecraft:custom_environment', value: null },
    { key: 'minecraft:arrow', value: null }, { key: 'minecraft:mob_attack', value: null },
  ] }, config);
  const hurt = (overrides: Packet = {}) => receive('damage_event', {
    entityId: 1, sourceTypeId: 0, sourceCauseId: 0, sourceDirectId: 0,
    sourcePosition: undefined, ...overrides,
  });
  const health = (value: number) => {
    receive('update_health', { health: value, food: 0, foodSaturation: 0 });
    bot.health = value;
  };
  const seen: DamageEvidence[] = [];
  const unobserve = observeDamage(bot, (evidence) => seen.push(evidence));
  return { bot, client, entity, hurt, health, receive, seen, unobserve };
}

async function flush() {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(60);
  else await new Promise((resolve) => setTimeout(resolve, 60));
}
afterEach(() => vi.useRealTimers());

describe('server damage provenance', () => {
  it('retains the live damage registry and decodes cause/direct IDs separately', async () => {
    const r = fixture();
    const shooter = r.entity(3, 'skeleton', new Vec3(20, 64, 0));
    r.entity(7, 'arrow');
    const native = vi.fn();
    r.bot.on('entityHurt', native);
    const packet = r.hurt({ sourceTypeId: 1, sourceCauseId: 4, sourceDirectId: 8,
      sourcePosition: { x: 20, y: 65, z: 0 } });
    await flush();
    expect(packet.sourceCauseId).toBe(4);
    expect(native).toHaveBeenCalledWith(r.bot.entity, shooter);
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]).toMatchObject({ origin: 'packet', sourceType: 'minecraft:arrow',
      causeId: 3, directId: 7, actor: { id: 3, entity: shooter }, projectile: true });
  });

  it('does not identify the nearby hidden hostile as the source of environment damage', async () => {
    const r = fixture();
    r.entity(2, 'zombie', new Vec3(0, 60, 1));
    for (let i = 0; i < 6; i++) { r.health(19 - i); r.hurt(); await flush(); }
    expect(r.seen).toHaveLength(6);
    expect(r.seen.every((evidence) => evidence.actor === null)).toBe(true);
    expect(r.seen[0].sourceType).toBe('minecraft:custom_environment');
  });

  it('accepts a live direct living source when cause is absent, not a projectile as its owner', async () => {
    const r = fixture();
    const zombie = r.entity(2, 'zombie');
    r.hurt({ sourceDirectId: 3 });
    await flush();
    expect(r.seen[0].actor?.entity).toBe(zombie);
    r.entity(8, 'arrow');
    r.hurt({ sourceTypeId: 1, sourceDirectId: 9, sourcePosition: { x: 4, y: 65, z: 0 } });
    await flush();
    expect(r.seen[1]).toMatchObject({ actor: null, directId: 8, projectile: true });
  });

  it('preserves a server-confirmed cause after the actor unloads', async () => {
    const r = fixture();
    r.hurt({ sourceCauseId: 501, sourceDirectId: 9 });
    await flush();
    expect(r.seen[0].actor).toEqual({ id: 500, name: '伤害来源' });
  });

  it('cannot replace a missing direct entity with another nearby actor', async () => {
    const r = fixture();
    r.entity(2, 'skeleton');
    r.hurt({ sourceTypeId: 1, sourceDirectId: 501 });
    await flush();
    expect(r.seen[0]).toMatchObject({ directId: 500, actor: null });
  });

  it.each(['native-first', 'raw-first'])('coalesces native/raw ordering: %s', async (order) => {
    vi.useFakeTimers();
    const r = fixture();
    const actor = r.entity(2, 'zombie');
    if (order === 'native-first') r.bot.emit('entityHurt', r.bot.entity, actor);
    r.hurt({ sourceTypeId: 2, sourceCauseId: 3, sourceDirectId: 3 });
    if (order === 'raw-first') r.bot.emit('entityHurt', r.bot.entity, actor);
    await flush();
    await vi.advanceTimersByTimeAsync(30);
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0].origin).toBe('packet');
  });

  it('environment raw overrides a legacy guess before legacy dispatch', async () => {
    vi.useFakeTimers();
    const r = fixture();
    r.bot.emit('entityHurt', r.bot.entity, r.entity(2, 'zombie'));
    await vi.advanceTimersByTimeAsync(10);
    r.hurt();
    await flush();
    await vi.advanceTimersByTimeAsync(30);
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0].actor).toBeNull();
  });

  it.each(['health-first', 'health-last'])('deduplicates echoes and permits fresh damage: %s', async (order) => {
    const r = fixture();
    r.entity(2, 'zombie');
    const packet = { sourceTypeId: 2, sourceCauseId: 3, sourceDirectId: 3 };
    if (order === 'health-first') r.health(18);
    r.hurt(packet);
    r.hurt(packet);
    if (order === 'health-last') r.health(18);
    await flush();
    for (let i = 0; i < 10; i++) { r.hurt(packet); await flush(); }
    expect(r.seen).toHaveLength(1);
    if (order === 'health-first') r.health(16);
    r.hurt(packet);
    if (order === 'health-last') r.health(16);
    await flush();
    expect(r.seen).toHaveLength(2);
    expect(r.seen[1].sequence).toBeGreaterThan(r.seen[0].sequence);
  });

  it('ignores another entity and self-caused damage does not become another actor', async () => {
    const r = fixture();
    r.entity(2, 'zombie');
    r.hurt({ entityId: 2, sourceCauseId: 3 });
    r.hurt({ sourceCauseId: 2, sourceDirectId: 3 });
    await flush();
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0].actor).toBeNull();
  });

  it('waits for health in the next callback and preserves absorbed hits without a health decrease', async () => {
    vi.useFakeTimers();
    const r = fixture();
    r.entity(2, 'zombie');
    const packet = { sourceTypeId: 2, sourceCauseId: 3, sourceDirectId: 3 };
    r.hurt(packet);
    await flush();
    r.hurt(packet);
    await vi.advanceTimersByTimeAsync(10);
    r.health(18);
    await flush();
    expect(r.seen).toHaveLength(2);
    const key = r.bot.registry.entitiesByName.player.metadataKeys!.indexOf('player_absorption');
    r.client.emit('entity_metadata', { entityId: 1, metadata: [{ key, value: 4 }] });
    r.hurt(packet);
    await vi.advanceTimersByTimeAsync(10);
    r.client.emit('entity_metadata', { entityId: 1, metadata: [{ key, value: 2 }] });
    await flush();
    expect(r.seen).toHaveLength(3);
    expect(r.bot.health).toBe(18);
  });

  it('drops queued evidence on death and keeps the next life independent', async () => {
    const r = fixture();
    r.hurt();
    r.bot.emit('death');
    await flush();
    expect(r.seen).toEqual([]);
    r.bot.emit('respawn');
    r.hurt();
    await flush();
    expect(r.seen).toHaveLength(1);
    r.unobserve();
    r.hurt({ sourceTypeId: 2 });
    await flush();
    expect(r.seen).toHaveLength(1);
  });

  it('late installation keeps an unknown type instead of using a guessed static ID', async () => {
    const r = fixture(false);
    r.hurt({ sourceTypeId: 1 });
    await flush();
    expect(r.seen[0].sourceType).toBeNull();
  });

  it('legacy unknown hurt stays unknown; explicit stale source is not trusted', async () => {
    vi.useFakeTimers();
    const r = fixture();
    const actor = r.entity(2, 'zombie');
    (r.bot as unknown as EventEmitter).emit('entityHurt', r.bot.entity);
    await vi.advanceTimersByTimeAsync(30);
    r.bot.emit('entityHurt', r.bot.entity, { ...actor } as never);
    await vi.advanceTimersByTimeAsync(30);
    r.bot.emit('entityHurt', r.bot.entity, actor);
    await vi.advanceTimersByTimeAsync(30);
    expect(r.seen.map((evidence) => evidence.actor?.id ?? null)).toEqual([null, null, 2]);
  });
});

function reflexFixture(r: ReturnType<typeof fixture>) {
  const combatHurt = vi.fn(() => true);
  const preempt = vi.fn();
  const reports: unknown[] = [];
  const reflex = new Reflexes({ getBot: () => r.bot, combatHurt, preempt,
    report: (report: unknown) => reports.push(report), log: {},
    fightBack: () => true, fleeHealth: () => 10, reactCooldownSec: () => 8,
    antiLava: () => false, antiDrown: () => false,
    pauseEnvironment: () => null, resumeEnvironment: () => ({ released: false }),
  } as never);
  (reflex as unknown as { hookHurt(bot: Bot): void }).hookHurt(r.bot);
  return { reflex, combatHurt, preempt, reports };
}

describe('Reflexes use confirmed attackers, not nearby candidates', () => {
  it('continuous unattributed hurt cannot refresh a prior confirmed combat hit', async () => {
    const r = fixture();
    const attacker = r.entity(2, 'skeleton', new Vec3(0, 60, 1));
    const f = reflexFixture(r);
    r.hurt({ sourceTypeId: 2, sourceCauseId: 3, sourceDirectId: 3 });
    await flush();
    expect(f.combatHurt).toHaveBeenCalledWith(attacker.id, 'skeleton');
    for (let i = 0; i < 12; i++) { r.health(19 - i); r.hurt(); await flush(); }
    expect(f.combatHurt).toHaveBeenCalledTimes(1);
    expect(f.preempt).not.toHaveBeenCalled();
    f.reflex.stop();
  });

  it('real invisible arrow source stays confirmed without retargeting a closer creature', async () => {
    const r = fixture();
    r.entity(2, 'zombie');
    r.entity(3, 'skeleton', new Vec3(30, 60, 0));
    r.entity(8, 'arrow');
    const f = reflexFixture(r);
    r.hurt({ sourceTypeId: 1, sourceCauseId: 4, sourceDirectId: 9 });
    await flush();
    expect(f.combatHurt).toHaveBeenCalledTimes(1);
    expect(f.combatHurt).toHaveBeenCalledWith(3, 'skeleton');
    f.reflex.stop();
  });

  it('low-health ownerless projectile permits directional escape without inventing a shooter', async () => {
    const r = fixture();
    r.bot.health = 6;
    r.entity(2, 'skeleton');
    r.entity(8, 'arrow');
    const f = reflexFixture(r);
    r.hurt({ sourceTypeId: 1, sourceDirectId: 9, sourcePosition: { x: 10, y: 65, z: 0 } });
    await flush();
    expect(f.combatHurt).not.toHaveBeenCalled();
    expect(f.preempt).toHaveBeenCalledTimes(1);
    expect(r.bot.pathfinder.goal).toMatchObject({ x: -8, z: 0 });
    f.reflex.stop();
  });
});
