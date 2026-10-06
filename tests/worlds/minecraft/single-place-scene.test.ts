import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { singlePlaceScene } from '../../../src/worlds/minecraft/placement.ts';
import { skillBuild } from '../../../src/worlds/minecraft/skills-build.ts';
import { SkillBlocked } from '../../../src/worlds/minecraft/skill-context.ts';

function occupiedBuildBot(decoration?: string) {
  return {
    entity: { position: new Vec3(0.5, 64, 1.5) },
    registry: { blocksByName: { chest: { boundingBox: 'block' } } },
    inventory: { items: () => [{ name: 'chest', count: 1 }] },
    blockAt: (p: { x: number; y: number; z: number }) => {
      if (p.y === 63) return { name: 'stone', boundingBox: 'block' };
      if (p.y === 64 && p.x === 0 && p.z === 0) return { name: 'crafting_table', boundingBox: 'block' };
      if (decoration && p.y === 64 && p.x === -1 && p.z === 1) return { name: decoration, boundingBox: 'empty' };
      return { name: 'air', boundingBox: 'empty' };
    },
  } as never;
}

describe('单格方块被占时的可见落点', () => {
  it.each(['torch', 'rail', 'ladder', 'wheat'])('没有碰撞箱的 %s 不被推荐为空位', (decoration) => {
    const center = { x: 0, y: 64, z: 0 };
    const empty = singlePlaceScene(occupiedBuildBot(), center, 'chest').join('\n');
    const occupied = singlePlaceScene(occupiedBuildBot(decoration), center, 'chest').join('\n');
    expect(empty).toContain('(-1, 64, 1)');
    expect(occupied).not.toContain('(-1, 64, 1)');
    expect(occupied).toContain('实测几何空位');
  });

  it('只列有支撑的空位,不推荐原格或玩家身体所在格', async () => {
    const bot = occupiedBuildBot();
    const scene = singlePlaceScene(bot, { x: 0, y: 64, z: 0 }, 'chest').join('\n');
    expect(scene).toContain('实测几何空位');
    expect(scene).not.toContain('(0, 64, 0)');
    expect(scene).not.toContain('(0, 64, 1)');
    expect(scene).toContain('保护许可');

    let blocked: SkillBlocked | null = null;
    try {
      await skillBuild(bot, { skill: 'build', anchors: [[0, 64, 0]], material: 'chest' } as never, {} as never);
    } catch (error) { blocked = error as SkillBlocked; }
    expect(blocked).toBeInstanceOf(SkillBlocked);
    expect(blocked?.scene.join('\n')).toContain('实测几何空位');
  });
});
