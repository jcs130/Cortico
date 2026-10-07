import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { chooseTool, equipToolFor, miningToolPlan, nearBreak } from '../../../src/worlds/minecraft/tools.ts';
import { defaultPolicy } from '../../../src/worlds/minecraft/policy.ts';
import type { InvItem } from '../../../src/worlds/minecraft/inventory.ts';
import type { SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';

const require = createRequire(import.meta.url);
const dependency = createRequire(require.resolve('mineflayer'));
const registry = require('minecraft-data')('1.20.6') as Bot['registry'];
const Blocks = dependency('prismarine-block')('1.20.6') as typeof Block;
const Items = dependency('prismarine-item')('1.20.6') as {
  fromNotch(packet: unknown): InvItem;
};

function stack(name: string, components: Array<{ type: string; data: unknown }> = []): InvItem {
  return Items.fromNotch({ itemId: registry.itemsByName[name].id, itemCount: 1, components });
}

function block(name: string): Block {
  return Blocks.fromStateId(registry.blocksByName[name].minStateId, 0);
}

function rig(items: InvItem[], reserve: string[] = []) {
  const policy = { ...defaultPolicy(), reserve };
  const bot = {
    registry,
    entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62, onGround: true,
      effects: {} as Record<number, { amplifier: number }> },
    game: { gameMode: 'survival' },
    inventory: { items: () => items, slots: [] as Array<InvItem | null> },
    getEquipmentDestSlot: () => 5,
    blockAt: (_position: Vec3) => block('air'),
    heldItem: null as InvItem | null,
    equip: async (item: InvItem) => { bot.heldItem = item; },
    unequip: async () => { bot.heldItem = null; },
  };
  const ctx = {
    policy: { get: () => policy },
    reserveHits: [],
    toolTrace: { notes: [], near: new Set<string>() },
  } as unknown as SkillContext;
  return { bot, ctx, choose: (target: Block, tool?: string) => chooseTool(bot as unknown as Bot,
    target, ctx, miningToolPlan(tool)) };
}

describe('economy mining tools with 1.20.6 block and item data', () => {
  it.each(['oak_log', 'cherry_log'])('equips a healthy named axe for %s without a harvest gate', async (name) => {
    const axe = stack('diamond_axe', [
      { type: 'custom_name', data: '{"text":"Carved axe"}' }, { type: 'damage', data: 41 },
    ]);
    const target = block(name);
    const { bot, ctx, choose } = rig([axe]);
    expect(registry.blocksByName[name].harvestTools).toBeUndefined();
    expect(target.digTime(null, false, false, false)).toBe(3000);
    expect(target.digTime(axe.type, false, false, false)).toBe(400);
    expect(choose(target).pick).toBe(axe);
    await equipToolFor(bot as unknown as Bot, target, ctx, miningToolPlan(undefined));
    expect(bot.heldItem).toBe(axe);
    expect(ctx.toolTrace?.notes).toContain('节约模式选:Carved axe 耐久1520/1561');
  });

  it('uses the material class for non-log blocks too', () => {
    const pick = stack('diamond_pickaxe');
    const shovel = stack('iron_shovel');
    const { choose } = rig([pick, shovel]);
    expect(choose(block('dirt')).pick).toBe(shovel);
  });

  it('keeps the least costly healthy tier rather than always choosing the fastest', () => {
    const wood = stack('wooden_axe');
    const diamond = stack('diamond_axe');
    const { choose } = rig([diamond, wood]);
    expect(choose(block('oak_log')).pick).toBe(wood);
    expect(choose(block('oak_log'), 'fastest').pick).toBe(diamond);
  });

  it('does not spend axe durability on a block already broken instantly by hand', () => {
    const axe = stack('diamond_axe');
    const target = block('oak_sapling');
    expect(target.material).toContain('mineable/axe');
    expect(target.digTime(null, false, false, false)).toBe(0);
    expect(rig([axe]).choose(target).pick).toBeNull();
  });

  it('uses hand fallback for an inapplicable tool and replaces a held durable weapon', async () => {
    const pick = stack('diamond_pickaxe');
    const sword = stack('diamond_sword');
    const bread = stack('bread');
    const { bot, ctx, choose } = rig([pick, sword, bread]);
    bot.heldItem = sword;
    const target = block('cherry_log');
    expect(choose(target)).toMatchObject({ pick: null, canDrop: true, error: null });
    await equipToolFor(bot as unknown as Bot, target, ctx, miningToolPlan(undefined));
    expect(bot.heldItem).toBe(bread);
    expect(ctx.toolTrace?.notes).toContain('樱花原木可徒手采集,已换下耐久工具');
  });

  it('can harvest by hand with no suitable tool in inventory', () => {
    expect(rig([]).choose(block('oak_log'))).toMatchObject({ pick: null, canDrop: true, error: null });
  });

  it('does not override reserve for optional speed gains', () => {
    const axe = stack('diamond_axe');
    const { choose } = rig([axe], ['axe']);
    expect(choose(block('oak_log'))).toMatchObject({ pick: null, error: null });
    expect(choose(block('oak_log')).reserve).toBeUndefined();
  });

  it('uses an unreserved alternative even if a lower tier is reserved', () => {
    const wood = stack('wooden_axe');
    const iron = stack('iron_axe');
    expect(rig([wood, iron], ['wooden_axe']).choose(block('oak_log')).pick).toBe(iron);
  });

  it('falls back at the durability reserve boundary and uses the axe just above it', () => {
    const critical = stack('diamond_axe', [{ type: 'damage', data: 1482 }]);
    const healthy = stack('diamond_axe', [{ type: 'damage', data: 1481 }]);
    expect(nearBreak(critical)).toEqual({ left: 79, max: 1561 });
    expect(nearBreak(healthy)).toBeNull();
    expect(rig([critical]).choose(block('oak_log'))).toMatchObject({ pick: null, error: null });
    expect(rig([critical, healthy]).choose(block('oak_log')).pick).toBe(healthy);
  });

  it('does not claim optional speed gains when the block has no duration predictor', () => {
    const { bot, ctx } = rig([stack('diamond_axe')]);
    expect(chooseTool(bot as unknown as Bot, { name: 'oak_log' }, ctx,
      miningToolPlan(undefined))).toMatchObject({ pick: null, error: null });
  });

  it('does not use a durable speed tool in creative mode where hand breaking is instant', () => {
    const r = rig([stack('diamond_axe')]);
    r.bot.game.gameMode = 'creative';
    expect(r.choose(block('oak_log')).pick).toBeNull();
  });

  it('re-evaluates speed benefits with eye-level water, aqua affinity, ground and haste', () => {
    const shovel = stack('iron_shovel');
    const target = block('dirt');
    const r = rig([shovel]);
    r.bot.entity.effects[registry.effectsByName.Haste.id] = { amplifier: 74 };
    // At this valid effect level, dry ground allows instant hand breaking.
    expect(r.choose(target).pick).toBeNull();
    r.bot.blockAt = (position) => block(position.y >= 65 ? 'water' : 'air');
    expect(r.choose(target).pick).toBe(shovel);
    r.bot.inventory.slots[5] = stack('diamond_helmet', [{ type: 'enchantments', data: {
      enchantments: [{ id: registry.enchantmentsByName.aqua_affinity.id, level: 1 }], showTooltip: true,
    } }]);
    expect(r.choose(target).pick).toBeNull();
    r.bot.entity.onGround = false;
    expect(r.choose(target).pick).toBe(shovel);
  });

  it('still requires a capable tool for harvest-gated blocks', () => {
    const wood = stack('wooden_pickaxe');
    const iron = stack('iron_pickaxe');
    expect(rig([wood]).choose(block('iron_ore'))).toMatchObject({ pick: null, canDrop: false });
    expect(rig([wood, iron]).choose(block('iron_ore')).pick).toBe(iron);
  });

  it('keeps the only-capable reserve exception for required harvesting tools', () => {
    const pick = stack('diamond_pickaxe');
    expect(rig([pick], ['pickaxe']).choose(block('obsidian'))).toMatchObject({
      pick, canDrop: true, error: null, reserve: { reason: 'only-capable', instead: null },
    });
  });

  it('still blocks a harvest-gated block when every capable tool is near breaking', () => {
    const worn = stack('diamond_pickaxe', [{ type: 'damage', data: 1482 }]);
    const r = rig([worn]);
    expect(r.choose(block('obsidian'))).toMatchObject({ pick: null, canDrop: false });
    expect(r.choose(block('obsidian')).error).toContain('临近损坏');
    expect(r.choose(block('obsidian'), 'fastest').pick).toBe(worn);
  });

  it('retains explicit tool and fastest overrides for worn optional tools', () => {
    const worn = stack('diamond_axe', [{ type: 'damage', data: 1482 }]);
    const r = rig([worn], ['axe']);
    expect(r.choose(block('oak_log'), 'diamond_axe')).toMatchObject({
      pick: worn, error: null, reserve: { reason: 'override', instead: null },
    });
    expect(r.choose(block('oak_log'), 'fastest').pick).toBe(worn);
  });
});
