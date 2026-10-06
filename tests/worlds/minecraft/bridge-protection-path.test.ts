import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import mineflayer from 'mineflayer';
import pathfinderPkg, { Movements, pathfinder } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nullLogger } from '../../../src/core/util.ts';
import { Bridge } from '../../../src/worlds/minecraft/bridge.ts';
import { installPathfinderPerf } from '../../../src/worlds/minecraft/pathfinder-perf.ts';

const req = createRequire(createRequire(import.meta.url).resolve('mineflayer/package.json'));
const registry = req('prismarine-registry')('1.20.6');
const World = req('prismarine-world')(registry);
const Chunk = req('prismarine-chunk')(registry);
const { Physics, PlayerState } = req('prismarine-physics');
const { goals } = pathfinderPkg;
installPathfinderPerf();

/** A sealed corridor has an open approach followed by two blocks to mine. */
function rig() {
  const world = new World(null).sync;
  for (let cx = -1; cx <= 2; cx++) {
    for (let cz = -1; cz <= 0; cz++) world.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }));
  }
  for (let x = -1; x <= 40; x++) {
    for (let y = 63; y <= 66; y++) {
      for (let z = -1; z <= 1; z++) {
        const shell = y === 63 || y === 66 || z !== 0 || x === -1 || x === 40;
        world.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[shell ? 'bedrock' : 'air'].defaultState);
      }
    }
  }
  for (let y = 64; y <= 65; y++) world.setBlockStateId(new Vec3(25, y, 0), registry.blocksByName.netherrack.defaultState);
  const sent: string[] = [];
  const digs: Vec3[] = [];
  const bot = Object.assign(new EventEmitter(), {
    registry, version: '1.20.6', world, _client: new EventEmitter(),
    game: { dimension: 'the_nether', minY: -64, height: 384 },
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0),
      height: 1.8, yaw: -Math.PI / 2, pitch: 0, onGround: true, effects: {} },
    entities: {},
    inventory: { slots: [], items: () => [{ type: registry.itemsByName.iron_pickaxe.id,
      name: 'iron_pickaxe', count: 1, nbt: null, metadata: 0 }] },
    controlState: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
    jumpTicks: 0, jumpQueued: false,
    physics: Physics(registry, { getBlock: (p: Vec3) => world.getBlock(p) }),
    blockAt: (p: Vec3) => world.getBlock(p),
    chat: (s: string) => { sent.push(s); },
    setControlState(name: string, value: boolean) { (this.controlState as Record<string, boolean>)[name] = value; },
    clearControlStates() { for (const key of Object.keys(this.controlState)) this.setControlState(key, false); },
    look(yaw: number, pitch: number) { this.entity.yaw = yaw; this.entity.pitch = pitch; },
    lookAt: () => {}, quit: () => {}, stopDigging: () => {}, equip: async () => {},
    dig: async (block: { position: Vec3 }) => {
      digs.push(block.position);
      world.setBlockStateId(block.position, registry.blocksByName.air.defaultState);
      bot.emit('blockUpdate', block, world.getBlock(block.position));
      bot.emit('diggingCompleted', block);
    },
    loadPlugin(plugin: unknown) { if (plugin === pathfinder) pathfinder(this as unknown as mineflayer.Bot); },
  });
  const create = vi.spyOn(mineflayer, 'createBot').mockReturnValue(bot as unknown as mineflayer.Bot);
  const bridge = new Bridge({ host: 'localhost', port: 25565, username: 'tester', version: '1.20.6',
    viewerPort: 0, log: nullLogger(), agentFriendProtect: true, onSpawn: () => {}, onDisconnect: () => {} });
  bridge.start();
  const live = bot as unknown as mineflayer.Bot;
  const movements = new Movements(live);
  (bridge as unknown as { applyTuning(bot: mineflayer.Bot, movements: Movements): void }).applyTuning(live, movements);
  movements.canDig = true;
  movements.scafoldingBlocks = [];
  movements.allowSprinting = false;
  live.pathfinder.setMovements(movements);
  (bridge as unknown as { liveMovements: Movements }).liveMovements = movements;
  const target = new goals.GoalNear(35, 64, 0, 1);
  const updates: Array<{ status: string; path: Array<{ x: number; toBreak: unknown[] }> }> = [];
  bot.on('path_update', (result) => updates.push(result));
  const reply = (status: 'deny' | 'allow_likely', y = 64) => bot._client.emit('custom_payload', {
    channel: 'mcagent:protection', data: Buffer.from(JSON.stringify({ action: 'break',
      dimension: 'the_nether', x: 25, y, z: 0, status, reason: 'test' })),
  });
  const tick = async () => {
    bot.emit('physicsTick');
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const walkTick = async () => {
    await tick();
    const state = new PlayerState(bot, bot.controlState);
    bot.physics.simulatePlayer(state, { getBlock: (p: Vec3) => world.getBlock(p) });
    state.apply(bot);
  };
  return { bot, bridge, live, movements, target, updates, sent, digs, reply, tick, walkTick,
    async close() { await bridge.stop(); create.mockRestore(); } };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('bridge protection along a distant route', () => {
  it('walks the existing prefix without failing the whole route before a permission query is in range', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const r = rig();
    try {
      const planned = r.live.pathfinder.getPathTo(r.movements, r.target);
      expect(planned.status).toBe('success');
      expect(planned.path.flatMap((p) => p.toBreak)).toHaveLength(2);
      let completed = false;
      const outcome = r.live.pathfinder.goto(r.target).then(() => { completed = true; return 'done'; }, (e: Error) => e.name);
      await r.walkTick();
      await vi.advanceTimersByTimeAsync(100);
      await r.walkTick();
      expect(r.movements.canDig).toBe(true);
      expect(r.updates.every((p) => p.status === 'success')).toBe(true);
      expect(r.updates[0].path.every((p) => p.toBreak.length === 0)).toBe(true);
      expect(completed).toBe(false);
      expect(r.sent).toEqual([]);
      for (let i = 0; i < 100 && r.sent.length === 0; i++) await r.walkTick();
      expect(r.bot.entity.position.x).toBeGreaterThan(10);
      expect(r.sent).toEqual(['/mycli protect break 25 65 0']);
      expect(r.digs).toEqual([]);
      r.reply('deny', 65);
      await vi.advanceTimersByTimeAsync(100);
      await r.tick();
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toBe('NoPath');
      expect(r.digs).toEqual([]);
    } finally { await r.close(); }
  });

  it('keeps a cancelled approach from issuing a later permission request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const r = rig();
    try {
      r.live.pathfinder.setGoal(r.target);
      await r.walkTick();
      r.live.pathfinder.setGoal(null);
      r.bot.entity.position = new Vec3(20.5, 64, 0.5);
      await r.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(r.sent).toEqual([]);
      expect(r.digs).toEqual([]);
      expect(r.live.pathfinder.goal).toBeNull();
    } finally { await r.close(); }
  });

  it('continues through permitted blocks and completes only at the original destination', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const r = rig();
    try {
      let completed = false;
      const outcome = r.live.pathfinder.goto(r.target).then(() => { completed = true; return 'done'; }, (e: Error) => e.name);
      let answered = 0;
      for (let i = 0; i < 300 && !completed; i++) {
        await r.walkTick();
        while (answered < r.sent.length) {
          const y = Number(r.sent[answered++].split(' ')[4]);
          r.reply('allow_likely', y);
        }
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(completed).toBe(true);
      expect(await outcome).toBe('done');
      expect(r.target.isEnd(r.bot.entity.position.floored() as unknown as Parameters<typeof r.target.isEnd>[0])).toBe(true);
      expect(r.digs.map((p) => [p.x, p.y, p.z])).toEqual([[25, 65, 0], [25, 64, 0]]);
      expect(r.sent).toEqual(['/mycli protect break 25 65 0', '/mycli protect break 25 64 0']);
    } finally { await r.close(); }
  });
});
