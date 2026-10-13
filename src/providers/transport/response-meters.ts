import { unknownMeters, type TokenMeters } from '../../core/generation.ts';

/** A missing or malformed counter stays unknown; only allowlisted native counters are retained. */
function number(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

const COUNTS = ['prompt_tokens', 'completion_tokens', 'input_tokens', 'output_tokens', 'total_tokens',
  'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'cached_tokens', 'reasoning_tokens',
  'audio_tokens', 'image_tokens', 'text_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'];
const DETAILS = ['prompt_tokens_details', 'completion_tokens_details', 'input_tokens_details', 'output_tokens_details'];

/** Retain standard usage counters without persisting arbitrary upstream strings or content. */
function usageMetadata(raw: Record<string, any>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of COUNTS) if (Object.hasOwn(raw, key)) result[key] = number(raw[key]);
  for (const key of DETAILS) if (raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key])) result[key] = usageMetadata(raw[key]);
  return result;
}

/** Native Chat Completions usage, including DeepSeek's explicit cache distribution. */
export function chatMeters(raw: Record<string, any> | null | undefined): TokenMeters {
  if (!raw) return unknownMeters();
  const input = number(raw.prompt_tokens);
  const output = number(raw.completion_tokens);
  const cachedInput = number(raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens);
  const uncachedInput = number(raw.prompt_cache_miss_tokens) ?? (input !== null && cachedInput !== null ? input - cachedInput : null);
  const validCached = cachedInput !== null && (input === null || cachedInput <= input) ? cachedInput : null;
  const reasoning = number(raw.completion_tokens_details?.reasoning_tokens);
  return { input, output, total: number(raw.total_tokens) ?? (input !== null && output !== null ? input + output : null),
    cachedInput: validCached, uncachedInput: uncachedInput !== null && uncachedInput >= 0
      && (input === null || uncachedInput <= input) ? uncachedInput : null,
    reasoning: reasoning !== null && (output === null || reasoning <= output) ? reasoning : null, native: usageMetadata(raw) };
}

export function responseMeters(raw: Record<string, any> | null | undefined): TokenMeters {
  if (!raw) return unknownMeters();
  const input = number(raw.input_tokens);
  const output = number(raw.output_tokens);
  const cachedInput = number(raw.input_tokens_details?.cached_tokens);
  const uncachedInput = input !== null && cachedInput !== null ? input - cachedInput : null;
  const reasoning = number(raw.output_tokens_details?.reasoning_tokens);
  return { input, output, total: number(raw.total_tokens) ?? (input !== null && output !== null ? input + output : null),
    cachedInput: cachedInput !== null && (input === null || cachedInput <= input) ? cachedInput : null,
    uncachedInput: uncachedInput !== null && uncachedInput >= 0 ? uncachedInput : null,
    reasoning: reasoning !== null && (output === null || reasoning <= output) ? reasoning : null,
    native: usageMetadata(raw) };
}
