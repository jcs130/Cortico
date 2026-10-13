import { describe, expect, it, vi } from 'vitest';
import { ForegroundAdviser, FAST_FOREGROUND_DEFAULTS, queueTailOpportunity } from '../../bots/cortiv/persona/foreground-adviser.ts';
import type { EventEnvelope } from '../../src/core/types.ts';

const now = Date.parse('2026-01-01T12:00:00Z');
function tail(patch: Partial<EventEnvelope> = {}): EventEnvelope {
  return { source: 'game', type: 'game.task.queue', origin: 'external', cursor: 42,
    ts: new Date(now).toISOString(), text: '任务正在执行最后一步，后面没有待办。', tags: ['snapshot'],
    meta: { minecraftQueueTail: { schemaVersion: 1, taskId: 7, stepIndex: 2, stepCount: 3 } }, ...patch };
}
function answer(reading = 'focused', timing = 'continue', probability = .94) {
  const readingKeys = ['focused','connected'];
  const timingKeys = ['continue','respond'];
  const choice = (selected: string, keys: string[]) => ({ type: 'choice', choice: selected, confidence: probability,
    probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? probability : (1-probability)/(keys.length-1)])) });
  return { answers: { reading: choice(reading, readingKeys), timing: choice(timing, timingKeys) }, latency_ms: 50 };
}
const config = () => ({ ...FAST_FOREGROUND_DEFAULTS, enabled: true, endpoint: 'http://fixture/decision', deferQueueTail: true });
const scene = (events = [tail()]) => ({ events, facts: [{ source: 'game', text: '位置已核实；正在移动；生命正常。' }],
  agenda: '把借来的工具还给原主人，尚未完成。', intent: { tool: 'game_do', arguments: '{"queue":"append"}', receipt: '任务已受理，尚未完成。' } });

describe('foreground reading and timing fallback', () => {
  it('uses the saved host choice without sending to a retained endpoint', async () => {
    const fetcher = vi.fn();
    const request = vi.fn(async (_input: unknown, _options: unknown) => answer());
    const adviser = new ForegroundAdviser(() => ({ ...config(), connection: 'host', decisionProvider: 'Choice' }),
      fetcher, () => now, () => ({ request } as any));
    expect(await adviser.advise(scene())).toMatchObject({ kind: 'advice', reading: 'focused' });
    expect(request.mock.calls[0][1]).toMatchObject({ provider: 'Choice' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('accepts reasoning independently of reading confidence and does not grant action or timing authority', async () => {
    let request: any;
    const adviser = new ForegroundAdviser(() => ({ ...config(), reasoningEnabled: true, reasoningModel: 'local-model' }),
      (async (_url, init) => { request = JSON.parse(String(init?.body));
        const raw = answer('connected', 'respond', .55);
        return new Response(JSON.stringify({ ...raw, answers: { ...raw.answers,
          reasoning: { choice: 'deliberate', confidence: .97, probabilities: { immediate: .01, routine: .02, deliberate: .97 } } } }));
      }) as typeof fetch, () => now);
    const input = scene([tail({ type: 'game.chat', text: 'While travelling normally, compare the supports for the bridge.' })]);
    const advice = await adviser.advise(input);
    expect(advice).toMatchObject({ kind: 'advice', reasoning: 'deliberate', reasoningProbability: .97, defer: false });
    expect(advice.reading).toBeUndefined();
    expect(request.questions.reasoning.criteria).toHaveProperty('immediate');
    expect(request.questions).not.toHaveProperty('timing');
  });

  it('inherits reasoning on a low probability or invalid choice and omits the question by default', async () => {
    for (const reasoning of [undefined, { choice: 'deliberate', confidence: .5, probabilities: { immediate: .1, routine: .4, deliberate: .5 } },
      { choice: 'deliberate', confidence: .05, probabilities: { immediate: .9, routine: .05, deliberate: .05 } }]) {
      const adviser = new ForegroundAdviser(() => ({ ...config(), reasoningEnabled: true, reasoningModel: 'local-model' }),
        (async () => new Response(JSON.stringify({ answers: { reasoning } }))) as typeof fetch, () => now);
      expect((await adviser.advise(scene())).reasoning).toBeUndefined();
    }
    let request: any;
    const ordinary = new ForegroundAdviser(config, (async (_url, init) => {
      request = JSON.parse(String(init?.body)); return new Response(JSON.stringify(answer()));
    }) as typeof fetch, () => now);
    await ordinary.advise(scene()); expect(request.questions).not.toHaveProperty('reasoning');
  });

  it('caller cancellation releases a blocked classifier without waiting for its timeout', async () => {
    const controller = new AbortController(); let started = false;
    const adviser = new ForegroundAdviser(config, (async () => {
      started = true; return new Promise<Response>(() => {});
    }) as typeof fetch, () => now);
    const pending = adviser.advise(scene(), controller.signal);
    expect(started).toBe(true); controller.abort();
    expect((await pending).kind).toBe('stale');
  });
  it('only a fresh structured queue tail without other substantive input is eligible', () => {
    expect(queueTailOpportunity([tail()], now)?.cursor).toBe(42);
    for (const event of [tail({ type: 'game.chat', text: '继续等我', tags: ['snapshot'] }),
      tail({ type: 'game.task', text: '移动失败了' }), tail({ type: 'game.combat', text: '正在掉血' }),
      tail({ blobs: [{ handle: 'mem:picture', mime: 'image/png', fallbackText: '观察' }] }),
      tail({ source: 'persona', type: 'planning', origin: 'internal' }), tail({ blobs: [{ handle: 'mem:picture', mime: 'image/png', fallbackText: '观察' }], type: 'game.visual' })]) {
      expect(queueTailOpportunity([tail(),event], now)).toBeNull();
    }
    expect(queueTailOpportunity([tail({ ts: new Date(now-1001).toISOString() })], now)).toBeNull();
    expect(queueTailOpportunity([tail({ meta: { minecraftQueueTail: { schemaVersion: 1, taskId: 7, stepIndex: 0, stepCount: 3 } } })], now)).toBeNull();
  });

  it('high probability advice chooses a shorter history and defers only the eligible observation', async () => {
    let request: any;
    const adviser = new ForegroundAdviser(config, (async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(answer()));
    }) as typeof fetch, () => now);
    const result = await adviser.advise(scene());
    expect(result).toMatchObject({ kind: 'advice', reading: 'focused', defer: true, cursors: [42] });
    expect(JSON.stringify(request.state)).toContain('把借来的工具还给原主人');
    expect(JSON.stringify(request.state)).toContain('尚未完成');
    const withChat = await new ForegroundAdviser(config, (async () => new Response(JSON.stringify(answer()))) as typeof fetch, () => now)
      .advise(scene([tail(),tail({ type: 'game.chat', meta: undefined, text: '请马上回答' })]));
    expect(withChat.defer).toBe(false);
  });

  it('uncertainty, malformed probabilities, unavailable service and timeout keep ordinary decisions', async () => {
    const bad = answer(); bad.answers.reading.probabilities.focused = 1.2;
    for (const raw of [answer('focused','continue',.55), bad, {}] as any[]) {
      // The timing answer is independently invalidated to exercise the fail-open path.
      if ('answers' in raw) raw.answers.timing = raw.answers.reading as any;
      const result = await new ForegroundAdviser(config, (async () => new Response(JSON.stringify(raw))) as typeof fetch, () => now).advise(scene());
      expect(result.defer).toBe(false);
      expect(result.reading).toBeUndefined();
    }
    const result = await new ForegroundAdviser(() => ({ ...config(), timeoutMs: 5 }),
      (() => new Promise(() => {})) as typeof fetch, () => now).advise(scene());
    expect(result.kind).toBe('timeout'); expect(result.defer).toBe(false);
    const offline = await new ForegroundAdviser(config, (async () => { throw new Error('offline'); }) as typeof fetch, () => now).advise(scene());
    expect(offline.kind).toBe('unavailable'); expect(offline.defer).toBe(false);
  });

  it('discarded configuration, reset and late queue observations cannot authorize a delay', async () => {
    let clock = now;
    const cfg = config();
    for (const change of ['config','reset','age']) {
      clock = now;
      let finish!: (response: Response) => void;
      const adviser = new ForegroundAdviser(() => cfg, (() => new Promise(resolve => { finish = resolve; })) as typeof fetch, () => clock);
      const pending = adviser.advise(scene());
      if (change === 'config') cfg.deferQueueTail = false;
      else if (change === 'reset') adviser.reset();
      else clock += 1001;
      finish(new Response(JSON.stringify(answer())));
      const result = await pending;
      expect(result.defer).toBe(false);
      if (change !== 'age') expect(result.kind).toBe('stale');
      cfg.deferQueueTail = true;
    }
  });

  it('bounds large scene text and suppresses overlapping or repeated requests', async () => {
    let body = '';
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
      body = String(init?.body); return new Response(JSON.stringify(answer()));
    });
    const adviser = new ForegroundAdviser(config, fetcher as typeof fetch, () => now);
    const long = (head: string, end: string) => head + '中间的较旧细节'.repeat(10000) + end;
    const input = scene(Array.from({ length: 100 }, () => tail({ text: long('仍在执行', '尚未抵达') })));
    input.facts[0].text = long('观测来源及当前位置', '生命下降，下一步需核验');
    input.facts.push({ source: 'other', text: long('同伴在线', '对方尚未回应') });
    input.agenda = long('目标是归还装备', '尚未完成');
    input.intent.arguments = long('目的地', '不能替换队列');
    input.intent.receipt = long('受理时间', '终态失败，装备仍在自己身上');
    await adviser.advise(input);
    expect(body.length).toBeLessThan(3100);
    const request = JSON.parse(body);
    expect(request.state.observations).toHaveLength(3);
    expect(request.state.observations[0]).toMatchObject({ source: 'game', type: 'game.task.queue', cursor: 42,
      at: tail().ts });
    for (const value of ['仍在执行', '尚未抵达', '观测来源及当前位置', '生命下降', '同伴在线', '对方尚未回应',
      '目标是归还装备', '尚未完成', '目的地', '不能替换队列', '受理时间', '终态失败，装备仍在自己身上']) expect(body).toContain(value);
    expect(request.state.queueTail).toEqual(tail().meta!.minecraftQueueTail);
    expect((await adviser.advise(input)).kind).toBe('cooldown');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
