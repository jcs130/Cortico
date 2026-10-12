import { describe, expect, it } from 'vitest';
import { observeModel, type ModelObservation } from '../../src/core/model-observer.ts';
import { inferenceStats } from '../../src/providers/transport/inference-stats.ts';
import { unknownMeters, type ResponseClient, type GenerateOptions, type ProviderAttempt } from '../../src/core/generation.ts';
import { createResponse } from '../../src/protocol/open-responses/index.ts';

const origin = { instance: 'fixture', module: 'fixture', model: 'test', compatibilityDomain: 'fixture' };

describe('model metadata observer', () => {
  it('keeps stable opaque conversation ids and publishes no model content or credentials', async () => {
    const seen: ModelObservation[] = [], sessions: string[] = [];
    const attempt: ProviderAttempt = { id: 'attempt', generationId: 'generation', ordinal: 1, origin,
      startedAt: new Date().toISOString(), elapsedMs: 30, requestId: 'call', responseId: 'response', outcome: 'completed',
      status: 200, serviceTier: null, meters: { ...unknownMeters(), input: 100, output: 10, reasoning: 0 }, charges: [],
      inferenceStats: inferenceStats({ inference_stats: { request_id: 'call', input_tokens: 100, output_tokens: 10, reasoning_tokens: null } }, 'call')! };
    const client: ResponseClient = { async respond(_request, options?: GenerateOptions) {
      sessions.push(options!.conversationId!);
      return { response: { ...createResponse('response', { model: 'test' }), status: 'completed' }, origin: attempt.origin, attempts: [attempt] };
    } };
    const wrapped = observeModel(client, event => seen.push(event), 'runtime');
    await wrapped.respond({ model: 'test', input: 'secret-prompt' }, { sessionId: 'private-session', role: 'main', nativeSpec: { model: 'test', thinking: true, reasoningEffort: 'high' } });
    await wrapped.bind!().respond({ model: 'test', input: 'secret-prompt' }, { sessionId: 'private-session', role: 'main' });
    expect(sessions[0]).toBe(sessions[1]);
    expect(sessions[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(seen.filter(event => event.kind === 'started')).toHaveLength(2);
    expect(seen[1]).toMatchObject({ kind: 'finished', attempts: [{ inputTokens: 100, reasoningTokens: null, executionMs: null }] });
    expect(JSON.stringify(seen)).not.toContain('secret-prompt');
    expect(seen[0]).toMatchObject({ thinking: true, effort: 'high' });
  });
  it('an observer failure cannot change generation', async () => {
    const client: ResponseClient = { async respond() { return { response: { ...createResponse('response', { model: 'test' }), status: 'completed' },
      origin, attempts: [] }; } };
    const wrapped = observeModel(client, () => { throw new Error('observer unavailable'); }, 'runtime');
    await expect(wrapped.respond({ model: 'test', input: '' })).resolves.toMatchObject({ response: { status: 'completed' } });
  });
});
