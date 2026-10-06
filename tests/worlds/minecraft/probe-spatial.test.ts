import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { readRegion } from '../../../src/worlds/minecraft/cell-facts.ts';
import { zhName } from '../../../src/worlds/minecraft/names.ts';
import { compositionText } from '../../../src/worlds/minecraft/receipt.ts';
import type { SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';
import { skillProbe } from '../../../src/worlds/minecraft/skills-gather.ts';

interface CellFixture { x: number; y: number; z: number; name: string; age?: number; moisture?: number }

function terrainBot(cells: CellFixture[], position = new Vec3(6, 67, 3)): Bot {
  const blocks = new Map(cells.map((cell) => [`${cell.x},${cell.y},${cell.z}`, cell]));
  return {
    entity: { position },
    blockAt(point: Vec3) {
      const p = point.floored();
      const cell = blocks.get(`${p.x},${p.y},${p.z}`);
      if (!cell) return null;
      return {
        name: cell.name,
        position: p,
        boundingBox: cell.name === 'wheat' ? 'empty' : 'block',
        getProperties: () => ({ ...(cell.age === undefined ? {} : { age: cell.age }),
          ...(cell.moisture === undefined ? {} : { moisture: cell.moisture }) }),
      };
    },
  } as unknown as Bot;
}

function probeContext(): SkillContext {
  return { aborted: () => false, probeMemo: { last: null, entries: new Map() } } as SkillContext;
}

const fieldProbe = { skill: 'probe', shape: 'box', anchors: [[0, 66, 0], [6, 66, 3]] } as const;

function fieldCells(): CellFixture[] {
  return Array.from({ length: 28 }, (_, index) => ({
    x: index % 7, y: 66, z: Math.floor(index / 7), name: 'dirt',
  }));
}

describe('probe spatial material samples', () => {
  it('a region larger than 27 cells includes the nearest soil coordinate with its actual height', async () => {
    const cells = fieldCells();
    cells[0].name = 'farmland';
    cells[27].name = 'farmland';
    cells[7].name = 'torch';
    const text = await skillProbe(terrainBot(cells), {
      ...fieldProbe, anchors: [[0, 66, 0], [6, 66, 3]],
    }, probeContext());

    expect(text).toContain('共 28 格');
    expect(text).toContain(`${zhName('farmland')}×2(最近的在 (6, 66, 3))`);
    expect(text).toContain(`${zhName('dirt')}×25(最近的在 (5, 66, 3))`);
    expect(text).toContain(`${zhName('torch')}×1(最近的在 (0, 66, 1))`);
    expect(text).toContain('样本上方空间仍需逐格核对');
    expect(text).not.toContain('逐格:');
  });

  it('unloaded cells add an unknown count without inventing a material or coordinate', async () => {
    const cells = [{ x: 6, y: 66, z: 3, name: 'farmland' }];
    const text = await skillProbe(terrainBot(cells), {
      ...fieldProbe, anchors: [[0, 66, 0], [6, 66, 3]],
    }, probeContext());

    expect(text).toContain(`${zhName('farmland')}×1(最近的在 (6, 66, 3))`);
    expect(text).toContain('27 格区块没加载,没读到');
    expect(text).not.toContain('空气');
    expect(text).not.toContain('(0, 66, 0)');
  });

  it('a wholly unloaded large region reports no observed material samples', async () => {
    const text = await skillProbe(terrainBot([]), {
      ...fieldProbe, anchors: [[0, 66, 0], [6, 66, 3]],
    }, probeContext());

    expect(text).toContain('什么都没有');
    expect(text).toContain('28 格区块没加载,没读到');
    expect(text).not.toContain('最近的在');
    expect(text).not.toContain('空气');
  });

  it('default composition retains non-ore counts and ore coordinates', () => {
    const cells = [
      { x: 0, y: 66, z: 0, name: 'grass_block' },
      { x: 1, y: 66, z: 0, name: 'grass_block' },
      { x: 2, y: 66, z: 0, name: 'iron_ore' },
    ];
    const reading = readRegion(terrainBot(cells, new Vec3(2, 67, 0)), cells);

    expect(compositionText(reading)).toBe(
      `${zhName('grass_block')}×2、${zhName('iron_ore')}×1(最近的在 (2, 66, 0))`,
    );
    expect(compositionText(reading, true)).toBe(
      `${zhName('grass_block')}×2(最近的在 (1, 66, 0))、${zhName('iron_ore')}×1(最近的在 (2, 66, 0))`,
    );
  });

  it('small probes retain individual coordinates and observed crop age', async () => {
    const cells = [
      { x: 1, y: 66, z: 1, name: 'farmland' },
      { x: 1, y: 67, z: 1, name: 'wheat', age: 3 },
    ];
    const text = await skillProbe(terrainBot(cells), {
      skill: 'probe', shape: 'line', anchors: [[1, 66, 1], [1, 67, 1]],
    }, probeContext());

    expect(text).toContain('逐格:');
    expect(text).toContain(`(1,66,1):${zhName('farmland')}`);
    expect(text).toContain(`(1,67,1):${zhName('wheat')}(age 3/7)`);
    expect(text).not.toContain('最近的在');
  });

  it('unchanged repeated probes retain the sampled coordinates in the prior observation', async () => {
    const bot = terrainBot(fieldCells());
    const ctx = probeContext();
    const call = { ...fieldProbe, anchors: [[0, 66, 0], [6, 66, 3]] as [number, number, number][] };
    const first = await skillProbe(bot, call, ctx);
    const repeated = await skillProbe(bot, call, ctx);

    expect(first).toContain(`${zhName('dirt')}×28(最近的在 (6, 66, 3))`);
    expect(repeated).toContain('与上次探查相同');
    expect(repeated).toContain(`上次: ${first}`);
  });

  it('irrigation updates the same crop-soil probe even before the crop grows', async () => {
    const soil = { x: 1, y: 66, z: 1, name: 'farmland', moisture: 0 };
    const cells = [soil, { x: 1, y: 67, z: 1, name: 'wheat', age: 3 }];
    const bot = terrainBot(cells), ctx = probeContext();
    const call = { skill: 'probe', shape: 'line', anchors: [[1, 66, 1], [1, 67, 1]] } as const;
    const first = await skillProbe(bot, { ...call, anchors: [[1, 66, 1], [1, 67, 1]] }, ctx);
    expect(first).toContain(`(1,66,1):${zhName('farmland')}(moisture 0/7)`);
    soil.moisture = 7;
    const irrigated = await skillProbe(bot, { ...call, anchors: [[1, 66, 1], [1, 67, 1]] }, ctx);
    expect(irrigated).not.toContain('与上次探查相同');
    expect(irrigated).toContain(`(1,66,1):${zhName('farmland')}(moisture 7/7)`);
    expect(irrigated).toContain(`(1,67,1):${zhName('wheat')}(age 3/7)`);
    expect(await skillProbe(bot, { ...call, anchors: [[1, 66, 1], [1, 67, 1]] }, ctx)).toContain('与上次探查相同');
  });
});
