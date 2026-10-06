import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelSpec } from '../../../src/core/types.ts';
import type { StreamEvent } from '../../../src/protocol/open-responses/index.ts';
import { GenerationError } from '../../../src/core/generation.ts';
import { message, record, functionResult, responseRecords } from '../../../src/protocol/open-responses/context.ts';
import { responseRequest } from '../../../src/protocol/open-responses/context-helpers.ts';
import { ChatCompatProvider, buildChatCompatRequestBody } from '../../../src/providers/openai-chat-compat/native.ts';

afterEach(() => vi.unstubAllGlobals());

const spec: ModelSpec = { model: 'test-model', thinking: true, reasoningEffort: 'high' };
const tools = [{ name: 'inspect', description: 'Reads the visible state.', parameters: { type: 'object', properties: { target: { type: 'string' } } } }];
const response = (text = 'ready') => new Response(JSON.stringify({ id: 'completion', model: spec.model,
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 23, completion_tokens: 7 } }));

function stream(chunks: unknown[]): Response {
  const data = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(new ReadableStream({ start(controller) {
    const bytes = new TextEncoder().encode(data);
    for (let offset = 0; offset < bytes.length; offset += 19) controller.enqueue(bytes.slice(offset, offset + 19));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

describe('Chat Completions request mapping', () => {
  it('maps the model thinking switch without adding template-specific fields', () => {
    expect(buildChatCompatRequestBody(spec, [])).toMatchObject({ reasoning_effort: 'high' });
    expect(buildChatCompatRequestBody({ ...spec, thinking: false }, [])).toMatchObject({ reasoning_effort: 'none' });
    expect(buildChatCompatRequestBody({ ...spec, reasoningEffort: undefined }, [])).not.toHaveProperty('reasoning_effort');
    const delegated = buildChatCompatRequestBody(spec, [], undefined, { reasoningMode: 'extra_body' });
    expect(delegated).not.toHaveProperty('reasoning_effort');
    expect(delegated).not.toHaveProperty('chat_template_kwargs');
  });

  it('replays reasoning only when enabled and respects the host history policy without mutating it', () => {
    const messages = [
      { role: 'assistant' as const, content: 'opening', reasoning_content: 'initial context', head: true as const },
      { role: 'assistant' as const, content: 'answer', reasoning_content: 'past thought' },
    ];
    const before = structuredClone(messages);
    const standard = buildChatCompatRequestBody(spec, messages).messages as any[];
    expect(standard.every(item => !('reasoning_content' in item))).toBe(true);
    const retained = buildChatCompatRequestBody(spec, messages, undefined, { replayReasoning: true }).messages as any[];
    expect(retained.map(item => item.reasoning_content)).toEqual(['initial context', 'past thought']);
    const reduced = buildChatCompatRequestBody(spec, messages, undefined, { replayReasoning: true, keepThinking: false }).messages as any[];
    expect(reduced.map(item => item.reasoning_content)).toEqual(['initial context', undefined]);
    expect(messages).toEqual(before);
    expect(retained.some(item => 'head' in item)).toBe(false);
  });

  it('uses connection body fields and endpoint headers while preserving the caller stream choice', async () => {
    let seen: { url: string; headers: Headers; body: any } | undefined;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
      return response();
    });
    const client = new ChatCompatProvider({ baseUrl: 'https://model.test/v1/', endpointPath: '/custom/completions', apiKey: 'fixture-key',
      extraHeaders: { authorization: 'ignored-key', 'X-Transport': 'fixture' }, reasoningMode: 'extra_body',
      extraBody: { thinking_switch: true, max_tokens: 41, stream: true } });
    const request = { ...responseRequest({ ...spec, maxTokens: 99 }, [message('user', 'inspect')], tools),
      tool_choice: 'auto' as const, parallel_tool_calls: false, service_tier: 'default' as const, top_p: 0.8,
      text: { format: { type: 'json_schema' as const, name: 'result', schema: { type: 'object' }, strict: true } } };
    const result = await client.respond(request, { nativeSpec: spec });
    expect(seen!.url).toBe('https://model.test/v1/custom/completions');
    expect(seen!.headers.get('authorization')).toBe('Bearer fixture-key');
    expect(seen!.headers.get('x-transport')).toBe('fixture');
    expect(seen!.body).toMatchObject({ max_tokens: 41, stream: false, thinking_switch: true, tool_choice: 'auto', parallel_tool_calls: false,
      top_p: 0.8, service_tier: 'default', response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true } } });
    expect(seen!.body).not.toHaveProperty('reasoning_effort');
    expect(seen!.body).not.toHaveProperty('input');
    expect(result.response.output[0]).toMatchObject({ type: 'message', content: [{ type: 'output_text', text: 'ready' }] });
    expect(result.attempts[0].meters).toMatchObject({ input: 23, output: 7, total: 30, cachedInput: null, uncachedInput: null, reasoning: null });
  });

  it('maps instructions, tools and saved or inline images, retaining only the newest saved image', async () => {
    const reads: string[] = [];
    let body: any;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return response(); });
    const client = new ChatCompatProvider({ baseUrl: 'https://model.test/v1',
      media: { enabled: () => true, maxContextImages: 1, read: handle => { reads.push(handle); return Buffer.from(handle); } } });
    const context = [
      message('developer', 'instructions'),
      message('user', 'old image', { blobs: [{ handle: 'old', mime: 'image/png', fallbackText: 'old image' }] }),
      record({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new image' },
        { type: 'input_image', image_url: 'data:image/png;base64,aW5saW5l', detail: 'low' }] },
      { blobs: [{ handle: 'new', mime: 'image/png', fallbackText: 'new image' }] }),
    ];
    const before = structuredClone(context);
    await client.respond({ ...responseRequest(spec, context, tools), instructions: 'system instructions' }, { context, nativeSpec: spec });
    expect(body.messages[0]).toEqual({ role: 'system', content: 'system instructions' });
    expect(body.messages[1]).toEqual({ role: 'system', content: 'instructions' });
    expect(body.messages[2]).toEqual({ role: 'user', content: 'old image' });
    expect(body.messages[3].content).toEqual([
      { type: 'text', text: 'new image' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW5saW5l', detail: 'low' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,bmV3' } },
    ]);
    expect(reads).toEqual(['new']);
    expect(context).toEqual(before);
    expect(body.tools).toEqual([{ type: 'function', function: tools[0] }]);
    expect(body.messages.some((item: any) => 'blobs' in item || 'parts' in item || 'head' in item)).toBe(false);
  });
});

describe('shared native tool and response lifecycle', () => {
  it('streams parallel function calls with reasoning and replays their matching results in a second round', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) return stream([
        { id: 'turn-1', model: spec.model, choices: [{ index: 0, delta: { reasoning_content: 'inspect both' } }] },
        { choices: [{ delta: { tool_calls: [
          { index: 0, id: 'call-a', type: 'function', function: { name: 'inspect', arguments: '{"target":' } },
          { index: 1, id: 'call-b', type: 'function', function: { name: 'inspect', arguments: '{"target":' } },
        ] } }] },
        { choices: [{ delta: { tool_calls: [
          { index: 0, function: { arguments: '"east"}' } }, { index: 1, function: { arguments: '"west"}' } },
        ] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100,
          prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 8 } } },
      ]);
      return stream([{ id: 'turn-2', model: spec.model, choices: [{ index: 0, delta: { content: 'both clear' }, finish_reason: 'stop' }] }]);
    });
    const events: StreamEvent[] = [];
    const client = new ChatCompatProvider({ baseUrl: 'https://model.test/v1', replayReasoning: true });
    const initial = [message('user', 'inspect both directions')];
    const first = await client.respond(responseRequest(spec, initial, tools), { context: initial, nativeSpec: spec, onEvent: event => events.push(event) });
    const calls = first.response.output.filter(item => item.type === 'function_call');
    expect(calls.map(item => [item.call_id, item.name, item.arguments])).toEqual([
      ['call-a', 'inspect', '{"target":"east"}'], ['call-b', 'inspect', '{"target":"west"}'],
    ]);
    expect(first.response.output[0]).toMatchObject({ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'inspect both' }] });
    expect(first.attempts[0].meters).toMatchObject({ input: 80, output: 20, total: 100, cachedInput: 60, uncachedInput: 20, reasoning: 8 });
    expect(events.at(-1)!.type).toBe('response.completed');
    expect(events.filter(event => event.type === 'response.function_call_arguments.done')).toHaveLength(2);
    const context = [...initial, ...responseRecords(first.response, first.origin), functionResult('call-a', 'east clear'), functionResult('call-b', 'west clear')];
    const second = await client.respond(responseRequest(spec, context, tools), { context, nativeSpec: spec, onEvent: () => {} });
    expect(bodies[1].messages).toEqual([
      { role: 'user', content: 'inspect both directions' },
      { role: 'assistant', content: '', reasoning_content: 'inspect both', tool_calls: [
        { id: 'call-a', type: 'function', function: { name: 'inspect', arguments: '{"target":"east"}' } },
        { id: 'call-b', type: 'function', function: { name: 'inspect', arguments: '{"target":"west"}' } },
      ] },
      { role: 'tool', content: 'east clear', tool_call_id: 'call-a' },
      { role: 'tool', content: 'west clear', tool_call_id: 'call-b' },
    ]);
    expect(bodies.every(body => body.stream && body.stream_options.include_usage)).toBe(true);
    expect(second.response.output[0]).toMatchObject({ content: [{ text: 'both clear' }] });
    expect(second.attempts[0].meters.input).toBeNull();
  });

  it('maps a nonstream function response to a canonical call without losing reasoning or IDs', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id: 'turn', model: spec.model,
      choices: [{ message: { role: 'assistant', content: null, reasoning_content: 'check east',
        tool_calls: [{ id: 'call-c', type: 'function', function: { name: 'inspect', arguments: '{"target":"east"}' } }] }, finish_reason: 'tool_calls' }] })));
    const result = await new ChatCompatProvider({ baseUrl: 'https://model.test/v1' }).respond(responseRequest(spec, [message('user', 'inspect')], tools));
    expect(result.response.output).toMatchObject([
      { type: 'reasoning', content: [{ text: 'check east' }] },
      { type: 'function_call', call_id: 'call-c', name: 'inspect', arguments: '{"target":"east"}', status: 'completed' },
    ]);
  });

  it('propagates caller cancellation to an in-flight request and records one aborted attempt', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const fetching = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      started();
    }));
    const pending = new ChatCompatProvider({ baseUrl: 'https://model.test/v1' }).respond({ model: spec.model, input: 'hi' }, { signal: controller.signal });
    const settled = pending.catch(error => error);
    await fetching;
    controller.abort(new Error('caller stopped'));
    const error = await settled;
    expect(error).toBeInstanceOf(GenerationError);
    expect(error.attempts).toHaveLength(1);
    expect(error.attempts[0].outcome).toBe('aborted');
    expect(error.message).toContain('caller stopped');
  });
});
