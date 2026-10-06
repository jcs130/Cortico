import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import { describe, expect, it } from 'vitest';
import { isStableScaffoldMaterial } from '../../../src/worlds/minecraft/scaffold-material.ts';
import { scaffoldNames } from '../../../src/worlds/minecraft/placement.ts';
import type { SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';
import { withMinecraftCollisionShapes } from './executor-harness.ts';
const require = createRequire(import.meta.url);
const registry = require('minecraft-data')('1.20.6') as Bot['registry'];

describe('stable scaffold collision shapes', () => {
  it.each(['dirt', 'stone', 'cobblestone', 'cherry_planks', 'moss_block'])('accepts a complete stable %s cube', name => {
    expect(isStableScaffoldMaterial(registry, name)).toBe(true);
  });
  it.each(['cherry_stairs', 'spruce_stairs', 'oak_slab', 'ladder', 'sand', 'red_sand', 'gravel',
    'torch', 'scaffolding', 'water', 'dirt_path', 'oak_fence', 'piston', 'chest', 'unknown_block'])
    ('rejects %s as automatic full-height support', name => {
      expect(isStableScaffoldMaterial(registry, name)).toBe(false);
    });
  it('preserves the selected stock order while filtering partial shapes in direct upkeep', () => {
    const ctx = { policy: { get: () => ({ scaffold: ['cherry_stairs', 'dirt', 'sand', 'cobblestone'] }) } } as unknown as SkillContext;
    expect(scaffoldNames(ctx, { registry } as Bot)).toEqual(['dirt', 'cobblestone']);
    ctx.policy!.get = () => ({ scaffold: ['spruce_stairs'] }) as never;
    expect(scaffoldNames(ctx, { registry } as Bot)).toBeNull();
  });
  it('fixture metadata preserves synthetic IDs without granting unknown or partial blocks support', () => {
    const fixture = withMinecraftCollisionShapes({ blocksByName: {
      dirt: { id: 900, name: 'dirt' }, cherry_stairs: { id: 901, name: 'cherry_stairs' },
      unknown_block: { id: 902, name: 'unknown_block' },
    } });
    expect(fixture.blocksByName.dirt.id).toBe(900);
    expect(fixture.blockCollisionShapes).toBe(registry.blockCollisionShapes);
    expect(isStableScaffoldMaterial(fixture as unknown as Bot['registry'], 'dirt')).toBe(true);
    expect(isStableScaffoldMaterial(fixture as unknown as Bot['registry'], 'cherry_stairs')).toBe(false);
    expect(isStableScaffoldMaterial(fixture as unknown as Bot['registry'], 'unknown_block')).toBe(false);
  });
});
