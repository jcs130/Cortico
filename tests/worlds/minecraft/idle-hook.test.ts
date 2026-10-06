import { EventEmitter } from 'node:events';
import type { Bot, ControlState } from 'mineflayer';
import { Vec3 } from 'vec3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolOutcome } from '../../../src/core/types.ts';
import { MinecraftWorld } from '../../../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS, type MinecraftConfigSection } from '../../../src/worlds/minecraft/config.ts';
import { CombatSession } from '../../../src/worlds/minecraft/combat.ts';
import { parseScoutSteps, parseSteps, Reflexes, type QueueStatus, type SkillCall, type TaskReport } from '../../../src/worlds/minecraft/executor.ts';
import { executeIdleAction } from '../../../src/worlds/minecraft/idle-actions.ts';
import { IdleBehaviorController, type IdleBehaviorEvent, type IdleBehaviorScene } from '../../../src/worlds/minecraft/idle-behavior.ts';
import { FakeHost } from '../../helpers/fake-host.ts';
import { combatBot, makeExecutorOn, waitUntil } from './executor-harness.ts';

/** A narrow inspection surface: production start/stop, admission and scene guards remain real. */
interface IdleInspection {
  idleBehavior: IdleBehaviorController | null;
  idleSceneCache: IdleBehaviorScene | null;
  idleScene(): IdleBehaviorScene | null;
  idleGeneration(): string;
  interruptIdle(reason: string): void;
  canIdle(): boolean;
  tryArrivalIdle(): void;
  onTaskReport(report: TaskReport): void;
  enqueueTool(name: 'mc_do' | 'mc_scout', args: Record<string, unknown>, parse: typeof parseSteps): string | ToolOutcome;
  autoEatTick(bot: Bot): void;
  hookBotEvents(bot: Bot): void;
  worldTimer: ReturnType<typeof setInterval> | null;
  connectionGeneration: number;
  escapeHoldUntil: number;
  idleQuietUntil: number;
  idleQuietReason: string | null;
  shuttingDown: boolean;
}

function inspection(world: MinecraftWorld): IdleInspection {
  return world as unknown as IdleInspection;
}

function fakeBot() {
  const controls = new Map<ControlState, boolean>();
  const stacks: Array<{ name: string; count: number }> = [];
  let hazard = false;
  const inventory = Object.assign(new EventEmitter(), {
    slots: Array.from({ length: 46 }, () => null), items: () => stacks,
  });
  const bot = Object.assign(new EventEmitter(), {
    username: 'IdleTest', health: 20, food: 20, oxygenLevel: 20,
    isSleeping: false, usingHeldItem: false, currentWindow: null as { id: number } | null,
    heldItem: null,
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0),
      yaw: 0, pitch: 0, onGround: true, metadata: [0] },
    game: { dimension: 'overworld', gameMode: 'survival' },
    time: { timeOfDay: 1000 }, rainState: 0,
    registry: { foodsByName: { bread: { foodPoints: 5, saturation: 6 } }, language: {} },
    entities: {}, players: {}, inventory, _client: new EventEmitter(),
    world: { raycast: () => null },
    pathfinder: { isMoving: (): boolean => false },
    findBlocks: () => [],
    blockAt: (p: Vec3) => ({ name: hazard && p.y >= 64 ? 'lava' : p.y < 64 ? 'stone' : 'air',
      position: p.floored(), boundingBox: p.y < 64 ? 'block' : 'empty',
      shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [], getProperties: () => ({}) }),
    getControlState: (control: ControlState) => controls.get(control) ?? false,
    setControlState: (control: ControlState, value: boolean) => { controls.set(control, value); },
    chat: vi.fn((_text: string) => {}), swingArm: vi.fn(),
    look: vi.fn(async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; }),
  });
  return { bot, asBot: bot as unknown as Bot, stacks, controls,
    setHazard: (value: boolean) => { hazard = value; } };
}

function rig(enabled = true) {
  const cfg = structuredClone(MINECRAFT_DEFAULTS) as MinecraftConfigSection;
  cfg.enabled = true;
  cfg.idle = { ...cfg.idle, enabled, minIdleMs: 0, minIntervalMs: 12_000, maxIntervalMs: 12_000 };
  cfg.client.enabled = false;
  cfg.player.enabled = false;
  const world = new MinecraftWorld({ cfg });
  const host = new FakeHost();
  const body = fakeBot();
  const queue: QueueStatus = { running: null, waiting: [], hold: null };
  const executor = {
    status: () => queue,
    hasPendingEat: () => false,
    repeatSuccessHold: () => null,
    submit: vi.fn((_steps: SkillCall[], _mode?: unknown, _wrote?: unknown,
      admitted?: (value: boolean, retryAfterMs?: number, completed?: boolean) => void,
      beforeEnqueue?: () => void) => {
      beforeEnqueue?.();
      admitted?.(true);
      return '任务#1 已受理';
    }),
    submitDetailed: vi.fn((_steps: SkillCall[], _mode?: unknown) => ({ accepted: true, receipt: '任务#2 已受理' })),
    shutdown: vi.fn(),
  };
  const bridge = { bot: body.asBot, connected: true, invSynced: true, stop: vi.fn(async () => {}) };
  const combat = { active: false, stop: vi.fn() };
  const reflexes = { envActive: false, stop: vi.fn() };
  Object.assign(world, { host, bridge, executor, combat, reflexes });
  const events: IdleBehaviorEvent[] = [];
  return { world, privateWorld: inspection(world), cfg, host, queue, executor, bridge, combat, reflexes, events, ...body };
}

/** Use the real action cleanup, so these tests observe body release rather than only cancel calls. */
function runIdle(r: ReturnType<typeof rig>, actionId: 'crouch' | 'short_walk' = 'crouch') {
  if (actionId === 'short_walk') r.cfg.idle.allowMovement = true;
  let signal: AbortSignal | undefined;
  let scene: IdleBehaviorScene | undefined;
  const controller = new IdleBehaviorController({
    config: () => r.cfg.idle, random: () => 0,
    host: {
      scene: () => {
        const current = r.privateWorld.idleScene();
        return current ? { ...current, candidates: current.candidates.filter(candidate => candidate.id === actionId) } : null;
      },
      execute: async (id, value, actionSignal) => {
        signal = actionSignal;
        scene = value;
        await executeIdleAction(r.asBot, id, value.state, actionSignal, {
          available: () => r.privateWorld.canIdle() && r.privateWorld.idleGeneration() === value.generation,
          inventoryPreview: (open) => r.bot.emit('viewer_inventory_preview', { open }),
        });
      },
      record: (event) => r.events.push(event),
    },
  });
  r.privateWorld.idleBehavior = controller;
  controller.tick();
  expect(controller.active).toBe(true);
  expect(signal).toBeDefined();
  return { controller, signal: signal!, scene: scene! };
}

function arrivalIdle(r: ReturnType<typeof rig>) {
  r.cfg.idle.afterArrival = true;
  r.cfg.idle.minIdleMs = 60_000;
  const controller = new IdleBehaviorController({
    config: () => r.cfg.idle, random: () => 0,
    host: {
      scene: () => r.privateWorld.idleScene(),
      execute: (id, scene, signal) => executeIdleAction(r.asBot, id, scene.state, signal, {
        available: () => r.privateWorld.canIdle() && r.privateWorld.idleGeneration() === scene.generation,
        inventoryPreview: (open) => r.bot.emit('viewer_inventory_preview', { open }),
      }),
      record: (event) => r.events.push(event),
    },
  });
  r.privateWorld.idleBehavior = controller;
  return controller;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Minecraft World 待机动作接线', () => {
  it('执行器成功回执以实际末步骤区分导航移交与随后交互', async () => {
    const bot = combatBot({});
    const { exec, reports } = makeExecutorOn(bot);
    try {
      exec.submit([{ skill: 'goto', at: [5, 64, 0] }]);
      await waitUntil(() => reports.length === 1);
      expect(reports[0]).toMatchObject({ kind: 'done', lastSkill: 'goto' });
      expect(bot.entity.position.x).toBe(5);
      exec.submit([{ skill: 'goto', at: [8, 64, 0] }, { skill: 'chat', text: '到了，先跟同伴说句话' }]);
      await waitUntil(() => reports.length === 2);
      expect(reports[1]).toMatchObject({ kind: 'done', lastSkill: 'chat' });
    } finally { exec.shutdown(); }
  });

  it('执行器受阻的导航不声称已完成末步骤', async () => {
    const bot = combatBot({ goto: async () => { throw Error('No path to the goal!'); } });
    const { exec, reports } = makeExecutorOn(bot);
    try {
      exec.submit([{ skill: 'goto', at: [10, 64, 0] }]);
      await waitUntil(() => reports.length === 1);
      expect(reports[0].kind).toBe('blocked');
      expect(reports[0].lastSkill).toBeUndefined();
    } finally { exec.shutdown(); }
  });

  it('成功导航清空队列且静稳后开始观察，新任务同步取消镜头动作', async () => {
    const r = rig();
    const controller = arrivalIdle(r);
    r.privateWorld.interruptIdle('task');
    r.privateWorld.onTaskReport({ kind: 'done', taskId: 1, lastSkill: 'goto', text: '到达目标位置' });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.active).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    r.privateWorld.tryArrivalIdle();
    expect(controller.active).toBe(true);
    expect(r.events.find(event => event.event === 'action-started')).toMatchObject({ actionId: 'look_left' });
    expect(r.bot.getControlState('forward')).toBe(false);
    expect(r.bot.currentWindow).toBeNull();
    r.privateWorld.interruptIdle('task');
    expect(controller.active).toBe(false);
    const yaw = r.bot.entity.yaw;
    await vi.advanceTimersByTimeAsync(500);
    expect(r.bot.entity.yaw).toBe(yaw);
    expect(r.events.at(-1)).toMatchObject({ event: 'cancelled', reason: 'task' });
  });

  it('到达残余速度消退且持续静稳后移交观察；过期的移交不会迟到启动', async () => {
    const r = rig();
    const controller = arrivalIdle(r);
    r.bot.entity.velocity.x = 0.1;
    r.privateWorld.onTaskReport({ kind: 'done', taskId: 1, lastSkill: 'goto', text: '到达目标' });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.active).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    r.bot.entity.velocity.x = 0;
    r.privateWorld.tryArrivalIdle();
    expect(controller.active).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    r.privateWorld.tryArrivalIdle();
    expect(controller.active).toBe(true);
    r.privateWorld.interruptIdle('task');
    r.bot.entity.velocity.x = 0.1;
    r.privateWorld.onTaskReport({ kind: 'done', taskId: 2, lastSkill: 'goto', text: '到达另一目标' });
    await vi.advanceTimersByTimeAsync(1_501);
    r.bot.entity.velocity.x = 0;
    r.privateWorld.tryArrivalIdle();
    expect(controller.active).toBe(false);
  });

  it('到达前已有的静稳等待不会先耗尽移交窗口，等待结束后仍需持续静稳', async () => {
    const r = rig();
    const controller = arrivalIdle(r);
    r.privateWorld.interruptIdle('prior-interaction');
    r.privateWorld.onTaskReport({ kind: 'done', taskId: 1, lastSkill: 'goto', text: '到达目标' });
    await vi.advanceTimersByTimeAsync(2_999);
    r.privateWorld.tryArrivalIdle();
    expect(controller.active).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    r.privateWorld.tryArrivalIdle();
    expect(controller.active).toBe(false);
    await vi.advanceTimersByTimeAsync(149);
    r.privateWorld.tryArrivalIdle();
    expect(controller.active).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    r.privateWorld.tryArrivalIdle();
    expect(controller.active).toBe(true);
    expect(r.events.filter(event => event.event === 'action-started')).toHaveLength(1);
    r.privateWorld.interruptIdle('test-cleanup');
    await vi.advanceTimersByTimeAsync(0);
  });

  it('远期静稳等待仍有移交上限，不在限制过去后迟到启动', async () => {
    const r = rig();
    const controller = arrivalIdle(r);
    r.privateWorld.idleQuietUntil = Date.now() + 60_000;
    r.privateWorld.idleQuietReason = 'prior-interaction';
    r.privateWorld.onTaskReport({ kind: 'done', taskId: 1, lastSkill: 'goto', text: '到达目标' });
    await vi.advanceTimersByTimeAsync(5_000);
    r.privateWorld.tryArrivalIdle();
    r.privateWorld.idleQuietUntil = 0;
    r.privateWorld.tryArrivalIdle();
    await vi.advanceTimersByTimeAsync(500);
    r.privateWorld.tryArrivalIdle();
    expect(controller.active).toBe(false);
    expect(r.events).toHaveLength(0);
  });

  it.each([
    ['任务', (r: ReturnType<typeof rig>, blocked: boolean) => { r.queue.hold = blocked ? 'other-body-owner' : null; }],
    ['战斗', (r: ReturnType<typeof rig>, blocked: boolean) => { r.combat.active = blocked; }],
    ['环境反射', (r: ReturnType<typeof rig>, blocked: boolean) => { r.reflexes.envActive = blocked; }],
    ['用物品', (r: ReturnType<typeof rig>, blocked: boolean) => { r.bot.usingHeldItem = blocked; }],
    ['实际容器', (r: ReturnType<typeof rig>, blocked: boolean) => { r.bot.currentWindow = blocked ? { id: 3 } : null; }],
  ])('到达等待静稳结束时%s仍有优先权，解除后重新计算持续静稳', async (_label, change) => {
    const r = rig();
    const controller = arrivalIdle(r);
    r.privateWorld.interruptIdle('prior-interaction');
    r.privateWorld.onTaskReport({ kind: 'done', taskId: 1, lastSkill: 'goto', text: '到达目标' });
    await vi.advanceTimersByTimeAsync(3_000);
    change(r, true);
    r.privateWorld.tryArrivalIdle();
    await vi.advanceTimersByTimeAsync(200);
    r.privateWorld.tryArrivalIdle();
    expect(controller.active).toBe(false);
    change(r, false);
    r.privateWorld.tryArrivalIdle();
    await vi.advanceTimersByTimeAsync(149);
    r.privateWorld.tryArrivalIdle();
    expect(controller.active).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    r.privateWorld.tryArrivalIdle();
    expect(controller.active).toBe(true);
    r.privateWorld.interruptIdle('test-cleanup');
    await vi.advanceTimersByTimeAsync(0);
  });

  it('一个空闲物理帧不足以移交；重新落地并持续静稳后才启动一次观察', async () => {
    const r = rig();
    const controller = arrivalIdle(r);
    r.privateWorld.hookBotEvents(r.asBot);
    r.privateWorld.onTaskReport({ kind: 'done', taskId: 1, lastSkill: 'goto', text: '到达目标' });
    await vi.advanceTimersByTimeAsync(50);
    r.bot.entity.onGround = false;
    r.bot.emit('physicsTick');
    await vi.advanceTimersByTimeAsync(50);
    r.bot.emit('physicsTick');
    expect(controller.active).toBe(false);
    expect(r.world.logConsole().entries().filter(entry => entry.event === 'idle-arrival-wait'))
      .toMatchObject([{ data: { reason: 'airborne' } }]);
    r.bot.entity.onGround = true;
    r.bot.emit('physicsTick');
    await vi.advanceTimersByTimeAsync(149);
    r.bot.emit('physicsTick');
    expect(controller.active).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    r.bot.emit('physicsTick');
    expect(controller.active).toBe(true);
    expect(r.events.filter(event => event.event === 'action-started')).toHaveLength(1);
    r.privateWorld.interruptIdle('test-cleanup');
    await vi.advanceTimersByTimeAsync(0);
  });

  it('实际失去身体优先权时只记录一次具体原因并停止镜头，不追加模型事件', async () => {
    const r = rig();
    const controller = arrivalIdle(r);
    r.privateWorld.hookBotEvents(r.asBot);
    r.privateWorld.onTaskReport({ kind: 'done', taskId: 1, lastSkill: 'goto', text: '到达目标' });
    await vi.advanceTimersByTimeAsync(150);
    r.bot.emit('physicsTick');
    expect(controller.active).toBe(true);
    const contextEvents = r.host.events.length;
    r.bot.usingHeldItem = true;
    r.bot.emit('physicsTick');
    expect(controller.active).toBe(false);
    const yaw = r.bot.entity.yaw;
    for (let i = 0; i < 10; i++) r.bot.emit('physicsTick');
    await vi.advanceTimersByTimeAsync(500);
    expect(r.bot.entity.yaw).toBe(yaw);
    expect(r.world.logConsole().entries().filter(entry => entry.event === 'idle-unavailable'))
      .toMatchObject([{ data: { reason: 'using-item' } }]);
    expect(r.events.at(-1)).toMatchObject({ event: 'cancelled', reason: 'body-owner-changed' });
    expect(r.host.events).toHaveLength(contextEvents);
  });

  it.each(['blocked', 'partial', 'cancelled', 'superseded'] as const)('%s 导航不会触发到达观察', async (kind) => {
    const r = rig();
    const controller = arrivalIdle(r);
    r.privateWorld.onTaskReport({ kind, taskId: 1, lastSkill: 'goto', text: '导航终态' });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.active).toBe(false);
    expect(r.events).toHaveLength(0);
  });

  it('文本提到到达而没有导航事实时不触发观察', async () => {
    const r = rig();
    const controller = arrivalIdle(r);
    r.privateWorld.onTaskReport({ kind: 'done', taskId: 1, text: '完成，到了 (0,64,0)' });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.active).toBe(false);
  });

  it.each([
    ['后续任务', (r: ReturnType<typeof rig>) => { r.queue.waiting.push({ id: 2, label: '下一件任务' }); }],
    ['战斗接管', (r: ReturnType<typeof rig>) => { r.combat.active = true; }],
    ['用物品', (r: ReturnType<typeof rig>) => { r.bot.usingHeldItem = true; }],
    ['实际容器', (r: ReturnType<typeof rig>) => { r.bot.currentWindow = { id: 3 }; }],
    ['脚边危险', (r: ReturnType<typeof rig>) => { r.setHazard(true); }],
    ['新的伤害', (r: ReturnType<typeof rig>) => { r.privateWorld.interruptIdle('damage'); }],
  ])('到达后的%s 保留身体优先权', async (_label, change) => {
    const r = rig();
    const controller = arrivalIdle(r);
    r.privateWorld.onTaskReport({ kind: 'done', taskId: 1, lastSkill: 'goto', text: '到达目标' });
    await vi.advanceTimersByTimeAsync(100);
    change(r);
    await vi.advanceTimersByTimeAsync(150);
    r.privateWorld.tryArrivalIdle();
    expect(controller.active).toBe(false);
    expect(r.events).toHaveLength(0);
  });

  it('原版默认配置和缺少旧配置子段时不生成待机场景', () => {
    const r = rig(false);
    expect(MINECRAFT_DEFAULTS.idle.enabled).toBe(false);
    expect(r.privateWorld.idleScene()).toBeNull();
    Object.assign(r.cfg, { idle: undefined });
    expect(r.privateWorld.idleScene()).toBeNull();
    expect(r.host.events).toHaveLength(0);
  });

  it.each([
    ['正在执行正式任务', (r: ReturnType<typeof rig>) => { r.queue.running = { id: 3, label: '赶路', step: 'goto',
      stepIndex: 0, stepCount: 1, elapsedMs: 0, taskElapsedMs: 0, count: null, pos: null }; }],
    ['有待办', (r: ReturnType<typeof rig>) => { r.queue.waiting.push({ id: 4, label: '回家收纳' }); }],
    ['队列被身体 owner 冻结', (r: ReturnType<typeof rig>) => { r.queue.hold = '救火'; }],
    ['正在战斗', (r: ReturnType<typeof rig>) => { r.combat.active = true; }],
    ['环境反射接管', (r: ReturnType<typeof rig>) => { r.reflexes.envActive = true; }],
    ['刚进入逃生保护期', (r: ReturnType<typeof rig>) => { r.privateWorld.escapeHoldUntil = Date.now() + 500; }],
    ['实际容器已打开', (r: ReturnType<typeof rig>) => { r.bot.currentWindow = { id: 2 }; }],
    ['正在用物品', (r: ReturnType<typeof rig>) => { r.bot.usingHeldItem = true; }],
    ['正在睡觉', (r: ReturnType<typeof rig>) => { r.bot.isSleeping = true; }],
    ['首次背包同步未完成', (r: ReturnType<typeof rig>) => { r.bridge.invSynced = false; }],
    ['失去连接', (r: ReturnType<typeof rig>) => { r.bridge.connected = false; }],
    ['未落地', (r: ReturnType<typeof rig>) => { r.bot.entity.onGround = false; }],
    ['寻路正在移动', (r: ReturnType<typeof rig>) => { r.bot.pathfinder.isMoving = () => true; }],
    ['脚边接触岩浆', (r: ReturnType<typeof rig>) => { r.setHazard(true); }],
    ['已死亡', (r: ReturnType<typeof rig>) => { r.bot.health = 0; }],
    ['World 收摊', (r: ReturnType<typeof rig>) => { r.privateWorld.shuttingDown = true; }],
  ])('%s 会清除已缓存的场景，不允许开始待机', (_name, change) => {
    const r = rig();
    expect(r.privateWorld.idleScene()?.candidates.length).toBeGreaterThan(0);
    change(r);
    expect(r.privateWorld.idleScene()).toBeNull();
    expect(r.privateWorld.idleSceneCache).toBeNull();
    expect(r.host.events).toHaveLength(0);
  });

  it('未知外部移动必须稳定下来；待机自己的短步不会被下一场景查询误判为忙', async () => {
    const r = rig();
    r.bot.setControlState('forward', true);
    expect(r.privateWorld.idleScene()).toBeNull();
    r.bot.setControlState('forward', false);
    r.bot.entity.velocity.x = 0.1;
    expect(r.privateWorld.idleScene()).toBeNull();
    r.bot.entity.velocity.x = 0;
    const idle = runIdle(r, 'short_walk');
    expect(r.bot.getControlState('forward')).toBe(true);
    r.bot.entity.velocity.z = -0.1;
    r.bot.entity.position.z -= 0.2;
    const cache = r.privateWorld.idleSceneCache;
    expect(r.privateWorld.idleScene()).toBe(cache);
    expect(idle.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(r.bot.getControlState('forward')).toBe(true);
    r.privateWorld.interruptIdle('task');
    expect(r.bot.getControlState('forward')).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('interruptIdle 同步释放身体、使旧场景失效，并在静稳窗口后生成新场景', async () => {
    const r = rig();
    const idle = runIdle(r);
    expect(r.bot.getControlState('sneak')).toBe(true);
    r.privateWorld.interruptIdle('incoming-chat');
    expect(idle.signal.aborted).toBe(true);
    expect(r.bot.getControlState('sneak')).toBe(false);
    expect(idle.controller.active).toBe(false);
    expect(r.privateWorld.idleGeneration()).not.toBe(idle.scene.generation);
    expect(r.privateWorld.idleScene()).toBeNull();
    expect(r.events.at(-1)).toMatchObject({ event: 'cancelled', reason: 'incoming-chat' });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(r.privateWorld.idleScene()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(r.privateWorld.idleScene()?.generation).not.toBe(idle.scene.generation);
    expect(r.host.events).toHaveLength(0);
  });

  it.each([
    ['mc_do', parseSteps], ['mc_scout', parseScoutSteps],
  ] as const)('%s 在正式任务受理后、开跑前取消待机并清理方向控制', async (name, parse) => {
    const r = rig();
    const idle = runIdle(r, 'short_walk');
    let handedOver = false;
    r.executor.submit.mockImplementation((steps, _mode, _wrote, admitted, beforeEnqueue) => {
      expect(idle.signal.aborted).toBe(false);
      beforeEnqueue?.();
      expect(idle.signal.aborted).toBe(true);
      expect(r.bot.getControlState('forward')).toBe(false);
      expect(r.privateWorld.idleGeneration()).not.toBe(idle.scene.generation);
      expect(steps).toMatchObject([{ skill: 'goto', at: [4, 64, 0] }]);
      r.bot.setControlState('forward', true); // new owner claims the same control
      handedOver = true;
      admitted?.(true);
      return '任务#1 已受理';
    });
    const receipt = r.privateWorld.enqueueTool(name, { steps: [{ skill: 'goto', at: [4, 64, 0] }] }, parse);
    expect(receipt).toContain('任务#1');
    expect(handedOver).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    // Late idle finally must not release the task's newly claimed direction.
    expect(r.bot.getControlState('forward')).toBe(true);
    expect(r.events.some(event => event.event === 'action-completed')).toBe(false);
  });

  it.each(['你好，一起走吧', '/msg Alex 看看这边', '/tell Alex 你好', '/w Alex 你好'])
    ('即时游戏聊天 %s 也在实际发送前取消待机', async (text) => {
      const r = rig();
      const idle = runIdle(r);
      r.bot.chat.mockImplementation((sent) => {
        expect(idle.signal.aborted).toBe(true);
        expect(r.bot.getControlState('sneak')).toBe(false);
        expect(sent).toBe(text);
      });
      expect(r.privateWorld.enqueueTool('mc_do', { steps: [{ skill: 'chat', text }] }, parseSteps)).toContain('已发送');
      expect(r.bot.chat).toHaveBeenCalledTimes(1);
      expect(r.executor.submit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
    });

  it('无效任务未提交时保留当前待机，不因工具解析失败清掉动作', async () => {
    const r = rig();
    const idle = runIdle(r);
    const receipt = r.privateWorld.enqueueTool('mc_do', { steps: [{ skill: 'not-a-skill' }] }, parseSteps);
    expect(receipt).toMatchObject({ failed: true, text: expect.stringContaining('失败') });
    expect(r.executor.submit).not.toHaveBeenCalled();
    expect(idle.signal.aborted).toBe(false);
    expect(r.bot.getControlState('sneak')).toBe(true);
    r.privateWorld.interruptIdle('test-cleanup');
    await vi.advanceTimersByTimeAsync(0);
  });

  it('自动进食在正常 eat 队列受理前撤销待机，仍使用真实食物选择', async () => {
    const r = rig();
    const idle = runIdle(r);
    r.bot.food = 15;
    r.stacks.push({ name: 'bread', count: 3 }, { name: 'rotten_flesh', count: 24 });
    r.executor.submitDetailed.mockImplementation((steps, mode) => {
      expect(idle.signal.aborted).toBe(true);
      expect(r.bot.getControlState('sneak')).toBe(false);
      expect(r.privateWorld.idleGeneration()).not.toBe(idle.scene.generation);
      expect(mode).toBe('afterCheckpoint');
      expect(steps).toEqual([{ skill: 'eat', item: 'bread' }]);
      return { accepted: true, receipt: '任务#2 已受理' };
    });
    r.privateWorld.autoEatTick(r.asBot);
    expect(r.executor.submitDetailed).toHaveBeenCalledTimes(1);
    expect(r.world.logConsole().entries().find(entry => entry.event === 'auto-eat')?.data)
      .toMatchObject({ item: 'bread', food: 15 });
    expect(r.host.events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('World.stop 先同步撤销待机，再等待 Bridge 与管理器关闭', async () => {
    const r = rig();
    const idle = runIdle(r);
    let finishBridge!: () => void;
    r.bridge.stop.mockImplementation(() => {
      expect(idle.signal.aborted).toBe(true);
      expect(r.bot.getControlState('sneak')).toBe(false);
      return new Promise<void>(resolve => { finishBridge = resolve; });
    });
    const stopClient = vi.fn(async () => {});
    const stopServer = vi.fn(async () => {});
    Object.assign(r.world, { client: { stop: stopClient }, playerClient: { stop: stopClient },
      mcServer: { stop: stopServer }, serverLifecycleQueue: Promise.resolve() });
    const stopping = r.world.stop();
    expect(idle.signal.aborted).toBe(true);
    expect(r.privateWorld.idleBehavior).toBeNull();
    expect(r.privateWorld.idleScene()).toBeNull();
    expect(stopClient).not.toHaveBeenCalled();
    finishBridge();
    await stopping;
    expect(stopClient).toHaveBeenCalledTimes(2);
    expect(stopServer).toHaveBeenCalledTimes(1);
    idle.controller.tick();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.events.filter(event => event.event === 'action-started')).toHaveLength(1);
  });

  it('World.start 的真实待机闭包只写诊断且打开本地预览，不给主模型投递动作文本', async () => {
    // Every source of runtime I/O is disabled before start; this test starts no game connection.
    vi.spyOn(CombatSession.prototype, 'start').mockImplementation(() => {});
    vi.spyOn(Reflexes.prototype, 'start').mockImplementation(() => {});
    const r = rig();
    r.cfg.idle.selector = 'decision';
    r.cfg.idle.endpoint = 'http://idle.example.test/choose';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { state: Record<string, unknown>;
        questions: { action: { criteria: Record<string, string> } } };
      expect(request.state).toMatchObject({ origin: { x: 0.5, y: 64, z: 0.5 }, health: 20, food: 20 });
      const criteria = request.questions.action.criteria;
      expect(criteria.inventory_preview).toBeTruthy();
      return new Response(JSON.stringify({ answers: { action: { choice: 'inventory_preview', confidence: 1,
        probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === 'inventory_preview' ? 1 : 0])) } }, latency_ms: 17 }));
    }));
    Object.assign(r.world, { syncManagedServerLifecycle: async () => {} });
    await r.world.start(r.host);
    clearInterval(r.privateWorld.worldTimer!);
    r.privateWorld.worldTimer = null;
    // Use the fake connection after start constructs its real closures and controller.
    Object.assign(r.world, { bridge: r.bridge, executor: r.executor });
    const previews: boolean[] = [];
    r.bot.on('viewer_inventory_preview', (value: { open: boolean }) => previews.push(value.open));
    const controller = r.privateWorld.idleBehavior!;
    controller.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(previews).toEqual([true]);
    expect(r.bot.currentWindow).toBeNull();
    expect(r.world.logConsole().entries().find(entry => entry.event === 'idle-action-started'))
      .toMatchObject({ lane: 'body', data: { actionId: 'inventory_preview', confidence: 1, latencyMs: 17 } });
    expect(r.host.events).toHaveLength(0);
    r.privateWorld.interruptIdle('incoming-chat');
    expect(previews).toEqual([true, false]);
    expect(r.world.logConsole().entries().find(entry => entry.event === 'idle-cancelled'))
      .toMatchObject({ data: { reason: 'incoming-chat' } });
    expect(r.host.events).toHaveLength(0);
    Object.assign(r.world, { client: { stop: async () => {} }, playerClient: { stop: async () => {} },
      mcServer: { stop: async () => {} } });
    await r.world.stop();
  });
});
