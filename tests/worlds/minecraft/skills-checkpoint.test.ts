import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { skillBuild, skillBuildBlueprint } from '../../../src/worlds/minecraft/skills-build.ts';
import { skillExcavate } from '../../../src/worlds/minecraft/skills-dig.ts';
import { skillCollect } from '../../../src/worlds/minecraft/skills-gather.ts';
import { acceptBlueprint } from '../../../src/worlds/minecraft/blueprint-plan.ts';
import { Aborted, Yielded, type BlueprintSite, type SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';
import type { SkillCall } from '../../../src/worlds/minecraft/skills.ts';
import { log } from './executor-harness.ts';

const dependency = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = dependency('prismarine-registry')('1.20.6');
const World = dependency('prismarine-world')(registry);
const Chunk = dependency('prismarine-chunk')(registry);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Actual versioned blocks, collision and inventory readback surround the scripted packet writes. */
function rig() {
  const world = new World(null).sync;
  for (const x of [-1, 0]) for (const z of [-1, 0]) {
    world.setColumn(x, z, new Chunk({ minY: -64, worldHeight: 384 }));
  }
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
    world.setBlockStateId(new Vec3(x, 63, z), registry.blocksByName.stone.defaultState);
  }
  const stock = new Map<string, number>([['cobblestone', 8], ['iron_pickaxe', 1]]);
  const cells: Vec3[] = [];
  const dug: string[] = [];
  const placed: string[] = [];
  const trace: string[] = [];
  let beforeDig: (() => Promise<void>) | undefined;
  let beforePlace: (() => Promise<void>) | undefined;
  let pickupDelay = 0;
  let abortAfterEquip = false;
  let aborted = false;
  const items = () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({
    name, count, type: registry.itemsByName[name].id,
  }));
  const bot = Object.assign(new EventEmitter(), {
    registry, version: '1.20.6', world,
    _client: Object.assign(new EventEmitter(), { write() {} }),
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), onGround: true, eyeHeight: 1.62 },
    entities: {} as Record<string, { name: string; position: Vec3 }>,
    game: { dimension: 'overworld' }, health: 20, food: 20,
    heldItem: null as ReturnType<typeof items>[number] | null,
    inventory: { items, slots: [] },
    blockAt: (at: Vec3) => world.getBlock(at),
    canSeeBlock: () => true, canDigBlock: () => true, digTime: () => 20,
    findBlocks: ({ matching }: { matching: number[] }) => cells.filter(at => matching.includes(world.getBlock(at).type)),
    equip: async (item: ReturnType<typeof items>[number]) => {
      bot.heldItem = item;
      if (abortAfterEquip) aborted = true;
    },
    unequip: async () => { bot.heldItem = null; },
    lookAt: async () => {}, setControlState() {}, stopDigging() {},
    pathfinder: {
      movements: {}, setGoal() {}, stop() {},
      goto: async (goal: { x: number; y: number; z: number }) => {
        bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
        for (const id of Object.keys(bot.entities)) delete bot.entities[id];
        trace.push('pickup-walk-done');
      },
    },
    placeBlock: async (ref: Block, face: Vec3) => {
      trace.push('place-start');
      await beforePlace?.();
      const at = ref.position.plus(face);
      const held = bot.heldItem!;
      const previous = world.getBlock(at);
      world.setBlockStateId(at, registry.blocksByName[held.name].defaultState);
      stock.set(held.name, stock.get(held.name)! - 1);
      placed.push(at.toString());
      bot.emit('blockUpdate', previous, world.getBlock(at));
      trace.push('place-confirmed');
    },
    dig: async (value: Block) => {
      trace.push('dig-start');
      await beforeDig?.();
      world.setBlockStateId(value.position, registry.blocksByName.air.defaultState);
      dug.push(value.position.toString());
      bot.emit('blockUpdate', value, world.getBlock(value.position));
      trace.push('dig-confirmed');
      const pickup = () => {
        const name = value.name === 'stone' ? 'cobblestone' : value.name;
        stock.set(name, (stock.get(name) ?? 0) + 1);
        trace.push('pickup-confirmed');
      };
      if (pickupDelay > 0) setTimeout(pickup, pickupDelay);
      else pickup();
    },
  });
  const seed = (name: string, at: [number, number, number]) => {
    const pos = new Vec3(...at);
    world.setBlockStateId(pos, registry.blocksByName[name].defaultState);
    cells.push(pos);
  };
  const ctx = {
    aborted: () => aborted, log, noLight: true, taskId: 1,
    intended: new Set<string>(), fleeHealth: () => 0, escape: { active: false },
  } as SkillContext;
  return {
    bot: bot as unknown as Bot, ctx, seed, stock, dug, placed, trace,
    gateDig: (gate: () => Promise<void>) => { beforeDig = gate; },
    gatePlace: (gate: () => Promise<void>) => { beforePlace = gate; },
    delayPickup: (ms: number) => { pickupDelay = ms; },
    abortOnEquip: () => { abortAfterEquip = true; },
  };
}

async function drain<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const result = await settled;
  if ('error' in result) throw result.error;
  return result.value;
}

describe('mechanical skill yield checkpoints', () => {
  it('finishes placement confirmation and its material permit before yielding; replay uses the completed cell', async () => {
    const r = rig();
    const yieldSignal = new Yielded();
    let release!: () => void;
    r.gatePlace(() => new Promise<void>(resolve => { release = resolve; }));
    let permitted = 0;
    r.ctx.permitResourcePlacement = () => ({ ok: true, finish: success => {
      expect(success).toBe(true);
      permitted++;
      r.trace.push('permit-finished');
    } });
    r.ctx.checkpoint = async settle => {
      await settle?.();
      expect(r.placed).toHaveLength(1);
      expect(permitted).toBe(1);
      r.trace.push('checkpoint');
      throw yieldSignal;
    };
    const call = { skill: 'build', material: 'cobblestone', anchors: [[2, 64, 0], [3, 64, 0]] } as Parameters<typeof skillBuild>[1];
    const outcome = skillBuild(r.bot, call, r.ctx).catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(r.trace).toEqual(['place-start']);
    release();
    expect(await drain(outcome)).toBe(yieldSignal);
    expect(r.trace.slice(-3)).toEqual(['place-confirmed', 'permit-finished', 'checkpoint']);
    r.gatePlace(async () => {});
    r.ctx.checkpoint = undefined;
    await drain(skillBuild(r.bot, call, r.ctx));
    expect(r.placed).toHaveLength(2);
    expect(new Set(r.placed).size).toBe(2);
    expect(permitted).toBe(2);
    expect(r.stock.get('cobblestone')).toBe(6);
  });

  it('collect yields only after the confirmed drop enters inventory, and the remaining count does not overcollect', async () => {
    const r = rig();
    for (let x = 2; x <= 4; x++) r.seed('oak_log', [x, 64, 0]);
    r.delayPickup(200);
    let done = 0;
    const yieldSignal = new Yielded();
    r.ctx.progress = (count, total) => {
      done = count;
      expect(total).toBe(2);
      expect(r.trace.at(-1)).toBe('dig-confirmed');
    };
    r.ctx.checkpoint = async settle => {
      expect(done).toBe(1);
      expect(r.stock.get('oak_log')).toBe(1);
      expect(r.trace.at(-1)).toBe('pickup-confirmed');
      await settle?.();
      throw yieldSignal;
    };
    expect(await drain(skillCollect(r.bot, 'oak_log', 2, r.ctx).catch(error => error))).toBe(yieldSignal);
    r.ctx.checkpoint = undefined;
    r.ctx.progress = undefined;
    await drain(skillCollect(r.bot, 'oak_log', 2 - done, r.ctx));
    expect(r.dug).toHaveLength(2);
    expect(r.stock.get('oak_log')).toBe(2);
    expect(r.bot.blockAt(new Vec3(4, 64, 0))?.name).toBe('oak_log');
  });

  it('excavate waits for native dig to finish, settles local drops on requested yield, and replays only the remaining block', async () => {
    const r = rig();
    r.seed('stone', [2, 64, 0]);
    r.seed('stone', [3, 64, 0]);
    let release!: () => void;
    r.gateDig(() => new Promise<void>(resolve => { release = resolve; }));
    const yieldSignal = new Yielded();
    let checkpoints = 0;
    r.ctx.checkpoint = async settle => {
      checkpoints++;
      expect(r.dug).toHaveLength(1);
      r.bot.entities[9] = { name: 'item', position: new Vec3(4, 64, 0) } as never;
      await settle?.();
      expect(Object.keys(r.bot.entities)).toHaveLength(0);
      throw yieldSignal;
    };
    const call: Extract<SkillCall, { skill: 'excavate' }> = {
      skill: 'excavate', shape: 'line', anchors: [[2, 64, 0], [3, 64, 0]], fill: 'solid',
    };
    const outcome = skillExcavate(r.bot, call, r.ctx).catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(checkpoints).toBe(0);
    expect(r.dug).toHaveLength(0);
    release();
    expect(await drain(outcome)).toBe(yieldSignal);
    expect(r.trace).toContain('pickup-walk-done');
    r.ctx.checkpoint = undefined;
    r.gateDig(async () => {});
    await drain(skillExcavate(r.bot, call, r.ctx));
    expect(r.dug).toHaveLength(2);
    expect(new Set(r.dug).size).toBe(2);
  });

  it.each([3, 4])('clear with progress disabled propagates Yielded unchanged for conflict ending at x=%s', async lastX => {
    const r = rig();
    r.seed('stone', [2, 64, 0]);
    r.seed('stone', [lastX, 64, 0]);
    const accepted = acceptBlueprint({
      key: 'clear-site', site_mode: 'new', size_xyz: [lastX - 1, 1, 1], axis_order: 'YZX',
      palette: ['minecraft:air'], layers: [[Array(lastX - 1).fill(0)]],
    });
    expect(accepted.ok).toBe(true);
    const site = {
      key: 'clear-site', name: null, anchor: [2, 64, 0], cursor: 0, survey: null, startedAt: null,
      blueprint: accepted.blueprint!, plan: accepted.plan!,
    } as BlueprintSite;
    r.ctx.blueprints = (() => ({ get: () => site, bind() {}, progress() {}, keys: () => ['clear-site'], stored: () => ({}) })) as never;
    r.ctx.progress = () => { throw new Error('clear must not publish child count'); };
    const yieldSignal = new Yielded();
    r.ctx.checkpoint = async settle => { await settle?.(); throw yieldSignal; };
    const outcome = await drain(skillBuildBlueprint(r.bot,
      { skill: 'build', blueprint: 'clear-site', at: [2, 64, 0], confirm: true }, r.ctx).catch(error => error));
    expect(outcome).toBe(yieldSignal);
    expect(r.dug).toHaveLength(1);
    expect(r.placed).toHaveLength(0);
  });

  it('a completed blueprint step yields before the next step and keeps confirmed cells on replay', async () => {
    const r = rig();
    r.stock.set('oak_planks', 2);
    const accepted = acceptBlueprint({
      key: 'mixed-floor', site_mode: 'new', size_xyz: [2, 1, 1], axis_order: 'YZX',
      palette: ['minecraft:cobblestone', 'minecraft:oak_planks'], layers: [[[0, 1]]],
    });
    expect(accepted.ok).toBe(true);
    const site = {
      key: 'mixed-floor', name: null, anchor: [2, 64, 0], cursor: 0, survey: null, startedAt: null,
      blueprint: accepted.blueprint!, plan: accepted.plan!,
    } as BlueprintSite;
    r.ctx.blueprints = (() => ({ get: () => site, bind() {}, progress() {}, keys: () => ['mixed-floor'], stored: () => ({}) })) as never;
    const yieldSignal = new Yielded();
    r.ctx.checkpoint = async settle => { await settle?.(); throw yieldSignal; };
    const call = { skill: 'build', blueprint: 'mixed-floor', at: [2, 64, 0], confirm: true } as const;
    expect(await drain(skillBuildBlueprint(r.bot, call as Parameters<typeof skillBuildBlueprint>[1], r.ctx)
      .catch(error => error))).toBe(yieldSignal);
    expect(r.placed).toHaveLength(1);
    r.ctx.checkpoint = undefined;
    await drain(skillBuildBlueprint(r.bot, call as Parameters<typeof skillBuildBlueprint>[1], r.ctx));
    expect(r.placed).toHaveLength(2);
    expect(new Set(r.placed).size).toBe(2);
    expect(r.stock.get('cobblestone')).toBe(7);
    expect(r.stock.get('oak_planks')).toBe(1);
  });

  it('single-unit completion returns its real receipt without offering a middle checkpoint', async () => {
    const r = rig();
    r.ctx.checkpoint = async () => { throw new Error('final unit must finish'); };
    await drain(skillBuild(r.bot, { skill: 'build', material: 'cobblestone', anchors: [[2, 64, 0]] }, r.ctx));
    r.seed('oak_log', [3, 64, 0]);
    expect(await drain(skillCollect(r.bot, 'oak_log', 1, r.ctx))).toContain('实际入包 1');
    r.seed('stone', [4, 64, 0]);
    expect(await drain(skillExcavate(r.bot,
      { skill: 'excavate', shape: 'line', anchors: [[4, 64, 0], [4, 64, 0]], fill: 'solid' }, r.ctx))).toContain('挖开了');
  });

  it.each(['collect', 'excavate'] as const)('late cancellation during tool equip prevents the next %s dig', async skill => {
    const r = rig();
    r.seed('stone', [2, 64, 0]);
    r.abortOnEquip();
    const outcome = skill === 'collect'
      ? skillCollect(r.bot, 'stone', 1, r.ctx)
      : skillExcavate(r.bot, { skill: 'excavate', shape: 'line', anchors: [[2, 64, 0], [2, 64, 0]], fill: 'solid' }, r.ctx);
    expect(await drain(outcome.catch(error => error))).toBeInstanceOf(Aborted);
    expect(r.dug).toHaveLength(0);
  });
});
