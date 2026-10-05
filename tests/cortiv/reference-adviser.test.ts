import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FAST_REFERENCE_DEFAULTS, REFERENCE_MAX_STATE_CHARS, REFERENCE_MAX_SUMMARY_CHARS, REFERENCE_MAX_TOPICS,
  ReferenceAdviceClient, type FastReferenceConfig, type FastReferenceTopic,
} from '../../bots/cortiv/persona/reference-adviser.ts';

const topics: FastReferenceTopic[] = [
  { key: 'making', summary: '准备材料、制作物件和检查结果。' },
  { key: 'talking', summary: '围绕当前话题与他人交流。' },
];
const config = (): FastReferenceConfig => ({ ...FAST_REFERENCE_DEFAULTS,
  enabled: true, endpoint: 'http://reference.invalid/judge', minIntervalMs: 0 });

function payload(): Record<string, any> {
  return {
    answers: {
      topic: { type: 'choice', choice: 'making', confidence: 0.9,
        probabilities: { making: 0.9, talking: 0.05, none: 0.05 } },
    }, latency_ms: 30,
  };
}
const reply = (value = payload()): Response => new Response(JSON.stringify(value));

afterEach(() => vi.useRealTimers());

describe('ReferenceAdviceClient', () => {
  it('returns one reading-topic choice from a brief request', async () => {
    const requests: RequestInit[] = [];
    const client = new ReferenceAdviceClient(config, async (_url, init) => {
      requests.push(init!); return reply();
    }, () => 100);
    const state = { current: '准备制作一个物件，材料尚未核对。', cursor: 20 };
    const original = structuredClone(state);
    const result = await client.advise(state, topics, 'scene:1');
    expect(result).toMatchObject({ kind: 'advice', advice: {
      topicKey: 'making', confidence: 0.9, sampledAtMs: 100, latencyMs: 30,
    } });
    const body = JSON.parse(String(requests[0].body));
    expect(body.state).toEqual(original);
    expect(state).toEqual(original);
    expect(Object.keys(body.questions)).toEqual(['topic']);
    expect(Object.keys(body.questions.topic.criteria)).toEqual([...topics.map(topic => topic.key), 'none']);
    expect(result).not.toHaveProperty('execute');
  });

  it('preserves explicit no-reference choices and low confidence without substituting a topic', async () => {
    const none = payload();
    none.answers.topic = { type: 'choice', choice: 'none', confidence: 0.9,
      probabilities: { making: 0.05, talking: 0.05, none: 0.9 } };
    expect(await new ReferenceAdviceClient(config, async () => reply(none)).advise({}, topics, 'none'))
      .toMatchObject({ kind: 'advice', advice: { topicKey: null, confidence: 0.9 } });
    const uncertain = payload();
    uncertain.answers.topic = { type: 'choice', choice: 'making', confidence: 0.6,
      probabilities: { making: 0.6, talking: 0.3, none: 0.1 } };
    expect(await new ReferenceAdviceClient(config, async () => reply(uncertain)).advise({}, topics, 'uncertain'))
      .toMatchObject({ kind: 'skipped', reason: 'uncertain', advice: {
        topicKey: 'making', confidence: 0.6,
      } });
  });

  it('rejects invalid catalogues and oversized or circular state without a request', async () => {
    const fetchImpl = vi.fn(async () => reply());
    const client = new ReferenceAdviceClient(config, fetchImpl);
    const circular: Record<string, unknown> = {}; circular.self = circular;
    const tooMany = Array.from({ length: REFERENCE_MAX_TOPICS + 1 }, (_, index) => ({ key: String(index), summary: 'brief' }));
    for (const [state, catalogue] of [
      [{ text: 'x'.repeat(REFERENCE_MAX_STATE_CHARS) }, topics], [circular, topics],
      [{}, []], [{}, tooMany], [{}, [...topics, topics[0]]],
      [{}, [{ key: 'none', summary: 'reserved' }]], [{}, [{ key: 'missing', summary: '' }]],
      [{}, [{ key: 'long', summary: 'x'.repeat(REFERENCE_MAX_SUMMARY_CHARS + 1) }]],
    ] as Array<[Record<string, unknown>, FastReferenceTopic[]]>) {
      expect(await client.advise(state, catalogue, 'invalid')).toEqual({ kind: 'error', reason: 'invalid-state' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('validates the topic answer type, complete distribution and probability boundaries', async () => {
    const changes: Array<(answer: Record<string, any>) => void> = [
      answer => { answer.answers.topic.choice = 'unknown'; },
      answer => { answer.answers.topic.type = 'noul'; },
      answer => { answer.answers.topic.confidence = 0.8; },
      answer => { answer.answers.topic.probabilities.making = 1.2; },
      answer => { answer.answers.topic.probabilities.extra = 0; },
      answer => { delete answer.answers.topic.probabilities.none; },
      answer => { answer.answers.topic.probabilities.talking = 0.5; },
      answer => { answer.answers.topic.confidence = -0.1; },
      answer => { answer.answers.topic.probabilities.none = -0.1; },
      answer => { answer.answers.topic.probabilities.making = null; },
      answer => { answer.latency_ms = -1; },
    ];
    for (const change of changes) {
      const value = payload(); change(value);
      expect(await new ReferenceAdviceClient(config, async () => reply(value)).advise({}, topics, 'invalid'))
        .toEqual({ kind: 'error', reason: 'invalid-response' });
    }
  });

  it('shares an in-flight scene and keeps one request active across a timeout that ignores abort', async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>(resolve => { release = resolve; });
    }) as typeof fetch;
    const client = new ReferenceAdviceClient(() => ({ ...config(), timeoutMs: 40 }), fetchImpl);
    const first = client.advise({}, topics, 'scene:1');
    expect(client.advise({}, topics, 'scene:1')).toBe(first);
    expect(await client.advise({}, topics, 'scene:2')).toEqual({ kind: 'skipped', reason: 'busy' });
    await vi.advanceTimersByTimeAsync(40);
    expect(await first).toEqual({ kind: 'error', reason: 'timeout' });
    expect(signal?.aborted).toBe(true);
    expect(await client.advise({}, topics, 'scene:2')).toEqual({ kind: 'skipped', reason: 'busy' });
    release(reply()); await vi.advanceTimersByTimeAsync(0);
    // The timed-out reply cannot populate the scene's deduplication cache.
    const retry = client.advise({}, topics, 'scene:1');
    release(reply());
    expect((await retry).kind).toBe('advice');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reset ends the bounded wait and prevents a late reply from restoring prior advice', async () => {
    let release!: (response: Response) => void;
    const client = new ReferenceAdviceClient(config, () => new Promise<Response>(resolve => { release = resolve; }));
    const first = client.advise({}, topics, 'scene:1');
    client.reset();
    expect(await first).toEqual({ kind: 'skipped', reason: 'stale' });
    expect(await client.advise({}, topics, 'scene:1')).toEqual({ kind: 'skipped', reason: 'busy' });
    release(reply()); await new Promise<void>(resolve => setImmediate(resolve));
    const retry = client.advise({}, topics, 'scene:1');
    release(reply());
    expect((await retry).kind).toBe('advice');
  });

  it('expires duplicate results and throttles requests across distinct scenes', async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => reply());
    const client = new ReferenceAdviceClient(() => ({ ...config(), minIntervalMs: 20, maxResultAgeMs: 50 }), fetchImpl, () => now);
    expect((await client.advise({}, topics, 'scene:1')).kind).toBe('advice');
    now = 10;
    expect(await client.advise({}, topics, 'scene:1')).toEqual({ kind: 'skipped', reason: 'duplicate' });
    expect(await client.advise({}, topics, 'scene:2')).toEqual({ kind: 'skipped', reason: 'throttled', retryAfterMs: 10 });
    now = 20;
    expect((await client.advise({}, topics, 'scene:2')).kind).toBe('advice');
    now = 50;
    expect((await client.advise({}, topics, 'scene:1')).kind).toBe('advice');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects results older than the sampling limit', async () => {
    let now = 0;
    const client = new ReferenceAdviceClient(() => ({ ...config(), maxResultAgeMs: 10 }), async () => {
      now = 11; return reply();
    }, () => now);
    expect(await client.advise({}, topics, 'scene:1')).toEqual({ kind: 'skipped', reason: 'stale' });
  });

  it('keeps disabled service and HTTP, transport or malformed JSON responses neutral', async () => {
    const disabled = vi.fn(async () => reply());
    expect(await new ReferenceAdviceClient(() => FAST_REFERENCE_DEFAULTS, disabled).advise({}, topics, 'scene:1'))
      .toEqual({ kind: 'skipped', reason: 'disabled' });
    expect(disabled).not.toHaveBeenCalled();
    for (const [fetchImpl, expected] of [
      [async () => new Response('', { status: 503 }), { kind: 'error', reason: 'http', status: 503 }],
      [async () => { throw new Error('unavailable'); }, { kind: 'error', reason: 'transport' }],
      [async () => new Response('invalid'), { kind: 'error', reason: 'invalid-response' }],
    ] as Array<[typeof fetch, object]>) {
      expect(await new ReferenceAdviceClient(config, fetchImpl).advise({}, topics, 'scene:1')).toEqual(expected);
    }
  });
});
