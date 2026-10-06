/** Core.spawnFork provider binding, output limits and cancellation. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Core } from '../../src/core/core.ts';
import type { CoreApi, ModelSpec, SessionDecl, ToolDef } from '../../src/core/types.ts';
import type { OutputItem } from '../../src/protocol/open-responses/index.ts';
import { createResponse } from '../../src/protocol/open-responses/index.ts';
import { message } from '../../src/protocol/open-responses/context.ts';
import { NOT_EXECUTED_THREAD_ENDED } from '../../src/core/markers.ts';
import { FakeLLM, makeCfg, makeFakePersona, makeLoaded, makeTmpDir, textReply, toolReply } from './helpers.ts';

const REVIEW_SPEC: ModelSpec = {
  model: 'review-model', thinking: true, reasoningEffort: 'high', temperature: 0.6,
  maxTokens: 720, contextWindow: 24000,
};

function stream(output: OutputItem[], model = REVIEW_SPEC.model): Response {
  const resource = createResponse(`resp_${crypto.randomUUID()}`, { model });
  const completed = { ...resource, status: 'completed', output,
    usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25,
      input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 2 } } };
  const events = [
    { type: 'response.created', response: resource },
    ...output.flatMap((item, output_index) => [
      { type: 'response.output_item.added', output_index, item },
      { type: 'response.output_item.done', output_index, item },
    ]),
    { type: 'response.completed', response: completed },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const call = (id: string, name: string): OutputItem => ({
  type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: '{}', status: 'completed',
});
const conclusion = (): OutputItem => ({
  type: 'message', id: 'msg_result', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'Reviewed.', annotations: [] }],
});

describe('Core.spawnFork provider and cancellation', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  const build = (llm?: FakeLLM, tools: ToolDef[] = []) => {
    const tmp = makeTmpDir();
    cleanups.push(tmp.cleanup);
    const config = makeCfg();
    config.providers.review = { kind: 'openai-responses-compat', baseUrl: 'https://review.test/v1', spec: { ...REVIEW_SPEC } };
    config.providers.next = { kind: 'openai-responses-compat', baseUrl: 'https://next.test/v1', spec: { model: 'next-model', thinking: false } };
    const decl: SessionDecl = {
      id: 'analysis', label: 'Analysis', persistent: false, receivesEvents: false,
      rounds: () => ({ soft: 2, hard: 4 }), tools: () => tools,
    };
    const persona = makeFakePersona([], { cfg: config, extraSessions: [decl] });
    const attach = persona.attach.bind(persona);
    let api!: CoreApi;
    persona.attach = value => { api = value; attach(value); };
    const core = new Core(makeLoaded({ config, rootDir: tmp.dir, memoryDir: `${tmp.dir}/memory`, dataDir: `${tmp.dir}/data` }), {
      persona, worlds: [], ...(llm ? { llm } : {}),
    });
    return { core, config, api, persona };
  };

  it('binds the selected endpoint and full model spec across rounds and attributes usage to it', async () => {
    let change!: () => void;
    const tool: ToolDef = { name: 'inspect', description: 'Read facts', tags: ['read'], parameters: {},
      handler: async () => { change(); return 'Read.'; } };
    const { core, config } = build(undefined, [tool]);
    change = () => {
      config.activeProvider = 'next';
      Object.assign(config.providers.review.spec!, { model: 'edited-model', thinking: false, reasoningEffort: 'low', maxTokens: 60, contextWindow: 1000 });
      config.providers.review.baseUrl = 'https://edited.test/v1';
    };
    const specs: Array<ModelSpec | undefined> = [];
    const bind = core.providers.bind.bind(core.providers);
    vi.spyOn(core.providers, 'bind').mockImplementation(name => {
      const client = bind(name);
      return { respond: (request, options) => { specs.push(options?.nativeSpec); return client.respond(request, options); } };
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(stream([call('inspect_1', 'inspect')]))
      .mockResolvedValueOnce(stream([conclusion()]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(core.spawnFork({ id: 'analysis', provider: 'review', messages: [message('user', 'Review the facts.')] })).resolves.toBe('Reviewed.');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://review.test/v1/responses', 'https://review.test/v1/responses']);
    expect(specs).toEqual([REVIEW_SPEC, REVIEW_SPEC]);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies).toEqual([expect.objectContaining({ model: REVIEW_SPEC.model, reasoning: { effort: REVIEW_SPEC.reasoningEffort }, max_output_tokens: REVIEW_SPEC.maxTokens, temperature: REVIEW_SPEC.temperature }),
      expect.objectContaining({ model: REVIEW_SPEC.model, reasoning: { effort: REVIEW_SPEC.reasoningEffort }, max_output_tokens: REVIEW_SPEC.maxTokens, temperature: REVIEW_SPEC.temperature })]);
    expect(core.usageLog.readAll().map(record => record.attempt?.origin)).toEqual([
      expect.objectContaining({ instance: 'review', model: REVIEW_SPEC.model }),
      expect.objectContaining({ instance: 'review', model: REVIEW_SPEC.model }),
    ]);
  });

  it('ends on a dynamic tool outcome, keeps its receipt and skips remaining calls without nudging', async () => {
    const llm = new FakeLLM();
    let laterEffects = 0;
    const tools: ToolDef[] = [
      { name: 'inspect', description: 'Read target', tags: ['read'], parameters: {},
        handler: async () => ({ text: 'Unchanged target.', failed: true, endsTurn: true }) },
      { name: 'later', description: 'Change target', tags: ['act'], parameters: {},
        handler: async () => { laterEffects++; return 'Changed.'; } },
    ];
    const { core, api } = build(llm, tools);
    llm.script(toolReply([{ name: 'inspect', id: 'first' }, { name: 'later', id: 'second' }]));
    await core.spawnFork({ id: 'analysis', messages: [], nudge: { when: () => true, message: 'Try again.' } });
    expect(llm.calls).toHaveLength(1);
    expect(laterEffects).toBe(0);
    const summary = core.sessions.list().find(session => session.role === 'analysis')!;
    const items = core.sessions.messages(summary.id)!.map(record => record.item);
    expect(items).toContainEqual(expect.objectContaining({ type: 'function_call_output',
      call_id: 'first', output: '[tool failed] Unchanged target.' }));
    expect(items).toContainEqual(expect.objectContaining({ type: 'function_call_output',
      call_id: 'second', output: NOT_EXECUTED_THREAD_ENDED }));
    expect(api.sessionInfo('analysis').running).toBe(0);
  });

  it('appends synchronous Persona explanations with the fork role and preserves dynamic ending and pairing', async () => {
    const llm = new FakeLLM();
    let laterEffects = 0;
    const tools: ToolDef[] = [
      { name: 'act', description: 'Act', tags: ['act'], parameters: {},
        handler: async () => ({ text: 'Actual failure.', failed: true, endsTurn: true }) },
      { name: 'later', description: 'Later', tags: ['act'], parameters: {},
        handler: async () => { laterEffects++; return 'Later.'; } },
    ];
    const { core, persona } = build(llm, tools);
    const seen: Array<Parameters<NonNullable<typeof persona.onToolOutcome>>[0]> = [];
    persona.onToolOutcome = context => { seen.push(context); return 'Persona explanation.'; };
    llm.script(toolReply([{ name: 'act', id: 'first', args: { target: 'oak' } }, { name: 'later', id: 'second' }]));
    await core.spawnFork({ id: 'analysis', messages: [], nudge: { when: () => true, message: 'Try again.' } });
    expect(llm.calls).toHaveLength(1);
    expect(laterEffects).toBe(0);
    expect(seen).toEqual([{ role: 'analysis', tool: 'act', args: { target: 'oak' },
      outcome: { text: 'Actual failure.', failed: true, endsTurn: true } }]);
    const session = core.sessions.list().find(entry => entry.role === 'analysis')!;
    const items = core.sessions.messages(session.id)!.map(record => record.item);
    expect(items).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'first',
      output: '[tool failed] Actual failure.\nPersona explanation.' }));
    expect(items).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'second', output: NOT_EXECUTED_THREAD_ENDED }));
  });

  it.each(['missing', 'no-spec', 'unknown-module'])('rejects unavailable provider %s without falling back or opening a fork', async provider => {
    const llm = new FakeLLM();
    const { core, config, api } = build(llm);
    config.providers['no-spec'] = { kind: 'openai-responses-compat', baseUrl: 'https://unset.test' };
    config.providers['unknown-module'] = { kind: 'unknown-module', baseUrl: 'https://unknown.test', spec: { ...REVIEW_SPEC } };
    await expect(core.spawnFork({ id: 'analysis', provider, messages: [] })).rejects.toThrow();
    expect(llm.calls).toEqual([]);
    expect(api.sessionInfo('analysis').running).toBe(0);
    expect(core.sessions.list().filter(session => session.role === 'analysis')).toEqual([]);
  });

  it('retains the default provider model snapshot when its config changes inside a tool', async () => {
    const llm = new FakeLLM();
    let change!: () => void;
    const tool: ToolDef = { name: 'inspect', description: '', tags: ['read'], parameters: {}, handler: async () => { change(); return 'Read.'; } };
    const { core, config } = build(llm, [tool]);
    const original = { ...config.providers[config.activeProvider].spec! };
    change = () => { config.providers[config.activeProvider].spec!.model = 'edited-model'; config.activeProvider = 'next'; };
    llm.script(toolReply([{ name: 'inspect', id: 'inspect_1' }]), textReply('Reviewed.'));
    await expect(core.spawnFork({ id: 'analysis', messages: [] })).resolves.toBe('Reviewed.');
    expect(llm.calls.map(entry => entry.spec)).toEqual([original, original]);
  });

  it('overrides only the fork output limit and leaves the provider spec intact', async () => {
    const { core, config } = build();
    const fetchMock = vi.fn().mockResolvedValue(stream([conclusion()]));
    vi.stubGlobal('fetch', fetchMock);
    await core.spawnFork({ id: 'analysis', provider: 'review', maxOutputTokens: 120, messages: [] });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).max_output_tokens).toBe(120);
    expect(config.providers.review.spec).toEqual(REVIEW_SPEC);
  });

  it('does not start a request or session when already cancelled', async () => {
    const llm = new FakeLLM();
    const { core, api } = build(llm);
    const controller = new AbortController();
    const reason = new Error('Cancelled before start');
    controller.abort(reason);
    await expect(core.spawnFork({ id: 'analysis', messages: [], signal: controller.signal })).rejects.toBe(reason);
    expect(llm.calls).toEqual([]);
    expect(api.sessionInfo('analysis').running).toBe(0);
    expect(core.sessions.list().filter(session => session.role === 'analysis')).toEqual([]);
  });

  it('cancels an in-flight provider request and releases accounting without retrying', async () => {
    const { core, api } = build();
    const controller = new AbortController();
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    let transportSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      transportSignal = init.signal as AbortSignal;
      entered();
      transportSignal.addEventListener('abort', () => reject(transportSignal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = core.spawnFork({ id: 'analysis', provider: 'review', signal: controller.signal, messages: [] });
    const rejected = expect(pending).rejects.toThrow('Cancelled during request');
    await waiting;
    expect(api.sessionInfo('analysis').running).toBe(1);
    controller.abort(new Error('Cancelled during request'));
    await rejected;
    expect(transportSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.sessionInfo('analysis').running).toBe(0);
    const session = core.sessions.list().find(entry => entry.role === 'analysis')!;
    expect(session.endedAt).not.toBeNull();
    expect(core.usageLog.readAll()).toEqual([expect.objectContaining({ attempt: expect.objectContaining({ outcome: 'aborted', origin: expect.objectContaining({ instance: 'review' }) }) })]);
  });

  it('records the tool finishing during cancellation and skips the rest of the round', async () => {
    const llm = new FakeLLM();
    const controller = new AbortController();
    const reason = new Error('Cancelled during tool');
    const ran: string[] = [];
    const tools = ['first', 'second'].map(name => ({ name, description: '', tags: ['read'] as const, parameters: {},
      handler: async () => { ran.push(name); if (name === 'first') controller.abort(reason); return `Done ${name}`; } }));
    const { core, api } = build(llm, tools);
    llm.script(toolReply([{ name: 'first', id: 'first_1' }, { name: 'second', id: 'second_1' }]), textReply('Must not continue.'));
    await expect(core.spawnFork({ id: 'analysis', signal: controller.signal, messages: [] })).rejects.toBe(reason);
    expect(ran).toEqual(['first']);
    expect(llm.calls).toHaveLength(1);
    expect(api.sessionInfo('analysis').running).toBe(0);
    const session = core.sessions.list().find(entry => entry.role === 'analysis')!;
    expect(session.endedAt).not.toBeNull();
    const receipts = core.sessions.messages(session.id)!.filter(entry => entry.item.type === 'function_call_output').map(entry => entry.item);
    expect(receipts).toMatchObject([
      { type: 'function_call_output', call_id: 'first_1', output: 'Done first' },
      { type: 'function_call_output', call_id: 'second_1', output: NOT_EXECUTED_THREAD_ENDED },
    ]);
  });
});
