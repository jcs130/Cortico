import { afterEach, describe, expect, it, vi } from 'vitest';
import { inferenceStats } from '../../../src/providers/transport/inference-stats.ts';
import { OpenAIHttpClient } from '../../../src/providers/transport/chat.ts';
import type { ModelSpec } from '../../../src/core/types.ts';
import type { NativeChatMessage } from '../../../src/providers/transport/native-types.ts';
import { nullLogger } from '../../../src/core/util.ts';

class Fixture extends OpenAIHttpClient {
  constructor() { super('https://fixture.test', nullLogger()); }
  protected buildBody(spec: ModelSpec, messages: NativeChatMessage[]): Record<string, unknown> { return { model: spec.model, messages }; }
  protected headers() { return { 'Content-Type': 'application/json' }; }
}
const stats = { schema: 'llm-request-stats-v1', request_id: 'call-1', session_id: 'session-1',
  input_tokens: 120, output_tokens: 12, cached_input_tokens: 100, reasoning_tokens: null,
  execution_ms: null, queue_ms: null, gateway_duration_ms: 900, input_processing_ms: 40, decode_ms: 60 };
const reply = { id: 'response-1', model: 'test', choices: [{ index: 0, message: { content: 'ready' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 120, completion_tokens: 12 } };
afterEach(() => vi.unstubAllGlobals());

describe('gateway metadata', () => {
  it('projects only numeric metadata and never derives execution from phase or gateway time', () => {
    const result = inferenceStats({ inference_stats: { ...stats, prompt: 'secret-input', credential: 'secret-key' } }, 'call-1');
    expect(result).toMatchObject({ inputTokens: 120, cachedInputTokens: 100, executionMs: null, queueMs: null, reasoningTokens: null });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(inferenceStats({ inference_stats: stats }, 'different-call')).toBeNull();
    expect(inferenceStats({ response: { inference_stats: stats } }, 'call-1')).toEqual(result);
  });
  it('rejects impossible token subdivisions and nonfinite values', () => {
    expect(inferenceStats({ inference_stats: { ...stats, cached_input_tokens: 121, reasoning_tokens: 13, execution_ms: Infinity } }, null))
      .toMatchObject({ cachedInputTokens: null, reasoningTokens: null, executionMs: null });
  });
  it('associates unary statistics with the HTTP request and forwards the opaque session header', async () => {
    let headers: RequestInit['headers'];
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      headers = init.headers;
      return new Response(JSON.stringify({ ...reply, inference_stats: stats }), { headers: { 'x-litellm-call-id': 'call-1' } });
    });
    const result = await new Fixture().respond({ model: 'test', input: 'input' }, { conversationId: 'opaque-session' });
    expect(new Headers(headers).get('x-litellm-session-id')).toBe('opaque-session');
    expect(result.attempts[0]).toMatchObject({ requestId: 'call-1', inferenceStats: { inputTokens: 120, executionMs: null } });
  });
  it('reads and replaces metadata after the content finish frame in a Chat stream', async () => {
    const frames = [
      { id: 'response-1', model: 'test', choices: [{ index: 0, delta: { content: 'ready' } }], inference_stats: { ...stats, input_tokens: 110 } },
      { id: 'response-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'response-1', choices: [], usage: reply.usage, inference_stats: stats },
    ];
    vi.stubGlobal('fetch', async () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'x-litellm-call-id': 'call-1', 'Content-Type': 'text/event-stream' } }));
    const result = await new Fixture().respond({ model: 'test', input: 'input' }, { onEvent() {} });
    expect(result.response.status).toBe('completed');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].inferenceStats?.inputTokens).toBe(120);
  });
});
