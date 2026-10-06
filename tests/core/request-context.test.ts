import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MainLoop } from '../../src/core/loop.ts';
import { WakeBus } from '../../src/core/bus.ts';
import { SessionLog } from '../../src/core/session.ts';
import { JsonlEventStore } from '../../src/core/event-store.ts';
import { CoreState } from '../../src/core/state.ts';
import { estimateMessagesTokens, nullLogger, renderEventLines } from '../../src/core/util.ts';
import { validatePairing } from '../../src/core/truncate.ts';
import { unknownMeters, type GenerateOptions, type ResponseClient } from '../../src/core/generation.ts';
import type { LogEmitOptions, Persona, ToolDef } from '../../src/core/types.ts';
import { createResponse, type OutputItem, type Request } from '../../src/protocol/open-responses/index.ts';
import { functionCall, functionResult, message, type ContextRecord } from '../../src/protocol/open-responses/context.ts';
import { textOf, withoutPastReasoning } from '../../src/protocol/open-responses/context-helpers.ts';
import { activeSpec, fakeBlobIntern, makeCfg, makeFakeHarnessApi, makeFakeIO, makeFakePersona, makeTmpDir, makeTool, sleep } from './helpers.ts';

class ScriptedClient implements ResponseClient {
  calls: Array<{ request: Request; context: ContextRecord[] }> = [];
  output: OutputItem[][] = [];
  async respond(request: Request, options?: GenerateOptions) {
    this.calls.push({ request: structuredClone(request), context: structuredClone([...(options?.context ?? [])]) });
    const response = createResponse(`response_${this.calls.length}`, request);
    response.status = 'completed';
    response.output = this.output.shift() ?? [];
    const origin = { instance: 'fixture', module: 'fixture', model: 'fixture', compatibilityDomain: 'fixture' };
    return {
      response, origin,
      attempts: [{
        id: `attempt_${response.id}`, generationId: response.id, ordinal: 0, origin,
        startedAt: new Date().toISOString(), elapsedMs: 1, requestId: null, responseId: response.id,
        outcome: 'completed' as const, status: 200, serviceTier: null, charges: [],
        meters: { ...unknownMeters(), input: 11, output: 3, total: 14, reasoning: 1 },
      }],
    };
  }
}

async function until(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 5_000) throw new Error('request context test timed out');
    await sleep(5);
  }
}

type PrepareRequest = NonNullable<Persona['prepareRequest']>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function makeRig(options: {
  prepareRequest?: PrepareRequest;
  preSession?: ContextRecord[];
  tools?: ToolDef[];
  head?: Persona['sessionHead'];
  eventDelivery?: 'tool' | 'user';
  onDelivery?: (loop: MainLoop) => void;
} = {}) {
  const tmp = makeTmpDir();
  const cfg = makeCfg();
  cfg.batching = { quietGapMs: 10, minBatchAgeMs: 0, maxBatchAgeMs: 100, maxBatchSize: 100 };
  const session = new SessionLog(tmp.dir);
  for (const entry of options.preSession ?? []) session.append(entry);
  const store = new JsonlEventStore({ dataDir: tmp.dir, run: 'r-20260101-000000-0001' });
  const state = new CoreState(tmp.dir);
  state.load();
  const bus = new WakeBus(cfg.batching);
  const llm = new ScriptedClient();
  const worlds = [makeFakeIO('fixture', options.tools ?? [])];
  const persona = makeFakePersona([], { cfg, worlds, silent: true, mainPatch: { eventDelivery: options.eventDelivery ?? 'user' } });
  persona.prepareRequest = options.prepareRequest;
  persona.sessionHead = options.head;
  const warnings: Array<{ msg: string; data?: unknown }> = [];
  const rounds: LogEmitOptions[] = [];
  const log = nullLogger();
  log.warn = (msg, data) => warnings.push({ msg, data });
  log.emit = (_level, _msg, options) => { if (options?.event === 'round') rounds.push(options); };
  const loop = new MainLoop({
    cfg, llm, persona, decl: persona.declareSessions()[0], spec: () => activeSpec(cfg),
    context: { hardTokens: () => null, estimateTokens: estimateMessagesTokens, contextOverflow: () => false },
    blobs: fakeBlobIntern(), worlds: { all: () => worlds, visible: () => worlds },
    bus, session, store, state, log,
  });
  if (options.onDelivery) persona.onDelivery = () => options.onDelivery!(loop);
  persona.attach(makeFakeHarnessApi({ sessionInfo: (id) => ({ id, running: 0, snapshot: [], ...loop.contextGauge() }) }));
  let run: Promise<void> | null = null;
  let events = 0;
  cleanups.push(async () => { loop.stop(); if (run) await run; tmp.cleanup(); });
  return {
    cfg, session, llm, loop, state, warnings, rounds, persona, store, tmp,
    start() { run = loop.run(); },
    push(text: string) {
      const event = store.append({ type: 'fixture.input', ts: new Date().toISOString(), source: 'fixture', origin: 'external', text });
      bus.push({ event }, { trigger: 'flush' });
      events++;
      return event;
    },
    settled() { return until(() => loop.getStatus().batchesHandled >= events); },
  };
}

const historicalContext = () => [message('system', 'stable prefix'), message('user', 'historical detail '.repeat(1_000)), message('assistant', 'historical answer')];
const actualEstimate = (rig: ReturnType<typeof makeRig>) => estimateMessagesTokens(rig.cfg.context.keepPastThinking ? rig.loop.outboundMessages() : withoutPastReasoning(rig.loop.outboundMessages()));

describe('MainLoop request context projection', () => {
  it.each(['user', 'tool'] as const)('preserves internal event provenance and exact offsets without changing %s delivery text', async (eventDelivery) => {
    const internal = ['First internal observation.\nSecond line.', 'A distinct internal state.'];
    const rig = makeRig({
      eventDelivery,
      onDelivery: (loop) => {
        loop.injectInternal(internal[0], 'planning');
        loop.injectInternal(internal[1], 'pending_work');
      },
    });
    rig.start();
    const external = rig.push('External observation.');
    await rig.settled();
    const delivered = rig.session.records.find(entry => entry.item.type === 'message' && entry.item.role === 'user')!;
    const refs = delivered.context.frame!.events;
    const expectedText = eventDelivery === 'user'
      ? [...internal, renderEventLines([external])].join('\n')
      : internal.join('\n');
    expect(textOf(delivered)).toBe(expectedText);
    expect(refs.map(ref => ref.source)).toEqual(eventDelivery === 'user' ? ['persona', 'persona', 'fixture'] : ['persona', 'persona']);
    expect(refs.slice(0, internal.length).map(ref => ref.type)).toEqual(['planning', 'pending_work']);
    for (const ref of refs) {
      expect(textOf(delivered).slice(ref.start, ref.start + ref.chars)).toBe(rig.store.get(ref.cursor)!.text);
    }
    if (eventDelivery === 'tool') {
      const frame = rig.session.records.find(entry => entry.item.type === 'function_call_output')!;
      const ref = frame.context.frame!.events[0];
      expect(ref.source).toBe('fixture');
      expect(textOf(frame).slice(ref.start, ref.start + ref.chars)).toBe(external.text);
      expect(validatePairing(rig.llm.calls[0].context)).toEqual([]);
    }
  });

  it('shortens only the request while preserving stored history, delivery cursor and the next real receipt', async () => {
    const seed = historicalContext();
    const seenRounds: Array<{ sessionId: string; round: number }> = [];
    const historicalIds = new Set(seed.slice(1).map(entry => entry.item.id));
    const rig = makeRig({
      preSession: seed,
      tools: [makeTool('inspect', 'actual observation')],
      prepareRequest: ({ sessionId, round, messages }) => {
        seenRounds.push({ sessionId, round });
        return messages.filter(entry => !historicalIds.has(entry.item.id));
      },
    });
    const savedBefore = readFileSync(join(rig.tmp.dir, 'session-main.jsonl'), 'utf8');
    rig.llm.output.push([functionCall('inspect_1', 'inspect', '{}').item as OutputItem], [message('assistant', 'finished').item as OutputItem]);
    rig.start();
    const event = rig.push('new observation');
    await rig.settled();

    expect(rig.llm.calls).toHaveLength(2);
    expect(rig.llm.calls[0].context.some(entry => textOf(entry).includes('historical detail'))).toBe(false);
    expect(rig.llm.calls[1].context.some(entry => entry.item.type === 'function_call_output' && textOf(entry) === 'actual observation')).toBe(true);
    expect(rig.llm.calls[1].request.input).toHaveLength(rig.llm.calls[1].context.length);
    expect(validatePairing(rig.llm.calls[1].context)).toEqual([]);
    expect(rig.session.records.slice(0, seed.length)).toEqual(seed);
    expect(readFileSync(join(rig.tmp.dir, 'session-main.jsonl'), 'utf8').startsWith(savedBefore)).toBe(true);
    expect(rig.loop.outboundMessages().some(entry => textOf(entry).includes('historical detail'))).toBe(true);
    expect(rig.state.data.lastDeliveredCursor).toBe(event.cursor);
    expect(seenRounds).toEqual([{ sessionId: 'main', round: 1 }, { sessionId: 'main', round: 2 }]);
  });

  it('repairs missing and orphaned tool outputs in the projected request without rewriting the originals', async () => {
    const seed = [message('system', 'prefix'), functionCall('retained', 'inspect', '{}'), functionResult('retained', 'stored receipt')];
    const rig = makeRig({ preSession: seed, prepareRequest: ({ messages }) => [messages[0], functionResult('orphan', 'ignored'), messages[1], messages.at(-1)!] });
    rig.start(); rig.push('new observation'); await rig.settled();
    const sent = rig.llm.calls[0].context;
    expect(validatePairing(sent)).toEqual([]);
    expect(sent.some(entry => entry.item.type === 'function_call_output' && entry.item.call_id === 'orphan')).toBe(false);
    expect(sent.filter(entry => entry.item.type === 'function_call_output')).toHaveLength(1);
    expect(rig.session.records.slice(0, seed.length)).toEqual(seed);
    expect(textOf(rig.session.records[2])).toBe('stored receipt');
  });

  it('falls back to the complete request after a throwing hook and isolates edits made before it throws', async () => {
    const seed = historicalContext();
    const rig = makeRig({ preSession: seed, prepareRequest: ({ messages }) => {
      messages[0].item = message('system', 'mutated prefix').item;
      throw new Error('projection unavailable');
    } });
    rig.start(); rig.push('new observation'); await rig.settled();
    expect(rig.llm.calls[0].context.slice(0, seed.length)).toEqual(seed);
    expect(rig.session.records.slice(0, seed.length)).toEqual(seed);
    expect(rig.warnings.some(entry => entry.msg.includes('prepareRequest'))).toBe(true);
    expect((rig.rounds[0].data as { requestContext: { projected: boolean } }).requestContext.projected).toBe(false);
  });

  it.each([
    {},
    [message('user', 'valid'), { role: 'user', content: 'not a record' }],
    [{ version: 2, context: {}, item: { type: 'reasoning' } }],
    [{ version: 2, context: {}, item: { type: 'message', role: 'user', content: [null] } }],
  ])('rejects malformed hook results and keeps the complete context', async (invalid) => {
    const seed = historicalContext();
    const rig = makeRig({ preSession: seed, prepareRequest: () => invalid as ContextRecord[] });
    rig.start(); rig.push('new observation'); await rig.settled();
    expect(rig.llm.calls[0].context.slice(0, seed.length)).toEqual(seed);
    expect(rig.warnings.some(entry => entry.msg.includes('prepareRequest'))).toBe(true);
  });

  it.each(['call', 'receipt'] as const)('falls back to the real complete context when a projection loses the %s partner', async (lost) => {
    const call = functionCall('original_call', 'inspect', '{}', { responseId: 'original_response' });
    const receipt = functionResult('original_call', 'The original operation was refused.');
    const seed = [message('system', 'stable prefix'), call, receipt, message('assistant', 'I read the refusal.')];
    const rig = makeRig({ preSession: seed, prepareRequest: ({ messages }) => messages.filter(entry =>
      lost === 'call' ? entry.item.type !== 'function_call' : entry.item.type !== 'function_call_output') });
    rig.start(); rig.push('new observation'); await rig.settled();
    expect(rig.llm.calls[0].context.slice(0, seed.length)).toEqual(seed);
    expect(validatePairing(rig.llm.calls[0].context)).toEqual([]);
    expect(rig.warnings.some(entry => entry.msg.includes('prepareRequest'))).toBe(true);
    expect(rig.session.records.slice(0, seed.length)).toEqual(seed);
  });

  it('uses the full stored estimate after a projection while retaining real usage and restores counting after a complete request', async () => {
    let projected = true;
    const rig = makeRig({ preSession: historicalContext(), prepareRequest: ({ messages }) => projected ? [messages[0], messages.at(-1)!] : [...messages] });
    rig.start(); rig.push('first observation'); await rig.settled();
    expect(rig.loop.getStatus().lastUsage).toMatchObject({ promptTokens: 11, completionTokens: 3 });
    expect(rig.loop.getStatus().context.countedTokens).toBe(0);
    expect(rig.loop.estTokens()).toBe(actualEstimate(rig));
    expect(rig.loop.estTokens()).toBeGreaterThan(14);

    projected = false;
    rig.push('second observation'); await rig.settled();
    expect(rig.llm.calls[1].context.some(entry => textOf(entry).includes('historical detail'))).toBe(true);
    expect(rig.loop.getStatus().context.countedTokens).toBe(14 - (rig.cfg.context.keepPastThinking ? 0 : 1));
  });

  it.each([undefined, () => null, () => undefined, ({ messages }: Parameters<PrepareRequest>[0]) => [...messages]])('preserves ordinary request counting when the hook leaves the view unchanged', async (prepareRequest) => {
    const seed = historicalContext();
    const rig = makeRig({ preSession: seed, prepareRequest });
    rig.start(); rig.push('observation'); await rig.settled();
    expect(rig.llm.calls[0].context.slice(0, seed.length)).toEqual(seed);
    expect(rig.loop.getStatus().context.countedTokens).toBe(14 - (rig.cfg.context.keepPastThinking ? 0 : 1));
  });

  it('includes the synthetic head in the hook and records request sizes without message bodies', async () => {
    const rig = makeRig({
      preSession: historicalContext(), head: () => [message('user', 'synthetic head').item],
      prepareRequest: ({ messages }) => [messages[0], messages[1], messages.at(-1)!],
    });
    rig.start(); rig.push('observation'); await rig.settled();
    const sent = rig.llm.calls[0].context;
    expect(sent[1].context.head).toBe(true);
    expect(rig.session.records.some(entry => entry.context.head)).toBe(false);
    const metadata = (rig.rounds[0].data as { requestContext: Record<string, unknown> }).requestContext;
    expect(metadata).toEqual({ storedRecords: 4, completeRecords: 5, requestRecords: 3, projected: true, estimatedInputTokens: estimateMessagesTokens(sent) });
    expect(JSON.stringify(metadata)).not.toContain('synthetic head');
    expect(JSON.stringify(metadata)).not.toContain('historical detail');
  });
});
