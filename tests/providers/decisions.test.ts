import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeCfg, makeTmpDir } from '../core/helpers.ts';
import { nullLogger } from '../../src/core/util.ts';
import { ProviderRegistry } from '../../src/providers/registry.ts';
import { decisionHost } from '../../src/providers/decisions.ts';
import type { ModelObservation } from '../../src/core/model-observer.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); cleanups.splice(0).forEach(fn => fn()); });
const input = { state: { privateField: 'scene-private' }, questions: { route: { type: 'choice' as const, instructions: 'Choose.', criteria: { next: 'Continue', wait: 'Wait' } } } };
const reply = () => new Response(JSON.stringify({ answers: { route: { type: 'choice', choice: 'next', confidence: 1, probabilities: { next: 1, wait: 0 } } } }));
function fixture() {
  const tmp = makeTmpDir(); cleanups.push(tmp.cleanup); const root = join(tmp.dir, 'providers'); mkdirSync(root);
  const cfg = makeCfg({ decisionProvider: 'Default', providers: {
    Default: { kind: 'system-one', baseUrl: 'https://one.test/v1', spec: { model: 'one', thinking: false } },
    Override: { kind: 'system-one', baseUrl: 'https://two.test/v1', spec: { model: 'two', thinking: false } },
  } });
  const registry = new ProviderRegistry(() => cfg.providers, { stateRoot: root, readBlob: () => null, keepThinking: () => true, log: nullLogger() });
  const observations: ModelObservation[] = []; let active = true;
  const host = decisionHost({ registry, config: () => cfg, caller: 'test', agentId: 'fixture', active: () => active, observe: e => observations.push(e) });
  return { cfg, host, observations, deactivate: () => { active = false; } };
}
it('inherits the host connection and isolates an explicit override without changing the default', async () => {
  const r = fixture(), sent: Array<{ url: string; body: any; session: string | null }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { sent.push({ url, body: JSON.parse(String(init.body)), session: new Headers(init.headers).get('x-litellm-session-id') }); return reply(); });
  await r.host.request(input); await r.host.request(input, { provider: 'Override' }); await r.host.request(input);
  expect(sent.map(s => s.body.model)).toEqual(['one', 'two', 'one']);
  expect(sent.map(s => s.url)).toEqual(['https://one.test/v1/systemone', 'https://two.test/v1/systemone', 'https://one.test/v1/systemone']);
  expect(r.cfg.decisionProvider).toBe('Default');
  expect(new Set(sent.map(s => s.session)).size).toBe(3);
  expect(sent.every(s => !!s.session)).toBe(true);
  expect(JSON.stringify(r.observations)).not.toContain('scene-private');
  expect(r.observations.at(-1)).toMatchObject({ kind: 'finished', attempts: [{ inputTokens: null, cachedInputTokens: null, executionMs: null, outcome: 'completed' }] });
});
it.each(['connection', 'model', 'lifetime'])('discards late answers after %s changes', async change => {
  const r = fixture(); let finish!: (value: Response) => void;
  vi.stubGlobal('fetch', () => new Promise<Response>(resolve => { finish = resolve; }));
  const pending = r.host.request(input);
  await vi.waitFor(() => expect(finish).toBeDefined());
  if (change === 'connection') r.cfg.decisionProvider = 'Override';
  if (change === 'model') r.cfg.providers.Default.spec!.model = 'changed';
  if (change === 'lifetime') r.deactivate();
  finish(reply());
  await expect(pending).rejects.toThrow(change === 'lifetime' ? 'inactive' : 'changed');
});
it('ends at its deadline even when a transport ignores cancellation', async () => {
  vi.useFakeTimers(); const r = fixture();
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
  const pending = expect(r.host.request(input, { timeoutMs: 50 })).rejects.toThrow('aborted');
  await vi.advanceTimersByTimeAsync(51); await pending;
  expect(r.observations.at(-1)).toMatchObject({ kind: 'finished', attempts: [{ outcome: 'aborted' }] });
});
it('does not fall back to the main model when no decision connection was selected', async () => {
  const r = fixture(); r.cfg.decisionProvider = '';
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(r.host.request(input)).rejects.toThrow('No decision connection');
  expect(fetcher).not.toHaveBeenCalled();
});
