import type { InferenceStats } from '../../core/generation.ts';
import { reasoningStats } from './reasoning-stats.ts';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
const id = (value: unknown): string | null => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value) ? value : null;

/** Final snapshots replace earlier snapshots; the HTTP attempt owns their association. */
export function inferenceStats(payload: unknown, expectedRequestId: string | null, expectedSessionId?: string): InferenceStats | null {
  const root = object(payload);
  const response = object(root.response);
  const raw = root.inference_stats ?? response.inference_stats ?? object(root.usage).inference_stats ?? object(response.usage).inference_stats;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = object(raw);
  const suppliedRequestId = id(source.request_id);
  const requestId = suppliedRequestId ?? expectedRequestId;
  const sessionId = id(source.session_id);
  if (suppliedRequestId && expectedRequestId && suppliedRequestId !== expectedRequestId
    || sessionId && expectedSessionId && sessionId !== expectedSessionId
    || source.schema !== undefined && source.schema !== 'llm-request-stats-v1') return null;
  const input = count(source.input_tokens), output = count(source.output_tokens);
  const cached = count(source.cached_input_tokens), reasoning = count(source.reasoning_tokens);
  return { requestId, sessionId, inputTokens: input, outputTokens: output,
    cachedInputTokens: input !== null && cached !== null && cached <= input ? cached : null,
    reasoningTokens: output !== null && reasoning !== null && reasoning <= output ? reasoning : null,
    gatewayDurationMs: number(source.gateway_duration_ms), gatewayTtftMs: number(source.gateway_ttft_ms),
    inputProcessingMs: number(source.input_processing_ms), decodeMs: number(source.decode_ms),
    executionMs: number(source.execution_ms), queueMs: number(source.queue_ms),
    inputTokS: number(source.input_tok_s), outputTokS: number(source.output_tok_s), reasoning: reasoningStats(source.reasoning) };
}
