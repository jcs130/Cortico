import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { ReferenceLibrary, REFERENCE_LIBRARY_DEFAULTS } from '../../bots/cortiv/persona/reference-library.ts';
import { ReferenceRouting } from '../../bots/cortiv/persona/reference-routing.ts';
import { FAST_REFERENCE_DEFAULTS } from '../../bots/cortiv/persona/reference-adviser.ts';
import { FOREGROUND_CONTEXT_DEFAULTS } from '../../bots/cortiv/persona/foreground-context.ts';
import { functionCall, functionResult, itemText, message, type ContextRecord } from '../../src/protocol/open-responses/context.ts';
import type { EventEnvelope } from '../../src/core/types.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';
import { nullLogger } from '../../src/core/util.ts';

const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const NOW = Date.parse('2026-01-01T00:00:00Z');
const event = (patch: Partial<EventEnvelope> = {}): EventEnvelope => ({ cursor: 9, source: 'scene',
  type: 'scene.observation', origin: 'external', text: 'I have materials and want to try making a shelter.',
  ts: new Date(NOW).toISOString(), ...patch });

function rig() {
  const root = mkdtempSync(join(tmpdir(), 'reference-integration-')); roots.push(root);
  const config = { ...REFERENCE_LIBRARY_DEFAULTS, enabled: true, indexFiles: 'references/example/index.json' };
  const fast = { ...FAST_REFERENCE_DEFAULTS, enabled: true, endpoint: 'http://classifier.invalid/decide',
    minIntervalMs: 0, timeoutMs: 200 };
  const put = (file: string, value: unknown) => {
    mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), JSON.stringify(value));
  };
  const act = (id: string) => ({ id, title: id, requires: 'materials and permission', firstStep: 'observe a small area',
    verify: 'actual external result', leaveWhen: 'blocked prerequisites', capability: 'consult current World tools',
    sourceIds: ['source'], provenance: 'reference candidate, not a personal success' });
  put(config.indexFiles, { kind: 'imported_reference_index', version: 'example', categories: [
    { file: 'building.json', ideas: 'making shelters and gardens' }, { file: 'life.json', ideas: 'walking and caring for animals' },
  ] });
  put('references/example/building.json', { activities: [act('shelter'), act('garden')] });
  put('references/example/life.json', { activities: [act('walk')] });
  const library = new ReferenceLibrary({ config: () => config, normalize: path => path,
    read: path => requireRead(root, path), canonicalPath: path => realpathSync(join(root, path)) });
  const topics = library.descriptors();
  const answer = (confidence = 0.9) => new Response(JSON.stringify({ latency_ms: 20, answers: {
    topic: { type: 'choice', choice: topics[0].key, confidence, probabilities: {
      [topics[0].key]: confidence, [topics[1].key]: (1 - confidence) / 2, none: (1 - confidence) / 2 } },
  } }));
  return { root, config, fast, put, library, topics, answer };
}
const requireRead = (root: string, path: string): string => readFileSync(join(root, path), 'utf8');

describe('Persona progressive reference integration', () => {
  it('keeps asynchronous result evidence when later snapshots and a long accepted plan share a batch', async () => {
    const r = rig(); const requests: RequestInit[] = [];
    const notices: string[] = [];
    const router = new ReferenceRouting(r.library, () => r.fast, async (_url, init) => {
      requests.push(init!); return r.answer();
    }, () => NOW);
    const outcome = event({ cursor: 20, type: 'scene.result', text: 'Target: process the gathered material. '
      + 'Recorded plan with several preparatory steps. '.repeat(30)
      + 'Execution rejected: the selected material is not usable here. Consult the operation reference.' });
    await router.observe([outcome, event({ cursor: 21, tags: ['snapshot'], text: 'Unrelated current position.' }),
      event({ cursor: 22, tags: ['snapshot'], text: 'The queue is idle.' })], [],
    makeFakeHarnessApi({ injectInternal: text => notices.push(text) }), {
      tool: 'scene_do', arguments: JSON.stringify({ steps: ['prepare'.repeat(200)] }),
      receipt: 'Accepted into the queue. ' + 'Planning details. '.repeat(30) + 'Execution has not been verified.',
    });
    const state = JSON.parse(String(requests[0].body)).state;
    expect(state.observations).toHaveLength(1);
    expect(state.observations[0].cursor).toBe(outcome.cursor);
    expect(state.observations[0].text).toContain('Target: process');
    expect(state.observations[0].text).toContain('Execution rejected');
    expect(state.observations[0].text).toContain('[中间未展开]');
    expect(state.recentIntent.receipt).toContain('Execution has not been verified');
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(2400);
    expect(r.library.selected()?.topicKey).toBe(r.topics[0].key);
    expect(notices[0]).toContain('不是新目标或行动指令');
  });

  it('allows background topic advice after manual catalog browsing or an invalid manual detail', async () => {
    const r = rig(); const requests: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => { requests.push(init!); return r.answer(); }));
    const persona = new CortiV({ memoryDir: r.root, references: () => r.config, fastReference: () => r.fast });
    const api = makeFakeHarnessApi(); persona.attach(api);
    const tool = persona.declareSessions().find(session => session.id === 'main')!.tools().find(tool => tool.name === 'reference_guide')!;
    const ctx = { role: 'main', log: nullLogger() };
    await tool.handler({ operation: 'catalog' }, ctx);
    await persona.onDelivery({ events: [event({ ts: new Date().toISOString() })] });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(requests).toHaveLength(1);
    await tool.handler({ operation: 'detail', activity_id: 'shelter' }, ctx);
    await persona.onDelivery({ events: [event({ cursor: 10, ts: new Date().toISOString() })] });
    expect(requests).toHaveLength(1);
    const rejected = await tool.handler({ operation: 'detail', activity_id: 'missing' }, ctx);
    expect(rejected).toContain('没有活动 id');
    await persona.onDelivery({ events: [event({ cursor: 11, ts: new Date().toISOString() })] });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(requests).toHaveLength(2);
  });

  it('loads only topic cards from a validated fast judgment and reports evidence separately from actions', async () => {
    const r = rig(); const notices: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => r.answer());
    const router = new ReferenceRouting(r.library, () => r.fast, fetchImpl, () => NOW);
    const input = event(); const before = structuredClone(input);
    await router.observe([input], [{ source: 'scene', text: 'Current observations.' }], makeFakeHarnessApi({ injectInternal: text => notices.push(text) }));
    expect(input).toEqual(before);
    expect(r.library.context()).toContain('shelter：shelter');
    expect(r.library.context()).not.toContain('[完整活动');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('不是新目标或行动指令');
    expect(notices[0]).toContain('后台构思');
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).state.observations[0].cursor).toBe(input.cursor);
  });

  it('preserves manually opened directions and discards a late result after manual clear', async () => {
    const r = rig(); let release!: (value: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const notices: string[] = [];
    const router = new ReferenceRouting(r.library, () => r.fast, fetchImpl, () => NOW);
    const api = makeFakeHarnessApi({ injectInternal: text => notices.push(text) });
    const pending = router.observe([event()], [], api);
    r.library.guides(r.topics[1].key); router.onManualRead(true);
    release(r.answer()); await pending;
    await router.observe([event({ cursor: 10 })], [], api);
    expect(r.library.selected()?.topicKey).toBe(r.topics[1].key);
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(notices).toEqual([]);
    r.library.clear(); router.onManualRead(false);
    const later = router.observe([event({ cursor: 11 })], [], api);
    router.onManualRead(false); release(r.answer()); await later;
    expect(r.library.selected()).toBeNull(); expect(notices).toEqual([]);
  });

  it('does not apply a prior topic after newer external observations arrive during classification', async () => {
    const r = rig(); let release!: (value: Response) => void;
    const notices: string[] = [];
    const router = new ReferenceRouting(r.library, () => r.fast,
      () => new Promise<Response>(resolve => { release = resolve; }), () => NOW);
    const api = makeFakeHarnessApi({ injectInternal: text => notices.push(text) });
    const first = router.observe([event()], [], api);
    await router.observe([event({ cursor: 10, text: 'The current circumstances changed.' })], [], api);
    release(r.answer()); await first;
    expect(r.library.selected()).toBeNull(); expect(notices).toEqual([]);
    const fresh = router.observe([event({ cursor: 11 })], [], api);
    release(r.answer()); await fresh;
    expect(r.library.selected()?.topicKey).toBe(r.topics[0].key);
    expect(notices).toHaveLength(1);
  });

  it('keeps uncertainty, malformed indexes, changed sources and archived inputs out of routing authority', async () => {
    const r = rig(); const notices: string[] = [];
    const api = makeFakeHarnessApi({ injectInternal: text => notices.push(text) });
    const weak = vi.fn(async () => r.answer(0.55));
    const router = new ReferenceRouting(r.library, () => r.fast, weak, () => NOW);
    await router.observe([event()], [], api); expect(r.library.selected()).toBeNull();
    await router.observe([event({ contextDelivery: 'archive-only' })], [], api);
    expect(weak).toHaveBeenCalledTimes(1);
    let release!: (value: Response) => void;
    const fresh = new ReferenceRouting(r.library, () => r.fast,
      () => new Promise<Response>(resolve => { release = resolve; }), () => NOW);
    const pending = fresh.observe([event({ cursor: 11 })], [], api);
    r.put('references/example/building.json', { activities: [{ id: 'invalid' }] });
    release(r.answer()); await pending;
    expect(r.library.selected()).toBeNull(); expect(notices).toEqual([]);
    r.put(r.config.indexFiles, { invalid: true });
    expect(() => fresh.observe([event({ cursor: 12 })], [], api)).not.toThrow();
  });

  it('pages the real Persona tool and keeps the chosen current activity across compact foreground epochs', async () => {
    const r = rig();
    const persona = new CortiV({ memoryDir: r.root, seedConstitution: 'A curious person.',
      references: () => r.config, foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true, maxHistoryTokens: 1024 }) });
    persona.attach(makeFakeHarnessApi());
    const tool = persona.declareSessions().find(session => session.id === 'main')!.tools().find(tool => tool.name === 'reference_guide')!;
    const ctx = { role: 'main', log: nullLogger() };
    const page = await tool.handler({ operation: 'catalog', offset: 1, limit: 1 }, ctx);
    expect(page).toContain(r.topics[1].file); expect(page).not.toContain(r.topics[0].file);
    await tool.handler({ operation: 'detail', topic_key: r.topics[0].key, activity_id: 'shelter' }, ctx);
    await tool.handler({ operation: 'detail', topic_key: r.topics[1].key, activity_id: 'walk' }, { ...ctx, role: 'dream' });
    const records: ContextRecord[] = [message('system', 'Environment contract.'), message('user', 'Current task.')];
    for (let round = 1; round <= 3; round++) {
      records.push(message('assistant', 'Older progress.'.repeat(500), { responseId: `old-${round}` }), message('user', 'New observation.'));
      const request = persona.prepareRequest({ sessionId: 'main', round, messages: records })!;
      const text = request.map(record => itemText(record.item)).join('\n');
      expect(text).toContain('[完整活动 shelter]'); expect(text).not.toContain('[完整活动 walk]');
      expect(text).toContain('不是亲历或已学会的证明');
    }
  });

  it('passes genuine recent action intent and its receipt as evidence without claiming execution', async () => {
    const r = rig(); const requests: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => { requests.push(init!); return r.answer(); }));
    const records = [functionCall('action-1', 'scene_do', '{"goal":"make a shelter"}', { ts: new Date().toISOString() }),
      functionResult('action-1', 'Accepted into the queue; not verified.')];
    const persona = new CortiV({ memoryDir: r.root, references: () => r.config, fastReference: () => r.fast });
    const api = makeFakeHarnessApi({ toolsTagged: () => new Set(['scene_do']) });
    const info = api.sessionInfo('main');
    api.sessionInfo = () => ({ ...info, snapshot: records });
    persona.attach(api);
    await persona.onDelivery({ events: [event({ ts: new Date().toISOString() })] });
    const state = JSON.parse(String(requests[0].body)).state;
    expect(state.recentIntent.tool).toBe('scene_do');
    expect(state.recentIntent.receipt).toContain('not verified');
    expect(state.recentIntent.boundary).toContain('不证明');
  });

  it('continues unrelated real Persona event delivery when its optional reference index is damaged', async () => {
    const r = rig(); r.put(r.config.indexFiles, { invalid: true });
    const injected: string[] = [];
    const persona = new CortiV({ memoryDir: r.root, references: () => r.config, fastReference: () => r.fast });
    persona.attach(makeFakeHarnessApi({ injectInternal: text => injected.push(text) }));
    await persona.onDelivery({ events: [event()] });
    expect(injected.at(-1)).toContain('外界事件原文');
  });

  it('delivers current events without waiting for reference advice and discards late work on stop', async () => {
    const r = rig(); let release!: (value: Response) => void;
    const injected: string[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { release = resolve; })));
    const persona = new CortiV({ memoryDir: r.root, references: () => r.config, fastReference: () => r.fast,
      foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true }) });
    persona.attach(makeFakeHarnessApi({ injectInternal: text => injected.push(text) }));
    await persona.onDelivery({ events: [event({ ts: new Date().toISOString() })] });
    expect(injected.at(-1)).toContain('外界事件原文');
    persona.stopRhythm();
    release(r.answer());
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(injected.some(text => text.startsWith('[资料快判断'))).toBe(false);
    const request = persona.prepareRequest({ sessionId: 'main', round: 1, messages: [message('user', 'Current event.')] })!;
    expect(request.map(record => itemText(record.item)).join('\n')).not.toContain('shelter：shelter');
  });
});
