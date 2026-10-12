import { randomUUID } from 'node:crypto';
import { createConversationId } from './conversation-id.ts';
import { GenerationError, type GenerateOptions, type ProviderAttempt, type ResponseClient } from './generation.ts';

export interface ModelRequestObservation {
  kind: 'started';
  id: string;
  atMs: number;
  role: string | null;
  sessionId: string | null;
  conversationId?: string;
  model: string | null;
  thinking: boolean | null;
  effort: string | null;
  estimatedInputTokens: number | null;
  resubmission: boolean;
}
export interface ModelAttemptObservation {
  id: string;
  requestId: string | null;
  sessionId?: string | null;
  ordinal: number;
  outcome: ProviderAttempt['outcome'];
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  elapsedMs: number;
  endedAtMs: number;
  executionMs: number | null;
}
export type ModelObservation = ModelRequestObservation | { kind: 'finished'; id: string; atMs: number; attempts: ModelAttemptObservation[] };

/** Observers receive identities, choices and counters, never request or response Items. */
export function observeModel(client: ResponseClient, emit: (event: ModelObservation) => void): ResponseClient {
  const publish = (event: ModelObservation): void => { try { emit(event); } catch { /* Observation cannot change generation. */ } };
  const finish = (id: string, attempts: readonly ProviderAttempt[]): void => publish({ kind: 'finished', id, atMs: Date.now(),
    attempts: attempts.filter(attempt => attempt.purpose !== 'diagnostic').map(attempt => ({
      id: attempt.id, requestId: attempt.requestId, ordinal: attempt.ordinal, outcome: attempt.outcome,
      sessionId: attempt.inferenceStats?.sessionId ?? null,
      inputTokens: attempt.inferenceStats ? attempt.inferenceStats.inputTokens : attempt.meters.input,
      outputTokens: attempt.inferenceStats ? attempt.inferenceStats.outputTokens : attempt.meters.output,
      cachedInputTokens: attempt.inferenceStats ? attempt.inferenceStats.cachedInputTokens : attempt.meters.cachedInput,
      reasoningTokens: attempt.inferenceStats ? attempt.inferenceStats.reasoningTokens : attempt.meters.reasoning,
      elapsedMs: attempt.elapsedMs, endedAtMs: Date.parse(attempt.startedAt) + attempt.elapsedMs,
      executionMs: attempt.inferenceStats?.executionMs ?? null,
    })) });
  return {
    bind: () => observeModel(client.bind?.() ?? client, emit),
    async respond(request, options: GenerateOptions = {}) {
      const id = randomUUID();
      const conversationId = options.conversationId ?? request.metadata?.session_id ?? createConversationId();
      publish({ kind: 'started', id, atMs: Date.now(), role: options.role ?? null, sessionId: options.sessionId ?? null, conversationId,
        model: request.model ?? null, thinking: options.nativeSpec?.thinking ?? null, effort: options.nativeSpec?.reasoningEffort ?? null,
        estimatedInputTokens: options.estimatedInputTokens ?? null, resubmission: options.resubmission === true });
      try {
        const result = await client.respond(request, { ...options, conversationId });
        finish(id, result.attempts);
        return result;
      } catch (error) {
        finish(id, error instanceof GenerationError ? error.attempts : []);
        throw error;
      }
    },
  };
}
