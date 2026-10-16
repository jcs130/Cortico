/** One generation per conversation and a per-service limit across an agent's provider bindings. */
import { createConversationId, validConversationId } from './conversation-id.ts';
import { GenerationError, type ProviderAttempt, type ResponseClient } from './generation.ts';

export const DEFAULT_MODEL_CONCURRENCY = 2;

interface Waiter {
  conversationId: string;
  resource: string;
  priority: number;
  signal: AbortSignal;
  acquired(release: () => void): void;
  aborted(): void;
}

export class ModelCallGate {
  private readonly active = new Map<string, string>();
  private readonly waiting: Waiter[] = [];

  constructor(private readonly limit: (resource: string) => number = () => DEFAULT_MODEL_CONCURRENCY) {}

  snapshot(resource = 'default'): { active: number; queued: number; maxConcurrent: number } {
    return { active: this.activeCount(resource), queued: this.waiting.filter(entry => entry.resource === resource).length,
      maxConcurrent: this.limit(resource) };
  }

  private activeCount(resource: string): number { return [...this.active.values()].filter(value => value === resource).length; }

  acquire(conversationId: string, signal: AbortSignal, resource = 'default', priority = 1): Promise<() => void> {
    signal.throwIfAborted();
    const limit = this.limit(resource);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Model concurrency must be a positive integer');
    return new Promise((resolve, reject) => {
      const remove = (): void => {
        signal.removeEventListener('abort', waiter.aborted);
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
      };
      const waiter: Waiter = { conversationId, resource, priority, signal,
        acquired: release => { remove(); resolve(release); },
        aborted: () => { remove(); reject(signal.reason); this.drain(); },
      };
      signal.addEventListener('abort', waiter.aborted, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    for (;;) {
      const waiter = this.waiting.filter(entry => !this.active.has(entry.conversationId)
        && this.activeCount(entry.resource) < this.limit(entry.resource))
        .reduce<Waiter | undefined>((first, entry) => !first || entry.priority < first.priority ? entry : first, undefined);
      if (!waiter) return;
      this.active.set(waiter.conversationId, waiter.resource);
      let released = false;
      waiter.acquired(() => {
        if (released) return;
        released = true;
        this.active.delete(waiter.conversationId);
        this.drain();
      });
    }
  }
}

/** Bound clients share the gate; queued cancellation never opens an upstream request. */
export function limitModelCalls(client: ResponseClient, gate: ModelCallGate, agentId: string, shutdown: AbortSignal,
  resource: string | (() => string) = 'default'): ResponseClient {
  const resourceKey = (): string => typeof resource === 'function' ? resource() : resource;
  const wrapped: ResponseClient = {
    bind: () => limitModelCalls(client.bind?.() ?? client, gate, agentId, shutdown, resourceKey()),
    async respond(request, options = {}) {
      const conversationId = options.conversationId ?? request.metadata?.session_id ?? createConversationId(agentId);
      if (!validConversationId(conversationId)) throw new TypeError('Invalid gateway session identity');
      const signal = options.signal ? AbortSignal.any([options.signal, shutdown]) : shutdown;
      const started = performance.now();
      const release = await gate.acquire(conversationId, signal, resourceKey(),
        options.priority === 'foreground' ? 0 : options.priority === 'background' ? 2 : 1);
      const clientQueueMs = Math.max(0, performance.now() - started);
      const tag = (attempt: ProviderAttempt): ProviderAttempt => ({ ...attempt, agentId, clientQueueMs });
      try {
        signal.throwIfAborted();
        const result = await client.respond(request, { ...options, agentId, conversationId, clientQueueMs, signal });
        return { ...result, attempts: result.attempts.map(tag) };
      } catch (error) {
        if (error instanceof GenerationError) throw new GenerationError(error.message, error.attempts.map(tag), error.partial,
          error.origin, error.status, error.body, { cause: error, itemData: error.itemData });
        throw error;
      } finally { release(); }
    },
  };
  return wrapped;
}
