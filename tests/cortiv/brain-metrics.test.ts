import { describe, expect, it } from 'vitest';
import { BrainMetrics, emptyBrainPolicy } from '../../bots/cortiv/persona/brain-metrics.ts';
import type { ModelRequestObservation, ModelAttemptObservation } from '../../src/core/model-observer.ts';
import type { EventEnvelope } from '../../src/core/types.ts';

const start = (id: string, atMs: number): ModelRequestObservation => ({ kind: 'started', id, atMs, role: 'main', sessionId: 'session',
  model: 'test', thinking: true, effort: 'high', estimatedInputTokens: 200, resubmission: false });
const attempt = (id: string, endedAtMs: number): ModelAttemptObservation => ({ id, requestId: `http-${id}`, ordinal: 1, outcome: 'completed',
  inputTokens: 180, outputTokens: 30, cachedInputTokens: 100, reasoningTokens: null, elapsedMs: 20, executionMs: null, endedAtMs });
describe('event brain metrics', () => {
  it('counts submissions once, keeps current unknowns, then matches final usage by request identity', () => {
    let now = 1_000_000;
    const metrics = new BrainMetrics(() => now);
    const policy = { ...emptyBrainPolicy(), eligible: true, reading: 'focused' as const, readingSource: 'adaptive' as const,
      requestedHistoryTokens: 3000, appliedHistoryTokens: 8000 };
    metrics.observe(start('first', now), policy);
    metrics.observe(start('first', now), policy);
    let state = metrics.snapshot();
    expect(state.selection).toMatchObject({ scope: 'current', context: { actual_input_tokens: null, applied_history_tokens: 8000 } });
    expect(state.window).toMatchObject({ eligible_requests: 1, adaptive_applied: 1, calls: 0, verified_success: null });
    now += 20;
    metrics.observe({ kind: 'finished', id: 'first', atMs: now, attempts: [attempt('a', now)] });
    metrics.observe({ kind: 'finished', id: 'first', atMs: now, attempts: [attempt('a', now)] });
    state = metrics.snapshot();
    expect(state.selection).toMatchObject({ scope: 'last', request_id: 'http-a', inference_request_id: 'http-a', context: { actual_input_tokens: 180 } });
    expect(state.window).toMatchObject({ calls: 1, input_tokens: 180, reasoning_tokens: null });
    metrics.observe(start('second', now));
    expect(metrics.snapshot().selection).toMatchObject({ scope: 'current', context: { actual_input_tokens: null, applied_history_tokens: null } });
  });
  it('deduplicates reused selector attempts, excludes cooldown, and ages events independently', () => {
    let now = 1_000_000;
    const metrics = new BrainMetrics(() => now);
    metrics.selector({ attemptId: 'selector', kind: 'advice', reading: 'focused', defer: false, cursors: [] });
    metrics.selector({ attemptId: 'selector', kind: 'stale', defer: false, cursors: [] });
    metrics.selector({ kind: 'cooldown', defer: false, cursors: [] });
    expect(metrics.snapshot().window).toMatchObject({ selector_attempts: 1, selector_stale: 1, complete: false });
    expect(metrics.snapshot().window.route_counts.system1).toBe(1);
    now += 600_001;
    expect(metrics.snapshot().window).toMatchObject({ selector_attempts: 0, complete: true });
  });
  it('keeps model task closures unverified and accepts only explicit environment evidence', () => {
    const now = 1_000_000;
    const metrics = new BrainMetrics(() => now);
    metrics.agenda([{ id: 'goal', status: 'done', updatedAt: new Date(now).toISOString() }]);
    expect(metrics.snapshot().window).toMatchObject({ unknown_tasks: 1, verified_success: null, recovered: null });
    const event: EventEnvelope = { cursor: 1, type: 'fixture.task', text: 'result', origin: 'external', source: 'fixture', ts: new Date(now).toISOString(),
      meta: { taskVerification: { schema: 'task-verification-v1', task_id: 'goal', outcome: 'success' } } };
    metrics.verification(event);
    expect(metrics.snapshot().window.verified_success).toBeNull();
    event.meta!.taskVerification = { schema: 'task-verification-v1', task_id: 'goal', outcome: 'success', verified_by: 'environment',
      evidence_id: 'receipt', recovery_case_id: 'failure-1', strategy_changed: true };
    metrics.verification(event);
    metrics.verification(event);
    expect(metrics.snapshot().window).toMatchObject({ verified_success: 1, verified_failed: 0, recovery_cases: 1, recovered: 1 });
  });
});
