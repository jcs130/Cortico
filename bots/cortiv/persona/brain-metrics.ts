import { createHash } from 'node:crypto';
import type { ModelObservation, ModelRequestObservation, ModelAttemptObservation } from 'cortico/core/model-observer.ts';
import type { CoreApi, EventEnvelope } from 'cortico/core/types.ts';
import type { ForegroundAdvice } from './foreground-adviser.ts';

type Source = 'adaptive' | 'configured' | 'inherited' | 'fallback' | 'manual';
type Reading = 'focused' | 'connected' | 'standard' | 'full';
export interface BrainPolicy {
  round: number | null;
  eligible: boolean;
  reading: Reading | null;
  readingSource: Source;
  reasoningSource: Source;
  proposedReading: Reading | null;
  proposedReasoning: 'immediate' | 'routine' | 'deliberate' | null;
  confidence: number | null;
  selectorMs: number | null;
  requestedHistoryTokens: number | null;
  appliedHistoryTokens: number | null;
  growthTokens: number | null;
  protectedTokens: number | null;
}
export const emptyBrainPolicy = (): BrainPolicy => ({ round: null, eligible: false, reading: null,
  readingSource: 'configured', reasoningSource: 'configured', proposedReading: null, proposedReasoning: null,
  confidence: null, selectorMs: null, requestedHistoryTokens: null, appliedHistoryTokens: null,
  growthTokens: null, protectedTokens: null });
interface Submission { event: ModelRequestObservation; policy: BrainPolicy; endedAtMs?: number; attempts: ModelAttemptObservation[] }
interface Selector { atMs: number; kind: ForegroundAdvice['kind'] }
interface Task { atMs: number; outcome: 'success' | 'failed' | 'unknown'; recoveryId: string | null; recovered: boolean | null }
const WINDOW_MS = 600_000;
const MAX_RECORDS = 10_000;
const opaque = (source: string, id: string): string => createHash('sha256').update(source).update('\0').update(id).digest('hex');
const roleOf = (role: string | null): string => {
  if (role === 'causal_review' || role === 'focused-cognition') return 'reflection';
  if (role === 'social-memory') return 'dream';
  return role && ['main', 'system1', 'planning', 'reflection', 'cognition', 'dream'].includes(role) ? role : 'unknown';
};
const distribution = (values: number[]) => {
  values.sort((a, b) => a - b);
  return { samples: values.length, p50_tokens: values.length ? values[Math.ceil(values.length * .5) - 1] : null,
    p95_tokens: values.length ? values[Math.ceil(values.length * .95) - 1] : null };
};
const buckets = (keys: string[], values: string[]) => Object.fromEntries(keys.map(key => [key, values.filter(value => value === key).length]));
const effortOf = (event: ModelRequestObservation): string => event.thinking === false ? 'off'
  : event.effort ? ['low', 'medium', 'high'].includes(event.effort) ? event.effort : 'other'
  : event.thinking === true ? 'default' : 'unknown';

/** Ten-minute event aggregates. The collector receives only choices, identities and numeric meters. */
export class BrainMetrics {
  private readonly startedAtMs: number;
  private incompleteUntilMs = 0;
  private readonly submissions = new Map<string, Submission>();
  private readonly selectors = new Map<string, Selector>();
  private readonly tasks = new Map<string, Task>();
  private taskVerificationObserved = false;
  private recoveryObserved = false;
  private last: Submission | null = null;

  constructor(private readonly now: () => number = Date.now) { this.startedAtMs = now(); }

  selector(advice: ForegroundAdvice): void {
    if (!advice.attemptId) return;
    const previous = this.selectors.get(advice.attemptId);
    // A reply invalidated before application is one stale attempt, not a second attempt.
    this.selectors.set(advice.attemptId, { atMs: previous?.atMs ?? this.now(), kind: advice.kind });
    this.prune();
  }

  observe(event: ModelObservation, policy?: BrainPolicy): void {
    if (event.kind === 'started') {
      if (!this.submissions.has(event.id)) this.submissions.set(event.id,
        { event: { ...event }, policy: { ...(policy ?? emptyBrainPolicy()) }, attempts: [] });
    } else {
      const submission = this.submissions.get(event.id);
      if (!submission) return;
      submission.endedAtMs = event.atMs;
      submission.attempts = [...new Map(event.attempts.map(attempt => [attempt.id, { ...attempt }])).values()];
      if (!this.last || (this.last.endedAtMs ?? 0) <= event.atMs) this.last = submission;
    }
    this.prune();
  }

  agenda(items: readonly { id: string; status: string; updatedAt: string }[]): void {
    for (const item of items) {
      const id = opaque('agenda', item.id);
      if (item.status === 'done') {
        const atMs = Date.parse(item.updatedAt);
        if (Number.isFinite(atMs)) this.tasks.set(id, { atMs, outcome: 'unknown', recoveryId: null, recovered: null });
      } else this.tasks.delete(id);
    }
    this.prune();
  }

  /** A World may attach an environment verdict; tool acceptance and model closure are insufficient. */
  verification(event: Pick<EventEnvelope, 'origin' | 'source' | 'ts' | 'meta'>): void {
    if (event.origin !== 'external') return;
    const value = event.meta?.taskVerification;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const data = value as Record<string, unknown>;
    const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(value);
    if (data.schema !== 'task-verification-v1' || !identifier(data.task_id)
      || !['success', 'failed', 'unknown'].includes(String(data.outcome))) return;
    const verified = data.outcome !== 'unknown';
    if (verified && (data.verified_by !== 'environment' || !identifier(data.evidence_id))) return;
    const atMs = Date.parse(event.ts);
    if (!Number.isFinite(atMs) || atMs > this.now() + 1000) return;
    this.taskVerificationObserved ||= verified || data.capability === 'mechanical-goal-closure-v1';
    const recoveryId = identifier(data.recovery_case_id) ? opaque(event.source, data.recovery_case_id) : null;
    this.recoveryObserved ||= recoveryId !== null && verified && data.strategy_changed === true;
    this.tasks.set(opaque(event.source, data.task_id), { atMs, outcome: data.outcome as Task['outcome'], recoveryId,
      recovered: recoveryId && verified && data.strategy_changed === true ? data.outcome === 'success' : null });
    this.prune();
  }

  private prune(): void {
    const now = this.now(), cutoff = now - WINDOW_MS;
    for (const [id, item] of this.submissions) if (item.endedAtMs !== undefined && item.endedAtMs < cutoff) this.submissions.delete(id);
    for (const collection of [this.selectors, this.tasks])
      for (const [id, item] of collection) if (item.atMs < cutoff) collection.delete(id);
    for (const collection of [this.submissions, this.selectors, this.tasks]) {
      while (collection.size > MAX_RECORDS) {
        collection.delete(collection.keys().next().value!);
        this.incompleteUntilMs = now + WINDOW_MS;
      }
    }
  }

  snapshot(runtime?: ReturnType<NonNullable<CoreApi['runtimeMetadata']>>) {
    this.prune();
    const now = this.now(), cutoff = now - WINDOW_MS;
    const all = [...this.submissions.values()];
    const submitted = all.filter(item => item.event.atMs >= cutoff);
    const ended = all.filter(item => item.endedAtMs !== undefined && item.endedAtMs >= cutoff);
    const attempts = [...new Map(ended.flatMap(item => item.attempts).filter(attempt => attempt.endedAtMs >= cutoff)
      .map(attempt => [attempt.id, attempt])).values()];
    const metered = [...new Map(attempts.map(attempt => [attempt.requestId ?? attempt.id, attempt])).values()];
    const selectors = [...this.selectors.values()];
    const tasks = [...this.tasks.values()];
    const active = all.filter(item => item.endedAtMs === undefined).sort((a, b) =>
      Number(b.event.role === 'main') - Number(a.event.role === 'main') || b.event.atMs - a.event.atMs);
    const chosen = active[0] ?? this.last;
    const selection = chosen ? this.selection(chosen, active.length ? 'current' : 'last') : null;
    const eligible = submitted.filter(item => item.policy.eligible);
    const total = (key: 'inputTokens' | 'outputTokens' | 'reasoningTokens') => metered.every(item => item[key] !== null)
      ? metered.reduce((sum, item) => sum + item[key]!, 0) : null;
    const recovery = [...new Map(tasks.filter(task => task.recoveryId && task.recovered !== null)
      .map(task => [task.recoveryId, task])).values()];
    return { schema: 'cortico-brain-metrics-v1', time: now / 1000,
      phase: runtime?.phase ?? null, paused: runtime?.paused ?? null,
      active_connection: { name: runtime?.providerName ?? null, model: runtime?.model ?? null },
      stage_budget_tokens: null, input_hard_limit: runtime?.inputHardLimit ?? null, selection,
      window: { window_seconds: 600, from: cutoff / 1000, to: now / 1000,
        covered_seconds: Math.min(600, (now - this.startedAtMs) / 1000),
        complete: now - this.startedAtMs >= WINDOW_MS && now >= this.incompleteUntilMs,
        eligible_requests: eligible.length,
        adaptive_applied: eligible.filter(item => item.policy.readingSource === 'adaptive' || item.policy.reasoningSource === 'adaptive').length,
        selector_attempts: selectors.length,
        selector_timeouts: selectors.filter(item => item.kind === 'timeout').length,
        selector_unavailable: selectors.filter(item => item.kind === 'unavailable').length,
        selector_uncertain: selectors.filter(item => item.kind === 'uncertain').length,
        selector_stale: selectors.filter(item => item.kind === 'stale').length,
        calls: attempts.length, failed_calls: attempts.filter(item => item.outcome === 'failed').length,
        aborted_calls: attempts.filter(item => item.outcome === 'aborted').length,
        discarded_calls: attempts.filter(item => item.outcome === 'discarded').length,
        retries: ended.reduce((sum, item) => sum + Math.max(0, item.attempts.length - 1) + Number(item.event.resubmission), 0),
        verified_success: this.taskVerificationObserved ? tasks.filter(task => task.outcome === 'success').length : null,
        verified_failed: this.taskVerificationObserved ? tasks.filter(task => task.outcome === 'failed').length : null,
        unknown_tasks: tasks.filter(task => task.outcome === 'unknown').length,
        recovery_cases: this.recoveryObserved ? recovery.length : null,
        recovered: this.recoveryObserved ? recovery.filter(task => task.recovered).length : null,
        task_verification_available: this.taskVerificationObserved,
        recovery_available: this.recoveryObserved,
        input_tokens: total('inputTokens'), output_tokens: total('outputTokens'), reasoning_tokens: total('reasoningTokens'),
        usage_samples: { attempts: attempts.length, input: attempts.filter(item => item.inputTokens !== null).length,
          output: attempts.filter(item => item.outputTokens !== null).length, reasoning: attempts.filter(item => item.reasoningTokens !== null).length },
        reading_counts: buckets(['focused', 'connected', 'standard', 'full', 'unknown'], submitted.map(item => item.policy.reading ?? 'unknown')),
        effort_counts: buckets(['off', 'low', 'medium', 'high', 'default', 'other', 'unknown'], submitted.map(item => effortOf(item.event))),
        route_counts: buckets(['main', 'system1', 'planning', 'reflection', 'cognition', 'dream', 'unknown'],
          [...submitted.map(item => roleOf(item.event.role)), ...selectors.map(() => 'system1')]),
        context_distributions: {
          history_budget: distribution(submitted.flatMap(item => item.policy.appliedHistoryTokens === null ? [] : [item.policy.appliedHistoryTokens])),
          matched_input: distribution(submitted.flatMap(item => { const matched = this.matched(item); return matched ? [matched.inputTokens!] : []; })),
          reasoning_budget: distribution([]),
        },
      } };
  }

  private matched(submission: Submission): ModelAttemptObservation | null {
    const attempt = submission.attempts.at(-1);
    return attempt?.requestId && attempt.inputTokens !== null ? attempt : null;
  }

  private selection(submission: Submission, scope: 'current' | 'last') {
    const { event, policy } = submission;
    const matched = this.matched(submission);
    const sources = { route: 'configured', reading: policy.readingSource, reasoning: policy.reasoningSource };
    return { scope, decision_id: event.id, request_id: matched?.requestId ?? event.id,
      inference_request_id: matched?.requestId ?? null, round: policy.round,
      origin: new Set(Object.values(sources)).size === 1 ? sources.route : 'mixed', sources,
      proposed: { reading: policy.proposedReading, reasoning: policy.proposedReasoning, effort: null },
      applied: { role: roleOf(event.role), model: event.model, reading: policy.reading, thinking: event.thinking,
        effort: event.effort, reasoning_budget_tokens: null },
      provider_confirmed: null, confidence: policy.confidence, selector_ms: policy.selectorMs,
      context: { requested_history_tokens: policy.requestedHistoryTokens, applied_history_tokens: policy.appliedHistoryTokens,
        growth_tokens: policy.growthTokens, protected_tokens: policy.protectedTokens,
        estimated_input_tokens: event.estimatedInputTokens, actual_input_tokens: matched?.inputTokens ?? null },
    };
  }
}
