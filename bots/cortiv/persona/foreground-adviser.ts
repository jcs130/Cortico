/** Optional context and response-timing fallback. No action or memory-writing authority. */
import { createHash, randomUUID } from 'node:crypto';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { parseTypedChoice } from 'cortico/protocol/typed-decision.ts';
import type { DecisionHost } from 'cortico/protocol/typed-decision.ts';
import { decisionAvailable, requestAdvice, type DecisionConnection } from './decision-connection.ts';

export interface FastForegroundConfig extends DecisionConnection {
  enabled: boolean;
  endpoint: string;
  timeoutMs: number;
  minConfidence: number;
  minIntervalMs: number;
  focusedHistoryTokens: number;
  deferQueueTail: boolean;
  maxDeferMs: number;
  reasoningEnabled: boolean;
  reasoningModel: string;
  reasoningRoutineEffort: string;
  reasoningDeliberateEffort: string;
}

export const FAST_FOREGROUND_DEFAULTS: FastForegroundConfig = {
  enabled: false, endpoint: '', timeoutMs: 120, minConfidence: .8,
  minIntervalMs: 2000, focusedHistoryTokens: 3000, deferQueueTail: false, maxDeferMs: 10_000,
  reasoningEnabled: false, reasoningModel: '', reasoningRoutineEffort: 'low', reasoningDeliberateEffort: 'medium',
};

const READING = {
  focused: 'Current evidence suffices.',
  connected: 'Need older agreements, dependencies or failure evidence.',
};
const TIMING = {
  continue: 'Fresh normal progress; await the terminal result or new input.',
  respond: 'Plan next action, check an anomaly or answer new input now.',
};
const REASONING = {
  immediate: 'Danger, urgent response, or known short next step.',
  routine: 'Brief check/conversation; safe planning time unknown.',
  deliberate: 'Complex design/comparison, confirmed safe time, no urgency; running/accepted alone is insufficient.',
};

export interface ForegroundScene {
  events: readonly EventEnvelope[];
  facts: readonly { source: string; text: string;
    decision?: { sampledAtMs: number; state: Readonly<Record<string, unknown>> } }[];
  agenda: string;
  performance?: { source: string; text: string };
  intent?: { tool: string; arguments: string; receipt?: string; at?: string };
}

export interface ForegroundAdvice {
  kind: 'advice' | 'disabled' | 'cooldown' | 'uncertain' | 'timeout' | 'unavailable' | 'stale';
  reading?: keyof typeof READING;
  defer: boolean;
  readingProbability?: number;
  timingProbability?: number;
  reasoning?: keyof typeof REASONING;
  reasoningProbability?: number;
  elapsedMs?: number;
  latencyMs?: number;
  inputChars?: number;
  inputFormat?: 'foreground-compact-v1';
  questionNames?: string[];
  cursors: number[];
  attemptId?: string;
  proposedReading?: keyof typeof READING;
  proposedReasoning?: keyof typeof REASONING;
}

/** Only a fresh structured queue-tail observation can defer; any other substantive event bypasses it. */
export function queueTailOpportunity(events: readonly EventEnvelope[], now: number): EventEnvelope | null {
  let tail: EventEnvelope | null = null;
  for (const event of events) {
    if (event.contextDelivery === 'archive-only') continue;
    if (event.blobs?.length) return null;
    if (event.origin === 'internal') {
      if (event.source === 'persona' && (event.type === 'notice' || event.type === 'tick')) continue;
      return null;
    }
    const raw = event.meta?.minecraftQueueTail;
    if (event.type === `${event.source}.task.queue` && raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const value = raw as Record<string, unknown>;
      const age = now - Date.parse(event.ts);
      if (value.schemaVersion !== 1 || !Number.isInteger(value.taskId) || !Number.isInteger(value.stepIndex)
        || !Number.isInteger(value.stepCount) || (value.stepCount as number) < 1
        || value.stepIndex !== (value.stepCount as number) - 1 || !Number.isFinite(age) || age < 0 || age > 1000) return null;
      tail = event;
      continue;
    }
    if (event.tags?.includes('snapshot') && (event.type === `${event.source}.world.snapshot`
      || event.type === `${event.source}.status`)) continue;
    return null;
  }
  return tail;
}

function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = '\n[中段未展开]\n';
  const head = Math.floor((max - marker.length) / 3);
  return text.slice(0, head) + marker + text.slice(-(max - marker.length - head));
}

export class ForegroundAdviser {
  private controller: AbortController | null = null;
  private generation = 0;
  private lastAttemptAt = -Infinity;

  constructor(private readonly config: () => FastForegroundConfig,
    private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now,
    private readonly decisionHost: () => DecisionHost | undefined = () => undefined) {}

  reset(): void { this.generation++; this.controller?.abort(); this.controller = null; this.lastAttemptAt = -Infinity; }

  async advise(scene: ForegroundScene, signal?: AbortSignal, purpose: 'foreground' | 'reasoning' = 'foreground'): Promise<ForegroundAdvice> {
    const cfg = this.config();
    const started = this.now();
    const base = { defer: false, cursors: scene.events.map(event => event.cursor) };
    if (signal?.aborted) return { ...base, kind: 'stale' };
    if (!cfg.enabled || !decisionAvailable(cfg, this.decisionHost())) return { ...base, kind: 'disabled' };
    if (purpose === 'reasoning' && (!cfg.reasoningEnabled || !cfg.reasoningModel.trim())) return { ...base, kind: 'disabled' };
    if (this.controller || started - this.lastAttemptAt < cfg.minIntervalMs) return { ...base, kind: 'cooldown' };
    this.lastAttemptAt = started;
    const opportunity = purpose === 'foreground' && cfg.deferQueueTail ? queueTailOpportunity(scene.events, started) : null;
    const facts = scene.facts.filter(fact => !cfg.reasoningEnabled || fact.source !== scene.performance?.source)
      .map(fact => ({ source: fact.source, ...(fact.decision ? {
        ageMs: started - fact.decision.sampledAtMs, state: fact.decision.state,
      } : { excerpt: excerpt(fact.text, 100), complete: fact.text.length <= 100 }) }));
    const latest = new Map<string, EventEnvelope>();
    for (const event of scene.events) {
      if (event.contextDelivery === 'archive-only' || (event.source === 'persona' && event.type === 'notice')) continue;
      // Collapse repeated snapshots only. A newer status must not displace speech or a failure result.
      if (event.tags?.includes('snapshot')) latest.set(JSON.stringify([event.source, event.type, event.senderKey]), event);
      else latest.set(String(event.cursor), event);
    }
    const observations = [...latest.values()].sort((a, b) => a.cursor - b.cursor)
        .map(event => ({ source: event.source, type: event.type.startsWith(event.source + '.') ? event.type.slice(event.source.length + 1) : event.type,
          ...(event.senderKey ? { sender: event.senderKey } : {}),
          ageMs: started - Date.parse(event.ts), text: excerpt(event.text, 80) }));
    const recentRequest = scene.intent ? { ...scene.intent, arguments: excerpt(scene.intent.arguments, 80),
      receipt: excerpt(scene.intent.receipt ?? '', 100) } : null;
    // The backend evaluates each question with state. Keep question-specific evidence out of that repeated state.
    const reading = { agenda: excerpt(scene.agenda, 100), recentRequest,
      worlds: facts.map(fact => ({ source: fact.source, ageMs: 'ageMs' in fact ? fact.ageMs : null })),
      ...(cfg.reasoningEnabled && cfg.reasoningModel.trim() ? {} : { facts }) };
    const reasoning = { facts, ...(scene.performance ? { performance: {
      source: scene.performance.source, text: excerpt(scene.performance.text, 100) } } : {}),
      latestResult: recentRequest ? { tool: recentRequest.tool, receipt: recentRequest.receipt, at: recentRequest.at } : null };
    const body = JSON.stringify({ state: { observations }, questions: {
      ...(purpose === 'foreground' ? { reading: { type: 'choice', instructions: 'Extra history; incomplete/unknown dependencies require connected. Context: ' + JSON.stringify(reading), criteria: READING } } : {}),
      ...(opportunity ? { timing: { type: 'choice', instructions: 'Only a fresh queue tail is pending. Running is not completion; uncertainty requires respond. Queue: '
        + JSON.stringify(opportunity.meta?.minecraftQueueTail), criteria: TIMING } } : {}),
      ...(cfg.reasoningEnabled && cfg.reasoningModel.trim() ? { reasoning: { type: 'choice',
        instructions: 'Reasoning only; unknown requires routine. Now: ' + JSON.stringify(reasoning), criteria: REASONING } } : {}),
    } });
    const attemptId = randomUUID();
    const controller = new AbortController();
    this.controller = controller;
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    const generation = this.generation;
    const configKey = createHash('sha256').update(JSON.stringify(cfg)).digest('hex');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let onAbort: (() => void) | undefined;
    try {
      const request = requestAdvice(cfg, JSON.parse(body), controller.signal, this.fetchImpl, this.decisionHost());
      const raw = await Promise.race([request, new Promise<null>(resolve => {
        timer = setTimeout(() => { timedOut = true; controller.abort(); resolve(null); }, Math.max(1, Math.min(2000, cfg.timeoutMs)));
      }), new Promise<null>(resolve => { onAbort = () => resolve(null); controller.signal.addEventListener('abort', onAbort, { once: true }); })]) as { answers?: Record<string, unknown>; latency_ms?: number } | null;
      const measured = { attemptId, elapsedMs: this.now() - started, inputChars: body.length, inputFormat: 'foreground-compact-v1' as const,
        questionNames: Object.keys(JSON.parse(body).questions),
        ...(typeof raw?.latency_ms === 'number' && Number.isFinite(raw.latency_ms) ? { latencyMs: raw.latency_ms } : {}) };
      if ((controller.signal.aborted && !timedOut) || generation !== this.generation || configKey !== createHash('sha256').update(JSON.stringify(this.config())).digest('hex'))
        return { ...base, ...measured, kind: 'stale' };
      if (!raw) return { ...base, ...measured, kind: timedOut ? 'timeout' : 'unavailable' };
      const reading = parseTypedChoice(raw.answers?.reading, Object.keys(READING) as Array<keyof typeof READING>);
      const timing = opportunity ? parseTypedChoice(raw.answers?.timing, Object.keys(TIMING) as Array<keyof typeof TIMING>) : null;
      const acceptedReading = reading && reading.choiceProbability >= cfg.minConfidence;
      const reasoning = cfg.reasoningEnabled && cfg.reasoningModel.trim()
        ? parseTypedChoice(raw.answers?.reasoning, Object.keys(REASONING) as Array<keyof typeof REASONING>) : null;
      const acceptedReasoning = reasoning && reasoning.choiceProbability >= cfg.minConfidence;
      // A late queue observation never authorizes a delay, even when its classifier result is confident.
      const defer = !!(opportunity && queueTailOpportunity(scene.events, this.now())
        && timing?.choice === 'continue' && timing.choiceProbability >= cfg.minConfidence);
      return { ...base, ...measured, kind: acceptedReading || acceptedReasoning || defer ? 'advice' : 'uncertain',
        proposedReading: reading?.choice, proposedReasoning: reasoning?.choice,
        ...(acceptedReading ? { reading: reading.choice } : {}), defer,
        ...(acceptedReasoning ? { reasoning: reasoning.choice } : {}), reasoningProbability: reasoning?.choiceProbability,
        readingProbability: reading?.choiceProbability, timingProbability: timing?.choiceProbability };
    } catch { return { ...base, attemptId, kind: timedOut ? 'timeout' : 'unavailable', elapsedMs: this.now() - started, inputChars: body.length }; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abortFromCaller);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      if (this.controller === controller) this.controller = null; }
  }
}
