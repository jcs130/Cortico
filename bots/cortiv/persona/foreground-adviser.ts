/** Optional context and response-timing fallback. No action or memory-writing authority. */
import { createHash } from 'node:crypto';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { parseTypedChoice } from 'cortico/protocol/typed-decision.ts';

export interface FastForegroundConfig {
  enabled: boolean;
  endpoint: string;
  timeoutMs: number;
  minConfidence: number;
  minIntervalMs: number;
  focusedHistoryTokens: number;
  deferQueueTail: boolean;
  maxDeferMs: number;
}

export const FAST_FOREGROUND_DEFAULTS: FastForegroundConfig = {
  enabled: false, endpoint: '', timeoutMs: 120, minConfidence: .8,
  minIntervalMs: 2000, focusedHistoryTokens: 3000, deferQueueTail: false, maxDeferMs: 10_000,
};

const READING = {
  focused: '当前目标、现场事实、最新完整调用与回执足以继续，只需少量最近历史',
  connected: '需要较早的人物约定、地点、步骤或失败证据，或者当前依赖不明确；保留通常历史并按需展开原始证据',
};
const TIMING = {
  continue: '当前身体任务正常执行，没有新问题或计划变化，等执行终态或有新输入时再决策',
  respond: '当前需要制定后续动作、核验异常、处理变化或回应新输入，主意识现在决策',
};

export interface ForegroundScene {
  events: readonly EventEnvelope[];
  facts: readonly { source: string; text: string }[];
  agenda: string;
  intent?: { tool: string; arguments: string; receipt?: string; at?: string };
}

export interface ForegroundAdvice {
  kind: 'advice' | 'disabled' | 'cooldown' | 'uncertain' | 'timeout' | 'unavailable' | 'stale';
  reading?: keyof typeof READING;
  defer: boolean;
  readingProbability?: number;
  timingProbability?: number;
  elapsedMs?: number;
  latencyMs?: number;
  inputChars?: number;
  cursors: number[];
}

/** Only a fresh structured queue-tail observation can defer; any other substantive event bypasses it. */
export function queueTailOpportunity(events: readonly EventEnvelope[], now: number): EventEnvelope | null {
  let tail: EventEnvelope | null = null;
  for (const event of events) {
    if (event.contextDelivery === 'archive-only') continue;
    if (event.blobs?.length) return null;
    if (event.origin === 'internal') {
      if (event.source === 'persona' && (event.type === 'notice' || event.type === 'tick')) continue;
      return null;
    }
    const raw = event.meta?.minecraftQueueTail;
    if (event.type === `${event.source}.task.queue` && raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const value = raw as Record<string, unknown>;
      const age = now - Date.parse(event.ts);
      if (value.schemaVersion !== 1 || !Number.isInteger(value.taskId) || !Number.isInteger(value.stepIndex)
        || !Number.isInteger(value.stepCount) || (value.stepCount as number) < 1
        || value.stepIndex !== (value.stepCount as number) - 1 || !Number.isFinite(age) || age < 0 || age > 1000) return null;
      tail = event;
      continue;
    }
    if (event.tags?.includes('snapshot') && (event.type === `${event.source}.world.snapshot`
      || event.type === `${event.source}.status`)) continue;
    return null;
  }
  return tail;
}

function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = '\n[中段未展开]\n';
  const head = Math.floor((max - marker.length) / 3);
  return text.slice(0, head) + marker + text.slice(-(max - marker.length - head));
}

export class ForegroundAdviser {
  private controller: AbortController | null = null;
  private generation = 0;
  private lastAttemptAt = -Infinity;

  constructor(private readonly config: () => FastForegroundConfig,
    private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  reset(): void { this.generation++; this.controller?.abort(); this.controller = null; this.lastAttemptAt = -Infinity; }

  async advise(scene: ForegroundScene): Promise<ForegroundAdvice> {
    const cfg = this.config();
    const started = this.now();
    const base = { defer: false, cursors: scene.events.map(event => event.cursor) };
    if (!cfg.enabled || !cfg.endpoint.trim()) return { ...base, kind: 'disabled' };
    if (this.controller || started - this.lastAttemptAt < cfg.minIntervalMs) return { ...base, kind: 'cooldown' };
    this.lastAttemptAt = started;
    const opportunity = cfg.deferQueueTail ? queueTailOpportunity(scene.events, started) : null;
    const state = {
      sampledAt: new Date(started).toISOString(),
      observations: scene.events.filter(event => event.contextDelivery !== 'archive-only'
        && !(event.source === 'persona' && event.type === 'notice')).slice(-3)
        .map(event => ({ source: event.source, type: event.type, cursor: event.cursor, at: event.ts, text: excerpt(event.text, 200) })),
      facts: scene.facts.slice(0, 2).map(fact => ({ source: fact.source, text: excerpt(fact.text, 300) })),
      agenda: excerpt(scene.agenda, 240),
      recentRequest: scene.intent ? { ...scene.intent, arguments: excerpt(scene.intent.arguments, 140),
        receipt: excerpt(scene.intent.receipt ?? '', 240) } : null,
      queueTail: opportunity?.meta?.minecraftQueueTail ?? null,
      boundary: '状态、目标、新用户输入、完整最新调用与失败回执始终保留。只选择额外历史的阅读量；继续执行不等于完成。',
    };
    const body = JSON.stringify({ state, questions: {
      reading: { type: 'choice', instructions: '按本次问题选择需要阅读的历史深度；信息依赖不明确时选 connected。无需输出解释。', criteria: READING },
      ...(opportunity ? { timing: { type: 'choice', instructions: '现在只有仍在执行的尾步队列观察。判断是否需要提前规划；有不确定性选 respond。此选择不能停止、替换或新增身体任务。', criteria: TIMING } } : {}),
    } });
    const controller = new AbortController();
    this.controller = controller;
    const generation = this.generation;
    const configKey = createHash('sha256').update(JSON.stringify(cfg)).digest('hex');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const request = (async () => {
        const response = await this.fetchImpl(cfg.endpoint, { method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }, body });
        return response.ok ? response.json() : null;
      })();
      const raw = await Promise.race([request, new Promise<null>(resolve => {
        timer = setTimeout(() => { timedOut = true; controller.abort(); resolve(null); }, Math.max(1, Math.min(250, cfg.timeoutMs)));
      })]) as { answers?: Record<string, unknown>; latency_ms?: number } | null;
      const measured = { elapsedMs: this.now() - started, inputChars: body.length,
        ...(typeof raw?.latency_ms === 'number' && Number.isFinite(raw.latency_ms) ? { latencyMs: raw.latency_ms } : {}) };
      if (generation !== this.generation || configKey !== createHash('sha256').update(JSON.stringify(this.config())).digest('hex'))
        return { ...base, ...measured, kind: 'stale' };
      if (!raw) return { ...base, ...measured, kind: timedOut ? 'timeout' : 'unavailable' };
      const reading = parseTypedChoice(raw.answers?.reading, Object.keys(READING) as Array<keyof typeof READING>);
      const timing = opportunity ? parseTypedChoice(raw.answers?.timing, Object.keys(TIMING) as Array<keyof typeof TIMING>) : null;
      const acceptedReading = reading && reading.choiceProbability >= cfg.minConfidence;
      // A late queue observation never authorizes a delay, even when its classifier result is confident.
      const defer = !!(opportunity && queueTailOpportunity(scene.events, this.now())
        && timing?.choice === 'continue' && timing.choiceProbability >= cfg.minConfidence);
      return { ...base, ...measured, kind: acceptedReading || defer ? 'advice' : 'uncertain',
        ...(acceptedReading ? { reading: reading.choice } : {}), defer,
        readingProbability: reading?.choiceProbability, timingProbability: timing?.choiceProbability };
    } catch { return { ...base, kind: timedOut ? 'timeout' : 'unavailable', elapsedMs: this.now() - started, inputChars: body.length }; }
    finally { clearTimeout(timer); if (this.controller === controller) this.controller = null; }
  }
}
