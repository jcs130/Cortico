import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SPATIAL_RAYS, DEFAULT_VOXEL_BOUNDS, observeSpatial, parseSpatialObservation,
  SPATIAL_OBSERVATION_LIMITS, spatialObservationText, type SpatialObserveInput, type SpatialRay,
} from '../../../src/worlds/minecraft/spatial-observation.ts';
import { parseScoutSteps, parseSteps, readSkillHelp, SCOUT_STEP_SCHEMA } from '../../../src/worlds/minecraft/skills.ts';
import { Executor, type TaskReport } from '../../../src/worlds/minecraft/executor.ts';
import { log, nextTaskId, waitUntil } from './executor-harness.ts';

const req = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = req('prismarine-registry')('1.20.6');
const Blocks = req('prismarine-block')(registry);

function native(name: string, properties: Record<string, unknown> = {}) {
  const def = registry.blocksByName[name];
  for (let state = def.minStateId; state <= def.maxStateId; state++) {
    const block = Blocks.fromStateId(state, 0);
    if (Object.entries(properties).every(([key, value]) => block.getProperties()[key] === value)) return block;
  }
  throw new Error(`No native state for ${name} ${JSON.stringify(properties)}`);
}

function rig() {
  const cells = new Map<string, ReturnType<typeof native> | null>();
  const client = Object.assign(new EventEmitter(), { write: vi.fn() });
  const bot = Object.assign(new EventEmitter(), {
    _client: client, registry, version: '1.20.6', game: { dimension: 'overworld' },
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, eyeHeight: 1.62, width: 0.6, height: 1.8 },
    entities: {} as Record<number, any>, health: 20, food: 20,
    inventory: { items: () => [], slots: Array(46).fill(null) }, heldItem: null,
    blockAt(at: Vec3) {
      const pos = at.floored(), key = `${pos.x},${pos.y},${pos.z}`;
      const block = cells.has(key) ? cells.get(key)! : native(pos.y < 64 ? 'stone' : 'air');
      if (block) block.position = pos;
      return block;
    },
    clearControlStates() {}, pathfinder: { stop() {}, setGoal() {} },
  });
  bot.entities[1] = bot.entity;
  return { bot: bot as unknown as Bot, model: bot, client, cells,
    set(at: [number, number, number], name: string | null, props: Record<string, unknown> = {}) {
      cells.set(at.join(','), name === null ? null : native(name, props));
    },
    entity(id: number, z: number, width = 0.6) {
      bot.entities[id] = { id, username: `player${id}`, type: 'player', position: new Vec3(0.5, 64, z), width, height: 1.8 };
    },
  };
}

function voxels(bot: Bot, bounds = DEFAULT_VOXEL_BOUNDS) {
  const result = observeSpatial(bot, { mode: 'voxels', bounds });
  if (result.kind !== 'voxels') throw new Error('Expected voxels');
  return result;
}

function rays(bot: Bot, spec: SpatialRay[] = [[0, 0, 12]]) {
  const result = observeSpatial(bot, { mode: 'rays', rays: spec });
  if (result.kind !== 'rays') throw new Error('Expected rays');
  return result;
}

afterEach(() => vi.useRealTimers());

describe('native spatial observation admission', () => {
  it('exposes bounded observations through both real action and scout parsers', () => {
    const request = [{ skill: 'observe', mode: 'voxels' }, { skill: 'observe', mode: 'rays' }];
    const expected = { steps: [{ skill: 'observe', mode: 'voxels', bounds: DEFAULT_VOXEL_BOUNDS },
      { skill: 'observe', mode: 'rays', rays: DEFAULT_SPATIAL_RAYS }] };
    expect(parseSteps(request)).toMatchObject(expected);
    expect(parseScoutSteps(request)).toMatchObject(expected);
    expect((SCOUT_STEP_SCHEMA.properties as any).skill.enum).toContain('observe');
    expect(readSkillHelp({ skill: 'observe' })).toMatchObject({ text: expect.stringContaining('相对pitch角') });
  });

  it('rejects reversed, oversized, fractional and mixed requests before reading the world', () => {
    for (const part of [{ bounds: [1, 0, 0, 0, 0, 0] }, { bounds: [-16, -16, -16, 16, 16, 16] },
      { bounds: [-17, 0, 0, 0, 0, 0] }, { bounds: [0, 0, 0, 0.5, 1, 1] }, { bounds: [0, 0, 0] },
      { bounds: ['0', 0, 0, 1, 1, 1] }, { rays: [[0, 0, 1]] }]) {
      expect(parseSpatialObservation({ mode: 'voxels', ...part })).toHaveProperty('error');
    }
    for (const part of [{ rays: [] }, { rays: [[0, 0, 0]] }, { rays: [[0, 0, 65]] }, { rays: [[91, 0, 1]] },
      { rays: [[0, 181, 1]] }, { rays: [[NaN, 0, 1]] }, { rays: [['0', 0, 1]] },
      { rays: Array(SPATIAL_OBSERVATION_LIMITS.rays + 1).fill([0, 0, 1]) }, { bounds: DEFAULT_VOXEL_BOUNDS }]) {
      expect(parseSpatialObservation({ mode: 'rays', ...part })).toHaveProperty('error');
    }
    expect(parseSpatialObservation({ mode: 'depth' })).toHaveProperty('error');
  });
});

describe('native local voxels', () => {
  it('preserves the spatial arrangement even when material totals are identical', () => {
    const r = rig();
    r.set([0, 64, 0], 'stone'); r.set([1, 65, 0], 'stone');
    const a = voxels(r.bot, [0, 0, 0, 1, 1, 0]);
    r.set([0, 64, 0], 'air'); r.set([1, 65, 0], 'air');
    r.set([1, 64, 0], 'stone'); r.set([0, 65, 0], 'stone');
    const b = voxels(r.bot, [0, 0, 0, 1, 1, 0]);
    const names = (v: typeof a) => v.cells.map(id => v.palette[id].name);
    expect(a.bounds).toEqual([0, 64, 0, 1, 65, 0]);
    expect(names(a)).toEqual(['stone', 'air', 'air', 'stone']);
    expect(names(b)).toEqual(['air', 'stone', 'stone', 'air']);
    expect(a.order).toBe('y,z,x; x fastest');
  });

  it('distinguishes known air, liquid, unknown cells and unread collision shapes', () => {
    const r = rig();
    r.set([1, 64, 0], 'water'); r.set([2, 64, 0], null);
    const unread = native('stone'); unread.shapes = undefined;
    r.cells.set('3,64,0', unread);
    const a = voxels(r.bot, [0, 0, 0, 3, 0, 0]);
    expect(a.palette[a.cells[0]]).toMatchObject({ air: true, collision: [] });
    expect(a.palette[a.cells[1]]).toMatchObject({ liquid: true, collision: [], properties: { level: '0' } });
    expect(a.cells[2]).toBe(-1);
    expect(a.unknownCells).toBe(1);
    expect(a.palette[a.cells[3]]).toMatchObject({ name: 'stone', collision: null });
  });

  it('retains actual slab and open-door properties and collision geometry', () => {
    const r = rig();
    r.set([0, 64, 0], 'stone_slab', { type: 'bottom' });
    r.set([1, 64, 0], 'oak_door', { open: true, half: 'lower' });
    const a = voxels(r.bot, [0, 0, 0, 1, 0, 0]);
    expect(a.palette[a.cells[0]]).toMatchObject({ properties: { type: 'bottom' }, collision: [[0, 0, 0, 1, 0.5, 1]] });
    expect(a.palette[a.cells[1]].collision).toEqual(native('oak_door', { open: true, half: 'lower' }).shapes);
    expect(a.palette[a.cells[1]].properties).toMatchObject({ open: true });
  });

  it('reads changes and a new dimension without reusing an old map', () => {
    vi.useFakeTimers();
    const r = rig(), a = voxels(r.bot, [0, 0, 0, 0, 0, 0]);
    vi.advanceTimersByTime(1000);
    r.set([0, 64, 0], 'stone'); r.model.game.dimension = 'the_nether';
    const b = voxels(r.bot, [0, 0, 0, 0, 0, 0]);
    expect(a.palette[0].name).toBe('air'); expect(b.palette[0].name).toBe('stone');
    expect(b.dimension).toBe('the_nether'); expect(a.observedAt).not.toBe(b.observedAt);
  });

  it('reports entities overlapping the region, keeps missing bounds unknown and excludes self', () => {
    const r = rig(); r.entity(2, 0.5); r.entity(3, -10); r.entity(4, 0.5, NaN);
    const a = voxels(r.bot);
    expect(a.entities.map(e => e.id)).toEqual([2, 4]);
    expect(a.entities[0].bounds).toEqual([0.2, 64, 0.2, 0.8, 65.8, 0.8]);
    expect(a.entities[1].bounds).toBeNull();
  });

  it('refuses overlong output without returning a cropped map', () => {
    const r = rig(), block = native('stone');
    block.getProperties = () => ({ payload: 'x'.repeat(SPATIAL_OBSERVATION_LIMITS.text) });
    r.cells.set('0,64,0', block);
    expect(() => spatialObservationText(r.bot, { mode: 'voxels', bounds: [0, 0, 0, 0, 0, 0] })).toThrow('未返回截断数据');
  });
});

describe('native collision rays', () => {
  it('measures the wall from the eye and passes above a bottom slab', () => {
    const r = rig(); r.set([0, 65, -3], 'stone_slab', { type: 'bottom' });
    expect(rays(r.bot).rays[0].terrain.kind).toBe('clear');
    r.set([0, 65, -3], 'stone');
    expect(rays(r.bot).rays[0].terrain).toMatchObject({ kind: 'block', distance: 2.5, cell: [0, 65, -3], point: [0.5, 65.62, -2] });
    expect(rays(r.bot).frame).toMatchObject({ eye: [0.5, 65.62, 0.5], eyeHeightSource: 'client' });
  });

  it('hits a fence extending above its owner voxel instead of returning clear', () => {
    const r = rig(); r.model.entity.eyeHeight = 1.4; r.set([0, 64, -3], 'oak_fence');
    expect(rays(r.bot).rays[0].terrain).toMatchObject({ kind: 'block', cell: [0, 64, -3] });
  });

  it('uses the current look frame, degree offsets and crouched eye height', () => {
    const r = rig(); r.model.entity.eyeHeight = 1.27;
    r.model.entity.yaw = Math.PI / 2; r.model.entity.pitch = Math.PI / 6;
    const a = rays(r.bot, [[15, 0, 2]]);
    expect(a.frame.eye[1]).toBe(65.27);
    expect(a.rays[0].direction[0]).toBeCloseTo(-Math.SQRT1_2, 5);
    expect(a.rays[0].direction[1]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(a.rays[0].direction[2]).toBeCloseTo(0, 5);
  });

  it('stops verification at an unloaded cell or unread neighboring shape', () => {
    const r = rig(); r.set([0, 65, -3], null);
    const a = rays(r.bot).rays[0].terrain;
    expect(a).toMatchObject({ kind: 'unknown', reason: 'unloaded', cell: [0, 65, -3] });
    expect(a.distance).toBeLessThan(2.5);
    const unread = native('stone'); unread.shapes = undefined; r.cells.set('0,65,-3', unread);
    expect(rays(r.bot).rays[0].terrain).toMatchObject({ kind: 'unknown', reason: 'collision-unread' });
  });

  it('compares entity bounds with terrain and does not report an entity behind a wall as first', () => {
    const r = rig(); r.set([0, 65, -3], 'stone'); r.entity(2, -1.5);
    let a = rays(r.bot).rays[0];
    expect(a.first).toBe('entity');
    expect(a.entity).toMatchObject({ entity: { id: 2 }, distance: 1.7 });
    expect(a.entityBeforeTerrain).toBe(true);
    r.entity(2, -5);
    a = rays(r.bot).rays[0];
    expect(a.entity).toMatchObject({ entity: { id: 2 } });
    expect(a.first).toBe('block'); expect(a.entityBeforeTerrain).toBe(false);
    r.set([0, 65, -3], null);
    a = rays(r.bot).rays[0];
    expect(a.first).toBe('unknown'); expect(a.entityBeforeTerrain).toBeNull();
  });

  it('handles negative coordinates, tied corner crossings and an origin inside a block', () => {
    const r = rig(); r.model.entity.position.x = -0.5; r.model.entity.yaw = Math.PI / 2;
    r.set([-3, 65, 0], 'stone');
    expect(rays(r.bot).rays[0].terrain).toMatchObject({ kind: 'block', distance: 1.5 });
    r.model.entity.position.x = 0.5; r.model.entity.yaw = Math.PI / 4; r.set([-2, 65, -2], 'stone');
    expect(rays(r.bot).rays[0].terrain.distance).toBeCloseTo(1.5 * Math.SQRT2, 5);
    r.set([0, 65, 0], 'stone');
    expect(rays(r.bot).rays[0].terrain).toMatchObject({ kind: 'block', distance: 0 });
  });

  it('includes an entity touching the range endpoint and reports missing entity bounds', () => {
    const r = rig(); r.entity(2, -2.8, 0.6); r.entity(3, -1, NaN);
    const a = rays(r.bot, [[0, 0, 3]]);
    expect(a.rays[0].entity?.distance).toBe(3);
    expect(a.rays[0].first).toBe('entity');
    expect(a.unreadEntityIds).toEqual([3]);
  });

  it('keeps liquids in the voxel data but does not invent liquid collision depth', () => {
    const r = rig(); r.set([0, 65, -1], 'water');
    expect(rays(r.bot, [[0, 0, 3]]).rays[0].terrain).toEqual({ kind: 'clear', distance: 3 });
    expect(voxels(r.bot, [0, 1, -1, 0, 1, -1]).palette[0].liquid).toBe(true);
  });

  it('bounds world reads and marks the untraced part unknown when the budget is exhausted', () => {
    const r = rig();
    const spec: SpatialRay[] = [-70, -50, -30, -10, 10, 30, 50, 70].flatMap(pitch =>
      [-160, -120, -80, -40, 0, 40, 80, 120].map(yaw => [pitch, yaw, 64] as SpatialRay));
    const a = rays(r.bot, spec);
    expect(a.blockReads).toBeLessThanOrEqual(SPATIAL_OBSERVATION_LIMITS.reads);
    expect(a.rays.some(ray => ray.terrain.kind === 'unknown' && ray.terrain.reason === 'read-budget')).toBe(true);
  });

  it('refuses incomplete entity scans rather than silently omitting nearby entities', () => {
    const r = rig();
    for (let i = 2; i <= SPATIAL_OBSERVATION_LIMITS.entities + 2; i++) r.entity(i, -1);
    expect(() => rays(r.bot)).toThrow('未返回不完整射线观测');
  });

  it('delivers the complete observation through a real executor task without moving or writing packets', async () => {
    vi.useFakeTimers();
    const r = rig(), start = r.bot.entity.position.clone(), reports: TaskReport[] = [];
    const exec = new Executor({ getBot: () => r.bot, report: report => reports.push(report), log, nextId: nextTaskId() });
    const input: SpatialObserveInput = { mode: 'voxels', bounds: [0, -1, 0, 0, 1, 0] };
    r.set([0, 64, 0], 'oak_door', { open: true, half: 'lower' });
    exec.submit([{ skill: 'observe', ...input }]);
    await waitUntil(() => reports.some(report => report.kind === 'done'));
    const receipt = reports.find(report => report.kind === 'done')!.text;
    expect(receipt).toContain('client-loaded-world'); expect(receipt).toContain('"open":true');
    expect(receipt).toContain('"bounds":[0,63,0,0,65,0]'); expect(receipt).toContain('"cells":');
    expect(r.bot.entity.position).toEqual(start); expect(r.client.write).not.toHaveBeenCalled();
    exec.shutdown();
  });
});
