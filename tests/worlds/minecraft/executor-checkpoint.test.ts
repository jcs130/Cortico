import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Executor, setOwnedGoal, type SkillCall, type TaskReport } from '../../../src/worlds/minecraft/executor.ts';
import { defaultPolicy } from '../../../src/worlds/minecraft/policy.ts';
import { Aborted, Yielded, type SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';
import { MinecraftLog } from '../../../src/worlds/minecraft/log.ts';
import { log, nextTaskId, waitUntil, V } from './executor-harness.ts';
type Window = NonNullable<Bot['currentWindow']>;
const dependency = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = dependency('prismarine-registry')('1.20.6');
const World = dependency('prismarine-world')(registry);
const Chunk = dependency('prismarine-chunk')(registry);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function rig() {
  const world = new World(null).sync;
  for (const x of [-1, 0]) for (const z of [-1, 0]) {
    world.setColumn(x, z, new Chunk({ minY: -64, worldHeight: 384 }));
  }
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
    world.setBlockStateId(new Vec3(x, 63, z), registry.blocksByName.stone.defaultState);
  }
  const stock = new Map<string, number>([['cobblestone', 8], ['iron_pickaxe', 1], ['bread', 2]]);
  const cells: Vec3[] = [];
  const dug: string[] = [];
  const placed: string[] = [];
  const trace: string[] = [];
  let beforeDig: (() => Promise<void>) | undefined;
  let beforePlace: (() => Promise<void>) | undefined;
  let pickupDelay = 0;
  let abortAfterEquip = false;
  let aborted = false;
  const items = () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({
    name, count, type: registry.itemsByName[name].id,
  }));
  const bot = Object.assign(new EventEmitter(), {
    registry, version: '1.20.6', world,
    _client: Object.assign(new EventEmitter(), { write() {} }),
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), onGround: true, eyeHeight: 1.62 },
    entities: {} as Record<string, { name: string; position: Vec3 }>,
    game: { dimension: 'overworld' }, health: 20, food: 8, currentWindow: null,
    heldItem: null as ReturnType<typeof items>[number] | null,
    inventory: { items, slots: Array(46).fill(null), selectedItem: null },
    blockAt: (at: Vec3) => world.getBlock(at),
    canSeeBlock: () => true, canDigBlock: () => true, digTime: () => 20,
    findBlocks: ({ matching }: { matching: number[] }) => cells.filter(at => matching.includes(world.getBlock(at).type)),
    equip: async (item: ReturnType<typeof items>[number]) => {
      bot.heldItem = item;
      if (abortAfterEquip) aborted = true;
    },
    unequip: async () => { bot.heldItem = null; },
    lookAt: async () => {}, setControlState() {}, stopDigging() {}, clearControlStates() {},
    deactivateItem() {},
    chat(text: string) { trace.push(`chat:${text}`); },
    consume: async () => {
      trace.push('eat-start');
      await new Promise<void>(resolve => setTimeout(resolve, 200));
      const name = bot.heldItem!.name;
      stock.set(name, stock.get(name)! - 1);
      bot.food = Math.min(20, bot.food + 5);
      trace.push('eat-confirmed');
    },
    toss: async (type: number, _metadata: unknown, count: number) => {
      const name = registry.items[type].name;
      stock.set(name, (stock.get(name) ?? 0) - count);
      trace.push(`toss:${name}`);
    },
    pathfinder: {
      movements: {}, goal: null as unknown, setGoal(goal?: unknown) { this.goal = goal ?? null; }, stop() {},
      goto: async (goal: { x: number; y: number; z: number }) => {
        bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
        for (const id of Object.keys(bot.entities)) delete bot.entities[id];
        trace.push('pickup-walk-done');
      },
    },
    placeBlock: async (ref: Block, face: Vec3) => {
      trace.push('place-start');
      await beforePlace?.();
      const at = ref.position.plus(face);
      const held = bot.heldItem!;
      const previous = world.getBlock(at);
      world.setBlockStateId(at, registry.blocksByName[held.name].defaultState);
      stock.set(held.name, stock.get(held.name)! - 1);
      placed.push(at.toString());
      bot.emit('blockUpdate', previous, world.getBlock(at));
      trace.push('place-confirmed');
    },
    dig: async (value: Block) => {
      trace.push('dig-start');
      await beforeDig?.();
      world.setBlockStateId(value.position, registry.blocksByName.air.defaultState);
      dug.push(value.position.toString());
      bot.emit('blockUpdate', value, world.getBlock(value.position));
      trace.push('dig-confirmed');
      const pickup = () => {
        const name = value.name === 'stone' ? 'cobblestone' : value.name;
        stock.set(name, (stock.get(name) ?? 0) + 1);
        trace.push('pickup-confirmed');
      };
      if (pickupDelay > 0) setTimeout(pickup, pickupDelay);
      else pickup();
    },
  });
  const seed = (name: string, at: [number, number, number]) => {
    const pos = new Vec3(...at);
    world.setBlockStateId(pos, registry.blocksByName[name].defaultState);
    cells.push(pos);
  };
  const ctx = {
    aborted: () => aborted, log, noLight: true, taskId: 1,
    intended: new Set<string>(), fleeHealth: () => 0, escape: { active: false },
  } as SkillContext;
  return {
    bot: bot as unknown as Bot, ctx, seed, stock, dug, placed, trace,
    gateDig: (gate: () => Promise<void>) => { beforeDig = gate; },
    gatePlace: (gate: () => Promise<void>) => { beforePlace = gate; },
    delayPickup: (ms: number) => { pickupDelay = ms; },
    abortOnEquip: () => { abortAfterEquip = true; },
  };
}

function executor(r: ReturnType<typeof rig>, extra: Partial<ConstructorParameters<typeof Executor>[0]> = {}) {
  const reports: TaskReport[] = [];
  const policy = { ...defaultPolicy(), light: [] };
  const exec = new Executor({
    getBot: () => r.bot, log, nextId: nextTaskId(), precheck: () => false,
    policy: { get: () => policy, defaults: () => ({ scaffold: [], light: [] }) },
    report: report => { reports.push(report); r.trace.push(`${report.kind}#${report.taskId}`); },
    ...extra,
  });
  return { exec, reports };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Exercise the executor's checkpoint callback with a controllable native action/finally. */
function checkpointControl(exec: Executor) {
  return exec as unknown as {
    task: object | null;
    checkpointTask(task: object, bot: Bot, from: number, boundary: boolean, settle?: () => Promise<void>): Promise<void>;
    checkpointDrain: { phase: string } | null;
    queue: { id: number; checkpointOwnerId?: number }[];
    frozen: { id: number; resumeFrom?: number; interrupted?: number | null } | null;
  };
}

const BUILD: SkillCall = { skill: 'build', material: 'cobblestone', anchors: [[2, 64, 0], [3, 64, 0]] };
const EAT = { skill: 'eat', item: 'bread' } as const;
const GOTO: SkillCall = { skill: 'goto', at: [8, 64, 0] };

describe('executor cooperative checkpoints', () => {
  it('real build confirms its placement and permit, eats before the full job ends, and resumes the original ID without double spending', async () => {
    const r = rig();
    const first = deferred();
    let calls = 0;
    r.gatePlace(async () => { if (++calls === 1) await first.promise; });
    let permits = 0;
    const { exec, reports } = executor(r, { permitResourcePlacement: () => ({ ok: true, finish: success => {
      expect(success).toBe(true); permits++; r.trace.push('permit-finished');
    } }) });
    exec.submit([{ skill: 'chat', text: '先开工' }, BUILD]);
    await waitUntil(() => r.trace.includes('place-start'));
    const receipt = exec.submit([EAT], 'afterCheckpoint');
    expect(receipt).toContain('等待任务#1');
    await vi.advanceTimersByTimeAsync(100);
    expect(r.trace).not.toContain('eat-start');
    expect(permits).toBe(0);
    first.resolve();
    await waitUntil(() => reports.some(p => p.kind === 'done' && p.taskId === 1));
    expect(r.placed).toHaveLength(2);
    expect(new Set(r.placed).size).toBe(2);
    expect(permits).toBe(2);
    expect(r.stock.get('cobblestone')).toBe(6);
    expect(r.stock.get('bread')).toBe(1);
    expect(r.bot.food).toBe(13);
    expect(r.trace.indexOf('eat-confirmed')).toBeLessThan(r.trace.lastIndexOf('place-start'));
    expect(r.trace.filter(t => t === 'chat:先开工')).toHaveLength(1);
    expect(reports.filter(p => p.taskId === 1).map(p => p.kind)).toEqual(['suspended', 'resumed', 'done']);
    expect(reports.filter(p => p.kind === 'cancelled')).toHaveLength(0);
  });

  it('real collection settles pickups then eats, and resumes only the actual remaining count', async () => {
    const r = rig();
    for (let x = 2; x <= 4; x++) r.seed('oak_log', [x, 64, 0]);
    r.delayPickup(200);
    const dig = deferred();
    let calls = 0;
    r.gateDig(async () => { if (++calls === 1) await dig.promise; });
    const { exec, reports } = executor(r);
    exec.submit([{ skill: 'collect', block: 'oak_log', count: 2 }]);
    await waitUntil(() => r.trace.includes('dig-start'));
    exec.submit([EAT], 'afterCheckpoint');
    dig.resolve();
    await waitUntil(() => reports.some(p => p.taskId === 1 && ['done', 'blocked', 'partial'].includes(p.kind)), 8_000);
    expect(reports.at(-1), JSON.stringify({ trace: r.trace, reports })).toMatchObject({ kind: 'done', taskId: 1 });
    expect(r.dug).toHaveLength(2);
    expect(r.stock.get('oak_log')).toBe(2);
    expect(r.stock.get('bread')).toBe(1);
    expect(r.trace.indexOf('pickup-confirmed')).toBeLessThan(r.trace.indexOf('eat-start'));
    expect(r.trace.indexOf('eat-confirmed')).toBeLessThan(r.trace.lastIndexOf('dig-start'));
    expect(reports.filter(p => p.taskId === 1).map(p => p.kind)).toEqual(['suspended', 'resumed', 'done']);
  });

  it('keeps multiple short requests FIFO; a blocked short request does not fail its original continuation', async () => {
    const r = rig(); const gate = deferred();
    let calls = 0; r.gatePlace(async () => { if (++calls === 1) await gate.promise; });
    const { exec, reports } = executor(r);
    exec.submit([BUILD]);
    await waitUntil(() => r.trace.includes('place-start'));
    exec.submit([{ skill: 'chat', text: '一' }], 'afterCheckpoint');
    exec.submit([{ skill: 'eat', item: 'dirt' }], 'afterCheckpoint');
    exec.submit([{ skill: 'chat', text: '三' }], 'afterCheckpoint');
    gate.resolve();
    await waitUntil(() => reports.some(p => p.taskId === 1 && p.kind === 'done'));
    expect(reports.filter(p => !['suspended', 'resumed'].includes(p.kind)).map(p => [p.taskId, p.kind]))
      .toEqual([[2, 'done'], [3, 'blocked'], [4, 'done'], [1, 'done']]);
    expect(r.trace.indexOf('chat:一')).toBeLessThan(r.trace.indexOf('chat:三'));
  });

  for (const cut of ['now', 'clear', 'death', 'disconnect'] as const) {
    it(`${cut} during awaited checkpoint cleanup revokes the continuation but waits for native action/finally to drain`, async () => {
      const r = rig(); const action = deferred(); const cleanup = deferred();
      let actionStarted = false;
      r.bot.pathfinder.goto = async () => { actionStarted = true; try { await action.promise; }
        finally { r.trace.push('old-native-finally'); r.bot.pathfinder.setGoal(null); } };
      const { exec, reports } = executor(r); const control = checkpointControl(exec);
      exec.submit([GOTO]); await waitUntil(() => actionStarted);
      exec.submit([{ skill: 'chat', text: '短单' }], 'afterCheckpoint');
      const yielding = control.checkpointTask(control.task!, r.bot, 0, false, () => cleanup.promise).catch(e => e);
      expect(control.checkpointDrain?.phase).toBe('settling');
      if (cut === 'now') exec.submit([{ skill: 'chat', text: '新单' }], 'now');
      else if (cut === 'clear') exec.clear(true);
      else if (cut === 'death') exec.cancelForDeath();
      else exec.onConnectionLost();
      if (cut === 'clear' || cut === 'death') exec.submit([{ skill: 'chat', text: '新单' }], 'append');
      await vi.advanceTimersByTimeAsync(50);
      expect(r.trace).not.toContain('chat:新单');
      cleanup.resolve(); expect(await yielding).toBeInstanceOf(Aborted);
      await vi.advanceTimersByTimeAsync(50);
      expect(r.trace).not.toContain('chat:新单');
      action.resolve();
      await vi.advanceTimersByTimeAsync(50);
      expect(r.trace).not.toContain('chat:短单');
      expect(reports.filter(p => p.taskId === 1 && p.kind === 'suspended')).toHaveLength(0);
      // Death retains its existing aggregate death event contract; other cuts have a task terminal.
      expect(reports.filter(p => p.taskId === 1 && !['suspended', 'resumed'].includes(p.kind)))
        .toHaveLength(cut === 'death' ? 0 : 1);
      if (cut !== 'disconnect') {
        expect(r.trace).toContain('chat:新单');
        expect(r.trace.indexOf('old-native-finally')).toBeLessThan(r.trace.indexOf('chat:新单'));
      }
    });
  }

  it('a yielded action waits through its native finally; combat ownership acquired meanwhile is neither cleared nor pumped over', async () => {
    const r = rig(); const body = { combatActive: false, environmentOwnerKind: null };
    const action = deferred(); const finalizer = deferred(); let started = false;
    r.bot.pathfinder.goto = async () => { started = true; try { await action.promise; }
      finally { await finalizer.promise; r.trace.push('old-native-finally'); } };
    const clear = vi.spyOn(r.bot, 'clearControlStates');
    const { exec, reports } = executor(r, { bodyState: () => body }); const control = checkpointControl(exec);
    exec.submit([GOTO]); await waitUntil(() => started);
    exec.submit([{ skill: 'chat', text: '短单' }], 'afterCheckpoint');
    expect(await control.checkpointTask(control.task!, r.bot, 0, false).catch(e => e)).toBeInstanceOf(Yielded);
    action.resolve(); await vi.advanceTimersByTimeAsync(20);
    expect(reports.some(p => p.kind === 'suspended')).toBe(false);
    body.combatActive = true;
    const combatGoal = new pathfinderPkg.goals.GoalNear(15, 64, 15, 1);
    setOwnedGoal(r.bot, combatGoal, 'combat', '测试战斗接管');
    const clearsBefore = clear.mock.calls.length;
    finalizer.resolve(); await vi.advanceTimersByTimeAsync(20);
    expect(reports.some(p => p.kind === 'suspended')).toBe(true);
    expect(r.bot.pathfinder.goal).toBe(combatGoal);
    expect(clear.mock.calls.length).toBe(clearsBefore);
    expect(r.trace).not.toContain('chat:短单');
    body.combatActive = false; r.bot.pathfinder.setGoal(null); exec.resume();
    await waitUntil(() => r.trace.includes('chat:短单'));
    exec.clear(true);
  });

  it('ordinary checkpoint cleanup failure defers yielding without failing the ongoing real build', async () => {
    const r = rig(); const first = deferred(); let calls = 0;
    r.gatePlace(async () => { if (++calls === 1) await first.promise; });
    const { exec, reports } = executor(r); const control = checkpointControl(exec);
    exec.submit([BUILD]); await waitUntil(() => r.trace.includes('place-start'));
    exec.submit([{ skill: 'chat', text: '短单' }], 'afterCheckpoint');
    await control.checkpointTask(control.task!, r.bot, 0, false, async () => { throw new Error('掉落暂时够不着'); });
    expect(control.checkpointDrain).toBeNull();
    expect(reports).toHaveLength(0);
    first.resolve(); await waitUntil(() => reports.some(p => p.taskId === 1 && p.kind === 'done'));
    expect(r.placed).toHaveLength(2);
    expect(reports.filter(p => p.kind === 'blocked')).toHaveLength(0);
  });

  it('unknown terrain, unsafe body, open window and cursor each defer checkpoints without claiming the short task started', async () => {
    for (const reason of ['unknown', 'lava', 'combat', 'window', 'cursor'] as const) {
      const r = rig(); const action = deferred(); let started = false;
      r.bot.pathfinder.goto = async () => { started = true; await action.promise; };
      const { exec, reports } = executor(r, { bodyState: () => ({ combatActive: reason === 'combat', environmentOwnerKind: null }) });
      // Start before combat owns the body, using ordinary mode; its checkpoint must not yield.
      exec.submit([GOTO]); await waitUntil(() => started);
      exec.submit([{ skill: 'chat', text: '短单' }], 'afterCheckpoint');
      if (reason === 'unknown') r.bot.blockAt = () => null;
      if (reason === 'lava') r.seed('lava', [0, 64, 0]);
      if (reason === 'window') r.bot.currentWindow = { id: 2 } as Bot['currentWindow'];
      if (reason === 'cursor') r.bot.inventory.selectedItem = { name: 'oak_log', count: 64 } as Bot['inventory']['selectedItem'];
      const control = checkpointControl(exec);
      await control.checkpointTask(control.task!, r.bot, 0, false);
      expect(control.checkpointDrain).toBeNull();
      expect(reports).toHaveLength(0);
      expect(r.trace).not.toContain('chat:短单');
      exec.clear(true); action.resolve(); await vi.advanceTimersByTimeAsync(30);
    }
  });

  it('a naturally completed last-unit build does not suspend and detaches a waiting request from its finished owner', async () => {
    const r = rig(); const first = deferred(); r.gatePlace(() => first.promise);
    const { exec, reports } = executor(r);
    exec.submit([{ skill: 'build', material: 'cobblestone', anchors: [[2, 64, 0]] }]);
    await waitUntil(() => r.trace.includes('place-start'));
    exec.submit([EAT], 'afterCheckpoint'); first.resolve();
    await waitUntil(() => reports.some(p => p.taskId === 2 && p.kind === 'done'));
    expect(reports.map(p => [p.taskId, p.kind])).toEqual([[1, 'done'], [2, 'done']]);
  });

  for (const cancel of ['server', 'fall'] as const) {
    it(`${cancel} terminal path detaches waiting request ownership instead of waiting on a dead owner`, async () => {
      const r = rig(); const action = deferred(); let started = false;
      r.bot.pathfinder.goto = async () => { started = true; await action.promise; };
      const { exec } = executor(r); const control = checkpointControl(exec);
      exec.submit([GOTO]); await waitUntil(() => started);
      exec.submit([{ skill: 'chat', text: '短单' }], 'afterCheckpoint');
      if (cancel === 'server') exec.blockCurrentFromServer('权限拒绝');
      else exec.stopCurrent('深坠');
      expect(control.queue.every(q => q.checkpointOwnerId === undefined)).toBe(true);
      action.resolve(); await vi.advanceTimersByTimeAsync(20); exec.clear(true);
    });
  }

  it('a real native opener and consecutive transfers remain one atomic window segment before the short request runs', async () => {
    const r = windowRig(); const terrain = rig(); const order: string[] = [];
    r.bot.blockAt = terrain.bot.blockAt;
    r.bot.entity.onGround = true;
    r.onUse = () => {
      order.push('opener'); r.open();
      r.exec.submit([{ skill: 'chat', text: '短单' }], 'afterCheckpoint');
    };
    const nativeChat = r.bot.chat.bind(r.bot);
    r.bot.chat = text => { if (text === '短单') order.push('short'); else nativeChat(text); };
    r.afterTransfer = () => { order.push('transfer'); expect(order).not.toContain('short'); };
    r.exec.submit([
      { skill: 'chat', text: '/warehouse open' },
      { skill: 'take', item: 'golden_apple', count: 1, from: 'open', needs: [1] },
      { skill: 'take', item: 'golden_apple', count: 1, from: 'open', needs: [2] },
    ]);
    await waitUntil(() => r.reports.some(p => p.taskId === 2 && p.kind === 'done'), 8_000);
    expect(order).toEqual(['opener', 'transfer', 'transfer', 'short']);
    expect(r.reports.map(p => [p.taskId, p.kind])).toEqual([[1, 'done'], [2, 'done']]);
    expect(r.closed).toHaveLength(1);
    expect(r.transfers[0]).toBe(r.transfers[1]);
  });

  it('combat during a complete-step checkpoint preserves the exact unstarted next step and its completed nonreplayable predecessor', async () => {
    const r = rig(); let busy: string | null = null;
    const { exec, reports } = executor(r, { busyWith: () => busy }); const control = checkpointControl(exec);
    const nativeCheckpoint = control.checkpointTask.bind(control);
    let frozenOnce = false;
    control.checkpointTask = (...args) => {
      const result = nativeCheckpoint(...args);
      if (!frozenOnce && args[3] && control.checkpointDrain?.phase === 'settling') {
        frozenOnce = true; busy = '战斗'; exec.suspend();
      }
      return result;
    };
    exec.submit([
      { skill: 'toss', item: 'cobblestone', count: 1, at: [0, 64, 3] },
      { skill: 'toss', item: 'bread', count: 1, at: [0, 64, 3] },
    ]);
    await waitUntil(() => r.trace.includes('toss:cobblestone'));
    exec.submit([{ skill: 'chat', text: '短单' }], 'afterCheckpoint');
    await waitUntil(() => control.frozen !== null);
    expect(control.frozen).toMatchObject({ id: 1, resumeFrom: 1, interrupted: null });
    await vi.advanceTimersByTimeAsync(30);
    expect(r.stock.get('cobblestone')).toBe(7);
    expect(r.stock.get('bread')).toBe(2);
    expect(r.trace).not.toContain('toss:bread');
    busy = null; exec.resume();
    await waitUntil(() => reports.some(p => p.taskId === 1 && p.kind === 'done'));
    expect(r.stock.get('bread')).toBe(1);
    expect(r.stock.get('cobblestone')).toBe(7);
    expect(r.trace.filter(t => t === 'toss:cobblestone')).toHaveLength(1);
    expect(r.trace.filter(t => t === 'toss:bread')).toHaveLength(1);
    expect(r.trace.indexOf('chat:短单')).toBeLessThan(r.trace.indexOf('toss:bread'));
    expect(reports.filter(p => p.taskId === 1 && p.kind === 'blocked')).toHaveLength(0);
  });

  it('combat freezes the short task independently while the original continuation stays queued and resumes after it', async () => {
    const r = rig(); const placement = deferred(); const shortWalk = deferred();
    let placed = 0; r.gatePlace(async () => { if (++placed === 1) await placement.promise; });
    let gotoCount = 0; let busy: string | null = null;
    r.bot.pathfinder.goto = async goal => {
      const destination = goal as typeof goal & { x: number; y: number; z: number };
      r.trace.push(`short-walk:${++gotoCount}`);
      if (gotoCount === 1) await shortWalk.promise;
      r.bot.entity.position = new Vec3(destination.x + 0.5, destination.y, destination.z + 0.5);
    };
    const { exec, reports } = executor(r, { busyWith: () => busy }); const control = checkpointControl(exec);
    exec.submit([BUILD]); await waitUntil(() => r.trace.includes('place-start'));
    exec.submit([{ skill: 'goto', at: [0, 64, 2] }], 'afterCheckpoint'); placement.resolve();
    await waitUntil(() => gotoCount === 1);
    busy = '战斗'; exec.suspend();
    expect(control.frozen?.id).toBe(2);
    expect(control.queue.map(q => q.id)).toContain(1);
    shortWalk.resolve(); await vi.advanceTimersByTimeAsync(30);
    expect(r.placed).toHaveLength(1);
    busy = null; exec.resume();
    await waitUntil(() => reports.some(p => p.taskId === 1 && p.kind === 'done'));
    expect(r.placed).toHaveLength(2);
    expect(reports.filter(p => p.kind === 'done').map(p => p.taskId)).toEqual([2, 1]);
  });

  it('a short request accepted while the owner is combat-frozen waits for safety, then runs before its untouched next action', async () => {
    const r = rig(); const firstWalk = deferred(); let walks = 0; let busy: string | null = null;
    r.bot.pathfinder.goto = async () => {
      walks++; r.trace.push(`walk:${walks}`);
      if (walks === 1) await firstWalk.promise;
      else r.bot.entity.position = new Vec3(8.5, 64, 0.5);
    };
    const { exec, reports } = executor(r, { busyWith: () => busy }); const control = checkpointControl(exec);
    exec.submit([GOTO]); await waitUntil(() => walks === 1);
    busy = '战斗'; exec.suspend();
    expect(exec.submit([{ skill: 'chat', text: '冻结时受理' }], 'afterCheckpoint')).toContain('等待任务#1');
    expect(control.frozen?.id).toBe(1);
    firstWalk.resolve(); await vi.advanceTimersByTimeAsync(20);
    expect(r.trace).not.toContain('chat:冻结时受理');
    busy = null; exec.resume();
    await waitUntil(() => reports.some(p => p.taskId === 1 && p.kind === 'done'));
    expect(r.trace.indexOf('chat:冻结时受理')).toBeLessThan(r.trace.indexOf('walk:2'));
  });

  it('rejected short requests leave no yield intent; a continuation cancelled by replace is described as started', async () => {
    const r = rig(); const first = deferred(); let placed = 0;
    r.gatePlace(async () => { if (++placed === 1) await first.promise; });
    const { exec, reports } = executor(r); const control = checkpointControl(exec);
    exec.submit([BUILD]); await waitUntil(() => r.trace.includes('place-start'));
    const refused = exec.submitDetailed([{ skill: 'use', item: 'diamond' }], 'afterCheckpoint');
    expect(refused.accepted).toBe(false);
    expect(control.queue).toHaveLength(0);
    const short = deferred(); r.bot.pathfinder.goto = async () => { await short.promise; };
    exec.submit([GOTO], 'afterCheckpoint'); first.resolve();
    await waitUntil(() => reports.some(p => p.kind === 'suspended'));
    expect(control.queue.map(q => q.id)).toContain(1);
    const receipt = exec.submit([{ skill: 'chat', text: '替换队列' }], 'replace');
    expect(receipt).toContain('已执行断点已撤');
    expect(receipt).not.toContain('都还没轮到跑第 1 步');
    expect(reports.filter(p => p.taskId === 1 && p.kind === 'cancelled')).toHaveLength(1);
    short.resolve(); await vi.advanceTimersByTimeAsync(20); exec.clear(true);
  });

  it('reconnection uses a new Bot even if old native cleanup never returns; late old finally cannot touch the new body or revive its continuation', async () => {
    const old = rig(); const fresh = rig(); const native = deferred(); const settle = deferred();
    let activeBot = old.bot; let started = false;
    old.bot.pathfinder.goto = async () => { started = true; try { await native.promise; }
      finally { old.bot.pathfinder.setGoal(null); old.trace.push('old-finally'); } };
    const { exec, reports } = executor(old, { getBot: () => activeBot }); const control = checkpointControl(exec);
    exec.submit([GOTO]); await waitUntil(() => started);
    exec.submit([{ skill: 'chat', text: '旧短单' }], 'afterCheckpoint');
    const yielding = control.checkpointTask(control.task!, old.bot, 0, false, () => settle.promise).catch(e => e);
    exec.onConnectionLost(); activeBot = fresh.bot;
    exec.submit([{ skill: 'chat', text: '新连接短单' }], 'afterCheckpoint');
    await waitUntil(() => fresh.trace.includes('chat:新连接短单'));
    const newGoal = new pathfinderPkg.goals.GoalNear(15, 64, 15, 1);
    setOwnedGoal(fresh.bot, newGoal, 'task', '新连接自己的目标');
    settle.resolve(); expect(await yielding).toBeInstanceOf(Aborted);
    native.resolve(); await vi.advanceTimersByTimeAsync(30);
    expect(fresh.bot.pathfinder.goal).toBe(newGoal);
    expect(fresh.trace).not.toContain('chat:旧短单');
    expect(reports.some(p => p.taskId === 1 && ['suspended', 'resumed', 'done'].includes(p.kind))).toBe(false);
    expect(control.checkpointDrain).toBeNull();
  });
});


function windowRig() {
  const registry = dependency('prismarine-registry')('1.20.6');
  const Item = dependency('prismarine-item')(registry);
  const client = new EventEmitter() as EventEmitter & { write(name: string, packet: unknown): void };
  const sent: Array<{ name: string; packet: unknown }> = [];
  let onUse = (): void => {};
  client.write = (name, packet) => {
    sent.push({ name, packet });
    if (name === 'use_item' || name === 'block_place') onUse();
  };
  const bot = Object.assign(new EventEmitter(), { registry, version: '1.20.6', _client: client,
    supportFeature: registry.supportFeature, QUICK_BAR_START: 36,
    entity: { id: 1, position: new V(0.5, 64, 0.5), yaw: 0, pitch: 0 },
    game: { dimension: 'overworld', gameMode: 'survival' }, health: 20, food: 20, entities: {},
    pathfinder: { stop() {}, setGoal() {}, goto: async () => {} },
    blockAt: (p: V) => ({ name: p.x === 2 && p.y === 64 && p.z === 0 ? 'chest' : 'air', position: p,
      boundingBox: p.x === 2 ? 'block' : 'empty' }),
    findBlocks: () => [], lookAt: async () => {}, swingArm: () => client.write('arm_animation', { hand: 0 }),
  }) as unknown as Bot;
  dependency('./lib/plugins/inventory')(bot, { hideErrors: true });
  const item = (name: string, count: number) => new Item(registry.itemsByName[name].id, count);
  const emit = (name: string, packet: object): void => {
    client.emit('packet', packet, { name });
    client.emit(name, packet);
  };
  const initial = new Array(bot.inventory.slots.length).fill(null);
  initial[36] = item('compass', 1);
  initial[9] = item('bread', 8);
  emit('window_items', { windowId: 0, stateId: 1, items: initial.map(Item.toNotch), carriedItem: Item.toNotch(null) });
  bot.quickBarSlot = 0;
  const updateInventorySlot = bot.inventory.updateSlot.bind(bot.inventory) as
    (slot: number, stack: Bot['heldItem']) => void;
  bot.equip = async (stack) => {
    const selected = typeof stack === 'number' ? bot.inventory.items().find((item) => item.type === stack) : stack;
    if (!selected) throw new Error('no fixture item to equip');
    if (bot.heldItem === selected) return;
    updateInventorySlot(36, selected);
    bot.quickBarSlot = 0;
  };
  bot.unequip = async () => { updateInventorySlot(36, null); };
  const opened: Window[] = [];
  bot.on('windowOpen', (window) => { opened.push(window); });
  const closed: Window[] = [];
  const nativeClose = bot.closeWindow.bind(bot);
  bot.closeWindow = (window) => { closed.push(window); nativeClose(window); };
  const transfers: Window[] = [];
  let afterTransfer = (): void => {};
  bot.transfer = async (options) => {
    const window = options.window ?? bot.currentWindow!;
    transfers.push(window);
    const source = window.slots.findIndex((stack, i) => i >= options.sourceStart && i < options.sourceEnd
      && stack?.type === options.itemType);
    const destination = window.slots.findIndex((stack, i) => i >= options.destStart && i < options.destEnd && !stack);
    if (source < 0 || destination < 0) throw new Error('no transfer slot');
    const before = window.slots[source]!;
    const count = Math.min(before.count, options.count ?? 1);
    emit('set_slot', { windowId: window.id, stateId: 3, slot: source,
      item: Item.toNotch(before.count > count ? item(before.name, before.count - count) : null) });
    emit('set_slot', { windowId: window.id, stateId: 4, slot: destination, item: Item.toNotch(item(before.name, count)) });
    afterTransfer();
  };
  const open = (options: { id?: number; type?: string; title?: unknown; contents?: boolean } = {}): Window => {
    emit('open_window', { windowId: options.id ?? 40, inventoryType: options.type ?? 'minecraft:generic_9x6',
      windowTitle: options.title ?? { text: 'Backpack', color: 'aqua' } });
    const window = bot.currentWindow!;
    if (options.contents !== false) full(window);
    return window;
  };
  const full = (window: Window): void => {
    const contents = new Array(window.slots.length).fill(null);
    contents[0] = item('golden_apple', 46);
    for (let i = 0; i < 36; i++) contents[window.inventoryStart + i] = bot.inventory.slots[9 + i];
    emit('window_items', { windowId: window.id, stateId: 2,
      items: contents.map(Item.toNotch), carriedItem: Item.toNotch(null) });
  };
  bot.chat = () => onUse();
  const diag = new MinecraftLog();
  const diagnostic = vi.spyOn(diag, 'write');
  const reports: TaskReport[] = [];
  const exec = new Executor({ getBot: () => bot, report: (report) => reports.push(report), log,
    diag, nextId: nextTaskId() });
  return { bot, client, emit, open, full, opened, closed, transfers, sent, reports, exec, diagnostic,
    set onUse(value: () => void) { onUse = value; },
    set afterTransfer(value: () => void) { afterTransfer = value; } };
}
