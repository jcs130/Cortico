import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CortiVSocialAttention, type FastAttentionConfig } from '../../bots/cortiv/persona/attention-adviser.ts';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import type { EventEnvelope } from '../../src/core/types.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';

const NOW = Date.parse('2026-10-04T02:30:00+08:00');
const config = (): FastAttentionConfig => ({ enabled: true, endpoint: 'http://decision.invalid/v1/systemone',
  timeoutMs: 180, minConfidence: 0.75, cooldownMs: 15_000 });
const event = (patch: Partial<EventEnvelope> = {}): EventEnvelope => ({
  cursor: 41, type: 'mymc.event', source: 'mymc', origin: 'external', ts: new Date(NOW).toISOString(),
  text: '[Minecraft] 玩家 Alex 连续挥动手臂。', senderKey: 'Alex',
  meta: { minecraftPlayerObservation: { schemaVersion: 1, kind: 'wave', playerName: 'Alex',
    entityId: 20, visible: true, distance: 2 } }, ...patch,
});
const response = (choice = 'interaction', confidence = 0.9): Response => new Response(JSON.stringify({
  answers: { attention: { type: 'choice', choice, confidence,
    probabilities: { interaction: 0.9, ambient: 0.05, uncertain: 0.05 } } }, latency_ms: 41,
}));

describe('CortiV bounded social attention', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('uses one short scene and question, adds inferred advice without issuing actions or changing facts', async () => {
    const injected: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => response());
    const api = makeFakeHarnessApi({ injectInternal: text => injected.push(text) });
    const adviser = new CortiVSocialAttention(config, fetchImpl, () => NOW);
    const original = event();
    const before = structuredClone(original);
    await adviser.observe([original], api);
    expect(original).toEqual(before);
    const payload = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(typeof payload.state).toBe('object');
    expect(Object.keys(payload.questions)).toEqual(['attention']);
    expect(JSON.stringify(payload).length).toBeLessThan(650);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain('观察事件#41');
    expect(injected[0]).toContain('推测');
    expect(injected[0]).toContain('不证明');
    expect(injected[0]).toContain('自行决定');
  });
  it('does no model work for absent metadata, chat-body spoofing, occlusion, far or stale observations', async () => {
    const fetchImpl = vi.fn(async () => response());
    const adviser = new CortiVSocialAttention(config, fetchImpl, () => NOW);
    const observation = event().meta!.minecraftPlayerObservation as Record<string, unknown>;
    for (const item of [event({ meta: undefined }), event({ type: 'mymc.chat' }),
      event({ meta: { minecraftPlayerObservation: { ...observation, visible: false } } }),
      event({ meta: { minecraftPlayerObservation: { ...observation, distance: 20 } } }),
      event({ meta: { minecraftPlayerObservation: { ...observation, kind: '__proto__' } } }),
      event({ ts: new Date(NOW - 31_000).toISOString() })]) {
      await adviser.observe([item], makeFakeHarnessApi());
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('keeps low confidence, inconsistent probabilities and outages neutral', async () => {
    const injected = vi.fn();
    for (const answer of [new Response(JSON.stringify({ answers: { attention: { choice: 'interaction',
      confidence: 0.6, probabilities: { interaction: 0.6, ambient: 0.3, uncertain: 0.1 } } } })),
      response('interaction', 0.99), new Response('', { status: 503 }), response('__proto__')]) {
      await new CortiVSocialAttention(config, async () => answer, () => NOW)
        .observe([event()], makeFakeHarnessApi({ injectInternal: injected }));
    }
    expect(injected).not.toHaveBeenCalled();
  });
  it('does not hang the delivery batch even if transport ignores abort', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImpl = vi.fn((_url, opts) => {
        signal = opts?.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }) as typeof fetch;
      const injected = vi.fn();
      const adviser = new CortiVSocialAttention(config, fetchImpl, () => NOW);
      const pending = adviser.observe([event()], makeFakeHarnessApi({ injectInternal: injected }));
      await vi.advanceTimersByTimeAsync(180);
      await pending;
      expect(signal?.aborted).toBe(true);
      expect(injected).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('bounds concurrent work, deduplicates each player and rejects disabled or reset late replies', async () => {
    let current = config();
    let release!: (value: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch;
    const adviser = new CortiVSocialAttention(() => current, fetchImpl, () => NOW);
    const injected = vi.fn();
    const api = makeFakeHarnessApi({ injectInternal: injected });
    const pending = adviser.observe([event()], api);
    expect(adviser.observe([event({ cursor: 42 })], api)).toBeUndefined();
    current = { ...current, enabled: false };
    release(response());
    await pending;
    expect(injected).not.toHaveBeenCalled();
    current = config();
    expect(adviser.observe([event()], api)).toBeUndefined();
    adviser.reset();
    const fresh = adviser.observe([event()], api);
    adviser.reset();
    release(response());
    await fresh;
    expect(injected).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('adds advice through the awaited Persona delivery hook in the same batch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortiv-social-'));
    try {
      vi.stubGlobal('fetch', vi.fn(async () => response()));
      const persona = new CortiV({ memoryDir: dir, fastAttention: config });
      const injected: string[] = [];
      persona.attach(makeFakeHarnessApi({ injectInternal: text => injected.push(text) }));
      await persona.onDelivery({ events: [event({ ts: new Date().toISOString() })] });
      expect(injected.some(text => text.includes('[快判断/推测]'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
