import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import pathfinderPkg, { pathfinder } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { nullLogger } from '../../../src/core/util.ts';
import { Bridge } from '../../../src/worlds/minecraft/bridge.ts';
import { installPathfinderPerf } from '../../../src/worlds/minecraft/pathfinder-perf.ts';
import { renderRouteMenu } from '../../../src/worlds/minecraft/travel.ts';

const req = createRequire(createRequire(import.meta.url).resolve('mineflayer/package.json'));
const registry = req('prismarine-registry')('1.20.6');
const World = req('prismarine-world')(registry);
const Chunk = req('prismarine-chunk')(registry);
const Block = req('prismarine-block')(registry);
const { goals } = pathfinderPkg;
installPathfinderPerf();

function rig(open: boolean | null) {
  const world = new World(null).sync;
  for (let cx = -1; cx <= 0; cx++) for (let cz = -1; cz <= 0; cz++) {
    world.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }));
  }
  for (let x = -3; x <= 3; x++) for (let z = -4; z <= 4; z++) {
    world.setBlockStateId(new Vec3(x, 63, z), registry.blocksByName.bedrock.defaultState);
    if (open !== null) for (let y = 64; y <= 66; y++) {
      const shell = x !== 0 || z === -4 || z === 4 || y === 66;
      world.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[shell ? 'bedrock' : 'air'].defaultState);
    }
  }
  if (open !== null) {
    const door = registry.blocksByName.oak_door;
    for (const half of ['lower', 'upper']) {
      let state: number | undefined;
      for (let s = door.minStateId; s <= door.maxStateId; s++) {
        const props = Block.fromStateId(s, 0).getProperties();
        if (props.half === half && props.open === open && props.facing === 'north' && props.hinge === 'left') {
          state = s;
          break;
        }
      }
      if (state === undefined) throw new Error('door state unavailable');
      world.setBlockStateId(new Vec3(0, half === 'lower' ? 64 : 65, 0), state);
    }
  }
  const items = [{ type: registry.itemsByName.cobblestone.id, name: 'cobblestone', count: 64,
    metadata: 0, nbt: null }];
  const bot = Object.assign(new EventEmitter(), {
    registry, version: '1.20.6', world, blockAt: (p: Vec3) => world.getBlock(p),
    inventory: { items: () => items }, entities: {},
    entity: { position: new Vec3(0.5, 64, -2.5), effects: {}, height: 1.8, onGround: true },
    game: { dimension: 'minecraft:overworld', minY: -64, height: 384 },
  }) as unknown as Bot;
  pathfinder(bot);
  const bridge = new Bridge({ host: 'localhost', port: 25565, username: 'tester', version: '1.20.6',
    viewerPort: 0, log: nullLogger(), scaffoldBlocks: () => ['cobblestone'],
    onSpawn: () => {}, onDisconnect: () => {} });
  (bridge as unknown as { _bot: Bot })._bot = bot;
  return { bot, bridge };
}

describe('bridge route preview work counts', () => {
  it('reports opening a closed door as interaction without inventing scaffold consumption', () => {
    const { bot, bridge } = rig(false);
    const at = { x: 0, y: 64, z: 3 };
    const routes = bridge.probeRoutes(at, new goals.GoalBlock(at.x, at.y, at.z));
    expect(routes).toHaveLength(3);
    for (const route of routes!) {
      expect(route).toMatchObject({ status: 'complete', place: 0, breaks: 0, interact: 1 });
    }
    const text = renderRouteMenu(routes!, at);
    expect(text).toContain('交互 1 次');
    expect(text).not.toMatch(/垫\s+\d+\s+块/);
    expect(bot.entity.position).toEqual(new Vec3(0.5, 64, -2.5));
    expect(bot.blockAt(new Vec3(0, 64, 0))!.getProperties().open).toBe(false);
  });

  it('requires no interaction for an already open door', () => {
    const { bridge } = rig(true);
    const routes = bridge.probeRoutes({ x: 0, y: 64, z: 3 }, new goals.GoalBlock(0, 64, 3));
    for (const route of routes!) expect(route).toMatchObject({ status: 'complete', place: 0, interact: 0 });
    expect(renderRouteMenu(routes!, { x: 0, y: 64, z: 3 })).not.toContain('交互');
  });

  it('still reports real scaffold blocks for a vertical tower route', () => {
    const { bridge } = rig(null);
    const routes = bridge.probeRoutes({ x: 0, y: 67, z: -3 }, new goals.GoalBlock(0, 67, -3));
    expect(routes![0]).toMatchObject({ profile: 'style', status: 'complete', interact: 0 });
    expect(routes![0].place).toBeGreaterThan(0);
    expect(renderRouteMenu([routes![0]], { x: 0, y: 67, z: -3 })).toContain('垫');
  });
});
