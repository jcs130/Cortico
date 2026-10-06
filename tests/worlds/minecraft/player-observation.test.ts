import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { PlayerObservations, playerFacingAngle, playerObservationMeta, renderPlayerObservation } from '../../../src/worlds/minecraft/player-observation.ts';
import { MinecraftWorld } from '../../../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS } from '../../../src/worlds/minecraft/config.ts';
import { FakeHost } from '../../helpers/fake-host.ts';

function player(id = 2, username = 'Alex', x = 5, z = 0) {
  return { id, username, type: 'player', name: 'player', isValid: true,
    position: new Vec3(x, 64, z), height: 1.8, yaw: 0, headYaw: 0, pitch: 0,
    equipment: [] as Array<{ name: string } | null> };
}

function rig() {
  const self = player(1, 'Bot', 0);
  const alex = player();
  let blocked = false;
  const inventory = Object.assign(new EventEmitter(), { items: () => [], slots: [] });
  const bot = Object.assign(new EventEmitter(), { entity: self,
    entities: { 1: self, 2: alex } as Record<number, ReturnType<typeof player>>,
    world: { raycast: () => blocked ? { name: 'stone' } : null },
    inventory, game: { dimension: 'overworld' }, _client: new EventEmitter(),
    chat: () => { throw new Error('Observation cannot send chat'); },
    attack: () => { throw new Error('Observation cannot attack'); },
  });
  const observations = new PlayerObservations();
  const ignore = (name: string) => name === 'Bot' || name === 'Camera';
  const sample = (time: number) => observations.sample(bot as unknown as Bot, ignore, time);
  const gesture = (motion: 'wave' | 'crouch', time: number) =>
    observations.gesture(bot as unknown as Bot, alex as unknown as Bot['entity'], motion, ignore, time);
  return { bot, alex, observations, sample, gesture, block: (value: boolean) => { blocked = value; } };
}

describe('PlayerObservations', () => {
  it('reports entry and close edges once, with hysteresis and camera filtering', () => {
    const { bot, alex, sample } = rig();
    bot.entities[3] = player(3, 'Camera', 2);
    expect(sample(0).map(playerObservationMeta)).toMatchObject([
      { kind: 'entered', playerName: 'Alex', entityId: 2, visible: true, distance: 5 },
    ]);
    expect(sample(500)).toEqual([]);
    alex.position.x = 3;
    expect(sample(1000).map(playerObservationMeta)).toMatchObject([{ kind: 'close' }]);
    alex.position.x = 4.5;
    expect(sample(1500)).toEqual([]);
    alex.position.x = 3;
    expect(sample(2000)).toEqual([]);
    alex.position.x = 24;
    expect(sample(2500)).toEqual([]);
    alex.position.x = 3;
    expect(sample(3000).map(playerObservationMeta)).toMatchObject([{ kind: 'entered' }]);
  });

  it('hidden players do not disclose exact distance; visibility regain is delivered', () => {
    const { sample, block } = rig();
    block(true);
    const [hidden] = sample(0);
    expect(hidden).toMatchObject({ visible: false, distance: null });
    expect(renderPlayerObservation(hidden)).toContain('方向有遮挡');
    expect(renderPlayerObservation(hidden)).not.toContain('5 格');
    block(false);
    expect(sample(1000).map(playerObservationMeta)).toMatchObject([{ kind: 'visible', distance: 5 }]);
  });

  it('small back-and-forth movement is observed even when net displacement is zero', () => {
    const { alex, sample } = rig();
    sample(0);
    for (let i = 1; i <= 11; i++) {
      alex.position.x = i % 2 ? 6 : 5;
      expect(sample(i * 1000)).toEqual([]);
    }
    alex.position.x = 5;
    expect(sample(12_000).map(playerObservationMeta)).toMatchObject([{ kind: 'moved', distance: 5 }]);
    expect(sample(24_000)).toEqual([]);
  });

  it('continuous facing has one stable edge; brief turns do not cause repeated wakeups', () => {
    const { alex, sample } = rig();
    alex.headYaw = Math.PI / 2; // Looks west toward the bot at the same height.
    expect(sample(0).map((fact) => fact.kind)).toEqual(['appearance']);
    expect(sample(999)).toEqual([]);
    expect(sample(1000).map(playerObservationMeta)).toMatchObject([{ kind: 'looking', angularErrorDegrees: 0 }]);
    expect(sample(20_000)).toEqual([]);
    alex.headYaw = 0;
    expect(sample(21_000)).toEqual([]);
    alex.headYaw = Math.PI / 2;
    expect(sample(22_000)).toEqual([]);
    expect(sample(23_000).map((fact) => fact.kind)).toEqual(['facing']);
  });

  it('uses head rotation and Mineflayer pitch convention without inferring intention', () => {
    const { bot, alex } = rig();
    alex.yaw = Math.PI / 2;
    alex.headYaw = 0;
    expect(playerFacingAngle(bot.entity as unknown as Bot['entity'], alex as unknown as Bot['entity'])).toBeCloseTo(90);
    alex.headYaw = Math.PI / 2;
    bot.entity.position.y += 5;
    alex.pitch = Math.PI / 4;
    expect(playerFacingAngle(bot.entity as unknown as Bot['entity'], alex as unknown as Bot['entity'])).toBeCloseTo(0);
    alex.pitch = -Math.PI / 4;
    expect(playerFacingAngle(bot.entity as unknown as Bot['entity'], alex as unknown as Bot['entity'])).toBeCloseTo(90);
  });

  it('two animation packets become one fact; armed swing remains distinct from wave', () => {
    const { alex, gesture } = rig();
    expect(gesture('wave', 0)).toBeNull();
    const empty = gesture('wave', 400)!;
    expect(playerObservationMeta(empty)).toMatchObject({ kind: 'wave', motion: 'arm_swing' });
    expect(gesture('wave', 800)).toBeNull();
    expect(gesture('wave', 1000)).toBeNull();
    alex.equipment[0] = { name: 'iron_sword' };
    expect(gesture('wave', 15_500)).toBeNull();
    const armed = gesture('wave', 15_900)!;
    expect(playerObservationMeta(armed)).toMatchObject({ kind: 'arm_swing', handItemName: 'iron_sword' });
    expect(renderPlayerObservation(armed)).toContain('手持 iron_sword');
    expect(renderPlayerObservation(armed)).not.toMatch(/打招呼|求助|挥手/);
  });

  it('gestures require line of sight and a nearby player', () => {
    const { alex, gesture, block } = rig();
    block(true);
    expect(gesture('crouch', 0)).toBeNull();
    expect(gesture('crouch', 400)).toBeNull();
    block(false);
    alex.position.x = 7;
    expect(gesture('crouch', 800)).toBeNull();
    alex.position.x = 3;
    expect(gesture('crouch', 1200)).toBeNull();
    expect(playerObservationMeta(gesture('crouch', 1600)!)).toMatchObject({ kind: 'crouch' });
  });

  it('clearing a disappeared player resets gesture and proximity dedupe for re-entry', () => {
    const { observations, sample, gesture } = rig();
    sample(0);
    gesture('wave', 100);
    expect(gesture('wave', 400)).not.toBeNull();
    observations.forget(2);
    expect(sample(600).map((fact) => fact.kind)).toEqual(['appearance']);
    expect(gesture('wave', 700)).toBeNull();
    expect(gesture('wave', 900)).not.toBeNull();
    observations.forgetPlayer('Alex');
    expect(sample(1000).map((fact) => fact.kind)).toEqual(['appearance']);
    observations.clear();
    expect(sample(1100).map((fact) => fact.kind)).toEqual(['appearance']);
  });

  it('a leave between sample ticks clears gestures received before proximity sampling', () => {
    const { observations, gesture } = rig();
    expect(gesture('wave', 0)).toBeNull();
    expect(gesture('wave', 400)).not.toBeNull();
    observations.forgetPlayer('Alex');
    expect(gesture('wave', 500)).toBeNull();
    expect(gesture('wave', 900)).not.toBeNull();
  });

  it('new connections and entity ID reuse cannot inherit a different player state', () => {
    const { bot, sample, observations } = rig();
    sample(0);
    bot.entities[2] = player(2, 'Sam', 5);
    expect(sample(1000).map(playerObservationMeta)).toMatchObject([{ playerName: 'Sam', kind: 'entered' }]);
    expect(observations.sample({ ...bot } as unknown as Bot, () => false, 2000)
      .map((fact) => fact.kind)).toEqual(['appearance']);
  });
});

describe('MinecraftWorld player observation delivery', () => {
  it('spawn delivers each player fact with their own identity, independently of snapshots', () => {
    const { bot } = rig();
    bot.entities[3] = player(3, 'Sam', 3);
    const host = new FakeHost();
    const world = new MinecraftWorld({ cfg: structuredClone(MINECRAFT_DEFAULTS) });
    Object.assign(world, { host });
    (world as any).hookBotEvents(bot);
    bot.emit('entitySpawn', bot.entities[2]);
    expect(host.events.map((event) => event.senderKey)).toEqual(['Alex', 'Sam']);
    expect(host.events.map((event) => event.meta?.minecraftPlayerObservation)).toMatchObject([
      { schemaVersion: 1, kind: 'entered', playerName: 'Alex', entityId: 2, distance: 5 },
      { schemaVersion: 1, kind: 'entered', playerName: 'Sam', entityId: 3, distance: 3 },
    ]);
    expect(host.pushOpts.every((opts) => opts?.trigger === 'flush' && opts.deliver !== false)).toBe(true);
    (world as any).proximityTick(bot);
    expect(host.events).toHaveLength(2);
    bot.emit('entityGone', bot.entities[2]);
    bot.emit('entitySpawn', bot.entities[2]);
    expect(host.events.at(-1)?.senderKey).toBe('Alex');
    expect(host.events).toHaveLength(3);
  });

  it('gesture hooks deliver facts and ignore events from a replaced connection', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const { bot, alex } = rig();
      alex.position.x = 3;
      const host = new FakeHost();
      const world = new MinecraftWorld({ cfg: structuredClone(MINECRAFT_DEFAULTS) });
      Object.assign(world, { host });
      (world as any).hookBotEvents(bot);
      bot.emit('entitySwingArm', alex);
      clock.mockReturnValue(1400);
      bot.emit('entitySwingArm', alex);
      expect(host.events[0].meta?.minecraftPlayerObservation).toMatchObject({ kind: 'wave', visible: true });
      Object.assign(world, { bridge: { bot: {} } });
      bot.emit('entityCrouch', alex);
      clock.mockReturnValue(1800);
      bot.emit('entityCrouch', alex);
      expect(host.events).toHaveLength(1);
    } finally { clock.mockRestore(); }
  });
});
