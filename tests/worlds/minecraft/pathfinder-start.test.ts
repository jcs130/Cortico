import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import pathfinderPkg, { Movements } from 'mineflayer-pathfinder';
import AStar from 'mineflayer-pathfinder/lib/astar.js';
import Move from 'mineflayer-pathfinder/lib/move.js';
import {
  installPartialBlockStartRepair, partialBlockStartMove,
} from '../../../src/worlds/minecraft/pathfinder-start.ts';

const require = createRequire(createRequire(import.meta.url).resolve('mineflayer/package.json'));
const registry = require('prismarine-registry')('1.20.6');
const World = require('prismarine-world')(registry);
const Chunk = require('prismarine-chunk')(registry);

function fixture(upperHasExit: boolean) {
  const bot = {
    entity: { onGround: true, position: new Vec3(1.5, 64.5625, 2.5) },
    blockAt: () => ({ type: 7 }),
  };
  const movements = {
    emptyBlocks: new Set<number>(),
    countScaffoldingItems: () => 0,
    getNeighbors: (node: { y: number }) => node.y === 64 || upperHasExit ? [{ x: 2, y: 64, z: 2 }] : [],
  };
  return { bot, movements };
}

describe('半高方块上的寻路起点', () => {
  it('1.20.6 床与低顶棚：原版上层起点无路，修正后能走出床位', () => {
    const world = new World(null).sync;
    for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
      world.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }));
    }
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
      world.setBlockStateId(new Vec3(x, 63, z), registry.blocksByName.grass_block.defaultState);
    }
    world.setBlockStateId(new Vec3(0, 64, 0), registry.blocksByName.white_bed.defaultState);
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
      world.setBlockStateId(new Vec3(x, 66, z), registry.blocksByName.stone.defaultState);
    }
    const position = new Vec3(0.5, 64.5625, 0.5);
    const bot = {
      registry, world, version: '1.20.6',
      entity: { position, onGround: true, effects: {}, height: 1.8 },
      entities: {}, inventory: { items: () => [] },
      game: { minY: -64, height: 384 },
      blockAt: (p: Vec3) => world.getBlock(p),
      pathfinder: { bestHarvestTool: () => null },
    };
    const movements = new Movements(bot as never);
    movements.canDig = false;
    movements.scafoldingBlocks = [];
    const goal = new pathfinderPkg.goals.GoalNear(3, 64, 0, 1);
    const run = (start: { x: number; y: number; z: number }) => {
      const makeMove = Move as never as new (...args: number[]) => unknown;
      const makeAStar = AStar as never as new (...args: unknown[]) => { compute(): { status: string } };
      const astar = new makeAStar(new makeMove(start.x, start.y, start.z, 0, 0), movements,
        goal, 1500, 100, -1);
      let result = astar.compute();
      while (result.status === 'partial') result = astar.compute();
      return result.status;
    };
    expect(run({ x: 0, y: 65, z: 0 })).toBe('noPath');
    const corrected = partialBlockStartMove(bot as never, movements, position);
    expect(corrected?.y).toBe(64);
    expect(run(corrected!)).toBe('success');
  });

  it('床上低顶棚使上取整的起点无出口时，按可走的下层起算', () => {
    const { bot, movements } = fixture(false);
    const start = partialBlockStartMove(bot as never, movements as never, bot.entity.position);
    expect(start).toMatchObject({ x: 1, y: 64, z: 2 });

    const original = vi.fn(function* (_movements, _pos, _goal, options) {
      yield { options };
    });
    const finder = { getPathFromTo: original };
    installPartialBlockStartRepair({ ...bot, pathfinder: finder } as never);
    const result = [...finder.getPathFromTo(movements as never, bot.entity.position as never, {} as never, {})];
    expect(result[0]?.options.startMove).toMatchObject({ x: 1, y: 64, z: 2 });
    expect(original).toHaveBeenCalledTimes(1);
  });

  it('上层有出口、双脚落地或站在空气中时保持原版起点', () => {
    const { bot, movements } = fixture(true);
    expect(partialBlockStartMove(bot as never, movements as never, bot.entity.position)).toBeNull();
    bot.entity.onGround = false;
    expect(partialBlockStartMove(bot as never, movements as never, bot.entity.position)).toBeNull();
    bot.entity.onGround = true;
    bot.entity.position.y = 64;
    expect(partialBlockStartMove(bot as never, movements as never, bot.entity.position)).toBeNull();
  });
});
