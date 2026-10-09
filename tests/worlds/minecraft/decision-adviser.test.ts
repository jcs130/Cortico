import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDecisionAdviser,
  DECISION_QUESTIONS,
  type DecisionAdviserResult,
} from '../../../src/worlds/minecraft/decision-adviser.ts';

const endpoint = 'http://localhost:45678/judge';

function serviceReply(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    answers: {
      next: {
        choice: 'inspect',
        confidence: 0.8,
        probabilities: { inspect: 0.8, replan: 0.1, resupply: 0.08, pause: 0.02 },
      },
      risk: { score: 1.5, probabilities: { 0: 0.1, 1: 0.3, 2: 0.5, 3: 0.1 } },
    },
    latency_ms: 43,
    ...overrides,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.useRealTimers());

describe('createDecisionAdviser', () => {
  it('sends a fixed choice and score question and returns validated advice', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const adviser = createDecisionAdviser({
      endpoint,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return serviceReply();
      },
    });
    const state = { task: 'find shelter', hp: 12 };
    const result = await adviser.advise(state, 'scene:1');
    expect(result).toEqual({
      kind: 'advice',
      advice: {
        choice: 'inspect',
        confidence: 0.8,
        probabilities: { inspect: 0.8, replan: 0.1, resupply: 0.08, pause: 0.02 },
        riskScore: 1.5,
        riskProbabilities: { 0: 0.1, 1: 0.3, 2: 0.5, 3: 0.1 },
        latencyMs: 43,
      },
    });
    expect(requests[0]?.url).toBe(endpoint);
    expect(requests[0]?.init.method).toBe('POST');
    expect(requests[0]?.init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ state, questions: DECISION_QUESTIONS });
  });

  it('accepts above-chance confidence and uses the selected probability for the configured threshold', async () => {
    const adviser = createDecisionAdviser({ endpoint, fetchImpl: async () => serviceReply({ answers: {
      next: { choice: 'inspect', confidence: (0.8 - 0.25) / 0.75,
        probabilities: { inspect: 0.8, replan: 0.1, resupply: 0.08, pause: 0.02 } }, risk: { score: 1 },
    } }) });
    expect(await adviser.advise({}, 'new-confidence')).toMatchObject({ kind: 'advice', advice: { confidence: 0.8 } });
  });

  it('keeps ambiguous choices observational without emitting an actionable suggestion', async () => {
    const adviser = createDecisionAdviser({ endpoint, fetchImpl: async () => serviceReply({ answers: {
      next: { choice: 'pause', confidence: 0.43,
        probabilities: { inspect: 0.3, replan: 0.2, resupply: 0.07, pause: 0.43 } }, risk: { score: 1.7 },
    } }) });
    expect(await adviser.advise({}, 'ambiguous')).toMatchObject({ kind: 'skipped', reason: 'uncertain',
      advice: { choice: 'pause', confidence: 0.43 } });
  });

  it('shares one in-flight request for the same scene and skips a different scene while busy', async () => {
    let resolveReply!: (response: Response) => void;
    let calls = 0;
    const adviser = createDecisionAdviser({
      endpoint,
      minIntervalMs: 0,
      fetchImpl: () => {
        calls++;
        return new Promise<Response>((resolve) => { resolveReply = resolve; });
      },
    });
    const first = adviser.advise({ task: 'survey' }, 'scene:1');
    const duplicate = adviser.advise({ task: 'survey' }, 'scene:1');
    expect(duplicate).toBe(first);
    expect(await adviser.advise({ task: 'move' }, 'scene:2')).toEqual({ kind: 'skipped', reason: 'busy' });
    expect(calls).toBe(1);
    resolveReply(serviceReply());
    expect((await first).kind).toBe('advice');
    expect(await adviser.advise({ task: 'survey' }, 'scene:1')).toEqual({ kind: 'skipped', reason: 'duplicate' });
  });

  it('throttles requests across scenes and reports the remaining interval', async () => {
    let nowMs = 10;
    let calls = 0;
    const adviser = createDecisionAdviser({
      endpoint,
      minIntervalMs: 200,
      now: () => nowMs,
      fetchImpl: async () => { calls++; return serviceReply(); },
    });
    expect((await adviser.advise({ task: 'survey' }, 'scene:1')).kind).toBe('advice');
    nowMs = 50;
    expect(await adviser.advise({ task: 'move' }, 'scene:2')).toEqual({
      kind: 'skipped', reason: 'throttled', retryAfterMs: 160,
    });
    nowMs = 210;
    expect((await adviser.advise({ task: 'move' }, 'scene:2')).kind).toBe('advice');
    expect(calls).toBe(2);
  });

  it('bounds a stalled request and aborts it', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const adviser = createDecisionAdviser({
      endpoint,
      timeoutMs: 30,
      minIntervalMs: 0,
      fetchImpl: (_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      },
    });
    const result = adviser.advise({ task: 'survey' }, 'scene:1');
    await vi.advanceTimersByTimeAsync(30);
    expect(await result).toEqual({ kind: 'error', reason: 'timeout' });
    expect(signal?.aborted).toBe(true);
  });

  it.each([
    serviceReply({ answers: { next: { choice: 'unknown', confidence: 0.5, probabilities: {} }, risk: { score: 1 } } }),
    serviceReply({ answers: { next: { choice: 'pause', confidence: 1.1, probabilities: { inspect: 0, replan: 0, resupply: 0, pause: 1 } }, risk: { score: 1 } } }),
    serviceReply({ answers: { next: { choice: 'pause', confidence: 1, probabilities: { inspect: 0, replan: 0, resupply: 0 } }, risk: { score: 1 } } }),
    serviceReply({ answers: { next: { choice: 'inspect', confidence: 0.8, probabilities: { inspect: 0.4, replan: 0.3, resupply: 0.2, pause: 0.1 } }, risk: { score: 1 } } }),
    serviceReply({ answers: { next: { choice: 'inspect', confidence: 1, probabilities: { inspect: 1, replan: 0, resupply: 0, pause: 0 } }, risk: { score: 999 } } }),
    serviceReply({ answers: { next: { choice: 'inspect', confidence: 1, probabilities: { inspect: 1, replan: 0, resupply: 0, pause: 0 } }, risk: { score: 1, probabilities: { 0: 0.5, 1: 0.5 } } } }),
    serviceReply({ latency_ms: -1 }),
    new Response('not json', { status: 200 }),
  ])('rejects malformed service responses', async (reply) => {
    const adviser = createDecisionAdviser({ endpoint, fetchImpl: async () => reply });
    expect(await adviser.advise({ task: 'survey' }, 'scene:1')).toEqual({
      kind: 'error', reason: 'invalid-response',
    });
  });

  it('returns HTTP and transport failures without throwing and allows retry after the interval', async () => {
    let nowMs = 0;
    let calls = 0;
    const adviser = createDecisionAdviser({
      endpoint,
      minIntervalMs: 20,
      now: () => nowMs,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return new Response('unavailable', { status: 503 });
        if (calls === 2) throw new Error('connection closed');
        return serviceReply();
      },
    });
    expect(await adviser.advise({ task: 'survey' }, 'scene:1')).toEqual({ kind: 'error', reason: 'http', status: 503 });
    nowMs = 20;
    expect(await adviser.advise({ task: 'survey' }, 'scene:1')).toEqual({ kind: 'error', reason: 'transport' });
    nowMs = 40;
    const third: DecisionAdviserResult = await adviser.advise({ task: 'survey' }, 'scene:1');
    expect(third.kind).toBe('advice');
    expect(calls).toBe(3);
  });

  it('rejects a state that cannot be serialized without sending a request', async () => {
    const state: Record<string, unknown> = {};
    state.self = state;
    let calls = 0;
    const adviser = createDecisionAdviser({
      endpoint,
      fetchImpl: async () => { calls++; return serviceReply(); },
    });
    expect(await adviser.advise(state, 'scene:1')).toEqual({ kind: 'error', reason: 'invalid-state' });
    expect(calls).toBe(0);
  });
});
