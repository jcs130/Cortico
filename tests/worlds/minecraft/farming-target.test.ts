import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { farmingClickCell } from '../../../src/worlds/minecraft/farming-target.ts';

describe('farmingClickCell', () => {
  function bot(upper: string, lower: string) {
    return {
      blockAt: (p: Vec3) => ({ name: p.y === 65 ? upper : lower }),
    } as never;
  }
  const at = { x: 3, y: 65, z: 0 };

  it('only aims one block down when the upper cell is air and lower cell supports that action', () => {
    expect(farmingClickCell(bot('air', 'grass_block'), at, 'wooden_hoe'))
      .toEqual({ x: 3, y: 64, z: 0 });
    expect(farmingClickCell(bot('cave_air', 'grass_block'), at, 'hoe'))
      .toEqual({ x: 3, y: 64, z: 0 });
    expect(farmingClickCell(bot('air', 'farmland'), at, 'wheat_seeds'))
      .toEqual({ x: 3, y: 64, z: 0 });
    expect(farmingClickCell(bot('air', 'soul_sand'), at, 'nether_wart'))
      .toEqual({ x: 3, y: 64, z: 0 });
  });

  it('unrelated item uses do not consult farming terrain', () => {
    expect(farmingClickCell({} as never, at, 'trident')).toBeNull();
    expect(farmingClickCell({} as never, at, 'bow')).toBeNull();
  });

  it('does not click through plants or change an explicit side face or invalid soil', () => {
    expect(farmingClickCell(bot('grass', 'grass_block'), at, 'wooden_hoe')).toBeNull();
    expect(farmingClickCell(bot('air', 'grass_block'), at, 'wheat_seeds')).toBeNull();
    expect(farmingClickCell(bot('air', 'farmland'), at, 'wheat_seeds', 'north')).toBeNull();
  });
});
