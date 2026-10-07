import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { normalizeBlueprint } from '../../../src/worlds/minecraft/blueprint.ts';
import { compileBlueprint } from '../../../src/worlds/minecraft/blueprint-plan.ts';
import { SkillBlocked, type BlueprintDesk, type BlueprintSite, type SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';
import { skillCollect, skillFind } from '../../../src/worlds/minecraft/skills-gather.ts';
import { FindObservationCache } from '../../../src/worlds/minecraft/search-observation.ts';
import { digBlock } from '../../../src/worlds/minecraft/travel.ts';

vi.mock('../../../src/worlds/minecraft/travel.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/worlds/minecraft/travel.ts')>(),
  gotoGoal: async (bot: Bot, goal: unknown) => bot.pathfinder.goto(goal as never),
  dropGoal: () => undefined,
}));

const req = createRequire(createRequire(import.meta.url).resolve('mineflayer/package.json'));
const registry = req('prismarine-registry')('1.20.6');
const Blocks = req('prismarine-block')(registry);

function site(states = ['minecraft:cherry_log[axis=x]'], startedAt: number | null | undefined = 1): BlueprintSite {
  const blueprint = normalizeBlueprint({ size_xyz: [states.length, 1, 1], site_mode: 'new', layers: [[states]] });
  return { key: 'cabin', name: null, blueprint, plan: compileBlueprint(blueprint), anchor: [0, 64, 0],
    cursor: 0, startedAt };
}

function rig(options: {
  sites?: BlueprintSite[];
  targets?: Vec3[];
  name?: string;
  onGoto?: () => void;
  onEquip?: (round: number) => void;
  boundDimension?: string;
} = {}) {
  const sites = options.sites ?? [];
  const name = options.name ?? 'cherry_log';
  const targets = options.targets ?? [new Vec3(0, 64, 0)];
  const blocks = new Map<string, Block>();
  const queries: number[] = [];
  const dug: Vec3[] = [];
  const bag = [{ name: 'iron_axe', count: 1, type: registry.itemsByName.iron_axe.id, stackSize: 1 }];
  let equipped = 0;
  const make = (blockName: string, at: Vec3): Block => {
    const block = Blocks.fromStateId(registry.blocksByName[blockName].defaultState, 0);
    block.position = at;
    return block;
  };
  for (const target of targets) blocks.set(target.toString(), make(name, target));
  if (name === 'wheat') {
    const mature = registry.blocksByName.wheat.maxStateId;
    for (const target of targets) {
      const crop = Blocks.fromStateId(mature, 0); crop.position = target;
      blocks.set(target.toString(), crop);
    }
  }
  const bot = Object.assign(new EventEmitter(), {
    registry, game: { dimension: 'overworld', gameMode: 'survival' },
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62, height: 1.8, onGround: true, effects: {} },
    entities: {}, heldItem: null as (typeof bag)[number] | null,
    world: { raycast: () => null },
    inventory: { items: () => bag, slots: [] },
    blockAt: (point: Vec3): Block => blocks.get(point.toString()) ?? make(point.y === 63 ? 'stone' : 'air', point),
    canSeeBlock: () => true,
    canDigBlock: (block: Block) => block.diggable
      && block.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)) <= 5.1,
    digTime: () => 20, stopDigging: () => undefined,
    unequip: async () => { bot.heldItem = null; },
    equip: async (item: (typeof bag)[number]) => { bot.heldItem = item as Bot['heldItem']; options.onEquip?.(++equipped); },
    findBlocks: ({ count }: { count: number }) => {
      queries.push(count);
      return targets.filter((point) => blocks.get(point.toString())?.name === name).slice(0, count);
    },
    dig: async (block: Block) => {
      dug.push(block.position.clone());
      blocks.set(block.position.toString(), make('air', block.position));
      const stack = bag.find((item) => item.name === name);
      if (stack) stack.count++;
      else bag.push({ name, count: 1, type: registry.itemsByName[name].id, stackSize: 64 });
    },
    pathfinder: {
      movements: { canDig: true, scafoldingBlocks: [] },
      setGoal: () => undefined,
      goto: async (goal: { pos?: Vec3; x?: number; z?: number }) => {
        if (goal.pos) bot.entity.position = goal.pos.offset(0.5, 0, 0.5);
        else if (goal.x !== undefined && goal.z !== undefined) {
          bot.entity.position = new Vec3(goal.x + 0.5, bot.entity.position.y, goal.z + 0.5);
        }
        options.onGoto?.();
      },
    },
  }) as unknown as Bot;
  const desk = {
    keys: () => sites.map((entry) => entry.key),
    get: (key: string) => sites.find((entry) => entry.key === key) ?? null,
  } as BlueprintDesk;
  const ctx = {
    aborted: () => false, noLight: true,
    search: { history: new FindObservationCache(), scope: () => ({
      connectionGeneration: 1, realm: 'test-world', dimension: bot.game.dimension,
    }) },
    blueprints: () => options.boundDimension && bot.game.dimension !== options.boundDimension
      ? { ...desk, get: () => null } : desk,
    marks: () => ({ around: () => [{ name: 'timber', at: 1 }] }),
  } as unknown as SkillContext;
  return { bot, ctx, targets, queries, dug };
}

describe('collect registered blueprint sources', () => {
  it('keeps a matching registered material despite different state properties and harvests a natural block in an air cell', async () => {
    const binding = site(['minecraft:cherry_log[axis=x]', 'minecraft:air']);
    binding.cursor = binding.plan.steps.length;
    const natural = new Vec3(1, 64, 0);
    const r = rig({ sites: [binding], targets: [new Vec3(0, 64, 0), natural] });
    const receipt = await skillCollect(r.bot, 'cherry_log', 1, r.ctx, false, false, 'iron_axe');
    expect(r.dug).toEqual([natural]);
    expect(r.bot.blockAt(r.targets[0])!.name).toBe('cherry_log');
    expect(receipt).toContain('登记蓝图「cabin」');
    expect(receipt).toContain('精确坐标的 dig');
  });

  it('extends a full nearest-candidate batch past registered material to a natural source outside the site', async () => {
    const binding = site(Array(16).fill('minecraft:cherry_log[axis=y]'));
    const sources = Array.from({ length: 16 }, (_, x) => new Vec3(x, 64, 0));
    const natural = new Vec3(0, 64, 1);
    const r = rig({ sites: [binding], targets: [...sources, natural] });
    await skillCollect(r.bot, 'cherry_log', 1, r.ctx, false, false, 'iron_axe');
    expect(r.dug).toEqual([natural]);
    expect(sources.every((point) => r.bot.blockAt(point)!.name === 'cherry_log')).toBe(true);
  });

  it.each(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void', 'minecraft:oak_planks'])
    ('does not claim a natural log in a blueprint %s cell as structure', async (state) => {
      const r = rig({ sites: [site([state])] });
      await skillCollect(r.bot, 'cherry_log', 1, r.ctx, false, false, 'iron_axe');
      expect(r.dug).toEqual(r.targets);
    });

  it('permits collection at an unbound design', async () => {
    const binding = site(); binding.anchor = null;
    const r = rig({ sites: [binding] });
    await skillCollect(r.bot, 'cherry_log', 1, r.ctx, false, false, 'iron_axe');
    expect(r.dug).toEqual(r.targets);
  });

  it('permits collection at an explicitly survey-only binding', async () => {
    const r = rig({ sites: [site(undefined, null)] });
    await skillCollect(r.bot, 'cherry_log', 1, r.ctx, false, false, 'iron_axe');
    expect(r.dug).toEqual(r.targets);
  });

  it('keeps the legacy startedAt-omitted bound structure', async () => {
    const binding = site(); delete binding.startedAt;
    const r = rig({ sites: [binding] });
    await expect(skillCollect(r.bot, 'cherry_log', 1, r.ctx)).rejects.toMatchObject({ source: 'local' });
    expect(r.dug).toEqual([]);
  });

  it('uses only bindings returned by the current dimension desk', async () => {
    const r = rig({ sites: [site()], boundDimension: 'overworld' });
    r.bot.game.dimension = 'the_nether';
    await skillCollect(r.bot, 'cherry_log', 1, r.ctx, false, false, 'iron_axe');
    expect(r.dug).toEqual(r.targets);
  });

  it('reports local structure-source exclusion and still allows an explicit exact dig', async () => {
    const r = rig({ sites: [site()] });
    const result = await skillCollect(r.bot, 'cherry_log', 1, r.ctx).catch((error: SkillBlocked) => error);
    expect(result).toBeInstanceOf(SkillBlocked);
    expect((result as SkillBlocked).source).toBe('local');
    expect((result as SkillBlocked).message).toContain('登记蓝图「cabin」');
    expect((result as SkillBlocked).message).not.toMatch(/采空|挖完|受保护/);
    expect(r.dug).toEqual([]);
    await digBlock(r.bot, r.bot.blockAt(r.targets[0])!, r.ctx);
    expect(r.dug).toEqual(r.targets);
  });

  it('does not declare a resource mark exhausted when the only remaining matches are structure', async () => {
    const r = rig({ sites: [site()], targets: [new Vec3(0, 64, 0), new Vec3(1, 64, 0)] });
    const receipt = await skillCollect(r.bot, 'cherry_log', 2, r.ctx, false, false, 'iron_axe');
    expect(r.dug).toEqual([r.targets[1]]);
    expect(receipt).toContain('剩下看见的 1 处是登记蓝图结构材料');
    expect(receipt).not.toContain('挖完了');
  });

  it('rechecks a binding created while approaching and continues to the available natural target', async () => {
    const binding = site(undefined, null); binding.anchor = [8, 64, 0];
    const r = rig({ sites: [binding], targets: [new Vec3(8, 64, 0), new Vec3(8, 64, 1)],
      onGoto: () => { binding.startedAt = 1; } });
    await skillCollect(r.bot, 'cherry_log', 1, r.ctx, false, false, 'iron_axe');
    expect(r.dug).toEqual([r.targets[1]]);
    expect(r.bot.blockAt(r.targets[0])!.name).toBe('cherry_log');
  });

  it('rechecks a binding created during the final equip await before issuing native dig', async () => {
    const binding = site(undefined, null);
    const r = rig({ sites: [binding], targets: [new Vec3(0, 64, 0), new Vec3(1, 64, 0)],
      onEquip: (round) => { if (round === 2) binding.startedAt = 1; } });
    await skillCollect(r.bot, 'cherry_log', 1, r.ctx, false, false, 'iron_axe');
    expect(r.dug).toEqual([r.targets[1]]);
    expect(r.bot.blockAt(r.targets[0])!.name).toBe('cherry_log');
  });

  it('harvests mature wheat registered in a started farm blueprint', async () => {
    const binding = site(['minecraft:wheat[age=7]']);
    const r = rig({ sites: [binding], name: 'wheat' });
    const receipt = await skillCollect(r.bot, 'wheat', 1, r.ctx);
    expect(r.dug).toEqual(r.targets);
    expect(receipt).toContain('实际入包 1 个');
  });

  it('keeps a registered decorative flower outside the renewable-crop exception', async () => {
    const r = rig({ sites: [site(['minecraft:poppy'])], name: 'poppy' });
    await expect(skillCollect(r.bot, 'poppy', 1, r.ctx)).rejects.toMatchObject({ source: 'local' });
    expect(r.dug).toEqual([]);
  });
});

describe('find registered blueprint sources', () => {
  it('finds and collects the same available source beside a registered structure', async () => {
    const natural = new Vec3(1, 64, 0);
    const r = rig({ sites: [site()], targets: [new Vec3(0, 64, 0), natural] });
    const receipt = await skillFind(r.bot, 'cherry_log', 'east', 16, r.ctx);
    expect(receipt).toContain('blockAt=(1, 64, 0)');
    expect(receipt).not.toContain('blockAt=(0, 64, 0)');
    expect(receipt).toContain('登记蓝图「cabin」的结构材料');
    await skillCollect(r.bot, 'cherry_log', 1, r.ctx, false, false, 'iron_axe');
    expect(r.dug).toEqual([natural]);
  });

  it('extends a full search batch past registered material', async () => {
    const sources = Array.from({ length: 16 }, (_, x) => new Vec3(x, 64, 0));
    const r = rig({ sites: [site(Array(16).fill('minecraft:cherry_log'))],
      targets: [...sources, new Vec3(0, 64, 1)] });
    const receipt = await skillFind(r.bot, 'cherry_log', 'north', 16, r.ctx);
    expect(receipt).toContain('blockAt=(0, 64, 1)');
    expect(r.dug).toEqual([]);
  });

  it('retains structures for static observation and excludes their historical coordinates from a resource search', async () => {
    const r = rig({ sites: [site()] });
    const observation = await skillFind(r.bot, 'cherry_log', undefined, 16, r.ctx);
    expect(observation).toContain('blockAt=(0, 64, 0)');
    expect(observation).toContain('登记蓝图「cabin」的结构材料，collect 会保留');
    const search = await skillFind(r.bot, 'cherry_log', 'east', 1, r.ctx);
    expect(search).toContain('没看见可作为批量采集来源的樱花原木');
    expect(search).not.toContain('真实历史观察');
    expect(search).not.toContain('blockAt=(0, 64, 0)');
    expect(search).not.toContain('已知受保护');
    expect(r.dug).toEqual([]);
  });

  it.each([false, true])('keeps a survey-only source available when unbound=%s', async (unbound) => {
    const binding = site(undefined, null);
    if (unbound) binding.anchor = null;
    const r = rig({ sites: [binding] });
    const receipt = await skillFind(r.bot, 'cherry_log', 'east', 16, r.ctx);
    expect(receipt).toContain('blockAt=(0, 64, 0)');
    expect(receipt).not.toContain('结构材料');
  });

  it('uses bindings only from the current dimension', async () => {
    const r = rig({ sites: [site()], boundDimension: 'overworld' });
    r.bot.game.dimension = 'the_nether';
    const receipt = await skillFind(r.bot, 'cherry_log', 'east', 16, r.ctx);
    expect(receipt).toContain('blockAt=(0, 64, 0)');
  });

  it('rechecks construction bindings when scanning after a movement', async () => {
    const binding = site(undefined, null);
    let moved = false;
    const r = rig({ sites: [binding], targets: [new Vec3(0, 64, 0), new Vec3(1, 64, 0)],
      onGoto: () => { binding.startedAt = 1; moved = true; } });
    r.bot.canSeeBlock = () => moved;
    const receipt = await skillFind(r.bot, 'cherry_log', 'east', 1, r.ctx);
    expect(receipt).toContain('blockAt=(1, 64, 0)');
    expect(receipt).not.toContain('blockAt=(0, 64, 0)');
    expect(receipt).toContain('结构材料');
  });

  it('keeps mature crops available for harvesting in a registered farm', async () => {
    const r = rig({ sites: [site(['minecraft:wheat[age=7]'])], name: 'wheat' });
    const receipt = await skillFind(r.bot, 'wheat', 'east', 16, r.ctx);
    expect(receipt).toContain('blockAt=(0, 64, 0)');
    expect(receipt).toContain('已成熟');
    expect(receipt).not.toContain('结构材料');
  });
});
