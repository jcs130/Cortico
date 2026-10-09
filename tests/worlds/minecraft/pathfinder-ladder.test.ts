/** Real path search and player physics must climb ladder rungs and exit onto a platform. */
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

const req = createRequire(createRequire(import.meta.url).resolve('mineflayer/package.json'));
const registry = req('prismarine-registry')('1.20.6');
const Block = req('prismarine-block')(registry);
const { Physics, PlayerState } = req('prismarine-physics');
const { pathfinder, goals } = pathfinderPkg;

const directions = {
  north: [0, 1], south: [0, -1], east: [-1, 0], west: [1, 0],
} as const;

function rig(facing: keyof typeof directions) {
  const [wallX, wallZ] = directions[facing];
  const ladder = registry.blocksByName.ladder;
  let ladderState = ladder.defaultState;
  for (let state = ladder.minStateId; state <= ladder.maxStateId; state++) {
    const properties = Block.fromStateId(state, 0).getProperties();
    if (properties.facing === facing && properties.waterlogged === false) { ladderState = state; break; }
  }
  const blockAt = (position: Vec3) => {
    const p = position.floored();
    const state = p.y < 64 || (p.x === wallX && p.z === wallZ && p.y <= 69)
      ? registry.blocksByName.stone.defaultState
      : p.x === 0 && p.z === 0 && p.y >= 64 && p.y <= 69 ? ladderState : 0;
    const block = Block.fromStateId(state, 0);
    block.position = p;
    return block;
  };
  const bot = Object.assign(new EventEmitter(), {
    registry, version: '1.20.6',
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0),
      onGround: true, yaw: 0, pitch: 0, height: 1.8, effects: {}, attributes: {},
      isInWater: false, isInLava: false, isInWeb: false, elytraFlying: false,
      isCollidedHorizontally: false, isCollidedVertically: false },
    entities: {}, game: { minY: -64, height: 384 },
    inventory: { slots: Array(46).fill(null), items: () => [] },
    controlState: { forward: false, back: false, left: false, right: false, jump: false, sneak: false, sprint: false },
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    blockAt, world: { getBlock: blockAt },
    physics: Physics(registry, { getBlock: blockAt }),
    setControlState(key: string, value: boolean) { (this.controlState as Record<string, boolean>)[key] = value; },
    clearControlStates() { for (const key of Object.keys(this.controlState)) this.setControlState(key, false); },
    async look(yaw: number, pitch: number) { this.entity.yaw = yaw; this.entity.pitch = pitch; },
    async lookAt(at: Vec3) { const d = at.minus(this.entity.position); await this.look(Math.atan2(-d.x, -d.z), 0); },
    stopDigging() {},
  });
  pathfinder(bot as never);
  const finder = (bot as unknown as { pathfinder: import('mineflayer-pathfinder').Pathfinder }).pathfinder;
  finder.movements.canDig = false;
  finder.movements.scafoldingBlocks = [];
  finder.movements.allowParkour = false;
  finder.movements.allowSprinting = false;
  const target = new goals.GoalBlock(wallX, 70, wallZ);
  let reachedAt: Vec3 | undefined;
  bot.on('goal_reached', () => { reachedAt = bot.entity.position.clone(); });
  const tick = () => {
    bot.emit('physicsTick');
    bot.physics.simulatePlayer(new PlayerState(bot, bot.controlState), bot.world).apply(bot);
  };
  return { bot, finder, target, tick, reachedAt: () => reachedAt };
}

describe('ladder path execution', () => {
  it.each(Object.keys(directions) as Array<keyof typeof directions>)('climbs a %s-facing ladder and stands on its platform', (facing) => {
    const r = rig(facing);
    const preview = r.finder.getPathTo(r.finder.movements, r.target);
    expect(preview.status).toBe('success');
    expect(preview.path.every(point => point.toBreak.length === 0 && point.toPlace.length === 0)).toBe(true);
    r.finder.setGoal(r.target);
    for (let ticks = 0; ticks < 400 && !r.reachedAt(); ticks++) r.tick();
    expect(r.reachedAt(), `actual ${r.bot.entity.position}`).toBeDefined();
    expect(r.bot.entity.position.y).toBeGreaterThanOrEqual(70);
    for (let ticks = 0; ticks < 20; ticks++) r.tick();
    expect(r.bot.entity.position.y).toBeCloseTo(70, 3);
    expect(r.bot.entity.onGround).toBe(true);
    expect(Object.values(r.bot.controlState).some(Boolean)).toBe(false);
  });

  it('does not announce an upper rung reached while the player is below it', () => {
    const r = rig('north');
    r.bot.entity.position.y = 66.2;
    r.bot.entity.onGround = false;
    r.finder.setGoal(new goals.GoalBlock(0, 67, 0));
    r.tick();
    expect(r.reachedAt()).toBeUndefined();
  });
});
