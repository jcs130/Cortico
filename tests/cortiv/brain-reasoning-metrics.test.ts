import { describe, expect, it } from 'vitest';
import { BrainMetrics } from '../../bots/cortiv/persona/brain-metrics.ts';
import type { ModelAttemptObservation } from '../../src/core/model-observer.ts';

describe('brain engine-confirmed reasoning', () => {
  it('uses only associated confirmed budgets and keeps new request fields unknown', () => {
    const now = 1_000_000, metrics = new BrainMetrics(() => now);
    const start = (id: string) => metrics.observe({ kind: 'started', id, atMs: now, role: 'main', sessionId: 'session',
      model: 'fixture', thinking: true, effort: 'high', estimatedInputTokens: 200, resubmission: false });
    const attempt: ModelAttemptObservation = { id: 'attempt-1', requestId: 'call-1', ordinal: 1, outcome: 'completed',
      inputTokens: null, outputTokens: 10, cachedInputTokens: null, reasoningTokens: 4, elapsedMs: 200, endedAtMs: now,
      executionMs: 150, queueMs: 30, reasoning: { requested: { thinking: true, effort: 'high', budgetTokens: 4096 },
        effective: { thinking: true, effort: 'medium', nativeEffort: 'medium', budgetTokens: 1024, budgetStatus: 'applied' },
        confirmation: 'serving_template_and_budget_policy', confirmed: true } };
    start('first');
    for (let i = 0; i < 2; i++) metrics.observe({ kind: 'finished', id: 'first', atMs: now, attempts: [attempt] });
    const result = metrics.snapshot();
    expect(result.selection).toMatchObject({ provider_confirmed: true, provider_confirmation_scope: 'reasoning',
      applied: { effort: 'high' }, provider_effective: { effort: 'medium', budgetTokens: 1024 }, execution_ms: 150,
      queue_ms: 30, context: { actual_input_tokens: null } });
    expect(result.window.context_distributions).toMatchObject({ reasoning_budget: { samples: 1, p50_tokens: 1024, p95_tokens: 1024 },
      matched_input: { samples: 0 } });
    start('second');
    expect(metrics.snapshot().selection).toMatchObject({ provider_confirmed: null, provider_effective: null, execution_ms: null });
  });
});
