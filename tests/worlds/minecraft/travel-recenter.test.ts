import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { wallEdgeRecenterTarget } from '../../../src/worlds/minecraft/travel.ts';

function makeBot(pos: Vec3, walls: string[]) {
  return {
    entity: { position: pos },
    blockAt: (p: Vec3) => ({
      boundingBox: p.y === 67 || walls.includes(`${p.x},${p.y},${p.z}`) ? 'block' : 'empty',
    }),
  } as never;
}

describe('贴墙起步回格心', () => {
  it('千灯纪家门口贴北墙的站位需要先回到安全格心', () => {
    const bot = makeBot(new Vec3(-569.62, 68, -479.30001), ['-570,68,-479']);
    expect(wallEdgeRecenterTarget(bot)).toEqual(new Vec3(-569.5, 68, -479.5));
  });

  it('开阔格子不额外移动', () => {
    const bot = makeBot(new Vec3(-569.62, 68, -479.30001), []);
    expect(wallEdgeRecenterTarget(bot)).toBeNull();
  });
});
