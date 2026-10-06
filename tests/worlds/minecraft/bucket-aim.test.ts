import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { bucketAimPoint } from '../../../src/worlds/minecraft/skills-interact.ts';
import { BLOCK_FACES, type BlockFace } from '../../../src/worlds/minecraft/geometry.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.6');
const Block = require('prismarine-block')('1.20.6');
const cell = { x: 10, y: 64, z: -20 };

describe('桶的表面瞄准', () => {
  it.each(Object.keys(BLOCK_FACES) as BlockFace[])('完整方块按 %s 面瞄准', (face) => {
    const block = Block.fromStateId(data.blocksByName.stone.defaultState, 0);
    const direction = BLOCK_FACES[face];
    const point = bucketAimPoint(cell, face, block.shapes);
    expect([point.x, point.y, point.z]).toEqual(
      [cell.x, cell.y, cell.z].map((origin, i) => origin + 0.5 + direction[i] * 0.5),
    );
  });

  it('耕地与下半台阶瞄准实际顶面，面外格仍是整数相邻格', () => {
    for (const name of ['farmland', 'oak_slab']) {
      const block = Block.fromStateId(data.blocksByName[name].defaultState, 0);
      const top = Math.max(...block.shapes.map((box: number[]) => box[4]));
      expect(top).toBeLessThan(1);
      const point = bucketAimPoint(cell, 'up', block.shapes);
      expect(point.y).toBe(cell.y + top);
      expect(point.x).toBe(cell.x + 0.5);
      expect(point.z).toBe(cell.z + 0.5);
    }
  });
});
