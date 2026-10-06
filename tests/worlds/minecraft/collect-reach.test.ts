import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { Aborted, SkillBlocked, type SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';
import { armTemporaryScaffoldPlacement, prepareTemporaryScaffoldPlacement, recordTemporaryScaffold,
  temporaryScaffoldScopeCount } from '../../../src/worlds/minecraft/temporary-scaffold.ts';
import { skillCollect } from '../../../src/worlds/minecraft/skills-gather.ts';

vi.mock('../../../src/worlds/minecraft/travel.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/worlds/minecraft/travel.ts')>();
  return { ...actual,
    gotoGoal: async (bot: Bot, goal: unknown) => { await bot.pathfinder.goto(goal as never); },
    digBlock: async (bot: Bot, block: Block) => { await bot.dig(block); },
    dropGoal: () => undefined,
  };
});

const require = createRequire(import.meta.url);
const dependency = createRequire(require.resolve('mineflayer'));
const registry = require('minecraft-data')('1.20.6') as Bot['registry'];
const Blocks = dependency('prismarine-block')('1.20.6') as typeof Block;
type Goal = { x?: number; y?: number; z?: number; pos?: Vec3 };
type Route = { goal: Goal; canDig: boolean; scaffolding: number[] };

function rig(options: {
  targets?: Vec3[];
  pickup?: 'immediate' | 'delayed' | 'ground' | 'none';
  drops?: Array<{ name?: string; at: Vec3; hidden?: boolean; status?: string }>;
  abortPickup?: boolean;
  pathSupport?: Vec3;
  failDig?: boolean;
} = {}) {
  const events = new EventEmitter();
  const blocks = new Map<string, Block>();
  const bag: Array<{ name: string; count: number; type: number }> = [];
  const targets = options.targets ?? [new Vec3(0, 68, 0)];
  const routes: Route[] = [];
  const probes: Route[] = [];
  const dug: Vec3[] = [];
  const scaffold = [registry.itemsByName.dirt.id, registry.itemsByName.cobblestone.id];
  const movements = { canDig: true, scafoldingBlocks: scaffold };
  let aborted = false;
  let pickupPhase = false;
  let scopeWasActive = false;
  const dropVisibility = new Map<string, boolean>();
  const dropStatuses = new Map<string, string>();
  const make = (name: string, position: Vec3): Block => {
    const block = Blocks.fromStateId(registry.blocksByName[name].minStateId, 0);
    block.position = position;
    return block;
  };
  for (const position of targets) blocks.set(position.toString(), make('cherry_log', position));
  const gain = () => { bag.push({ name: 'cherry_log', count: 1, type: registry.itemsByName.cherry_log.id }); };
  const bot = Object.assign(events, {
    registry, game: { dimension: 'overworld', gameMode: 'survival' },
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62, height: 1.62, onGround: true, effects: {} },
    entities: {} as Bot['entities'], heldItem: null,
    inventory: { items: () => bag, slots: [] },
    world: { raycast: (eye: Vec3, direction: Vec3, distance: number) => {
      const point = eye.plus(direction.scaled(distance));
      const key = `${Math.floor(point.x)},${Math.floor(point.y)},${Math.floor(point.z)}`;
      return dropVisibility.get(key) === false ? { name: 'stone', position: point } : null;
    } },
    blockAt: (p: Vec3) => blocks.get(p.toString()) ?? make(p.y === 63 ? 'stone' : 'air', p),
    canSeeBlock: () => true,
    canDigBlock: (block: Block) => block.diggable
      && block.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.65, 0)) <= 5.1,
    digTime: () => 20, unequip: async () => undefined,
    findBlocks: () => targets.filter((p) => blocks.get(p.toString())?.name === 'cherry_log'),
    dig: async (block: Block) => {
      if (block.name === 'cherry_log' && options.failDig) throw new SkillBlocked('服务器拒绝了这次采集', [], 'server');
      scopeWasActive = temporaryScaffoldScopeCount(bot as unknown as Bot) > 0;
      dug.push(block.position.clone()); blocks.set(block.position.toString(), make('air', block.position));
      bot.emit('blockUpdate', block, bot.blockAt(block.position)!);
      if (block.name !== 'cherry_log') {
        bag.push({ name: block.name, count: 1, type: registry.itemsByName[block.name].id });
        return;
      }
      pickupPhase = true;
      if ((options.pickup ?? 'immediate') === 'immediate') gain();
      if (options.pickup === 'delayed') setTimeout(gain, 200);
      const drops = options.drops ?? (options.pickup === 'ground' ? [{ at: new Vec3(3.5, 64.05, 0.5) }] : []);
      drops.forEach((drop, index) => {
        const id = index + 10;
        bot.entities[id] = { id, name: 'item', type: 'object', position: drop.at, height: 0.25,
          getDroppedItem: () => ({ name: drop.name ?? 'cherry_log', count: 1 }) } as never;
        const at = drop.at.floored();
        dropVisibility.set(`${at.x},${at.y},${at.z}`, drop.hidden !== true);
        dropStatuses.set(`${at.x},${at.y},${at.z}`, drop.status ?? (at.y <= 65 ? 'success' : 'noPath'));
      });
    },
    pathfinder: {
      movements,
      getPathTo: (_movements: unknown, goal: Goal) => {
        probes.push({ goal, canDig: movements.canDig, scaffolding: [...movements.scafoldingBlocks] });
        const key = `${goal.x},${goal.y},${goal.z}`;
        return { status: dropStatuses.get(key) ?? 'noPath', path: [] };
      },
      goto: async (goal: Goal) => {
        routes.push({ goal, canDig: movements.canDig, scaffolding: [...movements.scafoldingBlocks] });
        if (pickupPhase) {
          if (options.abortPickup) { aborted = true; throw new Aborted(); }
          gain(); bot.entities = {};
        } else if (goal.pos) {
          bot.entity.position = goal.pos.offset(0.5, -1, 0.5);
          if (options.pathSupport) {
            const before = bot.blockAt(options.pathSupport)!;
            const proof = prepareTemporaryScaffoldPlacement(bot, before);
            armTemporaryScaffoldPlacement(bot, options.pathSupport);
            const placed = make('oak_planks', options.pathSupport);
            blocks.set(options.pathSupport.toString(), placed);
            bot.emit('blockUpdate', before, placed);
            recordTemporaryScaffold(bot, proof, placed);
          }
        }
      },
    },
  }) as unknown as Bot;
  const ctx = { aborted: () => aborted, noLight: true } as unknown as SkillContext;
  return { bot, ctx, targets, routes, probes, dug, movements, scaffold,
    scopeWasActive: () => scopeWasActive,
    openScopeCount: () => temporaryScaffoldScopeCount(bot),
  };
}

async function run(r: ReturnType<typeof rig>, count = 1): Promise<string | Error> {
  const caught = skillCollect(r.bot, 'cherry_log', count, r.ctx)
    .then((value) => value, (error: Error) => error);
  await vi.runAllTimersAsync();
  return caught;
}

describe('collect block reach and real-drop pickup', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('digs a visible overhead log within survival reach without choosing a new standing position', async () => {
    const r = rig(); const result = await run(r);
    expect(typeof result).toBe('string'); expect(r.dug).toEqual(r.targets);
    expect(r.routes).toEqual([]); expect(r.probes).toEqual([]);
  });

  it('observes an item gained during dig before deciding to walk toward its drop', async () => {
    const r = rig({ pickup: 'immediate', drops: [{ at: new Vec3(3.5, 64.05, 0.5) }] });
    const started = Date.now(); const result = await run(r);
    expect(typeof result).toBe('string'); expect(Date.now() - started).toBe(0);
    expect(r.routes).toEqual([]); expect(r.probes).toEqual([]);
  });

  it('allows automatic pickup to settle without requesting a path', async () => {
    const r = rig({ pickup: 'delayed' }); const result = await run(r);
    expect(typeof result).toBe('string'); expect(r.routes).toEqual([]); expect(r.probes).toEqual([]);
  });

  it('does not walk into a vanished airborne block when no matching drop exists', async () => {
    const r = rig({ pickup: 'none' }); const result = await run(r);
    expect(result).toBeInstanceOf(SkillBlocked); expect(r.dug).toEqual(r.targets);
    expect(r.routes).toEqual([]); expect(r.probes).toEqual([]);
  });

  it('picks up a visible ground drop along a complete route with digging and building disabled', async () => {
    const r = rig({ pickup: 'ground' }); const result = await run(r);
    expect(typeof result).toBe('string'); expect(r.routes).toHaveLength(1); expect(r.probes).toHaveLength(1);
    expect(r.routes[0].goal).toMatchObject({ x: 3, y: 64, z: 0 });
    expect(r.routes[0]).toMatchObject({ canDig: false, scaffolding: [] });
    expect(r.probes[0]).toMatchObject({ canDig: false, scaffolding: [] });
    expect(r.movements.canDig).toBe(true); expect(r.movements.scafoldingBlocks).toBe(r.scaffold);
  });

  it.each([
    { name: 'dirt', at: new Vec3(3.5, 64.05, 0.5) },
    { hidden: true, at: new Vec3(3.5, 64.05, 0.5) },
    { status: 'partial', at: new Vec3(3.5, 64.05, 0.5) },
    { status: 'noPath', at: new Vec3(0.5, 70.1, 0.5) },
  ])('does not pursue an unrelated, hidden, or unreachable drop (%j)', async (drop) => {
    const r = rig({ pickup: 'none', drops: [drop] }); const result = await run(r);
    expect(result).toBeInstanceOf(SkillBlocked); expect(r.routes).toEqual([]);
    expect(r.movements.canDig).toBe(true); expect(r.movements.scafoldingBlocks).toBe(r.scaffold);
  });

  it('still approaches a distant visible target before digging it', async () => {
    const r = rig({ targets: [new Vec3(8, 66, 0)] }); const result = await run(r);
    expect(typeof result).toBe('string'); expect(r.routes).toHaveLength(1);
    expect(r.routes[0].goal.pos).toEqual(r.targets[0]); expect(r.dug).toEqual(r.targets);
    expect(r.routes[0].canDig).toBe(true);
  });

  it('prefers a currently reachable target over the first distant canopy index result', async () => {
    const nearby = new Vec3(1, 67, 0);
    const r = rig({ targets: [new Vec3(2, 74, 0), nearby] }); const result = await run(r);
    expect(typeof result).toBe('string'); expect(r.dug).toEqual([nearby]); expect(r.routes).toEqual([]);
  });

  it('restores the shared movement lease and closes the collection scope after pickup cancellation', async () => {
    const r = rig({ pickup: 'ground', abortPickup: true }); const result = await run(r);
    expect(result).toBeInstanceOf(Aborted); expect(r.routes).toHaveLength(1);
    expect(r.routes[0]).toMatchObject({ canDig: false, scaffolding: [] });
    expect(r.movements.canDig).toBe(true); expect(r.movements.scafoldingBlocks).toBe(r.scaffold);
    expect(r.openScopeCount()).toBe(0);
  });

  it('starts the temporary-support scope before actual digging and closes it after success', async () => {
    const r = rig(); const result = await run(r);
    expect(typeof result).toBe('string'); expect(r.scopeWasActive()).toBe(true); expect(r.openScopeCount()).toBe(0);
  });

  it('cleans a confirmed current-scope path support after collection and distinguishes its returned material', async () => {
    const target = new Vec3(8, 66, 0);
    const support = new Vec3(10, 65, 0);
    const r = rig({ targets: [target], pathSupport: support });
    const result = await run(r);
    expect(typeof result).toBe('string');
    expect(result).toContain('实际入包 1 个'); expect(result).toContain('临时垫脚拆除 1 块');
    expect(result).toContain('橡木木板×1');
    expect(r.dug).toEqual([target, support]); expect(r.routes).toHaveLength(1);
    expect(r.bot.blockAt(support)!.name).toBe('air');
    expect(r.bot.inventory.items().map(({ name, count }) => ({ name, count })))
      .toEqual([{ name: 'cherry_log', count: 1 }, { name: 'oak_planks', count: 1 }]);
    expect(r.openScopeCount()).toBe(0);
  });

  it('cleans only its own confirmed support on a business failure and appends cleanup facts to the error scene', async () => {
    const target = new Vec3(8, 66, 0);
    const support = new Vec3(10, 65, 0);
    const r = rig({ targets: [target], pathSupport: support, failDig: true });
    const result = await run(r);
    expect(result).toBeInstanceOf(SkillBlocked);
    expect((result as SkillBlocked).message).toBe('服务器拒绝了这次采集');
    expect((result as SkillBlocked).scene.join('\n')).toContain('临时垫脚拆除 1 块');
    expect((result as SkillBlocked).scene.join('\n')).toContain('橡木木板×1');
    expect(r.dug).toEqual([support]); expect(r.bot.blockAt(target)!.name).toBe('cherry_log');
    expect(r.bot.blockAt(support)!.name).toBe('air');
    expect(r.bot.inventory.items().map(({ name, count }) => ({ name, count })))
      .toEqual([{ name: 'oak_planks', count: 1 }]);
    expect(r.openScopeCount()).toBe(0);
  });
});
