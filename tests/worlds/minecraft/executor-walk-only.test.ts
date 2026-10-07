/** Owner: src/worlds/minecraft/executor.ts — explicit non-destructive navigation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Executor, parseSteps, type RouteProbe, type TaskReport } from '../../../src/worlds/minecraft/executor.ts';
import { combatBot, log, nextTaskId, waitUntil, withBotEvents } from './executor-harness.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function rig(fail = false) {
  const scaffolding = [1, 2];
  const movements = { canDig: true, scafoldingBlocks: scaffolding };
  const observed: Array<{ canDig: boolean; scaffolding: number[] }> = [];
  const bot = withBotEvents(combatBot({ goto: async (arrive) => {
    observed.push({ canDig: movements.canDig, scaffolding: [...movements.scafoldingBlocks] });
    if (fail) throw new Error('No path to the goal!');
    arrive();
  } }));
  Object.assign(bot.pathfinder, { movements });
  const reports: TaskReport[] = [];
  const probes: RouteProbe[] = [
    { profile: 'style', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 10 },
    { profile: 'dig', status: 'timeout', steps: 0, place: 0, breaks: 0, endDist: 10 },
    { profile: 'walk', status: 'complete', steps: 20, place: 0, breaks: 0, endDist: 0 },
  ];
  const exec = new Executor({ getBot: () => bot as never, report: (r) => reports.push(r),
    log, nextId: nextTaskId(), probeRoutes: () => probes });
  return { bot, exec, reports, movements, scaffolding, observed };
}

describe('goto walkOnly', () => {
  it('executes the selected walking route and restores the previous movement policy', async () => {
    const r = rig();
    r.exec.submit([{ skill: 'goto', at: [10, 64, 0], walkOnly: true }]);
    await waitUntil(() => r.reports.length === 1);
    expect(r.reports[0].kind).toBe('done');
    expect(r.bot.entity.position.x).toBe(10);
    expect(r.observed).toEqual([{ canDig: false, scaffolding: [] }]);
    expect(r.movements.canDig).toBe(true);
    expect(r.movements.scafoldingBlocks).toBe(r.scaffolding);
    expect(r.reports[0].text).toContain('未挖掘或垫脚');
    r.exec.submit([{ skill: 'goto', at: [12, 64, 0] }]);
    await waitUntil(() => r.reports.length === 2);
    expect(r.observed.at(-1)).toEqual({ canDig: true, scaffolding: r.scaffolding });
  });

  it('restores movement policy after a blocked route and reports only the selected preview', async () => {
    const r = rig(true);
    r.exec.submit([{ skill: 'goto', at: [10, 64, 0], walkOnly: true }]);
    await waitUntil(() => r.reports.length === 1);
    expect(r.reports[0].kind).toBe('blocked');
    expect(r.movements.canDig).toBe(true);
    expect(r.movements.scafoldingBlocks).toBe(r.scaffolding);
    expect(r.reports[0].text).toContain('只靠走');
    expect(r.reports[0].text).not.toContain('只挖不垫');
  });

  it('previews walking without moving or acquiring a movement restriction', async () => {
    const r = rig();
    r.exec.submit([{ skill: 'goto', at: [10, 64, 0], walkOnly: true, dryRun: true }]);
    await waitUntil(() => r.reports.length === 1);
    expect(r.reports[0].text).toContain('只靠走');
    expect(r.reports[0].text).not.toContain('按当前风格');
    expect(r.observed).toEqual([]);
    expect(r.bot.entity.position.x).toBe(0.5);
    expect(r.movements.canDig).toBe(true);
    expect(r.movements.scafoldingBlocks).toBe(r.scaffolding);
  });

  it('preserves explicit selection through parsing and rejects a string flag', () => {
    const steps = [{ skill: 'goto', at: [10, 64, 0], walkOnly: true }];
    expect(parseSteps(steps)).toEqual({ steps });
    expect(parseSteps([{ ...steps[0], walkOnly: 'true' }])).toHaveProperty('error');
  });
});
