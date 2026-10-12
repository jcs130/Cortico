import { afterEach, describe, expect, it, vi } from 'vitest';
import { inferenceStats } from '../../../src/providers/transport/inference-stats.ts';
import { OpenAIHttpClient } from '../../../src/providers/transport/chat.ts';
import type { ModelSpec } from '../../../src/core/types.ts';
import type { NativeChatMessage } from '../../../src/providers/transport/native-types.ts';
import { nullLogger } from '../../../src/core/util.ts';
import { SessionLog } from '../../../src/core/session.ts';
import { makeTmpDir } from '../../core/helpers.ts';

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
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

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

  it('uses the same persisted identity in unary and streaming calls and aligns existing body metadata', async () => {
    const tmp = makeTmpDir();
    const sent: Array<{ headers: Headers; body: Record<string, any> }> = [];
    try {
      vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
        const headers = new Headers(init.headers), body = JSON.parse(String(init.body));
        sent.push({ headers, body });
        const returned = { ...stats, session_id: headers.get('x-litellm-session-id') };
        if (!body.stream) return new Response(JSON.stringify({ ...reply, inference_stats: returned }),
          { headers: { 'x-litellm-call-id': 'call-1' } });
        const frames = [
          { id: reply.id, choices: [{ index: 0, delta: { content: 'ready' } }] },
          { id: reply.id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { id: reply.id, choices: [], usage: reply.usage, inference_stats: returned },
        ];
        return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
          { headers: { 'x-litellm-call-id': 'call-1', 'Content-Type': 'text/event-stream' } });
      });
      const client = new Fixture(), session = new SessionLog(tmp.dir);
      const request = { model: 'test', input: 'unchanged-history', metadata: { session_id: 'old-id', label: 'retained' } };
      const unary = await client.respond(request, { conversationId: session.conversationId });
      const restarted = new SessionLog(tmp.dir);
      const streamed = await client.respond(request, { conversationId: restarted.conversationId, onEvent() {} });
      for (const sentRequest of sent) {
        expect(sentRequest.headers.get('x-litellm-session-id')).toBe(session.conversationId);
        expect(sentRequest.body.metadata).toEqual({ session_id: session.conversationId, label: 'retained' });
        expect(sentRequest.body.messages).toEqual([{ role: 'user', content: 'unchanged-history' }]);
      }
      expect(request.metadata.session_id).toBe('old-id');
      expect(unary.attempts[0].inferenceStats?.sessionId).toBe(session.conversationId);
      expect(streamed.attempts[0].inferenceStats?.sessionId).toBe(session.conversationId);
      expect(streamed.attempts[0].inferenceStats?.executionMs).toBeNull();
    } finally { tmp.cleanup(); }
  });

  it('retains identity across HTTP retries without supplying a gateway request id', async () => {
    vi.useFakeTimers();
    const sent: Headers[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      sent.push(new Headers(init.headers));
      return sent.length === 1 ? new Response('retry', { status: 429 })
        : new Response(JSON.stringify({ ...reply, inference_stats: stats }), { headers: { 'x-litellm-call-id': 'call-1' } });
    });
    const promise = new Fixture().respond({ model: 'test', input: 'history' }, { conversationId: 'cortico-retry-context' });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result.attempts).toHaveLength(2);
    expect(sent.map(headers => headers.get('x-litellm-session-id'))).toEqual(['cortico-retry-context', 'cortico-retry-context']);
    expect(sent.every(headers => !headers.has('x-request-id') && !headers.has('x-litellm-call-id'))).toBe(true);
    expect(result.attempts[0].conversationId).toBe(result.attempts[1].conversationId);
    expect(result.attempts[1].inferenceStats?.sessionId).toBe(stats.session_id);
  });

  it('keeps missing response identities and execution readings unknown', () => {
    expect(inferenceStats({ inference_stats: { gateway_duration_ms: 900 } }, null))
      .toMatchObject({ requestId: null, sessionId: null, executionMs: null, queueMs: null, inputTokens: null });
    expect(inferenceStats({ usage: { inference_stats: { execution_ms: 12 } } }, 'call-1'))
      .toMatchObject({ requestId: 'call-1', sessionId: null, executionMs: 12 });
    expect(inferenceStats({}, 'call-1')).toBeNull();
  });
});
