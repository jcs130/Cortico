import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChestBook } from '../../../src/worlds/minecraft/chests.ts';
import { MINECRAFT_DEFAULTS } from '../../../src/worlds/minecraft/config.ts';
import {
  Executor, parseSteps, type SkillCall, type TaskAdmissionRejection, type TaskReport,
} from '../../../src/worlds/minecraft/executor.ts';
import { MinecraftWorld } from '../../../src/worlds/minecraft/world.ts';
import { FakeHost } from '../../helpers/fake-host.ts';
import { chestBot, combatBot, log, makeExecutorOn, nextTaskId, V } from './executor-harness.ts';

function rig(precheck = false) {
  const { bot, inv } = chestBot();
  const chests = new ChestBook(null);
  const reports: TaskReport[] = [];
  const exec = new Executor({ getBot: () => bot as never, log, nextId: nextTaskId(), chests,
    precheck: () => precheck, busyWith: () => 'existing work', report: (report) => reports.push(report) });
  const world = new MinecraftWorld({ cfg: structuredClone(MINECRAFT_DEFAULTS) });
  Object.assign(world, { host: new FakeHost(), executor: exec, bridge: { bot } });
  const submit = (steps: unknown, queue?: string) => (world as any).enqueueTool('mc_do', { steps, queue }, parseSteps);
  return { exec, world, bot, inv, chests, reports, submit };
}

function farmRig() {
  const r = rig(true);
  r.inv.set('iron_hoe', 1);
  r.inv.set('wheat_seeds', 8);
  const blocks = new Map<string, string>([['3,63,0', 'dirt'], ['3,64,0', 'oak_leaves']]);
  r.bot.blockAt = (p: V) => {
    const name = blocks.get(`${p.x},${p.y},${p.z}`) ?? 'air';
    return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' };
  };
  const cancellations: string[] = [];
  Object.assign(r.world, { idleBehavior: { cancel: (reason: string) => cancellations.push(reason) } });
  return { ...r, blocks, cancellations };
}

const take = (count = 1): Extract<SkillCall, { skill: 'take' }> =>
  ({ skill: 'take', item: 'coal', count, at: [3, 64, 0] });

afterEach(() => { vi.useRealTimers(); });

describe('Executor admission feedback', () => {
  it('an immediate attack without a target cannot cancel existing work; a later observed target is admitted', () => {
    const r = rig();
    Object.assign(r.bot, { world: { raycast: () => null } });
    try {
      r.exec.submit([{ skill: 'chat', text: 'existing task' }]);
      const before = r.exec.status();
      const attack: SkillCall[] = [{ skill: 'attack', target: 'creeper' }];
      const first = r.exec.submitDetailed(attack, 'now');
      expect(first).toMatchObject({ accepted: false,
        rejection: { kind: 'correction', rule: 'attack.noTarget' } });
      expect(first.receipt).toContain('不打断当前任务');
      expect(r.exec.status()).toEqual(before);
      expect(r.exec.submitDetailed(attack, 'now').rejection?.kind).toBe('repeat');
      expect(r.reports).toEqual([]);
      (r.bot as any).entities = { 7: { id: 7, name: 'creeper', type: 'mob', position: new V(2, 64, 0) } };
      expect(r.exec.submitDetailed(attack, 'now').accepted).toBe(true);
    } finally { r.exec.shutdown(); }
  });

  it('preserves a running movement and its waiting tasks when an immediate attack has no visible target', () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const bot = combatBot({ goto: () => gate });
    const { exec, reports } = makeExecutorOn(bot);
    try {
      exec.submit([{ skill: 'goto', at: [10, 64, 10] }]);
      exec.submit([{ skill: 'chat', text: 'next task' }], 'append');
      const before = exec.status();
      expect(before.running).not.toBeNull();
      expect(before.waiting).toHaveLength(1);
      expect(exec.submitDetailed([{ skill: 'attack', target: 'creeper' }], 'now').accepted).toBe(false);
      expect(exec.status().running?.id).toBe(before.running?.id);
      expect(exec.status().waiting).toEqual(before.waiting);
      expect(reports).toEqual([]);
    } finally { release(); exec.shutdown(); }
  });

  it('uses execution target matching and visibility for immediate attacks, including named players', () => {
    const r = rig();
    let blocked = true;
    Object.assign(r.bot, {
      world: { raycast: () => blocked ? { name: 'stone' } : null },
      entities: { 7: { id: 7, name: 'player', type: 'player', username: 'TestPlayer', position: new V(2, 64, 0) } },
    });
    try {
      expect(r.exec.submitDetailed([{ skill: 'attack', target: 'TestPlayer' }], 'now').accepted).toBe(false);
      blocked = false;
      expect(r.exec.submitDetailed([{ skill: 'attack', target: 'TestPlayer' }], 'now').accepted).toBe(true);
    } finally { r.exec.shutdown(); }
  });

  it('a future queued attack retains deferred target lookup after a movement step', () => {
    const r = rig();
    try {
      expect(r.exec.submitDetailed([{ skill: 'goto', at: [8, 64, 0] },
        { skill: 'attack', target: 'creeper' }], 'now').accepted).toBe(true);
      expect(r.exec.submitDetailed([{ skill: 'attack', target: 'zombie' }], 'append').accepted).toBe(true);
    } finally { r.exec.shutdown(); }
  });

  it('reports a new invalid target as correction and unchanged target as repeat without changing queued work', () => {
    const r = rig();
    try {
      r.exec.submit([{ skill: 'chat', text: 'existing task' }]);
      const before = r.exec.status();
      expect(r.exec.submitDetailed([take()])).toMatchObject({ accepted: false,
        rejection: { kind: 'correction', rule: 'take.not-container' } });
      expect(r.exec.submitDetailed([{ skill: 'goto', at: [1, 64, 0] }, take(2)])).toMatchObject({ accepted: false,
        rejection: { kind: 'repeat', rule: 'take.not-container' } });
      expect(r.exec.submitDetailed([take(3)])).toMatchObject({ accepted: false,
        rejection: { kind: 'repeat', rule: 'task.failed' } });
      expect(r.exec.status()).toEqual(before);
      expect(r.reports).toEqual([]);
    } finally { r.exec.shutdown(); }
  });

  it('returns admission classification through the typed submit callback', () => {
    const r = rig();
    const rejected: TaskAdmissionRejection[] = [];
    try {
      r.exec.submit([take()], 'replace', undefined, (accepted, retryAfterMs, completed, rejection) => {
        expect(accepted).toBe(false);
        expect(retryAfterMs).toBeGreaterThan(0);
        expect(completed).toBeUndefined();
        if (rejection) rejected.push(rejection);
      });
      expect(rejected).toEqual([{ kind: 'correction', rule: 'take.not-container' }]);
    } finally { r.exec.shutdown(); }
  });

  it('changed loaded evidence gets a fresh correction before repeat suppression applies again', () => {
    const r = rig();
    let block = 'air';
    r.bot.blockAt = (p: V) => ({ name: block, position: p, boundingBox: 'block' });
    const target = { x: 3, y: 64, z: 0 };
    try {
      expect(r.exec.submitDetailed([take()]).rejection?.kind).toBe('correction');
      expect(r.exec.submitDetailed([take()]).rejection?.kind).toBe('repeat');
      block = 'chest';
      r.chests.remember('overworld', target, [], 1, 27);
      expect(r.exec.submitDetailed([take()]).rejection).toEqual({ kind: 'correction', rule: 'take.missing-item' });
      expect(r.exec.submitDetailed([take()]).rejection?.kind).toBe('repeat');
      block = 'air';
      expect(r.exec.submitDetailed([take()]).rejection).toEqual({ kind: 'correction', rule: 'take.not-container' });
    } finally { r.exec.shutdown(); }
  });

  it('applies the same first and repeat contract to missing inventory and resets after inventory changes', () => {
    const r = rig();
    const steps: SkillCall[] = [{ skill: 'use', item: 'bread' }];
    try {
      expect(r.exec.submitDetailed(steps).rejection).toEqual({ kind: 'correction', rule: 'use.missingItem' });
      expect(r.exec.submitDetailed(steps).rejection?.kind).toBe('repeat');
      r.inv.set('coal', 1);
      expect(r.exec.submitDetailed(steps).rejection?.kind).toBe('correction');
      r.inv.set('bread', 1);
      expect(r.exec.submitDetailed(steps).accepted).toBe(true);
    } finally { r.exec.shutdown(); }
  });

  it('clears an old negative proof after goods are observed and leaves unknown blocks for execution', () => {
    const r = rig();
    const target = { x: 2, y: 64, z: 0 };
    const steps: SkillCall[] = [{ ...take(), at: [2, 64, 0] }];
    try {
      r.chests.remember('overworld', target, [], 1, 27);
      expect(r.exec.submitDetailed(steps).rejection?.kind).toBe('correction');
      expect(r.exec.submitDetailed(steps).rejection?.kind).toBe('repeat');
      r.chests.remember('overworld', target, [{ name: 'coal', count: 1 }], 1, 27);
      expect(r.exec.submitDetailed(steps).accepted).toBe(true);
      r.exec.clear();
      r.bot.blockAt = () => null as never;
      expect(r.exec.submitDetailed([take()]).accepted).toBe(true);
    } finally { r.exec.shutdown(); }
  });

  it('preserves queue waits and stopped world refusals as waits', () => {
    const r = rig();
    const steps: SkillCall[] = [{ skill: 'chat', text: 'existing task' }];
    try {
      expect(r.exec.submitDetailed(steps).accepted).toBe(true);
      expect(r.exec.submitDetailed(steps)).toMatchObject({ accepted: false,
        rejection: { kind: 'wait', rule: 'queue.pending' } });
      r.exec.shutdown();
      expect(r.exec.submitDetailed([take()])).toMatchObject({ accepted: false,
        rejection: { kind: 'wait', rule: 'world.stopped' } });
    } finally { r.exec.shutdown(); }
  });
});

describe('MinecraftWorld admission turn boundary', () => {
  it('replans a proven invalid farm target immediately, preserves idle and queue on rejection, and interrupts idle only for admitted work', () => {
    const r = farmRig();
    const seed: SkillCall = { skill: 'use', item: 'wheat_seeds', at: [3, 64, 0] };
    const steps: SkillCall[] = [{ skill: 'goto', at: [1, 64, 0] }, seed];
    try {
      r.exec.submit([{ skill: 'chat', text: 'existing task' }]);
      const before = r.exec.status();
      expect(r.submit(steps)).toMatchObject({ failed: true, text: expect.stringContaining('橡木树叶') });
      expect(r.cancellations).toEqual([]);
      expect(r.exec.status()).toEqual(before);
      // Changing the approach does not erase the unchanged seed target proof.
      expect(r.submit([{ skill: 'goto', at: [1, 64, 1] }, seed])).toMatchObject({ failed: true, endsTurn: true });
      r.blocks.set('3,64,0', 'farmland');
      expect(r.submit(steps, 'append')).toContain('任务#');
      expect(r.cancellations).toEqual(['task']);
      expect(r.exec.status().waiting).toHaveLength(2);
      expect(r.reports).toEqual([]);
    } finally { r.exec.shutdown(); }
  });

  it('first soil refusal does not end the turn and changed cover gets a fresh correction even when the soil itself is unchanged', () => {
    const r = farmRig();
    const hoe: SkillCall = { skill: 'use', item: 'iron_hoe', at: [3, 63, 0] };
    const steps: SkillCall[] = [{ skill: 'goto', at: [1, 64, 0] }, hoe];
    try {
      const first = r.submit(steps);
      expect(first).toMatchObject({ failed: true });
      expect(first).not.toHaveProperty('endsTurn');
      expect(r.submit(steps)).toMatchObject({ failed: true, endsTurn: true });
      r.blocks.set('3,64,0', 'stone');
      const changed = r.submit(steps);
      expect(changed).toMatchObject({ failed: true, text: expect.stringContaining('石头') });
      expect(changed).not.toHaveProperty('endsTurn');
      expect(r.submit(steps)).toMatchObject({ failed: true, endsTurn: true });
      r.blocks.delete('3,64,0');
      expect(r.submit(steps)).toContain('任务#');
    } finally { r.exec.shutdown(); }
  });

  it('defers soil checks when an earlier step can change it, and accepts hoe then seed at the same soil cell', () => {
    const r = farmRig();
    try {
      const hoe: SkillCall = { skill: 'use', item: 'iron_hoe', at: [3, 63, 0] };
      expect(r.exec.submitDetailed([{ skill: 'collect', block: 'oak_leaves', count: 1 }, hoe]).accepted).toBe(true);
      r.exec.clear();
      r.blocks.delete('3,64,0');
      expect(r.exec.submitDetailed([hoe, { skill: 'use', item: 'wheat_seeds', at: [3, 63, 0] }]).accepted).toBe(true);
    } finally { r.exec.shutdown(); }
  });

  it('a redundant already-satisfied movement does not cancel an idle action', () => {
    const r = farmRig();
    try {
      (r.exec as any).opts.busyWith = () => null;
      expect(r.submit([{ skill: 'goto', at: [0, 64, 0] }])).toMatchObject({ endsTurn: true });
      expect(r.cancellations).toEqual([]);
      expect(r.exec.status().waiting).toEqual([]);
    } finally { r.exec.shutdown(); }
  });

  it('allows same-turn replanning after a first take refusal, ends repeated refusal, and accepts an explicit corrected target', () => {
    const r = rig();
    try {
      r.exec.submit([{ skill: 'chat', text: 'existing task' }]);
      const before = r.exec.status();
      const first = r.submit([take()]);
      expect(first).toMatchObject({ failed: true, text: expect.stringContaining('不是可取物容器') });
      expect(first).not.toHaveProperty('endsTurn');
      expect(r.exec.status()).toEqual(before);
      expect(r.submit([take(2)])).toMatchObject({ failed: true, endsTurn: true });
      expect(r.exec.status()).toEqual(before);
      expect(r.submit([{ ...take(), at: [2, 64, 0] }], 'append')).toContain('任务#');
      expect(r.exec.status().waiting).toHaveLength(2);
      expect(r.reports).toEqual([]);
    } finally { r.exec.shutdown(); }
  });

  it('ends a duplicate queued intention while leaving unrelated corrections available', () => {
    const r = rig();
    const steps: SkillCall[] = [{ skill: 'goto', at: [8, 64, 0] }];
    try {
      expect(r.submit(steps)).toContain('任务#');
      const before = r.exec.status();
      expect(r.submit(steps)).toMatchObject({ failed: true, endsTurn: true });
      expect(r.exec.status()).toEqual(before);
      expect(r.submit([take()])).toMatchObject({ failed: true });
      expect(r.submit([take(2)])).toHaveProperty('endsTurn', true);
    } finally { r.exec.shutdown(); }
  });
});
