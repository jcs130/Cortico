import { afterEach, describe, expect, it, vi } from 'vitest';
import { inferenceStats } from '../../../src/providers/transport/inference-stats.ts';
import { reasoningStats } from '../../../src/providers/transport/reasoning-stats.ts';
import { OpenAIHttpClient } from '../../../src/providers/transport/chat.ts';
import { nullLogger } from '../../../src/core/util.ts';
import type { ModelSpec } from '../../../src/core/types.ts';
import type { NativeChatMessage } from '../../../src/providers/transport/native-types.ts';

class Fixture extends OpenAIHttpClient {
  constructor() { super('https://fixture.test', nullLogger()); }
  protected buildBody(spec: ModelSpec, messages: NativeChatMessage[], tools?: unknown) { return { model: spec.model, messages, tools }; }
  protected headers() { return { 'Content-Type': 'application/json' }; }
}
const reasoning = { requested: { thinking: true, reasoning_effort: 'high', budget_tokens: 4096 },
  effective: { thinking: true, reasoning_effort: 'medium', native_reasoning_effort: 'medium', budget_tokens: 1024, budget_status: 'applied' },
  confirmation: 'serving_template_and_budget_policy' };
const metadata = { schema: 'llm-request-stats-v1', request_id: 'call-1', input_tokens: 100, output_tokens: 10,
  reasoning_tokens: 4, execution_ms: 150, queue_ms: 30, reasoning };
afterEach(() => vi.unstubAllGlobals());

describe('effective engine reasoning metadata', () => {
  it('keeps requested and effective parameters separate and does not equate received parameters with confirmation', () => {
    expect(reasoningStats(reasoning)).toMatchObject({ confirmed: true, requested: { effort: 'high', budgetTokens: 4096 },
      effective: { effort: 'medium', budgetTokens: 1024 } });
    expect(reasoningStats({ requested: reasoning.requested })).toMatchObject({ confirmed: null, effective: { budgetTokens: null, thinking: null } });
    expect(reasoningStats({ ...reasoning, confirmation: 'requested_only' })).toMatchObject({ confirmed: false });
  });
  it('projects only metadata and excludes disabled, impossible or substituted budgets', () => {
    const value = inferenceStats({ inference_stats: { ...metadata, prompt: 'secret-body', max_output_tokens: 9000,
      reasoning: { ...reasoning, credential: 'secret-key', effective: { thinking: false, budget_tokens: 500, budget_status: 'disabled' } } } }, 'call-1');
    expect(value).toMatchObject({ executionMs: 150, queueMs: 30, reasoningTokens: 4,
      reasoning: { effective: { thinking: false, budgetTokens: null, budgetStatus: 'disabled' } } });
    expect(JSON.stringify(value)).not.toContain('secret');
    expect(reasoningStats({ ...reasoning, effective: { budget_tokens: Infinity, reasoning_effort: 'secret-body' } }))
      .toMatchObject({ confirmed: null, effective: { budgetTokens: null, effort: null } });
  });
  it('reads engine confirmation from ordinary responses and the final usage frame after streaming finishes', async () => {
    for (const stream of [false, true]) {
      vi.stubGlobal('fetch', async () => {
        const body = { id: 'response-1', model: 'fixture', choices: [{ index: 0, message: { content: 'ready' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 10 }, inference_stats: metadata };
        if (!stream) return new Response(JSON.stringify(body), { headers: { 'x-litellm-call-id': 'call-1' } });
        const frames = [{ id: 'response-1', choices: [{ index: 0, delta: { content: 'ready' }, finish_reason: 'stop' }] },
          { id: 'response-1', choices: [], usage: body.usage, inference_stats: metadata }];
        return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
          { headers: { 'x-litellm-call-id': 'call-1', 'Content-Type': 'text/event-stream' } });
      });
      const result = await new Fixture().respond({ model: 'fixture', input: 'input' }, stream ? { onEvent() {} } : {});
      expect(result.attempts[0].inferenceStats).toMatchObject({ requestId: 'call-1', executionMs: 150, queueMs: 30,
        reasoning: { confirmed: true, effective: { effort: 'medium', budgetTokens: 1024 } } });
    }
  });
});
