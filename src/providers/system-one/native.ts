import { parseTypedChoice, type DecisionRequest, type DecisionResult } from '../../protocol/typed-decision.ts';

export interface SystemOneOptions { baseUrl: string; endpointPath?: string; model: string; apiKey?: string; fetchImpl?: typeof fetch; }
const meter = (n: unknown): number | null => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;

/** One typed request, no retries or generated-text coercion. Callers own deadlines and stale-scene checks. */
export async function requestDecision(config: SystemOneOptions, input: DecisionRequest,
  options: { signal?: AbortSignal; conversationId?: string } = {}): Promise<DecisionResult> {
  if (!input || typeof input.questions !== 'object' || !input.questions || !Object.keys(input.questions).length)
    throw new Error('Decision questions are required.');
  for (const q of Object.values(input.questions)) {
    if (q.type !== 'choice' || !q.instructions || !q.criteria || Object.keys(q.criteria).length < 2
      || Object.values(q.criteria).some(value => typeof value !== 'string' || !value)) throw new Error('Invalid choice question.');
  }
  const response = await (config.fetchImpl ?? fetch)(config.baseUrl.replace(/\/+$/, '') + (config.endpointPath ?? '/systemone'), {
    method: 'POST', redirect: 'error', signal: options.signal,
    headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      ...(options.conversationId ? { 'x-litellm-session-id': options.conversationId } : {}) },
    body: JSON.stringify({ model: config.model, state: input.state, questions: input.questions }),
  });
  if (!response.ok) throw new Error(`Decision HTTP ${response.status}`);
  let data: Record<string, any>;
  try { data = await response.json() as Record<string, any>; }
  catch { throw new Error('Invalid decision response.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid decision response.');
  const answers: DecisionResult['answers'] = {};
  for (const [key, q] of Object.entries(input.questions)) {
    const answer = parseTypedChoice(data.answers?.[key], Object.keys(q.criteria));
    if (!answer) throw new Error('Invalid decision response.');
    answers[key] = answer;
  }
  return { answers, ...(typeof data.model === 'string' ? { model: data.model } : {}),
    ...(typeof data.latency_ms === 'number' && Number.isFinite(data.latency_ms) && data.latency_ms >= 0 ? { latency_ms: data.latency_ms } : {}),
    usage: { input_tokens: meter(data.usage?.input_tokens), output_tokens: meter(data.usage?.output_tokens),
      cached_input_tokens: meter(data.usage?.cached_input_tokens) } };
}

export async function probeDecision(request: (input: DecisionRequest, options: { signal: AbortSignal }) => Promise<DecisionResult>) {
  const started = Date.now();
  try {
    const value = await request({ state: { marker: 'ready' }, questions: { marker: { type: 'choice',
      instructions: 'Select the marker present in state.', criteria: { ready: 'ready', absent: 'absent' } } } },
    { signal: AbortSignal.timeout(5000) });
    return { ok: true, status: 200, elapsedMs: Date.now() - started, model: value.model,
      usage: { input: value.usage.input_tokens, output: value.usage.output_tokens, cachedInput: value.usage.cached_input_tokens, reasoning: null } };
  } catch (error) {
    return { ok: false, status: null, elapsedMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'Decision unavailable' };
  }
}
