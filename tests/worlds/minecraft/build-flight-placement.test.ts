import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { gotoPlaceable } from '../../../src/worlds/minecraft/placement.ts';
import { reclaimSiteScaffold, skillBuildBlueprint } from '../../../src/worlds/minecraft/skills-build.ts';
import { watchFlightAbilities } from '../../../src/worlds/minecraft/flight.ts';
import { armTemporaryScaffoldPlacement, pendingTemporaryScaffolds, prepareTemporaryScaffoldPlacement,
  recordTemporaryScaffold } from '../../../src/worlds/minecraft/temporary-scaffold.ts';
import { placedLedgerOf } from '../../../src/worlds/minecraft/placed-ledger.ts';
import { normalizeBlueprint } from '../../../src/worlds/minecraft/blueprint.ts';
import { compileBlueprint } from '../../../src/worlds/minecraft/blueprint-plan.ts';
import { SkillBlocked, type BlueprintSite, type SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';

const dependency = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = dependency('prismarine-registry')('1.20.6');
const World = dependency('prismarine-world')(registry);
const Chunk = dependency('prismarine-chunk')(registry);
const Blocks = dependency('prismarine-block')(registry) as typeof Block;
const releases: Array<() => void> = [];
afterEach(() => { releases.splice(0).forEach(release => release()); });

function rig(airborne = false) {
  const world = new World(null).sync;
  for (const cx of [-1, 0]) for (const cz of [-1, 0]) {
    world.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }));
  }
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
    world.setBlockStateId(new Vec3(x, 63, z), registry.blocksByName.stone.defaultState);
  }
  const client = Object.assign(new EventEmitter(), { write: vi.fn() });
  const stock: Array<{ name: string; count: number; type: number }> = [];
  const dug: string[] = [];
  let reachable = true;
  const goto = vi.fn(async () => { throw new Error('Unexpected ground pathfinder'); });
  const bot = Object.assign(new EventEmitter(), {
    registry, version: '1.20.6', world, _client: client,
    entity: { position: new Vec3(0.5, airborne ? 68.3 : 64, 0.5), eyeHeight: 1.62,
      width: 0.6, height: 1.8, onGround: !airborne, effects: {} },
    physics: { gravity: 0.08 }, physicsEnabled: true,
    game: { dimension: 'overworld' }, entities: {}, heldItem: null,
    inventory: { items: () => stock, slots: [] },
    blockAt: (at: Vec3) => world.getBlock(at),
    canSeeBlock: () => true, canDigBlock: () => reachable, digTime: () => 50,
    unequip: async () => undefined,
    pathfinder: { goto, setGoal: vi.fn() },
    dig: async (value: Block) => {
      dug.push(value.position.toString());
      world.setBlockStateId(value.position, registry.blocksByName.air.defaultState);
      bot.emit('blockUpdate', value, world.getBlock(value.position));
      stock.push({ name: value.name, count: 1, type: registry.itemsByName[value.name].id });
    },
  }) as unknown as Bot;
  const ctx = { aborted: () => false, intended: new Set<string>() } as unknown as SkillContext;
  releases.push(watchFlightAbilities(bot));
  if (airborne) client.emit('abilities', { flags: 6 });
  const seed = (name: string, at: Vec3, properties: Record<string, string> = {}): Block => {
    const info = registry.blocksByName[name];
    let stateId = info.defaultState;
    if (Object.keys(properties).length) {
      for (let id = info.minStateId; id <= info.maxStateId; id++) {
        if (Object.entries(properties).every(([key, value]) => String(Blocks.fromStateId(id, 0).getProperties()[key]) === value)) {
          stateId = id; break;
        }
      }
    }
    world.setBlockStateId(at, stateId);
    return world.getBlock(at);
  };
  const support = (at: Vec3) => {
    const before = world.getBlock(at);
    const proof = prepareTemporaryScaffoldPlacement(bot, before);
    expect(before.name).toBe('air');
    expect(proof).not.toBeNull();
    armTemporaryScaffoldPlacement(bot, at, 'oak_planks');
    const after = seed('oak_planks', at);
    expect(after.name).toBe('oak_planks');
    expect(after.boundingBox).toBe('block');
    expect(after.stateId).toBeTypeOf('number');
    expect([proof!.x, proof!.y, proof!.z]).toEqual([after.position.x, after.position.y, after.position.z]);
    recordTemporaryScaffold(bot, proof, after);
    return after;
  };
  return { bot, ctx, dug, goto, client, seed, support, unreachable: () => { reachable = false; } };
}

describe('airborne placement from actual eyes', () => {
  it('uses a real reachable reference face while hovering without ground pathfinding', async () => {
    const r = rig(true);
    r.seed('stone', new Vec3(3, 69, 0));
    expect(await gotoPlaceable(r.bot, { cell: { x: 2, y: 69, z: 0 }, face: 'west' }, r.ctx)).toBe(true);
    expect(r.goto.mock.calls).toHaveLength(0);
  });

  it('uses fractional eye position and real half-slab collision rather than a grounded node offset', async () => {
    const r = rig(true);
    r.seed('stone', new Vec3(3, 69, 0));
    r.seed('stone_slab', new Vec3(1, 69, 0), { type: 'bottom' });
    expect(await gotoPlaceable(r.bot, { cell: { x: 2, y: 69, z: 0 }, face: 'west' }, r.ctx)).toBe(true);
    r.seed('stone', new Vec3(1, 69, 0));
    await expect(gotoPlaceable(r.bot, { cell: { x: 2, y: 69, z: 0 }, face: 'west' }, r.ctx)).rejects.toThrow('flight');
    expect(r.goto.mock.calls).toHaveLength(0);
  });

  it('rejects a placement behind an obstacle with an explicit flight or land instruction', async () => {
    const r = rig(true);
    r.seed('stone', new Vec3(3, 69, 0));
    r.seed('stone', new Vec3(1, 69, 0));
    await expect(gotoPlaceable(r.bot, { cell: { x: 2, y: 69, z: 0 }, face: 'west' }, r.ctx)).rejects.toBeInstanceOf(SkillBlocked);
    await expect(gotoPlaceable(r.bot, { cell: { x: 2, y: 69, z: 0 }, face: 'west' }, r.ctx)).rejects.toThrow('land');
    expect(r.goto.mock.calls).toHaveLength(0);
  });

  it('rejects an out-of-reach reference instead of starting a ground route', async () => {
    const r = rig(true);
    r.seed('stone', new Vec3(11, 69, 0));
    await expect(gotoPlaceable(r.bot, { cell: { x: 10, y: 69, z: 0 }, face: 'west' }, r.ctx)).rejects.toThrow('悬停位置放不到');
    expect(r.goto.mock.calls).toHaveLength(0);
  });

  it('rejects a target intersecting the real body even if its reference face is visible', async () => {
    const r = rig(true);
    r.seed('stone', new Vec3(1, 69, 0));
    await expect(gotoPlaceable(r.bot, { cell: { x: 0, y: 69, z: 0 }, face: 'west' }, r.ctx)).rejects.toThrow('悬停位置放不到');
    expect(r.goto.mock.calls).toHaveLength(0);
  });

  it('requires the requested face and a loaded reference', async () => {
    const r = rig(true);
    r.seed('stone', new Vec3(3, 69, 0));
    await expect(gotoPlaceable(r.bot, { cell: { x: 2, y: 69, z: 0 }, face: 'east' }, r.ctx)).rejects.toThrow('flight');
    await expect(gotoPlaceable(r.bot, { cell: { x: 18, y: 69, z: 0 }, face: null }, r.ctx)).rejects.toThrow('flight');
    expect(r.goto.mock.calls).toHaveLength(0);
  });
});

describe('blueprint cleanup through strict temporary proofs', () => {
  it('ignores historical same-name placed ledger entries', async () => {
    const r = rig();
    r.seed('oak_planks', new Vec3(2, 64, 0));
    placedLedgerOf(r.bot).push({ name: 'oak_planks', x: 2, y: 64, z: 0 });
    expect(await reclaimSiteScaffold(r.bot, r.ctx)).toBe('');
    expect(r.dug).toEqual([]);
    expect(r.goto.mock.calls).toHaveLength(0);
  });

  it('reclaims a proven reachable temporary support and promotes an intended building cell', async () => {
    const r = rig();
    r.support(new Vec3(2, 64, 0));
    r.support(new Vec3(4, 64, 0));
    r.ctx.intended!.add('4,64,0');
    const result = await reclaimSiteScaffold(r.bot, r.ctx);
    expect(r.dug).toEqual([new Vec3(2, 64, 0).toString()]);
    expect(result).toContain('拆除 1 块');
    expect(r.bot.blockAt(new Vec3(4, 64, 0))!.name).toBe('oak_planks');
    expect(pendingTemporaryScaffolds(r.bot)).toEqual([]);
    expect(r.goto.mock.calls).toHaveLength(0);
  });

  it('retains a remote support without moving, placing or chasing it', async () => {
    const r = rig();
    r.support(new Vec3(10, 64, 0));
    r.unreachable();
    const result = await reclaimSiteScaffold(r.bot, r.ctx);
    expect(result).toContain('够不到');
    expect(r.dug).toEqual([]);
    expect(pendingTemporaryScaffolds(r.bot)).toHaveLength(1);
    expect(r.goto.mock.calls).toHaveLength(0);
  });

  it('does not remove a current underfoot support or an attached structure', async () => {
    const r = rig();
    r.support(new Vec3(0, 64, 0));
    r.bot.entity.position.y = 65;
    r.support(new Vec3(2, 64, 0));
    r.seed('stone', new Vec3(2, 65, 0));
    const result = await reclaimSiteScaffold(r.bot, r.ctx);
    expect(result).toContain('实体脚下');
    expect(result).toContain('上方仍有承重方块');
    expect(r.dug).toEqual([]);
    expect(r.goto.mock.calls).toHaveLength(0);
  });

  it('registers and promotes every planned non-air blueprint cell even when already built', async () => {
    const r = rig();
    const blueprint = normalizeBlueprint({ site_mode: 'new', size_xyz: [2, 2, 1],
      layers: [[['minecraft:oak_planks', 'minecraft:air']], [['minecraft:oak_planks', 'minecraft:air']]] });
    const site: BlueprintSite = { key: 'hut', name: null, blueprint, plan: compileBlueprint(blueprint),
      anchor: [2, 64, 0], cursor: 0, startedAt: 1 };
    r.support(new Vec3(2, 64, 0));
    r.support(new Vec3(2, 65, 0));
    r.ctx.blueprints = () => ({ get: () => site, keys: () => ['hut'], stored: () => ({}),
      progress: vi.fn(), bind: vi.fn() }) as never;
    await skillBuildBlueprint(r.bot, { skill: 'build', blueprint: 'hut', stopAfter: 0 }, r.ctx);
    expect(r.ctx.intended).toEqual(new Set(['2,64,0', '2,65,0']));
    expect(pendingTemporaryScaffolds(r.bot)).toEqual([]);
    expect(r.dug).toEqual([]);
  });

  it.each(['dryRun', 'survey'] as const)('does not promote planned cells during %s', async (mode) => {
    const r = rig();
    const blueprint = normalizeBlueprint({ site_mode: mode === 'survey' ? 'retrofit' : 'new', size_xyz: [1, 1, 1],
      layers: [[['minecraft:oak_planks']]] });
    const site: BlueprintSite = { key: 'hut', name: null, blueprint, plan: compileBlueprint(blueprint),
      anchor: [2, 64, 0], cursor: 0, startedAt: null };
    r.support(new Vec3(2, 64, 0));
    r.ctx.blueprints = () => ({ get: () => site, keys: () => ['hut'], stored: () => ({}),
      survey: vi.fn(), progress: vi.fn(), bind: vi.fn() }) as never;
    await skillBuildBlueprint(r.bot, { skill: 'build', blueprint: 'hut', ...(mode === 'dryRun' ? { dryRun: true } : {}) }, r.ctx);
    expect(r.ctx.intended).toEqual(new Set());
    expect(pendingTemporaryScaffolds(r.bot)).toHaveLength(1);
    expect(r.dug).toEqual([]);
  });
});
