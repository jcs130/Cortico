import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { describeSkill, parseSteps, Executor, type TaskReport } from '../../../src/worlds/minecraft/executor.ts';
import { parseScoutSteps } from '../../../src/worlds/minecraft/skills.ts';
import { parseFlightPlan, previewFlightPlan } from '../../../src/worlds/minecraft/flight-preview.ts';
import { MinecraftWorld } from '../../../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS } from '../../../src/worlds/minecraft/config.ts';
import { log, nextTaskId } from './executor-harness.ts';
import { flightFlags, flightState, flyToLanding, flyToPosition, landFlight, MAX_FLIGHT_DISTANCE,
  previewFlight, setFlightExpiry, stopFlight, watchFlightAbilities } from '../../../src/worlds/minecraft/flight.ts';

const require = createRequire(import.meta.url);
const dependency = createRequire(require.resolve('mineflayer'));
const registry = require('minecraft-data')('1.20.6') as Bot['registry'];
const Blocks = dependency('prismarine-block')('1.20.6') as typeof Block;
const releases: Array<() => void> = [];

function block(name: string, properties?: Record<string, string>) {
  const info = registry.blocksByName[name];
  if (properties) {
    for (let state = info.minStateId; state <= info.maxStateId; state++) {
      const candidate = Blocks.fromStateId(state, 0);
      if (Object.entries(properties).every(([key, value]) => String(candidate.getProperties()[key]) === value)) return candidate;
    }
    throw new Error(`No block state for ${name}`);
  }
  return Blocks.fromStateId(info.defaultState, 0);
}

function flightBot() {
  const client = Object.assign(new EventEmitter(), { write: vi.fn() });
  const world = new Map<string, Block | null>();
  const positions: Vec3[] = [];
  let pos = new Vec3(0.5, 64, 0.5);
  const entity = { velocity: new Vec3(0, 0, 0), onGround: true } as Bot['entity'];
  Object.defineProperty(entity, 'position', { get: () => pos, set: (next: Vec3) => { pos = next; positions.push(next.clone()); } });
  const bot = Object.assign(new EventEmitter(), {
    _client: client, entity, registry,
    physics: { gravity: 0.08 }, physicsEnabled: true,
    clearControlStates: vi.fn(),
    blockAt: (at: Vec3) => world.has(at.floored().toString()) ? world.get(at.floored().toString())! : block(at.y < 64 ? 'stone' : 'air'),
  }) as unknown as Bot & { _client: typeof client };
  releases.push(watchFlightAbilities(bot));
  return { bot, client, positions, set: (at: Vec3, value: Block | null) => world.set(at.toString(), value) };
}

async function finish<T>(work: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return work;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2025-01-01T00:00:00Z')); });
afterEach(() => { releases.splice(0).forEach(release => release()); vi.useRealTimers(); });

describe('server-granted flight movement', () => {
  it('keeps the reason for a completed hover ending until the next real takeoff', async () => {
    const { bot, client } = flightBot();
    client.emit('abilities', { flags: 4 });
    await finish(flyToPosition(bot, { x: 0.5, y: 66, z: 0.5 }, () => false));
    expect(flightState(bot)).toMatchObject({ controlActive: true, flying: true });
    client.emit('abilities', { flags: 0 });
    expect(flightState(bot)).toMatchObject({ allowed: false, controlActive: false, flying: false,
      lastStop: { reason: '服务端已收回飞行权限', atMs: Date.now() } });
    expect(bot.physicsEnabled).toBe(true);
    client.emit('abilities', { flags: 4 });
    expect(flightState(bot).lastStop?.reason).toBe('服务端已收回飞行权限');
    await finish(flyToPosition(bot, { x: 0.5, y: 67, z: 0.5 }, () => false));
    expect(flightState(bot)).toMatchObject({ controlActive: true, lastStop: undefined });
    bot.emit('forcedMove');
    expect(flightState(bot)).toMatchObject({ controlActive: false,
      lastStop: { reason: '服务端修正了位置，已停止飞行移动' } });
  });
  it('projects every relative leg and rejects an over-budget whole route before casting', () => {
    const { bot, client, positions } = flightBot();
    client.emit('abilities', { flags: 0, flyingSpeed: 0.035 });
    const parsed = parseFlightPlan({ points: Array.from({ length: 5 }, () => ({ at: ['~0', '~11', '~0'], land: false })), budgetMs: 21_000 });
    if ('error' in parsed) throw new Error(parsed.error);
    const result = previewFlightPlan(bot, parsed.steps, parsed.budgetMs);
    expect(result).toMatchObject({ complete: true, budgetMs: 21_000, budgetSource: 'caller', fitsBudget: false, endsOnSupport: false });
    expect(result.segments.map(segment => segment.at[1])).toEqual([75, 86, 97, 108, 119]);
    expect(result.segments.at(-1)?.from).toEqual(result.segments.at(-2)?.at);
    expect(result.estimatedDurationMs).toBe(result.segments.reduce((sum, segment) => sum + segment.estimatedDurationMs, 0));
    expect(result.estimatedDurationMs).toBeGreaterThan(21_000);
    expect(positions).toHaveLength(0);
    expect(client.write.mock.calls).toHaveLength(0);
    expect(flightState(bot).allowed).toBe(false);
  });

  it('checks a later leg collision and leaves the uninspected tail unknown', () => {
    const { bot, set, client, positions } = flightBot();
    set(new Vec3(4, 68, 0), block('stone'));
    const parsed = parseFlightPlan({ points: [
      { at: [0, 68, 0], land: false }, { at: [4, 68, 0], land: false }, { at: [4, 64, 0] },
    ] });
    if ('error' in parsed) throw new Error(parsed.error);
    const result = previewFlightPlan(bot, parsed.steps);
    expect(result).toMatchObject({ complete: false, blockedStep: 2, estimatedDurationMs: null, fitsBudget: null, endsOnSupport: null });
    expect(result.reason).toContain('stone @ (4,68,0)');
    expect(result.segments).toHaveLength(1);
    expect(positions).toHaveLength(0);
    expect(client.write.mock.calls).toHaveLength(0);
  });

  it('includes the declared descent and preserves the real server deadline', async () => {
    const { bot, client } = flightBot();
    client.emit('abilities', { flags: 4, flyingSpeed: 0.05 });
    const deadline = Date.now() + 8_000;
    setFlightExpiry(bot, deadline);
    const parsed = parseFlightPlan({ points: [
      { at: [0, 68, 0], land: false }, { at: [4, 68, 0], land: false }, { at: [4, 64, 0] },
    ], budgetMs: 60_000 });
    if ('error' in parsed) throw new Error(parsed.error);
    const result = previewFlightPlan(bot, parsed.steps, parsed.budgetMs);
    expect(result).toMatchObject({ complete: true, budgetMs: 8_000, budgetSource: 'caller-and-server-expiry', fitsBudget: true, endsOnSupport: true });
    expect(result.estimatedDurationMs).toBeGreaterThan(result.segments[0].estimatedDurationMs + result.segments[1].estimatedDurationMs);
    expect(flightState(bot).expiresAtMs).toBe(deadline);
    const start = Date.now();
    for (const step of result.segments) {
      const move = flyToPosition(bot, { x: step.at[0], y: step.at[1], z: step.at[2] }, () => false, { land: step.land });
      await vi.advanceTimersByTimeAsync(step.estimatedDurationMs);
      await move;
    }
    expect(Date.now() - start).toBeLessThanOrEqual(result.estimatedDurationMs!);
    expect(bot.entity.position).toEqual(new Vec3(4.5, 64, 0.5));
  });

  it('does not infer a duration from a route or from permission without a deadline', () => {
    const { bot, client } = flightBot();
    client.emit('abilities', { flags: 4 });
    const parsed = parseFlightPlan({ points: [{ at: [0, 68, 0], land: false }] });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(previewFlightPlan(bot, parsed.steps)).toMatchObject({ complete: true, budgetMs: null, budgetSource: null, fitsBudget: null, endsOnSupport: false });
  });

  it('validates flight plan input before reading or acting on the world', () => {
    expect(parseFlightPlan({ points: [{ at: [0, 68, 0], land: 'false' }] })).toHaveProperty('error');
    expect(parseFlightPlan({ points: [{ at: [0, 68, 0] }], budgetMs: 0 })).toHaveProperty('error');
    expect(parseFlightPlan({ points: [] })).toHaveProperty('error');
    expect(parseFlightPlan({ points: [{ at: [0, 68, 0], text: '/test grant-flight' }] })).toHaveProperty('error');
  });

  it('reports whole-route failure through the read-only World tool without enqueueing or sending packets', async () => {
    const { bot, client, positions } = flightBot();
    const world = new MinecraftWorld({ cfg: structuredClone({ ...MINECRAFT_DEFAULTS, enabled: true }) });
    const submitted: unknown[] = [];
    Object.assign(world, { bridge: { bot }, executor: { submit: (steps: unknown) => submitted.push(steps) } });
    const tool = world.tools().find(tool => tool.name === 'mc_flight_plan')!;
    const result = await tool.handler({ points: [{ at: [0, 68, 0], land: false }, { at: [30, 68, 0], land: false }] }, {} as never);
    expect(result).toMatchObject({ failed: true });
    expect(JSON.stringify(result)).toContain('blockedStep');
    expect(JSON.stringify(result)).toContain('飞行单段最多');
    expect(tool.tags).toEqual(['read']);
    expect(submitted).toHaveLength(0);
    expect(positions).toHaveLength(0);
    expect(client.write.mock.calls).toHaveLength(0);
  });

  it('previews a loaded airborne route without permission, packets or movement', () => {
    const { bot, client, positions } = flightBot();
    const preview = previewFlight(bot, { x: 0.5, y: 68, z: 0.5 });
    expect(preview).toMatchObject({ from: [0.5, 64, 0.5], at: [0.5, 68, 0.5],
      distance: 4, land: false, allowed: false, speedSource: 'default', remainingMs: null, timeEnough: null });
    expect(preview.estimatedDurationMs).toBeGreaterThan(0);
    expect(positions).toHaveLength(0);
    expect(client.write.mock.calls).toHaveLength(0);
    expect(bot.physicsEnabled).toBe(true);
  });

  it('detects a roof and a missing landing surface before spending permission', () => {
    const { bot, set, client, positions } = flightBot();
    const target = { x: 0.5, y: 68, z: 0.5 };
    expect(() => previewFlight(bot, target, { land: true })).toThrow('没有已加载的安全落脚方块');
    set(new Vec3(0, 66, 0), block('stone'));
    expect(() => previewFlight(bot, target)).toThrow('飞行路径有碰撞方块 stone @ (0,66,0)');
    expect(positions).toHaveLength(0);
    expect(client.write.mock.calls).toHaveLength(0);
  });

  it('reports observed speed and the actual remaining deadline without renewing it', () => {
    const { bot, client } = flightBot();
    client.emit('abilities', { flags: 4, flyingSpeed: 0.1 });
    setFlightExpiry(bot, Date.now() + 600);
    const preview = previewFlight(bot, { x: 0.5, y: 68, z: 0.5 });
    expect(preview).toMatchObject({ speedSource: 'server', allowed: true, remainingMs: 600, timeEnough: false });
    expect(preview.estimatedDurationMs).toBeGreaterThan(600);
    expect(client.write.mock.calls).toHaveLength(0);
  });

  it('revalidates geometry changed after a successful preview', async () => {
    const { bot, client, set, positions } = flightBot();
    const target = { x: 0.5, y: 68, z: 0.5 };
    previewFlight(bot, target);
    set(new Vec3(0, 66, 0), block('stone'));
    client.emit('abilities', { flags: 4 });
    await expect(flyToPosition(bot, target, () => false)).rejects.toThrow('飞行路径有碰撞方块');
    expect(positions).toHaveLength(0);
  });

  it('executes flight scout steps as read-only through the real task executor', async () => {
    const { bot, client, positions } = flightBot();
    Object.assign(bot, { inventory: { items: () => [] }, pathfinder: { stop() {}, setGoal() {} } });
    const reports: TaskReport[] = [];
    const exec = new Executor({ getBot: () => bot, log, nextId: nextTaskId(), precheck: () => false,
      report: report => reports.push(report) });
    releases.push(() => exec.shutdown());
    const parsed = parseScoutSteps([{ skill: 'flight', at: [0, 68, 0], land: false }]);
    if (!('steps' in parsed)) throw new Error(parsed.error);
    expect(parsed.steps).toEqual([{ skill: 'flight', at: [0, 68, 0], land: false, dryRun: true }]);
    expect(describeSkill(parsed.steps[0])).toContain('试算飞行');
    exec.submit(parsed.steps);
    await vi.advanceTimersByTimeAsync(500);
    expect(reports).toHaveLength(1);
    expect(JSON.stringify(reports[0])).toContain('estimatedDurationMs');
    expect(JSON.stringify(reports[0])).toContain('未移动、未施法');
    expect(positions).toHaveLength(0);
    expect(client.write.mock.calls).toHaveLength(0);
    expect(reports[0].text).toContain('试算结束（没有执行移动、施法、放置或挖掘）');
    expect(reports[0].text).toContain('真实起点 (0.5, 64, 0.5)');
  });

  it('reports independent preview origins even when a later flight needs an earlier route trial', async () => {
    const { bot, client, positions, set } = flightBot();
    Object.assign(bot, { inventory: { items: () => [] }, pathfinder: { stop() {}, setGoal() {} } });
    for (let x = 0; x <= 5; x++) set(new Vec3(x, 66, 0), block('stone'));
    const reports: TaskReport[] = [];
    const exec = new Executor({ getBot: () => bot, log, nextId: nextTaskId(), precheck: () => false,
      probeRoutes: () => [{ profile: 'walk', status: 'complete', steps: 3, place: 0, breaks: 0, endDist: 0 }],
      report: report => reports.push(report) });
    releases.push(() => exec.shutdown());
    for (const x of [3, 5]) {
      const parsed = parseScoutSteps([{ skill: 'goto', at: [x, 64, 0] },
        { skill: 'flight', at: [x, 68, 0], land: false, needs: [1] }]);
      if (!('steps' in parsed)) throw new Error(parsed.error);
      exec.submit(parsed.steps);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(reports).toHaveLength(2);
    for (const report of reports) {
      expect(report.kind).toBe('blocked');
      expect(report.text).toContain('飞行路径有碰撞方块');
      expect(report.text.match(/真实起点 \(0\.5, 64, 0\.5\)/g)).toHaveLength(2);
      expect(report.text).toContain('不继承前步假定位置或材料');
      expect(report.text).toContain('已返回的试算:');
      expect(report.text).not.toContain('做成的:');
    }
    expect(positions).toHaveLength(0);
    expect(client.write.mock.calls).toHaveLength(0);
  });

  it('keeps corrected and repeated previews out of physical no-progress feedback', async () => {
    const { bot, client, positions } = flightBot();
    Object.assign(bot, { inventory: { items: () => [] }, pathfinder: { stop() {}, setGoal() {} } });
    const reports: TaskReport[] = [];
    const exec = new Executor({ getBot: () => bot, log, nextId: nextTaskId(), precheck: () => false,
      report: report => reports.push(report) });
    releases.push(() => exec.shutdown());
    for (let attempt = 0; attempt < 5; attempt++) {
      const parsed = parseScoutSteps([{ skill: 'flight', at: [0, 68, 0], land: attempt === 0 }]);
      if (!('steps' in parsed)) throw new Error(parsed.error);
      exec.submit(parsed.steps);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(reports).toHaveLength(5);
    expect(reports[0].kind).toBe('blocked');
    expect(reports[0].text).toContain('没有已加载的安全落脚方块');
    expect(reports.slice(1).map(report => report.kind)).toEqual(['done', 'done', 'done', 'done']);
    expect(reports.slice(1).every(report => report.text.includes('"allowed":false'))).toBe(true);
    expect(reports.map(report => report.repeatFailure)).toEqual(Array(5).fill(undefined));
    expect(positions).toHaveLength(0);
    expect(client.write.mock.calls).toHaveLength(0);
    expect(flightState(bot).allowed).toBe(false);
  });

  it.each([true, false])('continues a queued cast, flight segments and landing only when permission is granted: %s', async (granted) => {
    const { bot, client, positions } = flightBot();
    const said: string[] = [];
    Object.assign(bot, { inventory: { items: () => [] }, pathfinder: { stop() {}, setGoal() {} },
      chat: (text: string) => {
        said.push(text);
        if (text === '/test grant-flight' && granted) setTimeout(() => {
          client.emit('abilities', { flags: 4, flyingSpeed: 0.05 });
          setFlightExpiry(bot, Date.now() + 21_000);
        }, 50);
      },
    });
    const reports: TaskReport[] = [];
    const exec = new Executor({ getBot: () => bot, log, nextId: nextTaskId(), precheck: () => false,
      report: report => reports.push(report) });
    releases.push(() => exec.shutdown());
    exec.submit([
      { skill: 'chat', text: '/test grant-flight' },
      { skill: 'flight', at: [0, 68, 0], land: false, needs: [1] },
      { skill: 'flight', at: [4, 68, 0], land: false, needs: [2] },
      { skill: 'land', needs: [3] },
      { skill: 'chat', text: '已经落地', needs: [4] },
    ]);
    await vi.advanceTimersByTimeAsync(100);
    expect(positions.length > 0).toBe(granted);
    expect(said).toEqual(['/test grant-flight']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports).toHaveLength(1);
    if (granted) {
      expect(said).toEqual(['/test grant-flight', '已经落地']);
      expect(bot.entity.position).toEqual(new Vec3(4.5, 64, 0.5));
      expect(Math.max(...positions.map(pos => pos.y))).toBe(68);
    } else {
      expect(said).toEqual(['/test grant-flight']);
      expect(positions).toHaveLength(0);
      expect(JSON.stringify(reports[0])).toContain('尚未授予飞行能力');
      expect(reports[0].kind).toBe('blocked');
    }
    expect(bot.physicsEnabled).toBe(true);
    expect(flightState(bot).flying).toBe(false);
  });

  it('keeps the existing integer-cell landing action compatible', () => {
    const parsed = parseSteps([{ skill: 'flight', at: [2, 65, 0] }]);
    expect('steps' in parsed).toBe(true);
    if ('steps' in parsed) expect(describeSkill(parsed.steps[0])).toContain('飞到安全落脚点');
  });

  it('distinguishes permission from flight and keeps permission until a server revocation', async () => {
    const { bot, client } = flightBot();
    client.emit('abilities', { flags: 4 });
    expect(flightState(bot)).toMatchObject({ allowed: true, flying: false, serverFlying: false });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(flightFlags(bot)).toBe(4);
    client.emit('abilities', { flags: 0 });
    expect(flightState(bot)).toMatchObject({ allowed: false, flying: false });
  });

  it('clears a previous connection permission on respawn and end', () => {
    const { bot, client } = flightBot();
    client.emit('abilities', { flags: 6 });
    (bot as unknown as EventEmitter).emit('respawn');
    expect(flightFlags(bot)).toBe(0);
    client.emit('abilities', { flags: 4 });
    bot.emit('end', 'test');
    expect(flightFlags(bot)).toBe(0);
  });

  it('flies over a ledge and restores ordinary physics only when it lands', async () => {
    const { bot, client, set, positions } = flightBot();
    set(new Vec3(2, 64, 0), block('stone'));
    client.emit('abilities', { flags: 4 });
    const result = await finish(flyToLanding(bot, { x: 2, y: 65, z: 0 }, () => false));
    expect(result).toContain('实际在 (2.5,65.0,0.5)');
    expect(Math.max(...positions.map(pos => pos.y))).toBe(65);
    expect(bot.entity.position.y).toBe(65);
    expect(bot.physicsEnabled).toBe(true);
    expect(bot.physics.gravity).toBe(0.08);
    expect(flightState(bot)).toMatchObject({ allowed: true, flying: false });
  });

  it('can take off, hover for building, move to another view, descend and land without a scaffold', async () => {
    const { bot, client } = flightBot();
    client.emit('abilities', { flags: 4 });
    await finish(flyToPosition(bot, { x: 0.5, y: 66, z: 0.5 }, () => false));
    expect(flightState(bot)).toMatchObject({ allowed: true, flying: true, serverFlying: false });
    expect(bot.physicsEnabled).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(bot.entity.position.y).toBe(66);
    await finish(flyToPosition(bot, { x: 2.5, y: 66, z: 0.5 }, () => false));
    await finish(flyToPosition(bot, { x: 2.5, y: 65, z: 0.5 }, () => false));
    const result = await finish(landFlight(bot, () => false));
    expect(result).toContain('落地');
    expect(bot.entity.position).toEqual(new Vec3(2.5, 64, 0.5));
    expect(flightState(bot).flying).toBe(false);
    expect(bot.physicsEnabled).toBe(true);
    expect(bot.physics.gravity).toBe(0.08);
    expect(client.write.mock.calls.map(([name]) => name)).toEqual(['abilities', 'abilities']);
  });

  it('keeps Mineflayer position packets moving while local gravity simulation is suspended', async () => {
    const { bot, client } = flightBot();
    const now = vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    const flightRegistry = dependency('prismarine-registry')('1.20.6');
    Object.assign(bot, { registry: flightRegistry, isAlive: true,
      supportFeature: (name: string) => flightRegistry.supportFeature(name) });
    Object.assign(bot.entity, { id: 1, yaw: 0, pitch: 0, eyeHeight: 1.62 });
    dependency('./lib/plugins/physics')(bot, { physicsEnabled: true });
    bot.emit('login');
    client.emit('position', { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0, flags: {}, teleportId: 1 });
    const positions: Array<Record<string, unknown>> = [];
    client.write.mockImplementation((name: string, packet: Record<string, unknown>) => {
      if (name === 'position' || name === 'position_look') positions.push({ ...packet });
    });
    client.emit('abilities', { flags: 4 });
    const work = flyToPosition(bot, { x: 2.5, y: 66, z: 0.5 }, () => false);
    await vi.advanceTimersByTimeAsync(2000);
    await work;
    expect(positions.length).toBeGreaterThan(1);
    expect(positions[0].x).toBeLessThan(2.5);
    expect(positions.at(-1)).toMatchObject({ x: 2.5, y: 66, z: 0.5, onGround: false });
    expect(bot.physicsEnabled).toBe(false);
    bot.emit('end', 'test');
    now.mockRestore();
  });

  it('uses actual slab shapes and a direct route under a low ceiling', async () => {
    const { bot, client, set, positions } = flightBot();
    for (let x = 0; x <= 2; x++) set(new Vec3(x, 66, 0), block('stone_slab', { type: 'top' }));
    set(new Vec3(2, 64, 0), block('stone_slab', { type: 'bottom' }));
    client.emit('abilities', { flags: 4 });
    await finish(flyToPosition(bot, { x: 2.5, y: 64.5, z: 0.5 }, () => false, { land: true }));
    expect(bot.entity.position.y).toBe(64.5);
    expect(Math.max(...positions.map(pos => pos.y))).toBe(64.5);
    expect(bot.physicsEnabled).toBe(true);
  });

  it('does not fly through fence shapes extending above their own block', async () => {
    const { bot, client, set } = flightBot();
    set(new Vec3(2, 64, 0), block('oak_fence'));
    client.emit('abilities', { flags: 4 });
    await expect(flyToPosition(bot, { x: 2.5, y: 65.25, z: 0.5 }, () => false)).rejects.toThrow('目标空间有碰撞');
    expect(client.write.mock.calls).toHaveLength(0);
  });

  it('rejects unknown collision or landing data before sending movement', async () => {
    const { bot, client, set } = flightBot();
    client.emit('abilities', { flags: 4 });
    set(new Vec3(2, 63, 0), null);
    await expect(flyToLanding(bot, { x: 2, y: 64, z: 0 }, () => false)).rejects.toThrow('没有已加载的安全落脚方块');
    set(new Vec3(2, 65, 0), null);
    await expect(flyToPosition(bot, { x: 2.5, y: 65, z: 0.5 }, () => false)).rejects.toThrow('未加载区域');
    expect(client.write.mock.calls).toHaveLength(0);
  });

  it('states the effective landing mode when an airborne target has no floor', async () => {
    const { bot, client } = flightBot();
    client.emit('abilities', { flags: 4 });
    await expect(flyToPosition(bot, { x: 0.5, y: 66, z: 0.5 }, () => false, { land: true }))
      .rejects.toThrow('当前 land:true 要求落地；空中悬停用 land:false');
    expect(client.write.mock.calls).toHaveLength(0);
    await finish(flyToPosition(bot, { x: 0.5, y: 66, z: 0.5 }, () => false, { land: false }));
    expect(bot.entity.position.y).toBe(66);
    expect(flightState(bot).flying).toBe(true);
  });

  it.each([
    ['dirt', '碰撞方块 dirt'],
    ['water', '危险方块或液体 water'],
    [null, '未加载区域'],
  ] as const)('identifies %s in the ascent path without moving or claiming a different cause', async (name, cause) => {
    const { bot, client, set, positions } = flightBot();
    const obstruction = new Vec3(0, 66, 0);
    set(obstruction, name === null ? null : block(name));
    client.emit('abilities', { flags: 4 });
    const failure = await flyToPosition(bot, { x: 0.5, y: 70, z: 0.5 }, () => false)
      .catch(error => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(`飞行路径有${cause} @ (${obstruction.x},${obstruction.y},${obstruction.z})`);
    expect(positions).toHaveLength(0);
    expect(client.write.mock.calls).toHaveLength(0);
  });

  it('reports the exact three-dimensional distance when horizontal offset exceeds a vertical segment limit', async () => {
    const { bot, client } = flightBot();
    const target = new Vec3(1, bot.entity.position.y + MAX_FLIGHT_DISTANCE, 1);
    const distance = bot.entity.position.distanceTo(target);
    expect(distance).toBeGreaterThan(MAX_FLIGHT_DISTANCE);
    expect(distance.toFixed(1)).toBe(MAX_FLIGHT_DISTANCE.toFixed(1));
    await expect(flyToPosition(bot, target, () => false))
      .rejects.toThrow(`三维直线距离 ${distance} 格`);
    expect(client.write.mock.calls).toHaveLength(0);
  });

  it('distinguishes a movement time limit from a collision when the server grants a low flying speed', async () => {
    const { bot, client, positions } = flightBot();
    client.emit('abilities', { flags: 4, flyingSpeed: 0.001 });
    await expect(flyToPosition(bot, { x: 2.5, y: 64, z: 0.5 }, () => false))
      .rejects.toThrow('按服务端飞行速度，候选路径均超过');
    expect(positions).toHaveLength(0);
    expect(client.write.mock.calls).toHaveLength(0);
  });

  it('waits for a real permission packet instead of treating a sent spell as success', async () => {
    const { bot, client } = flightBot();
    const result = expect(flyToPosition(bot, { x: 0.5, y: 65, z: 0.5 }, () => false)).rejects.toThrow('尚未授予飞行能力');
    await vi.runAllTimersAsync();
    await result;
    expect(client.write.mock.calls).toHaveLength(0);
    expect(bot.physicsEnabled).toBe(true);
  });

  it('rechecks the actual start after waiting for permission and preserves a moved connection position', async () => {
    const { bot, client } = flightBot();
    const result = expect(flyToPosition(bot, { x: 2.5, y: 65, z: 0.5 }, () => false)).rejects.toThrow('位置已变化');
    await vi.advanceTimersByTimeAsync(100);
    bot.entity.position = new Vec3(20.5, 64, 0.5);
    client.emit('abilities', { flags: 4 });
    await vi.runAllTimersAsync();
    await result;
    expect(bot.entity.position).toEqual(new Vec3(20.5, 64, 0.5));
    expect(client.write.mock.calls).toHaveLength(0);
  });

  it('stops on a real permission revocation and never overwrites the subsequent fall position', async () => {
    const { bot, client } = flightBot();
    client.emit('abilities', { flags: 4 });
    const result = expect(flyToPosition(bot, { x: 3.5, y: 65, z: 0.5 }, () => false)).rejects.toThrow('收回飞行权限');
    await vi.advanceTimersByTimeAsync(100);
    client.emit('abilities', { flags: 0 });
    bot.entity.position = new Vec3(0.8, 64.1, 0.5);
    await vi.runAllTimersAsync();
    await result;
    expect(bot.entity.position).toEqual(new Vec3(0.8, 64.1, 0.5));
    expect(bot.physicsEnabled).toBe(true);
    expect(bot.physics.gravity).toBe(0.08);
  });

  it('preserves an authoritative server correction and releases the old flight control', async () => {
    const { bot, client } = flightBot();
    client.emit('abilities', { flags: 4 });
    const result = expect(flyToPosition(bot, { x: 3.5, y: 65, z: 0.5 }, () => false)).rejects.toThrow('服务端修正了位置');
    await vi.advanceTimersByTimeAsync(100);
    bot.entity.position = new Vec3(10.5, 64, 10.5);
    bot.emit('forcedMove');
    await vi.runAllTimersAsync();
    await result;
    expect(bot.entity.position).toEqual(new Vec3(10.5, 64, 10.5));
    expect(flightState(bot).flying).toBe(false);
    expect(bot.physicsEnabled).toBe(true);
  });

  it('checks newly changed collision shapes during flight and holds before the obstruction', async () => {
    const { bot, client, set } = flightBot();
    client.emit('abilities', { flags: 4 });
    const result = expect(flyToPosition(bot, { x: 3.5, y: 64, z: 0.5 }, () => false))
      .rejects.toThrow('途中空间发生变化：有碰撞方块 stone @ (1,64,0)');
    await vi.advanceTimersByTimeAsync(10);
    set(new Vec3(1, 64, 0), block('stone'));
    await vi.runAllTimersAsync();
    await result;
    expect(bot.entity.position.x + 0.3).toBeLessThanOrEqual(1);
    expect(flightState(bot).flying).toBe(true);
    await finish(landFlight(bot, () => false));
    expect(bot.physicsEnabled).toBe(true);
  });

  it('keeps a canceled airborne task suspended until an explicit landing', async () => {
    const { bot, client } = flightBot();
    client.emit('abilities', { flags: 4 });
    let aborted = false;
    const result = expect(flyToPosition(bot, { x: 0.5, y: 67, z: 0.5 }, () => aborted)).rejects.toThrow('保持当前位置悬停');
    await vi.advanceTimersByTimeAsync(100);
    aborted = true;
    await vi.runAllTimersAsync();
    await result;
    expect(flightState(bot).flying).toBe(true);
    await finish(landFlight(bot, () => false));
    expect(bot.entity.position.y).toBe(64);
  });

  it('uses an explicit adapter deadline and restores physics when that deadline expires', async () => {
    const { bot, client } = flightBot();
    client.emit('abilities', { flags: 4 });
    const work = flyToPosition(bot, { x: 0.5, y: 65, z: 0.5 }, () => false);
    await vi.runAllTimersAsync();
    await work;
    setFlightExpiry(bot, Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(flightState(bot)).toMatchObject({ allowed: false, flying: false });
    expect(bot.physicsEnabled).toBe(true);
    expect(bot.physics.gravity).toBe(0.08);
  });

  it('does not begin a move that exceeds the known flight window', async () => {
    const { bot, client } = flightBot();
    client.emit('abilities', { flags: 4 });
    setFlightExpiry(bot, Date.now() + 400);
    await expect(flyToPosition(bot, { x: 3.5, y: 65, z: 0.5 }, () => false)).rejects.toThrow('剩余时间不足');
    expect(bot.physicsEnabled).toBe(true);
    expect(client.write.mock.calls).toHaveLength(0);
  });

  it('serializes movements on one connection without interrupting the first flight', async () => {
    const { bot, client } = flightBot();
    client.emit('abilities', { flags: 4 });
    const first = flyToPosition(bot, { x: 3.5, y: 65, z: 0.5 }, () => false);
    await expect(flyToPosition(bot, { x: 1.5, y: 65, z: 0.5 }, () => false)).rejects.toThrow('尚未结束');
    await finish(first);
    expect(bot.entity.position).toEqual(new Vec3(3.5, 65, 0.5));
    stopFlight(bot);
  });

  it('bounds a single flight move and keeps control unchanged on invalid targets', async () => {
    const { bot, client } = flightBot();
    client.emit('abilities', { flags: 4 });
    await expect(flyToPosition(bot, { x: MAX_FLIGHT_DISTANCE + 1.5, y: 64, z: 0.5 }, () => false)).rejects.toThrow('飞行单段最多');
    await expect(flyToPosition(bot, { x: NaN, y: 64, z: 0.5 }, () => false)).rejects.toThrow('有限数字');
    expect(bot.physicsEnabled).toBe(true);
    expect(client.write.mock.calls).toHaveLength(0);
  });

  it('keeps hover if there is no loaded safe surface for a vertical landing', async () => {
    const { bot, client, set } = flightBot();
    client.emit('abilities', { flags: 4 });
    await finish(flyToPosition(bot, { x: 0.5, y: 66, z: 0.5 }, () => false));
    set(new Vec3(0, 63, 0), block('water'));
    await expect(landFlight(bot, () => false)).rejects.toThrow('没有已加载的安全落点');
    expect(bot.physicsEnabled).toBe(false);
    expect(flightState(bot).flying).toBe(true);
  });

  it('treats an already supported ground position as landed without asking for flight permission', async () => {
    const { bot, client } = flightBot();
    expect(await landFlight(bot, () => false)).toContain('已在安全地面');
    expect(bot.physicsEnabled).toBe(true);
    expect(client.write.mock.calls).toHaveLength(0);
  });

  it('ends server-reported flying on the ground even before this module has moved the player', async () => {
    const { bot, client } = flightBot();
    client.emit('abilities', { flags: 6 });
    expect(flightState(bot).flying).toBe(true);
    await landFlight(bot, () => false);
    expect(flightState(bot)).toMatchObject({ allowed: true, flying: false, serverFlying: true });
    expect(bot.physicsEnabled).toBe(true);
  });
});
