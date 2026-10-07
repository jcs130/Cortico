import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { skillControl } from '../../../src/worlds/minecraft/skills-control.ts';
import { CONTROL_DURATION, CONTROL_KEYS, parseSteps, parseScoutSteps, type SkillCall } from '../../../src/worlds/minecraft/skills.ts';
import { SkillBlocked, type SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';
import { flightState, watchFlightAbilities } from '../../../src/worlds/minecraft/flight.ts';
import { goals, noteGoalOwner, releaseBody } from '../../../src/worlds/minecraft/travel.ts';
import { Executor, type TaskReport } from '../../../src/worlds/minecraft/executor.ts';
import { log, nextTaskId, waitUntil } from './executor-harness.ts';

const req = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = req('prismarine-registry')('1.20.6');
const Blocks = req('prismarine-block')(registry);
const { Physics, PlayerState } = req('prismarine-physics');
const cleanup: Array<() => void> = [];

function rig() {
  const cells = new Map<string, string | null>();
  const blockAt = (at: Vec3) => {
    const pos = at.floored();
    const name = cells.has(pos.toString()) ? cells.get(pos.toString()) : pos.y < 64 ? 'stone' : 'air';
    if (name === null) return null;
    const block = Blocks.fromStateId(registry.blocksByName[name!].defaultState, 0);
    block.position = pos;
    return block;
  };
  const world = { getBlock: blockAt };
  const client = Object.assign(new EventEmitter(), { write: vi.fn() });
  const keys = Object.fromEntries(CONTROL_KEYS.map(key => [key, false]));
  const positions: Vec3[] = [];
  const said: string[] = [];
  const bot = Object.assign(new EventEmitter(), {
    _client: client, registry, version: '1.20.6', world,
    game: { dimension: 'overworld' }, entities: {}, health: 20, food: 20,
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0,
      onGround: true, height: 1.8, effects: {}, attributes: {} },
    inventory: { slots: Array(46).fill(null), items: () => [] }, heldItem: null, currentWindow: null,
    controlState: keys, jumpTicks: 0, jumpQueued: false, physicsEnabled: true,
    physics: Physics(registry, world), blockAt,
    setControlState(key: string, value: boolean) { keys[key] = value; },
    clearControlStates() { for (const key of CONTROL_KEYS) keys[key] = false; },
    look: async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; },
    stopDigging() {}, chat(text: string) { said.push(text); },
    pathfinder: { goal: null, setGoal(goal: unknown) { this.goal = goal as null; bot.clearControlStates(); } },
  });
  const live = bot as unknown as Bot;
  const timer = setInterval(() => {
    if (bot.physicsEnabled) {
      const state = new PlayerState(bot, keys);
      bot.physics.simulatePlayer(state, world);
      state.apply(bot);
    }
    positions.push(bot.entity.position.clone());
  }, 50);
  cleanup.push(() => clearInterval(timer), watchFlightAbilities(live));
  let aborted = false;
  const ctx = { aborted: () => aborted, abortedBy: () => aborted ? '测试中断' : null,
    log, taskId: 1 } as SkillContext;
  return { bot: live, client, keys, positions, said, ctx,
    abort() { aborted = true; }, set: (at: Vec3, name: string | null) => cells.set(at.toString(), name) };
}

function call(part: Partial<Extract<SkillCall, { skill: 'control' }>> = {}): Extract<SkillCall, { skill: 'control' }> {
  return { skill: 'control', keys: ['forward'], mode: 'ground', durationMs: 500, ...part };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2025-01-01T00:00:00Z')); });
afterEach(() => { cleanup.splice(0).reverse().forEach(close => close()); vi.useRealTimers(); });

describe('bounded direct input', () => {
  it('validates keys, durations, angles and dependencies at admission', () => {
    expect(parseSteps([{ skill: 'control', keys: ['forward', 'forward', 'jump'], needs: [1] }])).toHaveProperty('error');
    expect(parseSteps([{ skill: 'look', at: [1, 65, 1] },
      { skill: 'control', keys: ['forward', 'forward', 'jump'], needs: [1], expect: { near: [2, 64, 2], within: 2 } }]))
      .toMatchObject({ steps: [{ skill: 'look' }, { keys: ['forward', 'jump'], mode: 'ground',
        durationMs: CONTROL_DURATION.defaultMs, needs: [1], expect: { near: [2, 64, 2] } }] });
    for (const invalid of [{ keys: ['forward', 'back'] }, { keys: ['left', 'right'] }, { keys: ['jump', 'sneak'] },
      { keys: ['attack'] }, { durationMs: CONTROL_DURATION.maxMs + 1 }, { durationMs: 50.5 },
      { durationMs: 0 }, { yawDeg: NaN }, { pitchDeg: 91 }, { mode: 'creative' },
      { mode: 'flight', keys: ['sprint'] }, { keys: [] }]) {
      expect(parseSteps([{ ...call(), ...invalid }])).toHaveProperty('error');
    }
    expect(parseScoutSteps([call()])).toHaveProperty('error');
  });

  it('walks and jumps using real ordinary physics and releases every key', async () => {
    const r = rig();
    const work = skillControl(r.bot, call({ keys: ['forward', 'jump'] }), r.ctx);
    await vi.advanceTimersByTimeAsync(700);
    const receipt = await work;
    expect(r.bot.entity.position.z).toBeLessThan(-0.2);
    expect(Math.max(...r.positions.map(p => p.y))).toBeGreaterThan(64.5);
    expect(Object.values(r.keys).every(value => !value)).toBe(true);
    expect(receipt).toContain('实际起点(0.50,64.00,0.50)');
    expect(receipt).toContain('位移');
    expect(receipt).toContain('到达目标须');
  });

  it('keeps server-provided leap velocity and lets physics collide with a wall', async () => {
    const r = rig();
    for (let x = -2; x <= 2; x++) for (let y = 64; y <= 70; y++) r.set(new Vec3(x, y, -1), 'stone');
    r.bot.entity.velocity.y = 0.6;
    const work = skillControl(r.bot, call({ durationMs: 1000 }), r.ctx);
    await vi.advanceTimersByTimeAsync(1100);
    await work;
    expect(Math.max(...r.positions.map(p => p.y))).toBeGreaterThan(65);
    expect(r.bot.entity.position.z).toBeGreaterThanOrEqual(0.29);
    expect(r.bot.physicsEnabled).toBe(true);
  });

  it('turns left and up relative to the current view before walking', async () => {
    const r = rig();
    const work = skillControl(r.bot, call({ yawDeg: 90, pitchDeg: 30 }), r.ctx);
    await vi.advanceTimersByTimeAsync(600);
    await work;
    expect(r.bot.entity.position.x).toBeLessThan(-0.2);
    expect(r.bot.entity.position.z).toBeCloseTo(0.5);
    expect(r.bot.entity.pitch).toBeCloseTo(Math.PI / 6);
  });

  it('does not clear a new body owner when the cancelled input drains', async () => {
    const r = rig();
    const outcome = skillControl(r.bot, call({ durationMs: 2000 }), r.ctx).catch(error => error);
    await vi.advanceTimersByTimeAsync(75);
    noteGoalOwner(r.bot, new goals.GoalNear(2, 64, 2, 1), 'escape', '逃离危险');
    expect(r.keys.forward).toBe(false);
    r.bot.setControlState('forward', true);
    r.bot.setControlState('jump', true);
    r.bot.entity.position = new Vec3(100, 64, 100);
    await vi.advanceTimersByTimeAsync(100);
    const error = await outcome;
    expect(error.message).toContain('escape 接管身体');
    expect(error.scene.join('\n')).not.toContain('100.00');
    expect(r.keys.forward).toBe(true);
    expect(r.keys.jump).toBe(true);
  });

  it.each(['death', 'respawn', 'end', 'forcedMove'] as const)('releases input on %s and reports observed partial movement', async event => {
    const r = rig();
    const outcome = skillControl(r.bot, call({ durationMs: 2000 }), r.ctx).catch(error => error as SkillBlocked);
    await vi.advanceTimersByTimeAsync(125);
    (r.bot as unknown as EventEmitter).emit(event, 'test');
    expect(r.keys.forward).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    const error = await outcome;
    expect(error).toBeInstanceOf(SkillBlocked);
    if (!(error instanceof SkillBlocked)) throw new Error('Expected interruption evidence');
    expect(error.source).toBe('server');
    expect(error.scene.join('\n')).toContain('实际起点');
    expect(r.bot.listenerCount('death')).toBe(0);
  });

  it('releases input when the task abort flag changes', async () => {
    const r = rig();
    const outcome = skillControl(r.bot, call({ durationMs: 2000 }), r.ctx).catch(error => error);
    await vi.advanceTimersByTimeAsync(75);
    r.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect((await outcome).message).toContain('测试中断');
    expect(r.keys.forward).toBe(false);
  });

  it('waits for real flight permission and moves diagonally without enabling ordinary flight physics', async () => {
    const r = rig();
    setTimeout(() => r.client.emit('abilities', { flags: 4, flyingSpeed: 0.05 }), 100);
    const work = skillControl(r.bot, call({ mode: 'flight', keys: ['left', 'jump'] }), r.ctx);
    await vi.advanceTimersByTimeAsync(900);
    const receipt = await work;
    expect(r.bot.entity.position.x).toBeLessThan(0);
    expect(r.bot.entity.position.y).toBeGreaterThan(64.5);
    expect(r.bot.entity.position.z).toBeCloseTo(0.5);
    expect(flightState(r.bot).flying).toBe(true);
    expect(receipt).toContain('flying:true');
    await expect(skillControl(r.bot, call(), r.ctx)).rejects.toThrow('先 land');
  });

  it('refuses to forge flight permission', async () => {
    const r = rig();
    const outcome = skillControl(r.bot, call({ mode: 'flight' }), r.ctx).catch(error => error);
    await vi.advanceTimersByTimeAsync(2200);
    expect((await outcome).message).toContain('尚未授予');
    expect(r.client.write.mock.calls).toHaveLength(0);
    expect(r.bot.entity.position).toEqual(new Vec3(0.5, 64, 0.5));
  });

  it.each(['stone', null] as const)('stops direct flight before entering %s terrain', async obstruction => {
    const r = rig();
    r.client.emit('abilities', { flags: 4, flyingSpeed: 0.05 });
    r.set(new Vec3(0, 64, -1), obstruction);
    const outcome = skillControl(r.bot, call({ mode: 'flight', durationMs: 2000 }), r.ctx).catch(error => error);
    await vi.advanceTimersByTimeAsync(2200);
    const error = await outcome;
    expect(error).toBeInstanceOf(SkillBlocked);
    expect(error.message).toContain(obstruction ? '碰撞' : '未加载');
    expect(r.bot.entity.position.z).toBeGreaterThanOrEqual(0.3);
    expect(error.scene.join('\n')).toContain('实际起点');
  });

  it('stops when flight permission is revoked and restores ordinary physics', async () => {
    const r = rig();
    r.client.emit('abilities', { flags: 4, flyingSpeed: 0.05 });
    const outcome = skillControl(r.bot, call({ mode: 'flight', keys: ['jump'], durationMs: 2000 }), r.ctx).catch(error => error);
    await vi.advanceTimersByTimeAsync(175);
    const y = r.bot.entity.position.y;
    r.client.emit('abilities', { flags: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect((await outcome).message).toContain('收回');
    expect(r.bot.physicsEnabled).toBe(true);
    expect(r.bot.entity.position.y).toBeLessThan(y + 0.16);
  });

  it('does not continue the old direction after a server teleport', async () => {
    const r = rig();
    r.client.emit('abilities', { flags: 4, flyingSpeed: 0.05 });
    const outcome = skillControl(r.bot, call({ mode: 'flight', durationMs: 2000 }), r.ctx).catch(error => error);
    await vi.advanceTimersByTimeAsync(175);
    r.bot.entity.position = new Vec3(10.5, 64, 10.5);
    r.bot.emit('forcedMove');
    await vi.advanceTimersByTimeAsync(150);
    expect((await outcome).message).toContain('修正了位置');
    expect(r.bot.entity.position.x).toBeCloseTo(10.5);
    expect(r.bot.entity.position.z).toBeCloseTo(10.5);
  });

  it('chains inputs in one task and verifies the actual destination before its dependent chat', async () => {
    const r = rig();
    const reports: TaskReport[] = [];
    const exec = new Executor({ getBot: () => r.bot, report: report => reports.push(report), log, nextId: nextTaskId() });
    exec.submit([call({ durationMs: 300 }), call({ durationMs: 300, keys: ['back'] }),
      { ...call({ keys: [], yawDeg: 30, durationMs: 50 }), expect: { near: [0, 64, 0], within: 1 }, needs: [2] },
      { skill: 'chat', text: 'done', needs: [3] }]);
    await waitUntil(() => reports.some(report => report.kind === 'done'));
    expect(r.said).toEqual(['done']);
    expect(reports.at(-1)?.text).toContain('实际起点');
    expect(Object.values(r.keys).every(value => !value)).toBe(true);
    exec.shutdown();
  });

  it('does not replay an interrupted timed input when a suspended task resumes', async () => {
    const r = rig();
    const reports: TaskReport[] = [];
    const exec = new Executor({ getBot: () => r.bot, report: report => reports.push(report), log, nextId: nextTaskId() });
    exec.submit([call({ durationMs: 2000 }), { skill: 'chat', text: 'tail', needs: [] }]);
    await waitUntil(() => r.keys.forward);
    await vi.advanceTimersByTimeAsync(150);
    exec.suspend('战斗接管');
    expect(r.keys.forward).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    exec.resume();
    await waitUntil(() => reports.some(report => report.kind === 'blocked'));
    expect(r.said).toEqual(['tail']);
    expect(reports.at(-1)?.text).toContain('重复移动');
    expect(Math.min(...r.positions.map(p => p.z))).toBeGreaterThan(-1);
    exec.shutdown();
    releaseBody(r.bot, '测试结束');
  });

  it('blocks dependent actions when keys finish but the declared destination is not reached', async () => {
    const r = rig();
    const reports: TaskReport[] = [];
    const exec = new Executor({ getBot: () => r.bot, report: report => reports.push(report), log, nextId: nextTaskId() });
    exec.submit([{ ...call({ durationMs: 50 }), expect: { near: [0, 64, -10], within: 1 } },
      { skill: 'chat', text: '到达', needs: [1] }]);
    await waitUntil(() => reports.some(report => report.kind === 'blocked'));
    expect(r.said).toEqual([]);
    expect(reports.at(-1)?.text).toContain('实际起点');
    expect(r.bot.entity.position.z).toBeGreaterThan(-1);
    exec.shutdown();
  });
});
