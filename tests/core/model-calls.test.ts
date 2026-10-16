import { describe, expect, it, vi } from 'vitest';
import { ModelCallGate, limitModelCalls } from '../../src/core/model-calls.ts';
import { GenerationError, unknownMeters, type GenerateOptions, type ProviderAttempt, type ResponseClient } from '../../src/core/generation.ts';
import { createResponse } from '../../src/protocol/open-responses/index.ts';

const origin = { instance: 'fixture', module: 'fixture', model: 'fixture-model', compatibilityDomain: 'fixture' };
function upstream() {
  const active = new Set<string>();
  const starts: string[] = [];
  const seen: GenerateOptions[] = [];
  const pending = new Map<string, () => void>();
  let peak = 0;
  const client: ResponseClient = { async respond(request, options = {}) {
    const name = String(request.input);
    const identity = options.conversationId!;
    if (active.has(identity)) throw new Error('Overlapping conversation');
    active.add(identity); starts.push(name); seen.push(options); peak = Math.max(peak, active.size);
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => { options.signal?.removeEventListener('abort', abort); active.delete(identity); resolve(); };
      const abort = (): void => { active.delete(identity); reject(options.signal?.reason); };
      options.signal?.addEventListener('abort', abort, { once: true });
      pending.set(name, finish);
    });
    const attempt: ProviderAttempt = { id: name, generationId: name, ordinal: 0, origin, startedAt: new Date().toISOString(),
      elapsedMs: 1, requestId: name, responseId: name, outcome: 'completed', status: 200, serviceTier: null,
      meters: unknownMeters(), charges: [] };
    return { response: { ...createResponse(name, request), status: 'completed' }, origin, attempts: [attempt] };
  } };
  return { client, starts, seen, pending, peak: () => peak };
}

describe('model call admission', () => {
  it('serializes a conversation across bound clients while other conversations use the second slot', async () => {
    const server = upstream(), gate = new ModelCallGate(), shutdown = new AbortController();
    const client = limitModelCalls(server.client, gate, 'agent-a', shutdown.signal);
    const run = (name: string, identity: string, bound = client) => bound.respond({ model: origin.model, input: name }, { conversationId: identity });
    const a1 = run('a1', 'session-a');
    const a2 = run('a2', 'session-a', client.bind!());
    const b = run('b', 'session-b');
    const c = run('c', 'session-c', client.bind!());
    await vi.waitFor(() => expect(server.starts).toEqual(['a1', 'b']));
    expect(gate.snapshot()).toMatchObject({ active: 2, queued: 2 });
    server.pending.get('b')!(); await b;
    await vi.waitFor(() => expect(server.starts).toEqual(['a1', 'b', 'c']));
    server.pending.get('a1')!(); await a1;
    await vi.waitFor(() => expect(server.starts).toEqual(['a1', 'b', 'c', 'a2']));
    server.pending.get('a2')!(); server.pending.get('c')!();
    const results = await Promise.all([a2, c]);
    expect(server.peak()).toBe(2);
    expect(gate.snapshot()).toMatchObject({ active: 0, queued: 0 });
    expect(results.every(result => result.attempts[0].agentId === 'agent-a' && result.attempts[0].clientQueueMs! >= 0)).toBe(true);
  });

  it('cancels queued work without submitting it and cancels active work on shutdown', async () => {
    const server = upstream(), gate = new ModelCallGate(() => 1), shutdown = new AbortController(), cancel = new AbortController();
    const client = limitModelCalls(server.client, gate, 'agent-a', shutdown.signal);
    const first = client.respond({ model: origin.model, input: 'first' }, { conversationId: 'first' }).catch(error => error);
    const queued = client.respond({ model: origin.model, input: 'queued' }, { conversationId: 'second', signal: cancel.signal }).catch(error => error);
    await vi.waitFor(() => expect(server.starts).toEqual(['first']));
    cancel.abort(new Error('task cancelled'));
    expect((await queued).message).toBe('task cancelled');
    expect(gate.snapshot()).toMatchObject({ active: 1, queued: 0 });
    shutdown.abort(new Error('agent stopped'));
    expect((await first).message).toBe('agent stopped');
    expect(server.starts).toEqual(['first']);
    expect(gate.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it('two agents each use two slots and keep reasoning and output limits intact', async () => {
    const server = upstream(), shutdown = new AbortController();
    const clients = ['agent-a', 'agent-b'].map(agent => limitModelCalls(server.client, new ModelCallGate(), agent, shutdown.signal));
    const work = clients.flatMap((client, index) => [0, 1].map(branch => client.respond({ model: origin.model,
      input: `${index}-${branch}`, reasoning: { effort: 'high' }, max_output_tokens: 2048 },
    { nativeSpec: { model: origin.model, thinking: true, reasoningEffort: 'high', maxTokens: 2048 } })));
    await vi.waitFor(() => expect(server.starts).toHaveLength(4));
    expect(server.peak()).toBe(4);
    expect(new Set(server.seen.map(options => options.conversationId)).size).toBe(4);
    expect(server.seen.every(options => options.conversationId!.startsWith(`${options.agentId}:`)
      && options.nativeSpec!.reasoningEffort === 'high' && options.nativeSpec!.maxTokens === 2048)).toBe(true);
    for (const finish of server.pending.values()) finish();
    await Promise.all(work);
  });

  it('a configured agent can use all four gateway slots without limiting an independent service', async () => {
    const server = upstream(), gate = new ModelCallGate(() => 4), shutdown = new AbortController();
    let resource = 'gateway';
    const dynamic = limitModelCalls(server.client, gate, 'agent-a', shutdown.signal, () => resource);
    const gateway = dynamic.bind!();
    resource = 'independent';
    const work = [0, 1, 2, 3].map(index => gateway.respond({ model: origin.model, input: `gateway-${index}` }, { conversationId: `gateway-${index}` }));
    const extra = gateway.respond({ model: origin.model, input: 'extra' }, { conversationId: 'extra' });
    const other = dynamic.respond({ model: origin.model, input: 'other' }, { conversationId: 'other' });
    const same = dynamic.respond({ model: origin.model, input: 'same' }, { conversationId: 'gateway-0' });
    await vi.waitFor(() => expect(server.starts).toHaveLength(5));
    expect(gate.snapshot('gateway')).toMatchObject({ active: 4, queued: 1 });
    expect(gate.snapshot('independent')).toMatchObject({ active: 1, queued: 1 });
    expect(server.starts).not.toContain('same');
    server.pending.get('gateway-0')!(); await work[0];
    await vi.waitFor(() => expect(server.starts).toContain('extra'));
    await vi.waitFor(() => expect(server.starts).toContain('same'));
    for (const finish of server.pending.values()) finish();
    await Promise.all([...work, extra, other, same]);
    expect(gate.snapshot('gateway').active).toBe(0);
    expect(gate.snapshot('independent').active).toBe(0);
  });

  it('admits foreground ahead of waiting work without interrupting an active request', async () => {
    const server = upstream(), gate = new ModelCallGate(() => 1), shutdown = new AbortController();
    const client = limitModelCalls(server.client, gate, 'agent-a', shutdown.signal);
    const run = (name: string, priority?: GenerateOptions['priority']) => client.respond({ model: origin.model, input: name },
      { conversationId: name, priority });
    const active = run('active', 'background'), background = run('background', 'background'), normal = run('normal'), foreground = run('foreground', 'foreground');
    await vi.waitFor(() => expect(server.starts).toEqual(['active']));
    server.pending.get('active')!(); await active;
    await vi.waitFor(() => expect(server.starts).toEqual(['active', 'foreground']));
    server.pending.get('foreground')!(); await foreground;
    await vi.waitFor(() => expect(server.starts).toEqual(['active', 'foreground', 'normal']));
    server.pending.get('normal')!(); await normal;
    await vi.waitFor(() => expect(server.starts).toEqual(['active', 'foreground', 'normal', 'background']));
    server.pending.get('background')!(); await background;
  });

  it('releases a failed generation and retains its metering and nullable execution', async () => {
    const attempt: ProviderAttempt = { id: 'attempt', generationId: 'generation', ordinal: 0, origin,
      startedAt: new Date().toISOString(), elapsedMs: 300, requestId: null, responseId: null, outcome: 'failed', status: 503,
      serviceTier: null, meters: unknownMeters(), charges: [] };
    const gate = new ModelCallGate();
    const itemData = { call: { chatExtraContent: { fixture: { signature: 'opaque' } } } };
    const client = limitModelCalls({ async respond() { throw new GenerationError('unavailable', [attempt], null, origin, 503, '', { itemData }); } },
      gate, 'agent-a', new AbortController().signal);
    const error = await client.respond({ model: origin.model, input: 'private-input' }).catch(error => error);
    expect(error).toBeInstanceOf(GenerationError);
    expect(error.attempts).toMatchObject([{ requestId: null, agentId: 'agent-a', meters: { input: null } }]);
    expect(error.itemData).toEqual(itemData);
    expect(gate.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });
});
