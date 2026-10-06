import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { precheckEmptyUseTarget, precheckStep, precheckSteps, type PrecheckDeps } from '../../../src/worlds/minecraft/precheck.ts';
import { blockAtCell, resolveAt } from '../../../src/worlds/minecraft/cell-facts.ts';
import { MinecraftWorld } from '../../../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS } from '../../../src/worlds/minecraft/config.ts';
import { Executor, parseSteps, type SkillCall } from '../../../src/worlds/minecraft/executor.ts';
import { useOnce } from '../../../src/worlds/minecraft/skills-interact.ts';
import { FakeHost } from '../../helpers/fake-host.ts';
import { log, nextTaskId } from './executor-harness.ts';

function rig() {
  let name: string | null = 'air';
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, heldItem: null,
    inventory: { items: () => [] },
    blockAt: (position: Vec3) => name === null ? null : { name, position, boundingBox: 'empty' },
    activateBlock: () => { throw new Error('No interaction packet may be sent'); },
    pathfinder: { goto: () => { throw new Error('No navigation may start'); } },
  } as unknown as Bot;
  const deps: PrecheckDeps = { resolve: (value) => resolveAt(bot, value as Parameters<typeof resolveAt>[1]),
    blockAt: (cell) => blockAtCell(bot, cell), cellsOf: () => null };
  const submissions: SkillCall[][] = [];
  const status = { running: null as { id: number } | null, waiting: [] as Array<{ id: number }>, hold: null };
  const ledger = new Executor({ getBot: () => bot, report: () => {}, log, nextId: nextTaskId() });
  const executor = { status: () => status,
    submit: (steps: SkillCall[]) => { submissions.push(steps); return '已排进队列'; },
    noteAdmissionRejection: ledger.noteAdmissionRejection.bind(ledger),
    repeatSuccessHold: () => null };
  const world = new MinecraftWorld({ cfg: structuredClone(MINECRAFT_DEFAULTS) });
  Object.assign(world, { host: new FakeHost(), executor, bridge: { bot } });
  const submit = (args: Record<string, unknown>) => (world as any).enqueueTool('mc_do', args, parseSteps);
  return { bot, deps, submissions, status, submit, block: (value: string | null) => { name = value; } };
}

const USE: Extract<SkillCall, { skill: 'use' }> = { skill: 'use', at: [1, 64, 0] };

describe('nearby empty use target preflight', () => {
  it.each(['air', 'cave_air', 'void_air', 'water', 'lava'])('rejects loaded %s before admission or packets', async (name) => {
    const r = rig(); r.block(name);
    expect(precheckStep(r.bot, USE, r.deps)).toMatchObject({ level: 'hard', rule: 'use.emptyTarget' });
    const first = r.submit({ steps: [USE] });
    expect(first).toMatchObject({ failed: true,
      text: expect.stringContaining('没有发送使用，也没有导航') });
    expect(first).not.toHaveProperty('endsTurn');
    expect(r.submit({ steps: [USE] })).toMatchObject({ failed: true, endsTurn: true });
    expect(r.submissions).toEqual([]);
    await expect(useOnce(r.bot, USE, { aborted: () => false } as never)).rejects.toThrow('不产生任何动作');
  });

  it('new negative block data allows another correction while unchanged cell data ends the turn', () => {
    const r = rig();
    const first = r.submit({ steps: [USE] });
    expect(first).not.toHaveProperty('endsTurn');
    expect(r.submit({ steps: [USE] })).toHaveProperty('endsTurn', true);
    r.block('water');
    expect(r.submit({ steps: [USE] })).not.toHaveProperty('endsTurn');
    expect(r.submit({ steps: [USE] })).toHaveProperty('endsTurn', true);
    expect(r.submissions).toEqual([]);
  });

  it('preserves valid loaded blocks and does not infer unavailable or distant targets', () => {
    const r = rig();
    r.block('chest'); expect(precheckEmptyUseTarget(r.bot, USE, r.deps)).toBeNull();
    expect(r.submit({ steps: [USE] })).toContain('排进队列');
    r.block(null); expect(precheckEmptyUseTarget(r.bot, USE, r.deps)).toBeNull();
    r.block('air');
    expect(precheckEmptyUseTarget(r.bot, { ...USE, at: [20, 64, 0] }, r.deps)).toBeNull();
    expect(precheckEmptyUseTarget(r.bot, { ...USE, at: ['+1', 64, 0] }, r.deps)).toBeNull();
  });

  it.each(['snowball', 'trident', 'water_bucket', 'bucket', 'glass_bottle', 'iron_hoe', 'wheat_seeds', 'custom_wand'])
    ('leaves explicit %s semantics to use handlers and prechecks an omitted item as bare hand', (item) => {
      const r = rig();
      expect(precheckEmptyUseTarget(r.bot, { ...USE, item }, r.deps)).toBeNull();
      Object.assign(r.bot, { heldItem: { name: item } });
      expect(precheckEmptyUseTarget(r.bot, USE, r.deps)).toMatchObject({ level: 'hard', rule: 'use.emptyTarget' });
    });

  it('does not preempt body work or earlier steps that may change the hand or cell', () => {
    const running = rig(); running.status.running = { id: 1 };
    expect(running.submit({ steps: [USE] })).toContain('排进队列');
    const waiting = rig(); waiting.status.waiting.push({ id: 2 });
    expect(waiting.submit({ steps: [USE] })).toContain('排进队列');
    expect(rig().submit({ steps: [USE], queue: 'append' })).toContain('排进队列');
    const r = rig();
    const earlier: SkillCall = { skill: 'chat', text: '/server-command' };
    expect(r.submit({ steps: [earlier, USE] })).toContain('排进队列');
    expect(precheckSteps(r.bot, [earlier, USE], r.deps)).toEqual([]);
    r.block('chest'); // The earlier action has now supplied an interactable target.
    expect(precheckStep(r.bot, USE, r.deps)).toBeNull();
    expect(precheckEmptyUseTarget(r.bot, { ...USE, target: 'villager' }, r.deps)).toBeNull();
  });
});
