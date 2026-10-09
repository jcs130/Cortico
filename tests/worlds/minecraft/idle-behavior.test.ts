import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IdleBehaviorController,
  type IdleBehaviorConfig,
  type IdleBehaviorEvent,
  type IdleBehaviorScene,
} from '../../../src/worlds/minecraft/idle-behavior.ts';

const endpoint = 'http://localhost:45678/judge';
const candidates = [
  { id: 'look-around', label: '平缓地环顾四周' },
  { id: 'look-sky', label: '抬头看看天空' },
  { id: 'look-ground', label: '低头看看脚边' },
  { id: 'inventory', label: '查看自己的背包' },
  { id: 'look-flower', label: '看看附近可见的花' },
];

function reply(choice: string, ids = candidates.map(candidate => candidate.id)): Response {
  return new Response(JSON.stringify({ answers: { action: {
    choice, confidence: 1, probabilities: Object.fromEntries([...ids, 'wait'].map(id => [id, id === choice ? 1 : 0])),
  } }, latency_ms: 17 }), { headers: { 'content-type': 'application/json' } });
}

function distributionReply(probabilities: Record<string, number>, choice = 'wait'): Response {
  return new Response(JSON.stringify({ answers: { action: {
    choice, confidence: probabilities[choice], probabilities,
  } }, latency_ms: 17 }), { headers: { 'content-type': 'application/json' } });
}

function rig(options: {
  config?: Partial<IdleBehaviorConfig>;
  fetchImpl?: typeof fetch;
  execute?: (id: string, scene: IdleBehaviorScene, signal: AbortSignal) => Promise<void>;
  random?: () => number;
} = {}) {
  let scene: IdleBehaviorScene | null = {
    generation: 'connection:1/body:1', state: { time: 'day', visiblePlayers: [] },
    candidates: [...candidates],
  };
  const config: IdleBehaviorConfig = {
    enabled: true, selector: 'random', endpoint, timeoutMs: 100,
    minIdleMs: 1_000, minIntervalMs: 12_000, maxIntervalMs: 28_000,
    ...options.config,
  };
  const events: IdleBehaviorEvent[] = [];
  const executed: Array<{ id: string; scene: IdleBehaviorScene; signal: AbortSignal }> = [];
  const controller = new IdleBehaviorController({
    config: () => config, random: options.random ?? (() => 0),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    host: {
      scene: () => scene,
      execute: async (id, value, signal) => {
        executed.push({ id, scene: value, signal });
        await options.execute?.(id, value, signal);
      },
      record: event => events.push(event),
    },
  });
  return { controller, config, events, executed,
    scene: () => scene, setScene: (value: IdleBehaviorScene | null) => { scene = value; } };
}

async function begin(controller: IdleBehaviorController): Promise<void> {
  controller.tick();
  await vi.advanceTimersByTimeAsync(1_000);
  controller.tick();
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => vi.useRealTimers());

describe('IdleBehaviorController', () => {
  it('selects an action with above-chance confidence and records its probability', async () => {
    const probabilities = Object.fromEntries([...candidates.map(candidate => candidate.id), 'wait']
      .map(id => [id, id === 'look-around' ? 0.8 : 0.04]));
    const r = rig({ config: { selector: 'decision' }, fetchImpl: async () => new Response(JSON.stringify({
      answers: { action: { type: 'choice', choice: 'look-around', confidence: (0.8 - 1 / 6) / (1 - 1 / 6), probabilities } },
    })) });
    await begin(r.controller);
    expect(r.executed.map(action => action.id)).toEqual(['look-around']);
    expect(r.events.find(event => event.event === 'action-started')).toMatchObject({ confidence: 0.8 });
    expect(r.events.some(event => event.event === 'decision-fallback')).toBe(false);
  });

  it('starts one arrival look immediately and resumes ordinary intervals afterwards', async () => {
    const r = rig({ config: { afterArrival: true, minIdleMs: 60_000 } });
    r.controller.tick();
    expect(r.executed).toHaveLength(0);
    expect(r.controller.startAfterArrival(['look-sky', 'look-ground'])).toBe(true);
    expect(r.executed.map(action => action.id)).toEqual(['look-sky']);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.events.at(-1)).toMatchObject({ event: 'action-completed', actionId: 'look-sky' });
    r.config.minIdleMs = 0;
    await vi.advanceTimersByTimeAsync(11_999);
    r.controller.tick();
    expect(r.executed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    r.controller.tick();
    expect(r.executed.map(action => action.id)).toEqual(['look-sky', 'look-around']);
  });

  it('arrival looks bypass a preceding interval and do not query the selector', async () => {
    const r = rig({ config: { afterArrival: true }, fetchImpl: async () => { throw Error('no request expected'); } });
    await begin(r.controller);
    r.config.selector = 'decision';
    expect(r.controller.startAfterArrival(['look-sky'])).toBe(true);
    expect(r.executed.map(action => action.id)).toEqual(['look-around', 'look-sky']);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('arrival presentation uses current permission and remains cancellable', async () => {
    const r = rig({ config: { afterArrival: true }, execute: () => new Promise(() => {}) });
    expect(r.controller.startAfterArrival(['look-ground'])).toBe(true);
    const action = r.executed[0];
    expect(action.signal.aborted).toBe(false);
    r.setScene(null);
    r.controller.tick();
    expect(action.signal.aborted).toBe(true);
    expect(r.controller.startAfterArrival(['look-ground'])).toBe(false);
    expect(r.events.at(-1)).toMatchObject({ event: 'cancelled', reason: 'scene-unavailable' });
  });

  it('does not start arrival presentation when disabled or no permitted look exists', () => {
    const r = rig();
    expect(r.controller.startAfterArrival(['look-ground'])).toBe(false);
    r.config.afterArrival = true;
    r.config.enabled = false;
    expect(r.controller.startAfterArrival(['look-ground'])).toBe(false);
    r.config.enabled = true;
    expect(r.controller.startAfterArrival(['unavailable-look'])).toBe(false);
    expect(r.executed).toHaveLength(0);
  });

  it('requires a continuous idle scene and respects the interval after each action', async () => {
    const r = rig();
    r.controller.tick();
    await vi.advanceTimersByTimeAsync(600);
    r.setScene(null);
    r.controller.tick();
    r.setScene({ generation: 'connection:1/body:2', state: {}, candidates });
    r.controller.tick();
    await vi.advanceTimersByTimeAsync(999);
    r.controller.tick();
    expect(r.executed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    r.controller.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.executed.map(action => action.id)).toEqual(['look-around']);
    await vi.advanceTimersByTimeAsync(11_999);
    r.controller.tick();
    expect(r.executed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    r.controller.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.executed.map(action => action.id)).toEqual(['look-around', 'look-sky']);
  });

  it('samples the configured interval and never overlaps a running action', async () => {
    let complete!: () => void;
    const r = rig({ random: () => 0.5, execute: () => new Promise(resolve => { complete = resolve; }) });
    await begin(r.controller);
    await vi.advanceTimersByTimeAsync(90_000);
    r.controller.tick();
    expect(r.executed).toHaveLength(1);
    complete();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(19_999);
    r.controller.tick();
    expect(r.executed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    r.controller.tick();
    expect(r.executed).toHaveLength(2);
  });

  it('uses only current candidates and excludes the three most recent actions', async () => {
    const requests: Record<string, any>[] = [];
    const r = rig({ config: { selector: 'decision' }, fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const ids = Object.keys(body.questions.action.criteria).filter(id => id !== 'wait');
      return reply(ids[0], ids);
    } });
    await begin(r.controller);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(12_000);
      r.controller.tick();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(r.executed.map(action => action.id)).toEqual([
      'look-around', 'look-sky', 'look-ground', 'inventory', 'look-around',
    ]);
    expect(requests[0].state).toEqual({ time: 'day', visiblePlayers: [] });
    expect(requests[0].questions.action.type).toBe('choice');
    expect(requests[3].questions.action.criteria).not.toHaveProperty('look-around');
    expect(requests[3].questions.action.criteria).not.toHaveProperty('look-sky');
    expect(requests[3].questions.action.criteria).not.toHaveProperty('look-ground');
    expect(requests.every(body => Object.hasOwn(body.questions.action.criteria, 'wait'))).toBe(true);
  });

  it('rotates a small catalogue by least recent use instead of exhausting it', async () => {
    const r = rig();
    r.scene()!.candidates = candidates.slice(0, 2);
    await begin(r.controller);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(12_000);
      r.controller.tick();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(r.executed.map(action => action.id)).toEqual(['look-around', 'look-sky', 'look-around', 'look-sky']);
  });

  it('lets the model choose wait without executing or repeatedly asking each tick', async () => {
    let requests = 0;
    const r = rig({ config: { selector: 'decision' }, fetchImpl: async () => { requests++; return reply('wait'); } });
    await begin(r.controller);
    expect(r.executed).toHaveLength(0);
    expect(r.events.filter(event => event.event === 'decision-wait')).toHaveLength(1);
    for (let i = 0; i < 11; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      r.controller.tick();
    }
    expect(requests).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    r.controller.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toBe(2);
  });

  const spread = { 'look-around': 0.2, 'look-sky': 0.15, 'look-ground': 0,
    inventory: 0.2, 'look-flower': 0.1, wait: 0.35 };

  it.each([
    [0, 'look-around', 0.2], [0.21, 'look-sky', 0.15], [0.36, 'inventory', 0.2],
    [0.56, 'look-flower', 0.1], [0.9, 'wait', 0.35],
  ] as const)('samples the complete model distribution at random point %s, with the selected probability', async (point, choice, confidence) => {
    const fetchCall = vi.fn(async () => distributionReply(spread));
    const r = rig({ config: { selector: 'decision', decisionPolicy: 'sample' },
      random: () => point, fetchImpl: fetchCall });
    await begin(r.controller);
    expect(fetchCall).toHaveBeenCalledTimes(1);
    if (choice === 'wait') {
      expect(r.executed).toHaveLength(0);
      expect(r.events.find(event => event.event === 'decision-wait'))
        .toMatchObject({ confidence, modelChoice: 'wait', latencyMs: 17 });
    } else {
      expect(r.executed.map(action => action.id)).toEqual([choice]);
      expect(r.events.find(event => event.event === 'action-started'))
        .toMatchObject({ actionId: choice, confidence, modelChoice: 'wait', latencyMs: 17 });
    }
    expect(r.events.some(event => event.event === 'decision-fallback')).toBe(false);
  });

  it.each([undefined, 'choice'] as const)('keeps argmax behaviour for decisionPolicy=%s', async decisionPolicy => {
    const r = rig({ config: { selector: 'decision', decisionPolicy },
      random: () => 0, fetchImpl: async () => distributionReply(spread) });
    await begin(r.controller);
    expect(r.executed).toHaveLength(0);
    expect(r.events.find(event => event.event === 'decision-wait')).toMatchObject({ confidence: 0.35 });
    expect(r.events.find(event => event.event === 'decision-wait')).not.toHaveProperty('modelChoice');
  });

  it.each([[0, 'look-sky'], [0.3, 'look-flower'], [0.6, 'wait'], [1, 'wait']] as const)
    ('never samples zero-mass options at random point %s, including distribution boundaries', async (point, choice) => {
      const probabilities = { 'look-around': 0, 'look-sky': 0.3, 'look-ground': 0,
        inventory: 0, 'look-flower': 0.3, wait: 0.4 };
      const r = rig({ config: { selector: 'decision', decisionPolicy: 'sample' },
        random: () => point, fetchImpl: async () => distributionReply(probabilities) });
      await begin(r.controller);
      expect(r.executed.map(action => action.id)).toEqual(choice === 'wait' ? [] : [choice]);
      const event = r.events.find(event => event.event === 'action-started' || event.event === 'decision-wait');
      expect(event).toMatchObject({ confidence: probabilities[choice], modelChoice: 'wait' });
      expect(event?.confidence).toBeGreaterThan(0);
    });

  it('filters recent sampled actions rather than the original model argmax', async () => {
    const requests: Array<Record<string, string>> = [];
    const r = rig({ config: { selector: 'decision', decisionPolicy: 'sample' }, random: () => 0,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const criteria = body.questions.action.criteria as Record<string, string>;
        requests.push(criteria);
        const ids = Object.keys(criteria);
        // The response still favours wait; sampling the first weighted action owns recency.
        return distributionReply(Object.fromEntries(ids.map(id => [id, id === 'wait' ? 0.4 : 0.6 / (ids.length - 1)])));
      } });
    await begin(r.controller);
    await vi.advanceTimersByTimeAsync(12_000);
    r.controller.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.executed.map(action => action.id)).toEqual(['look-around', 'look-sky']);
    expect(requests[1]).not.toHaveProperty('look-around');
    expect(requests[1]).toHaveProperty('wait');
  });

  it('does not sample or execute a late distribution after synchronous cancellation', async () => {
    let finish!: (value: Response) => void;
    const random = vi.fn(() => 0.2);
    const r = rig({ config: { selector: 'decision', decisionPolicy: 'sample' }, random,
      fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
    await begin(r.controller);
    expect(random).not.toHaveBeenCalled();
    r.controller.cancel('incoming-player');
    finish(distributionReply(spread));
    await vi.advanceTimersByTimeAsync(0);
    expect(random).not.toHaveBeenCalled();
    expect(r.executed).toHaveLength(0);
    expect(r.events.at(-1)).toMatchObject({ event: 'cancelled', reason: 'incoming-player' });
    expect(r.events.some(event => event.event === 'decision-fallback' || event.event === 'decision-wait')).toBe(false);
  });

  it('revokes an in-flight choice when a task or combat takes the body', async () => {
    let finish!: (value: Response) => void;
    let requestSignal: AbortSignal | undefined;
    let requests = 0;
    const r = rig({ config: { selector: 'decision' }, fetchImpl: (_url, init) => {
      requests++;
      requestSignal = init?.signal ?? undefined;
      return new Promise(resolve => { finish = resolve; });
    } });
    await begin(r.controller);
    expect(r.controller.active).toBe(true);
    r.controller.tick();
    expect(requests).toBe(1);
    r.setScene(null);
    r.controller.tick();
    expect(r.controller.active).toBe(false);
    expect(requestSignal?.aborted).toBe(true);
    finish(reply('look-sky'));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.executed).toHaveLength(0);
    expect(r.events.filter(event => event.event === 'cancelled')).toHaveLength(1);
    expect(r.events.some(event => event.event === 'decision-fallback')).toBe(false);
  });

  it('cancels an executing action synchronously and discards its late completion', async () => {
    let finish!: () => void;
    const r = rig({ execute: () => new Promise(resolve => { finish = resolve; }) });
    await begin(r.controller);
    expect(r.controller.active).toBe(true);
    expect(r.executed[0].signal.aborted).toBe(false);
    r.controller.cancel('player-chat');
    expect(r.controller.active).toBe(false);
    expect(r.executed[0].signal.aborted).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.events.some(event => event.event === 'action-completed')).toBe(false);
    expect(r.events.at(-1)).toMatchObject({ event: 'cancelled', reason: 'player-chat' });
  });

  it('cancels the active lease when disabled and requires a fresh idle period after enabling', async () => {
    let finish!: () => void;
    const r = rig({ execute: () => new Promise(resolve => { finish = resolve; }) });
    await begin(r.controller);
    r.config.enabled = false;
    r.controller.tick();
    expect(r.controller.active).toBe(false);
    expect(r.executed[0].signal.aborted).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    r.config.enabled = true;
    r.controller.tick();
    await vi.advanceTimersByTimeAsync(999);
    r.controller.tick();
    expect(r.executed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    r.controller.tick();
    expect(r.executed).toHaveLength(2);
  });

  it('discards a response from a changed scene even before the next tick notices it', async () => {
    let finish!: (value: Response) => void;
    const r = rig({ config: { selector: 'decision' }, fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
    await begin(r.controller);
    r.setScene({ generation: 'connection:2/body:1', state: {}, candidates });
    finish(reply('look-around'));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.executed).toHaveLength(0);
    expect(r.events.at(-1)).toMatchObject({ event: 'decision-stale', reason: 'scene-changed' });
  });

  it('rechecks availability after the model reply before executing its choice', async () => {
    let finish!: (value: Response) => void;
    const r = rig({ config: { selector: 'decision' }, fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
    await begin(r.controller);
    r.scene()!.candidates = candidates.filter(candidate => candidate.id !== 'look-sky');
    finish(reply('look-sky'));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.executed).toHaveLength(0);
    expect(r.events.at(-1)).toMatchObject({ event: 'decision-stale', reason: 'action-unavailable', actionId: 'look-sky' });
  });

  it.each([
    { choice: 'attack', confidence: 1, probabilities: { attack: 1 } },
    { choice: 'look-around', confidence: 0.8, probabilities: { 'look-around': 1, 'look-sky': 0, 'look-ground': 0, inventory: 0, 'look-flower': 0, wait: 0 } },
    { choice: 'look-around', confidence: 0.5, probabilities: { 'look-around': 0.5, 'look-sky': 0.5, 'look-ground': 0.5, inventory: 0, 'look-flower': 0, wait: 0 } },
    { choice: 'wait', confidence: -0.1, probabilities: { 'look-around': 0, 'look-sky': 0, 'look-ground': 0, inventory: 0, 'look-flower': 0, wait: 1 } },
    { choice: 'wait', confidence: 1, probabilities: { wait: 1 } },
  ])('records invalid responses and uses a current random candidate as fallback', async action => {
    const r = rig({ config: { selector: 'decision' }, fetchImpl: async () =>
      new Response(JSON.stringify({ answers: { action } })) });
    await begin(r.controller);
    expect(r.executed.map(action => action.id)).toEqual(['look-around']);
    expect(r.events.slice(0, 2)).toMatchObject([
      { event: 'decision-error', reason: 'invalid-response' },
      { event: 'decision-fallback', reason: 'invalid-response', actionId: 'look-around' },
    ]);
  });

  it.each(['transport', 'http', 'json', 'state', 'endpoint'])('falls back on %s failure without an unhandled rejection', async failure => {
    const r = rig({ config: { selector: 'decision', ...(failure === 'endpoint' ? { endpoint: '' } : {}) },
      fetchImpl: async () => {
        if (failure === 'transport') throw new Error('service unavailable');
        if (failure === 'http') return new Response('', { status: 503 });
        return new Response('malformed-json');
      } });
    if (failure === 'state') r.scene()!.state.self = r.scene()!.state;
    await begin(r.controller);
    expect(r.executed.map(action => action.id)).toEqual(['look-around']);
    expect(r.events.filter(event => event.event === 'decision-error')).toHaveLength(1);
    expect(r.events.filter(event => event.event === 'decision-fallback')).toHaveLength(1);
  });

  it('times out, aborts the request, and ignores its late reply without overlapping another request', async () => {
    let finish!: (value: Response) => void;
    let requestSignal: AbortSignal | undefined;
    let requests = 0;
    const r = rig({ config: { selector: 'decision' }, fetchImpl: (_url, init) => {
      requests++;
      requestSignal = init?.signal ?? undefined;
      return new Promise(resolve => { finish = resolve; });
    } });
    await begin(r.controller);
    await vi.advanceTimersByTimeAsync(100);
    expect(requestSignal?.aborted).toBe(true);
    expect(r.executed.map(action => action.id)).toEqual(['look-around']);
    expect(r.events.some(event => event.event === 'decision-fallback' && event.reason === 'timeout')).toBe(true);
    await vi.advanceTimersByTimeAsync(12_000);
    r.controller.tick();
    expect(requests).toBe(1);
    finish(reply('look-sky'));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.executed).toHaveLength(1);
  });

  it('does not fall back when a failed request returns after its scene becomes busy', async () => {
    let reject!: (error: Error) => void;
    const r = rig({ config: { selector: 'decision' }, fetchImpl: () => new Promise((_resolve, fail) => { reject = fail; }) });
    await begin(r.controller);
    r.setScene(null);
    reject(new Error('closed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.executed).toHaveLength(0);
    expect(r.events.some(event => event.event === 'decision-fallback')).toBe(false);
  });

  it('records execution failure and stops permanently while a cancelled action settles', async () => {
    let reject!: (error: Error) => void;
    const r = rig({ execute: () => new Promise((_resolve, fail) => { reject = fail; }) });
    await begin(r.controller);
    reject(new Error('lease revoked'));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.events.at(-1)).toMatchObject({ event: 'action-error', reason: 'Error: lease revoked' });
    await vi.advanceTimersByTimeAsync(12_000);
    r.controller.tick();
    r.controller.stop();
    expect(r.executed.at(-1)!.signal.aborted).toBe(true);
    reject(new Error('cancelled'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    r.controller.tick();
    expect(r.executed).toHaveLength(2);
    expect(r.events.filter(event => event.event === 'action-error')).toHaveLength(1);
  });
});
