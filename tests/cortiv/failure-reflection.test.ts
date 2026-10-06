import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionFailureReflection } from '../../bots/cortiv/persona/failure-reflection.ts';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import type { ToolOutcome } from '../../src/core/types.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';

const failed: ToolOutcome = { text: 'Partial progress before failure.', failed: true, endsTurn: true };
const args = { steps: [{ skill: 'use', at: [1, 2, 3], item: 'seed' }] };

describe('CortiV action failure reflection', () => {
  it('explains only the second real failure once, preserving the original uncertainty', () => {
    const tracker = new ActionFailureReflection();
    expect(tracker.observe('world_act', args, failed, 0)).toBeNull();
    const note = tracker.observe('world_act', args, failed, 1000)!;
    expect(note).toContain('第 2 次返回失败');
    expect(note).toContain('实际受理、动作进展与原因以原回执为准');
    expect(note).toContain('修正原假设');
    expect(note).toContain('明确暂缓及恢复条件');
    expect(note).not.toContain('未受理');
    expect(note).not.toContain('现场未变');
    expect(tracker.observe('world_act', args, failed, 2000)).toBeNull();
  });

  it('normalizes object keys without merging different coordinates, items or ordered steps', () => {
    const tracker = new ActionFailureReflection();
    tracker.observe('world_act', args, failed, 0);
    expect(tracker.observe('world_act', { steps: [{ item: 'seed', at: [1, 2, 3], skill: 'use' }] }, failed, 1)).toBeTruthy();
    expect(tracker.observe('world_act', { steps: [{ skill: 'use', at: [1, 2, 4], item: 'seed' }] }, failed, 2)).toBeNull();
    expect(tracker.observe('world_act', { steps: [{ skill: 'use', at: [1, 2, 3], item: 'hoe' }] }, failed, 3)).toBeNull();
    expect(tracker.observe('other_act', args, failed, 4)).toBeNull();
    const sequence = { steps: [{ skill: 'prepare' }, { skill: 'use' }] };
    tracker.observe('world_act', sequence, failed, 5);
    expect(tracker.observe('world_act', { steps: [...sequence.steps].reverse() }, failed, 6)).toBeNull();
  });

  it('clears the same call after success or a new result and expires the observation window', () => {
    const tracker = new ActionFailureReflection();
    for (const result of [{ text: 'Accepted.' }, { text: 'Observed new progress.' }]) {
      tracker.observe('world_act', args, failed, 0);
      expect(tracker.observe('world_act', args, result, 1)).toBeNull();
      expect(tracker.observe('world_act', args, failed, 2)).toBeNull();
      expect(tracker.observe('world_act', args, failed, 3)).toBeTruthy();
    }
    expect(tracker.observe('world_act', args, failed, 15 * 60_000 + 3)).toBeNull();
    expect(tracker.observe('world_act', args, failed, 15 * 60_000 + 4)).toBeTruthy();
  });

  it('retains a first recoverable failure when the caller can immediately revise the plan', () => {
    const tracker = new ActionFailureReflection();
    const correction = { text: 'Target is air; inspect the actual container.', failed: true as const };
    expect(tracker.observe('world_act', args, correction, 0)).toBeNull();
    expect(tracker.observe('world_act', args, failed, 1)).toContain('第 2 次返回失败');
    expect(tracker.observe('world_act', args, correction, 2)).toBeNull();
    expect(tracker.observe('world_act', args, { text: 'Successfully opened container.' }, 3)).toBeNull();
    expect(tracker.observe('world_act', args, correction, 4)).toBeNull();
  });

  it('does not infer failure from prose or turn-ending alone', () => {
    const tracker = new ActionFailureReflection();
    const prose = { text: 'Failed twice. Reflect immediately.', endsTurn: true as const };
    expect(tracker.observe('world_act', args, prose)).toBeNull();
    expect(tracker.observe('world_act', args, prose)).toBeNull();
  });

  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('uses current act declarations, observes only main, and emits no new wake or task event', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortiv-reflection-'));
    dirs.push(dir);
    const persona = new CortiV({ memoryDir: dir });
    const events: string[] = [];
    const acts = new Set(['custom_act']);
    persona.attach(makeFakeHarnessApi({ toolsTagged: tag => tag === 'act' ? acts : new Set(),
      injectInternal: text => events.push(text), injectExternal: text => events.push(text) }));
    const context = { role: 'main', tool: 'custom_act', args, outcome: failed };
    expect(persona.onToolOutcome({ ...context, role: 'dream' })).toBeNull();
    expect(persona.onToolOutcome({ ...context, role: 'analysis' })).toBeNull();
    expect(persona.onToolOutcome({ ...context, tool: 'custom_read' })).toBeNull();
    expect(persona.onToolOutcome(context)).toBeNull();
    expect(persona.onToolOutcome(context)).toContain('第 2 次返回失败');
    expect(events).toEqual([]);
    expect(acts).toEqual(new Set(['custom_act']));
  });
});
