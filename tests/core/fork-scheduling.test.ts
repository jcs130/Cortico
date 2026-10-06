import { afterEach, describe, expect, it, vi } from 'vitest';
import { Core } from '../../src/core/core.ts';
import { GenerationError, type GenerateOptions, type Generation, type ResponseClient } from '../../src/core/generation.ts';
import type { CoreApi, ForkOptions, SessionDecl, ToolDef } from '../../src/core/types.ts';
import type { Request } from '../../src/protocol/open-responses/index.ts';
import { message, functionCall, functionResult } from '../../src/protocol/open-responses/context.ts';
import { textOf } from '../../src/protocol/open-responses/context-helpers.ts';
import { FakeLLM, makeCfg, makeFakePersona, makeLoaded, makeTmpDir, textReply, toolReply } from './helpers.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(value => { resolve = value; });
  return { promise, resolve };
}

async function answer(request: Request, options: GenerateOptions | undefined, reply = textReply('Done.')): Promise<Generation> {
  const llm = new FakeLLM(); llm.script(reply);
  return llm.respond(request, options);
}

async function untilAborted(request: Request, options: GenerateOptions): Promise<Generation> {
  const draft = await answer(request, options, textReply('Uncommitted draft.'));
  await new Promise<never>((_resolve, reject) => {
    const signal = options.signal!;
    const fail = () => reject(new GenerationError(String(signal.reason), draft.attempts.map(attempt => ({ ...attempt, outcome: 'aborted' })), draft.response, draft.origin));
    if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
  });
  return draft;
}

describe('fork background generations', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

  const build = (llm: ResponseClient, tools: ToolDef[] = [], maxRounds = 4) => {
    const tmp = makeTmpDir();
    const config = makeCfg();
    Object.assign(config.batching, { minBatchAgeMs: 0, quietGapMs: 0, maxBatchAgeMs: 0 });
    config.providers.independent = { kind: 'openai-responses-compat', baseUrl: 'https://independent.test', spec: { model: 'other-alias', thinking: false } };
    const decl: SessionDecl = { id: 'worker', label: 'Worker', persistent: false, receivesEvents: false,
      rounds: () => ({ soft: Math.max(1, maxRounds - 1), hard: maxRounds }), tools: () => tools };
    const persona = makeFakePersona(tools, { cfg: config, silent: true, extraSessions: [decl] });
    let api!: CoreApi;
    const attach = persona.attach.bind(persona);
    persona.attach = value => { api = value; attach(value); };
    const core = new Core(makeLoaded({ config, rootDir: tmp.dir, memoryDir: `${tmp.dir}/memory`, dataDir: `${tmp.dir}/data` }), { persona, worlds: [], llm });
    cleanups.push(async () => { await core.stop(); tmp.cleanup(); });
    return { core, api, config };
  };

  it('preempts a model alias on the shared provider, retries the same settled round and never repeats its executed tool', async () => {
    const enteredBackground = deferred();
    const enteredForegroundTool = deferred();
    const finishForegroundTool = deferred();
    let sideEffects = 0;
    let workerRequests = 0;
    let foregroundRequests = 0;
    const workerContexts: GenerateOptions['context'][] = [];
    const llm: ResponseClient = { respond: async (request, options = {}) => {
      if (options.role === 'worker') {
        workerContexts.push(structuredClone(options.context));
        if (++workerRequests === 1) return answer(request, options, toolReply([{ name: 'inspect', id: 'inspect_1' }]));
        if (workerRequests === 2) { enteredBackground.resolve(); return untilAborted(request, options); }
        return answer(request, options, textReply('Background complete.'));
      }
      if (++foregroundRequests === 1) return answer(request, options, toolReply([{ name: 'hold', id: 'hold_1' }]));
      return answer(request, options);
    } };
    const tools: ToolDef[] = [
      { name: 'inspect', description: '', parameters: {}, tags: ['read'], handler: async () => { sideEffects++; return 'Observed facts.'; } },
      { name: 'hold', description: '', parameters: {}, tags: ['read'], handler: async () => { enteredForegroundTool.resolve(); await finishForegroundTool.promise; return 'Foreground tool completed.'; } },
    ];
    const { core, api } = build(llm, tools, 2);
    await core.start();
    const fork = core.spawnFork({ id: 'worker', model: 'background-alias', generationPriority: 'background', messages: [message('user', 'Review.')] });
    await enteredBackground.promise;
    api.injectInternal('React now.');
    await enteredForegroundTool.promise;
    await Promise.resolve();
    expect(workerRequests).toBe(2);
    expect(sideEffects).toBe(1);
    finishForegroundTool.resolve();
    await expect(fork).resolves.toBe('Background complete.');
    expect(sideEffects).toBe(1);
    expect(workerContexts[2]).toEqual(workerContexts[1]);
    const session = core.sessions.list().find(entry => entry.role === 'worker')!;
    const items = core.sessions.messages(session.id)!.map(entry => entry.item);
    expect(items).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'inspect_1', output: expect.stringContaining('Observed facts.') }));
    expect(JSON.stringify(items)).not.toContain('Uncommitted draft.');
    expect(core.usageLog.readAll().filter(record => record.role === 'worker').map(record => record.attempt?.outcome)).toEqual(['completed', 'aborted', 'completed']);
  });

  it('keeps independent-provider forks and default forks running during a foreground batch', async () => {
    const foregroundEntered = deferred();
    const releaseForeground = deferred();
    let foregroundSignal!: AbortSignal;
    const llm: ResponseClient = { respond: async (request, options = {}) => {
      if (options.role !== 'worker') {
        foregroundSignal = options.signal!; foregroundEntered.resolve();
        await releaseForeground.promise;
      }
      return answer(request, options);
    } };
    const { core, api } = build(llm);
    vi.spyOn(core.providers, 'bind').mockImplementation(() => llm);
    await core.start(); api.injectInternal('React.');
    await foregroundEntered.promise;
    await expect(core.spawnFork({ id: 'worker', provider: 'independent', generationPriority: 'background', messages: [] })).resolves.toBe('Done.');
    await expect(core.spawnFork({ id: 'worker', messages: [] })).resolves.toBe('Done.');
    expect(foregroundSignal.aborted).toBe(false);
    releaseForeground.resolve();
  });

  it('cancels a waiting fork without requesting a model and stops an active fork before any new tool', async () => {
    const enteredForeground = deferred();
    const workerEntered = deferred();
    let workerRequests = 0;
    let effects = 0;
    const llm: ResponseClient = { respond: async (request, options = {}) => {
      if (options.role === 'worker') { workerRequests++; workerEntered.resolve(); }
      else enteredForeground.resolve();
      return untilAborted(request, options);
    } };
    const { core, api } = build(llm, [{ name: 'act', description: '', parameters: {}, tags: ['act'], handler: async () => { effects++; return 'Changed.'; } }]);
    await core.start(); api.injectInternal('React.');
    await enteredForeground.promise;
    const controller = new AbortController();
    const waiting = core.spawnFork({ id: 'worker', generationPriority: 'background', signal: controller.signal, messages: [] });
    const cancelled = expect(waiting).rejects.toThrow('Cancel waiting fork');
    controller.abort(new Error('Cancel waiting fork')); await cancelled;
    expect(workerRequests).toBe(0);
    const waitingForShutdown = core.spawnFork({ id: 'worker', generationPriority: 'background', messages: [] });
    const stoppedWaiting = expect(waitingForShutdown).rejects.toThrow('Core stopped');
    const active = core.spawnFork({ id: 'worker', messages: [] });
    const stopped = expect(active).rejects.toThrow('Core stopped');
    await workerEntered.promise;
    await core.stop(); await stopped; await stoppedWaiting;
    expect(effects).toBe(0);
    expect(api.sessionInfo('worker').running).toBe(0);
    expect(core.sessions.list().filter(entry => entry.role === 'worker').every(entry => entry.endedAt)).toBe(true);
    await expect(core.spawnFork({ id: 'worker', messages: [] })).rejects.toThrow('Core stopped');
  });

  it('starts with fresh scheduling state when a stopped runtime is replaced by a new Core instance', async () => {
    const roles: string[] = [];
    const llm: ResponseClient = { respond: async (request, options = {}) => { roles.push(options.role!); return answer(request, options); } };
    const old = build(llm);
    await old.core.start(); await old.core.stop();
    const next = build(llm);
    await next.core.start();
    await expect(next.core.spawnFork({ id: 'worker', generationPriority: 'background', messages: [] })).resolves.toBe('Done.');
    next.api.injectInternal('New runtime event.');
    await vi.waitFor(() => expect(roles).toContain('main'));
    expect(next.core.loop.getStatus().running).toBe(true);
  });

  it('projects each settled round without changing tool receipts or original input, and falls back on invalid pairing', async () => {
    const requests: GenerateOptions['context'][] = [];
    const llm: ResponseClient = { respond: async (request, options) => {
      requests.push(structuredClone(options?.context));
      return answer(request, options, requests.length === 1 ? toolReply([{ name: 'inspect', id: 'fresh' }]) : textReply('Projected.'));
    } };
    const tool: ToolDef = { name: 'inspect', description: '', parameters: {}, tags: ['read'], handler: async () => 'New complete receipt.' };
    const { core } = build(llm, [tool]);
    const old = [message('system', 'Prefix.'), message('user', 'Large old context.'), functionCall('old', 'inspect', '{}'), functionResult('old', 'Old receipt.')];
    const original = structuredClone(old);
    const hook: ForkOptions['prepareRequest'] = ({ messages, round }) => {
      messages[0].item = message('system', 'Altered request prefix.').item;
      if (round === 1) return [messages[0]];
      return [messages[0], messages.at(-1)!];
    };
    await expect(core.spawnFork({ id: 'worker', messages: old, prepareRequest: hook })).resolves.toBe('Projected.');
    expect(requests[0]?.map(textOf)).toEqual(['Altered request prefix.']);
    expect(requests[1]?.slice(0, original.length)).toEqual(original);
    expect(requests[1]?.slice(original.length).map(entry => entry.item)).toMatchObject([
      { type: 'function_call', call_id: 'fresh' }, { type: 'function_call_output', call_id: 'fresh', output: 'New complete receipt.' },
    ]);
    expect(old).toEqual(original);
    const session = core.sessions.list().find(entry => entry.role === 'worker')!;
    expect(core.sessions.messages(session.id)!.slice(0, original.length)).toEqual(original);
  });
});
