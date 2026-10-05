export interface FastReferenceConfig {
  enabled: boolean;
  endpoint: string;
  timeoutMs: number;
  minIntervalMs: number;
  minConfidence: number;
  maxResultAgeMs: number;
}

export const FAST_REFERENCE_DEFAULTS: FastReferenceConfig = {
  enabled: false, endpoint: '', timeoutMs: 120, minIntervalMs: 15_000,
  minConfidence: 0.75, maxResultAgeMs: 15_000,
};

export const REFERENCE_MAX_TOPICS = 16;
export const REFERENCE_MAX_STATE_CHARS = 2400;
export const REFERENCE_MAX_TIMEOUT_MS = 500;
export const REFERENCE_MAX_SUMMARY_CHARS = 80;

export interface FastReferenceTopic {
  key: string;
  /** Brief material scope used to distinguish this topic from the other choices. */
  summary: string;
}

/** Topic advice carries no authority to change a task or execute tools. */
export interface ReferenceAdvice {
  topicKey: string | null;
  confidence: number;
  topicProbabilities: Record<string, number>;
  sampledAtMs: number;
  latencyMs?: number;
}

export type ReferenceAdviceResult =
  | { kind: 'advice'; advice: ReferenceAdvice }
  | { kind: 'skipped'; reason: 'disabled' | 'busy' | 'duplicate' | 'throttled' | 'stale'; retryAfterMs?: number }
  | { kind: 'skipped'; reason: 'uncertain'; advice: ReferenceAdvice }
  | { kind: 'error'; reason: 'invalid-state' | 'timeout' | 'transport' | 'http' | 'invalid-response'; status?: number };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function distribution(value: unknown, keys: readonly string[]): Record<string, number> | null {
  const values = object(value);
  if (!values || Object.keys(values).length !== keys.length
    || !keys.every(key => Object.hasOwn(values, key) && probability(values[key]))
    || Math.abs(keys.reduce((sum, key) => sum + Number(values[key]), 0) - 1) > 0.02) return null;
  return Object.fromEntries(keys.map(key => [key, Number(values[key])]));
}

function choice(value: unknown, keys: readonly string[]): {
  choice: string; confidence: number; probabilities: Record<string, number>;
} | null {
  const answer = object(value);
  if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string'
    || !keys.includes(answer.choice) || !probability(answer.confidence)) return null;
  const probabilities = distribution(answer.probabilities, keys);
  if (!probabilities || Math.abs(probabilities[answer.choice] - answer.confidence) > 0.01) return null;
  return { choice: answer.choice, confidence: answer.confidence, probabilities };
}

function parseAdvice(value: unknown, topicKeys: readonly string[], sampledAtMs: number): ReferenceAdvice | null {
  const root = object(value);
  const answers = object(root?.answers);
  if (!root || !answers) return null;
  const topic = choice(answers.topic, topicKeys);
  if (!topic) return null;
  if (root.latency_ms !== undefined && (typeof root.latency_ms !== 'number'
    || !Number.isFinite(root.latency_ms) || root.latency_ms < 0)) return null;
  return {
    topicKey: topic.choice === 'none' ? null : topic.choice,
    confidence: topic.confidence,
    topicProbabilities: topic.probabilities,
    sampledAtMs,
    ...(typeof root.latency_ms === 'number' ? { latencyMs: root.latency_ms } : {}),
  };
}

interface Operation {
  sceneKey: string;
  generation: number;
  controller: AbortController;
  promise: Promise<ReferenceAdviceResult>;
}

/** One brief scene and a bounded topic catalogue produce one reading-topic choice. */
export class ReferenceAdviceClient {
  private operation: Operation | null = null;
  private pendingTransport: Promise<ReferenceAdviceResult> | null = null;
  private generation = 0;
  private lastStartedAtMs = -Infinity;
  private readonly recent = new Map<string, number>();

  constructor(private readonly config: () => FastReferenceConfig,
    private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  reset(): void {
    this.generation++;
    this.operation?.controller.abort();
    this.operation = null;
    this.recent.clear();
    this.lastStartedAtMs = -Infinity;
  }

  advise(state: Record<string, unknown>, topics: readonly FastReferenceTopic[], sceneKey: string): Promise<ReferenceAdviceResult> {
    const cfg = { ...this.config() };
    if (!cfg.enabled || !cfg.endpoint.trim()) return Promise.resolve({ kind: 'skipped', reason: 'disabled' });
    if (this.operation) return this.operation.sceneKey === sceneKey
      ? this.operation.promise : Promise.resolve({ kind: 'skipped', reason: 'busy' });
    // A transport that ignores abort keeps its slot until it actually settles.
    if (this.pendingTransport) return Promise.resolve({ kind: 'skipped', reason: 'busy' });
    const now = this.now();
    for (const [key, at] of this.recent) if (now - at >= cfg.maxResultAgeMs) this.recent.delete(key);
    if (this.recent.has(sceneKey)) return Promise.resolve({ kind: 'skipped', reason: 'duplicate' });
    const remainingMs = this.lastStartedAtMs + cfg.minIntervalMs - now;
    if (remainingMs > 0) return Promise.resolve({ kind: 'skipped', reason: 'throttled', retryAfterMs: remainingMs });
    let body: string;
    try {
      if (!sceneKey || topics.length === 0 || topics.length > REFERENCE_MAX_TOPICS
        || new Set(topics.map(topic => topic.key)).size !== topics.length
        || topics.some(topic => !topic.key.trim() || topic.key === 'none' || topic.key.length > 80
          || !topic.summary.trim() || topic.summary.length > REFERENCE_MAX_SUMMARY_CHARS)) {
        return Promise.resolve({ kind: 'error', reason: 'invalid-state' });
      }
      const serialized = JSON.stringify(state);
      if (!serialized || serialized.length > REFERENCE_MAX_STATE_CHARS || !object(JSON.parse(serialized))) {
        return Promise.resolve({ kind: 'error', reason: 'invalid-state' });
      }
      body = JSON.stringify({ state: JSON.parse(serialized), questions: {
        topic: { type: 'choice', instructions: '根据当前活动与观察，选择最相关的参考主题；没有相关主题或事实不足时选择 none。只选择给出的主题。',
          criteria: Object.fromEntries([...topics.map(topic => [topic.key, topic.summary]), ['none', '当前无需参考主题，或事实不足以选定主题。']]) },
      } });
    } catch { return Promise.resolve({ kind: 'error', reason: 'invalid-state' }); }
    this.lastStartedAtMs = now;
    const operation: Operation = { sceneKey, generation: this.generation, controller: new AbortController(),
      promise: Promise.resolve({ kind: 'skipped', reason: 'stale' }) };
    this.operation = operation;
    operation.promise = this.request(body, [...topics.map(topic => topic.key), 'none'], now, cfg, operation)
      .then(result => {
        if (operation.generation !== this.generation) return { kind: 'skipped', reason: 'stale' } as const;
        if (result.kind === 'advice' || (result.kind === 'skipped' && result.reason === 'uncertain')) {
          this.recent.set(sceneKey, now);
          // Bound deduplication storage independently of catalogue paging.
          if (this.recent.size > 64) this.recent.delete(this.recent.keys().next().value!);
        }
        return result;
      }).finally(() => { if (this.operation === operation) this.operation = null; });
    return operation.promise;
  }

  private async request(body: string, topicKeys: readonly string[], sampledAtMs: number,
    cfg: FastReferenceConfig, operation: Operation): Promise<ReferenceAdviceResult> {
    const transport = (async (): Promise<ReferenceAdviceResult> => {
      let response: Response;
      try {
        response = await this.fetchImpl(cfg.endpoint, { method: 'POST',
          headers: { 'content-type': 'application/json' }, body, signal: operation.controller.signal });
      } catch { return { kind: 'error', reason: 'transport' }; }
      if (!response.ok) return { kind: 'error', reason: 'http', status: response.status };
      let payload: unknown;
      try { payload = await response.json(); }
      catch { return { kind: 'error', reason: 'invalid-response' }; }
      const advice = parseAdvice(payload, topicKeys, sampledAtMs);
      if (!advice) return { kind: 'error', reason: 'invalid-response' };
      if (this.now() - sampledAtMs > cfg.maxResultAgeMs) return { kind: 'skipped', reason: 'stale' };
      return advice.confidence < cfg.minConfidence
        ? { kind: 'skipped', reason: 'uncertain', advice } : { kind: 'advice', advice };
    })();
    this.pendingTransport = transport;
    void transport.then(() => { if (this.pendingTransport === transport) this.pendingTransport = null; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort!: () => void;
    try {
      return await Promise.race([transport, new Promise<ReferenceAdviceResult>(resolve => {
        onAbort = () => resolve({ kind: 'skipped', reason: 'stale' });
        operation.controller.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          resolve({ kind: 'error', reason: 'timeout' });
          operation.controller.abort();
        }, Math.max(1, Math.min(REFERENCE_MAX_TIMEOUT_MS, cfg.timeoutMs)));
      })]);
    } finally {
      clearTimeout(timer);
      operation.controller.signal.removeEventListener('abort', onAbort);
    }
  }
}
