import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { Movements } from 'mineflayer-pathfinder';
import { installPathfinderPerf } from '../../../src/worlds/minecraft/pathfinder-perf.ts';
import { movementTouchesHazard } from '../../../src/worlds/minecraft/hazard-geometry.ts';
import { hazardTouch } from '../../../src/worlds/minecraft/terrain.ts';

const req = createRequire(createRequire(import.meta.url).resolve('mineflayer/package.json'));
const registry = req('prismarine-registry')('1.20.6');
const World = req('prismarine-world')(registry);
const Chunk = req('prismarine-chunk')(registry);
const { Vec3 } = req('vec3');

function fixture() {
  const world = new World(null).sync;
  for (let x = -1; x <= 0; x++) {
    for (let z = -1; z <= 0; z++) world.setColumn(x, z, new Chunk({ minY: -64, worldHeight: 384 }));
  }
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) {
      world.setBlockStateId(new Vec3(x, 63, z), registry.blocksByName.stone.defaultState);
    }
  }
  const bot = {
    registry, version: '1.20.6', world,
    blockAt: (point: unknown) => world.getBlock(point),
    entity: { position: new Vec3(0.5, 64, 0.5), effects: {}, metadata: [0] }, entities: {},
    inventory: { items: () => [] }, game: { minY: -64, height: 384 },
    pathfinder: { bestHarvestTool: () => null },
  };
  const put = (x: number, y: number, z: number, name: string) =>
    world.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].defaultState);
  installPathfinderPerf();
  const movements = new Movements(bot as never);
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  const neighbors = (x = 0, y = 64, z = 0): Array<{ x: number; y: number; z: number }> =>
    movements.getNeighbors({ x, y, z, remainingBlocks: 0 } as never);
  return { world, bot, put, neighbors };
}

describe('pathfinder burning contact volume', () => {
  it.each(['lava', 'fire', 'soul_fire'])('rejects a diagonal corner cutting through %s while keeping the clear cardinal exit', (name) => {
    const { put, neighbors } = fixture();
    put(1, 64, 0, name);
    const moves = neighbors();
    expect(moves.some((move) => move.x === 1 && move.y === 64 && move.z === 1)).toBe(false);
    expect(moves.some((move) => move.x === 0 && move.y === 64 && move.z === 1)).toBe(true);
  });

  it('uses the same contact box as the reflex even when the reported center distance exceeds one block', () => {
    const { bot, put } = fixture();
    put(-3, 64, 1, 'lava');
    const point = new Vec3(-2.02959, 64, 0.61422);
    bot.entity.position = point;
    expect(hazardTouch(bot).touching?.name).toBe('lava');
    expect(hazardTouch(bot).touching?.distance).toBeGreaterThan(1);
    expect(movementTouchesHazard(point, point,
      (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name)).toBe(true);
  });

  it('rejects a fall through a loaded lava cell even when the landing body is clear', () => {
    const read = (x: number, y: number, z: number) => x === 0 && y === 65 && z === 0 ? 'lava' : 'air';
    expect(movementTouchesHazard({ x: 0.5, y: 67, z: 0.5 }, { x: 0.5, y: 63, z: 0.5 }, read)).toBe(true);
  });

  it('keeps a complete solid bridge over lava traversable', () => {
    const { put, neighbors } = fixture();
    put(1, 62, 0, 'lava');
    expect(neighbors().some((move) => move.x === 1 && move.y === 64 && move.z === 0)).toBe(true);
  });

  it.each(['lava', 'fire'])('can leave an existing %s contact toward clear terrain without planning through a new hazard', (name) => {
    const { put, neighbors } = fixture();
    put(0, 64, 0, name);
    put(1, 64, 0, name);
    const moves = neighbors();
    expect(moves.some((move) => move.x === -1 && move.y === 64 && move.z === 0)).toBe(true);
    expect(moves.some((move) => move.x === 1 && move.y === 64 && move.z === 0)).toBe(false);
  });

  it('does not turn unknown terrain or ordinary water into a burning hazard', () => {
    const from = { x: 0.5, y: 64, z: 0.5 };
    const to = { x: 1.5, y: 64, z: 1.5 };
    expect(movementTouchesHazard(from, to, () => undefined)).toBe(false);
    expect(movementTouchesHazard(from, to, () => 'water')).toBe(false);
  });

  it('rejects a magma landing while retaining an exit from the original scorching floor', () => {
    const { put, neighbors } = fixture();
    put(1, 63, 0, 'magma_block');
    expect(neighbors().some((move) => move.x === 1 && move.y === 64 && move.z === 0)).toBe(false);
    put(0, 63, 0, 'magma_block');
    expect(neighbors().some((move) => move.x === -1 && move.y === 64 && move.z === 0)).toBe(true);
  });

  it('reads only the local swept box for a flat diagonal edge', () => {
    const read: Array<[number, number, number]> = [];
    movementTouchesHazard({ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 1.5 },
      (x, y, z) => { read.push([x, y, z]); return 'air'; });
    expect(read).toHaveLength(12);
    expect(read.every(([x, y, z]) => x >= 0 && x <= 1 && y >= 63 && y <= 65 && z >= 0 && z <= 1)).toBe(true);
  });
});
