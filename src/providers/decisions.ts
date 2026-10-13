import { randomUUID } from 'node:crypto';
import type { CoreConfig } from '../core/types.ts';
import type { ModelObservation } from '../core/model-observer.ts';
import { createConversationId } from '../core/conversation-id.ts';
import type { DecisionHost } from '../protocol/typed-decision.ts';
import type { ProviderRegistry } from './registry.ts';

export function decisionHost(options: { registry: ProviderRegistry; config: () => CoreConfig; caller: string;
  agentId: string; active?: () => boolean; signal?: AbortSignal; observe?: (event: ModelObservation) => void }): DecisionHost {
  const publish = (event: ModelObservation) => { try { options.observe?.(event); } catch { /* Metrics cannot change the decision. */ } };
  return { async request(input, request = {}) {
    if (options.active?.() === false) throw new Error('Decision host is inactive.');
    const name = request.provider?.trim() || options.config().decisionProvider;
    if (!name) throw new Error('No decision connection is selected.');
    const entry = options.config().providers[name];
    if (!entry) throw new Error('Decision connection is unavailable.');
    const revision = JSON.stringify(entry);
    const instance = options.registry.resolve(name);
    if (!instance.decide) throw new Error('This connection does not support typed decisions.');
    const timeoutMs = request.timeoutMs ?? 1000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid decision deadline.');
    const deadline = new AbortController();
    const signal = AbortSignal.any([deadline.signal, ...(request.signal ? [request.signal] : []), ...(options.signal ? [options.signal] : [])]);
    signal.throwIfAborted();
    const id = randomUUID(), conversationId = createConversationId(options.agentId), started = Date.now();
    publish({ kind: 'started', id, atMs: started, role: `decision:${options.caller}`, sessionId: null, conversationId,
      agentId: options.agentId, model: entry.spec?.model ?? null, thinking: false, effort: null, estimatedInputTokens: null, resubmission: false });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let result: Awaited<ReturnType<NonNullable<typeof instance.decide>>> | undefined;
    let outcome: 'completed' | 'failed' | 'aborted' | 'discarded' = 'failed';
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('Decision request aborted.'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        timer = setTimeout(() => deadline.abort(), timeoutMs);
      });
      result = await Promise.race([aborted, Promise.resolve().then(() => { signal.throwIfAborted(); return instance.decide!(input, { signal, conversationId }); })]);
      const currentName = request.provider?.trim() || options.config().decisionProvider;
      if (signal.aborted || options.active?.() === false) { outcome = 'aborted'; throw new Error('Decision host is inactive.'); }
      if (name !== currentName || revision !== JSON.stringify(options.config().providers[name])) {
        outcome = 'discarded'; throw new Error('Decision connection changed during the request.');
      }
      outcome = 'completed'; return result;
    } finally {
      clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort);
      publish({ kind: 'finished', id, atMs: Date.now(), attempts: [{ id, ordinal: 1, requestId: null,
        sessionId: conversationId, outcome: signal.aborted ? 'aborted' : outcome,
        inputTokens: result?.usage.input_tokens ?? null, outputTokens: result?.usage.output_tokens ?? null,
        cachedInputTokens: result?.usage.cached_input_tokens ?? null, reasoningTokens: null,
        elapsedMs: Date.now() - started, endedAtMs: Date.now(), executionMs: null }] });
    }
  } };
}
