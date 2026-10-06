import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SleepReview, SLEEP_REVIEW_DEFAULTS, type SleepReviewConfig } from '../../bots/cortiv/persona/sleep-review.ts';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { DREAM_DEFAULTS } from '../../bots/cortiv/persona/dream-context.ts';
import definition, { CORTIV_SLEEP_REVIEW_CONFIG_GROUP, CORTIV_DREAM_CONFIG_GROUP } from '../../bots/cortiv/index.ts';
import type { EventEnvelope, ToolOutcome } from '../../src/core/types.ts';
import { functionCall, functionResult, message, type ContextRecord } from '../../src/protocol/open-responses/context.ts';
import { validateRequestContext } from '../../src/core/request-context.ts';
import { makeFakeHarnessApi, sleep } from '../core/helpers.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string { const dir = mkdtempSync(join(tmpdir(), 'sleep-review-')); dirs.push(dir); return dir; }
const night = (patch: Partial<EventEnvelope> = {}): EventEnvelope => ({ cursor: 1,
  ts: '2026-01-02T20:00:00Z', source: 'game', type: 'game.sleep', origin: 'external', text: 'Asleep.',
  meta: { sleeping: true, world: 'local-world', dimension: 'minecraft:overworld', gameDay: 12, timeOfDay: 14000 }, ...patch });
function rig(patch: Partial<SleepReviewConfig> = {}) {
  const state: Record<string, unknown> = {};
  const config = { ...SLEEP_REVIEW_DEFAULTS, enabled: true, eventTypes: 'game.sleep', ...patch };
  const core = makeFakeHarnessApi({ personaState: () => state, toolsTagged: tag => new Set(tag === 'speak' ? ['game_speak'] : []) });
  const review = new SleepReview(core, () => config);
  return { state, config, core, review };
}
const outcome = (patch: { role?: string; tool?: string; args?: Record<string, unknown>; outcome?: ToolOutcome } = {}) => ({
  role: 'main', tool: 'game_speak', args: { text: '忙了一天，我想想今天学会了什么。' }, outcome: { text: 'Accepted.' }, ...patch,
});

describe('sleep review trigger', () => {
  it.each([
    night({ type: 'game.chat', text: '躺下睡了。' }),
    night({ origin: 'internal' }),
    night({ meta: { sleeping: false, world: 'w', gameDay: 12, timeOfDay: 14000 } }),
    night({ meta: { sleeping: true, world: 'w', gameDay: 12, timeOfDay: 6000 } }),
    night({ meta: { sleeping: true, world: 'w', gameDay: null, timeOfDay: 14000 } }),
    night({ meta: { sleeping: true, world: 'w', gameDay: 12, timeOfDay: null } }),
  ])('does not infer nighttime sleep from prose, failed attempts or unknown facts: $type', event => {
    const r = rig();
    expect(r.review.observe([event])).toBeNull();
    expect(r.review.takeReady()).toBeNull();
    expect(r.state).toEqual({});
  });

  it('is disabled by default and exposes hot settings without World or model defaults', () => {
    expect(SLEEP_REVIEW_DEFAULTS.enabled).toBe(false);
    expect(SLEEP_REVIEW_DEFAULTS.eventTypes).toBe('');
    expect(definition.defaults().sleepReview).toEqual(SLEEP_REVIEW_DEFAULTS);
    for (const property of Object.values(CORTIV_SLEEP_REVIEW_CONFIG_GROUP.schema.properties)) expect(property['x-hot']).toBe(true);
    expect(CORTIV_DREAM_CONFIG_GROUP.schema.properties['dream.onHandoff']['x-hot']).toBe(true);
    expect(rig({ enabled: false }).review.observe([night()])).toBeNull();
  });

  it('announces at most once per world day across wake and restart, then accepts the next day', () => {
    const r = rig();
    const notice = r.review.observe([night()])!;
    expect(notice).toContain('先通过现有发言工具');
    expect(notice).toContain('第 12 天');
    expect(r.review.observe([night(), night({ type: 'game.wake', meta: { sleeping: false } })])).toBeNull();
    r.review.noteOutcome(outcome());
    expect(r.review.takeReady()).toContain('睡前回顾');
    const restored = new SleepReview(r.core, () => r.config);
    expect(restored.observe([night()])).toBeNull();
    const next = night({ meta: { ...night().meta, gameDay: 13 } });
    expect(restored.observe([next])).toContain('第 13 天');
  });

  it('waits for successful native speech with text, preserves failures and does not accept pure poses or other roles', () => {
    const r = rig(); r.review.observe([night()]);
    for (const invalid of [outcome({ outcome: { text: 'Failed.', failed: true } }), outcome({ args: { pose: 'wave' } }),
      outcome({ args: { text: ' ' } }), outcome({ args: { script: '【开心】【看向镜头】' } }), outcome({ tool: 'read_file' }), outcome({ role: 'dream' })]) {
      r.review.noteOutcome(invalid);
      expect(r.review.takeReady()).toBeNull();
    }
    r.review.noteOutcome(outcome());
    const reason = r.review.takeReady()!;
    expect(reason).toContain('开场发言已受理');
    expect(reason).toContain('2026-01-02T20:00:00Z');
    expect(reason).toContain('不把跨日旧经历');
    expect(r.review.takeReady()).toBeNull();
  });

  it('restores the announcement or ready phase without replaying a completed review', () => {
    const r = rig(); r.review.observe([night()]);
    const waiting = new SleepReview(r.core, () => r.config);
    expect(waiting.notice()).not.toBeNull();
    waiting.noteOutcome(outcome());
    const ready = new SleepReview(r.core, () => r.config);
    expect(ready.notice()).toBeNull();
    expect(ready.takeReady()).not.toBeNull();
    expect(new SleepReview(r.core, () => r.config).observe([night()])).toBeNull();
  });
});

describe('Persona sleep review lifecycle', () => {
  it('starts a background snapshot only after native announcement and batch completion, keeping main history and handoff unchanged', async () => {
    const forks: any[] = [];
    const injected: string[] = [];
    let handoffs = 0;
    const snapshot: ContextRecord[] = [message('system', 'Persona.'), message('user', 'Today: a verified fishing catch.')];
    const original = structuredClone(snapshot);
    const core = makeFakeHarnessApi({
      injectInternal: text => { injected.push(text); },
      toolsTagged: tag => new Set(tag === 'speak' ? ['game_speak'] : []),
      requestContextHandoff: () => { handoffs++; return true; },
    });
    core.sessionInfo = () => ({ id: 'main', running: 0, snapshot, estTokens: 0, hardTokens: null });
    core.spawnFork = async options => { forks.push(options); return '(nothing)'; };
    const persona = new CortiV({ memoryDir: temp(),
      dream: () => ({ ...DREAM_DEFAULTS, onHandoff: false, yieldToForeground: true }),
      sleepReview: () => ({ enabled: true, eventTypes: 'game.sleep' }) });
    persona.attach(core);
    persona.onDelivery({ events: [night()] });
    expect(injected.some(text => text.startsWith('[睡前回顾]'))).toBe(true);
    await sleep(0); expect(forks).toHaveLength(0);
    snapshot.push(functionCall('announcement', 'game_speak', JSON.stringify(outcome().args)), functionResult('announcement', 'Accepted.'));
    persona.onToolOutcome(outcome());
    expect(forks).toHaveLength(0);
    persona.onBatchEnd();
    snapshot.push(message('user', 'A later event after the snapshot.'));
    await sleep(0);
    expect(forks).toHaveLength(1);
    expect(forks[0]).toMatchObject({ id: 'dream', generationPriority: 'background' });
    expect(JSON.stringify(forks[0].messages)).toContain('睡前回顾');
    expect(JSON.stringify(forks[0].messages)).toContain('a verified fishing catch');
    expect(JSON.stringify(forks[0].messages)).not.toContain('A later event after the snapshot.');
    expect(() => validateRequestContext(forks[0].messages)).not.toThrow();
    expect(snapshot.slice(0, 2)).toEqual(original);
    expect(handoffs).toBe(0);
    persona.onBatchEnd(); await sleep(0); expect(forks).toHaveLength(1);
    await persona.onHandoff(snapshot, { hardTokens: null }); await sleep(0);
    expect(forks).toHaveLength(1);
  });
});
