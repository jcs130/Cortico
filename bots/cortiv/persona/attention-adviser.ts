import type { CoreApi, EventEnvelope } from '../../../src/core/types.ts';

/** Optional semantic advice; geometric player observations remain World facts. */
export interface FastAttentionConfig {
  enabled: boolean;
  endpoint: string;
  timeoutMs: number;
  minConfidence: number;
  cooldownMs: number;
}

export const FAST_ATTENTION_DEFAULTS: FastAttentionConfig = {
  enabled: false, endpoint: '', timeoutMs: 180, minConfidence: 0.75, cooldownMs: 15_000,
};

const DESCRIPTIONS: Record<string, string> = {
  entered: '进入附近可见范围', visible: '从遮挡后进入视野', close: '走到身边',
  moved: '仍在附近移动', wave: '连续空手挥动手臂', crouch: '连续蹲起', looking: '持续朝向你',
};
const CRITERIA = {
  interaction: '身边的人连续挥手、蹲起或持续面对你，可能在找你互动，值得及时留意',
  ambient: '对方只是在路过、远处移动或忙其他事，没有朝向你的互动迹象',
  uncertain: '可见性或动作事实不足、互相矛盾，无法判断是否值得注意',
};
type Choice = keyof typeof CRITERIA;
interface Observation { event: EventEnvelope; name: string; kind: string; distance: number; }

function observation(event: EventEnvelope): Observation | null {
  // Chat body cannot impersonate a structured observation. Renamed Worlds retain the contract.
  if (event.origin !== 'external' || event.type !== `${event.source}.event`) return null;
  const value = event.meta?.minecraftPlayerObservation;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || raw.visible !== true || typeof raw.playerName !== 'string'
    || !raw.playerName.trim() || raw.playerName.length > 64 || typeof raw.kind !== 'string'
    || !Object.hasOwn(DESCRIPTIONS, raw.kind) || typeof raw.distance !== 'number'
    || !Number.isFinite(raw.distance) || raw.distance < 0 || raw.distance > 8) return null;
  return { event, name: raw.playerName, kind: raw.kind, distance: raw.distance };
}

function readAnswer(value: unknown): { choice: Choice; confidence: number; latencyMs?: number } | null {
  if (!value || typeof value !== 'object') return null;
  const root = value as Record<string, any>;
  const answer = root.answers?.attention;
  if (!answer || typeof answer.choice !== 'string' || !Object.hasOwn(CRITERIA, answer.choice) || typeof answer.confidence !== 'number'
    || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return null;
  const probabilities = answer.probabilities;
  if (!probabilities || Object.keys(CRITERIA).some(key => typeof probabilities[key] !== 'number'
    || !Number.isFinite(probabilities[key]) || probabilities[key] < 0 || probabilities[key] > 1)) return null;
  if (Math.abs(probabilities[answer.choice] - answer.confidence) > 0.01
    || Math.abs(Object.keys(CRITERIA).reduce((sum, key) => sum + probabilities[key], 0) - 1) > 0.02) return null;
  return { choice: answer.choice, confidence: answer.confidence,
    ...(typeof root.latency_ms === 'number' && Number.isFinite(root.latency_ms)
      && root.latency_ms >= 0 ? { latencyMs: root.latency_ms } : {}) };
}

/**
 * One compressed scene, one bounded classifier request, no action authority. This adds advice to
 * the current event batch; it never drops an observation or creates another main-model turn.
 */
export class CortiVSocialAttention {
  private readonly attempts = new Map<string, number>();
  private controller: AbortController | null = null;
  private generation = 0;

  constructor(private readonly config: () => FastAttentionConfig,
    private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  reset(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.attempts.clear();
  }

  observe(events: readonly EventEnvelope[], core: CoreApi): void | Promise<void> {
    const cfg = this.config();
    if (!cfg.enabled || !cfg.endpoint.trim() || this.controller) return;
    const now = this.now();
    const candidates = events.map(observation).filter((item): item is Observation => item !== null)
      .filter(item => {
        const at = Date.parse(item.event.ts);
        return Number.isFinite(at) && now - at >= -1000 && now - at <= 30_000;
      });
    // Prefer the latest actual gesture over a proximity edge from the same delivery batch.
    const selected = [...candidates].reverse().find(item => item.kind === 'wave' || item.kind === 'crouch')
      ?? candidates.at(-1);
    if (!selected) return;
    const key = `${selected.event.source}/${selected.name}`;
    const cooldown = Math.max(0, cfg.cooldownMs);
    if (now - (this.attempts.get(key) ?? -Infinity) < cooldown) return;
    this.attempts.set(key, now);
    for (const [name, at] of this.attempts) if (now - at > Math.max(cooldown, 60_000)) this.attempts.delete(name);
    return this.classify(selected, cfg, core);
  }

  private async classify(item: Observation, cfg: FastAttentionConfig, core: CoreApi): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const generation = this.generation;
    const started = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = Math.max(10, Math.min(500, cfg.timeoutMs));
    let outcome = 'unavailable';
    try {
      const request = (async () => {
        const response = await this.fetchImpl(cfg.endpoint, {
          method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            state: { situation: `可见的玩家${item.name}在距离${Math.round(item.distance * 10) / 10}格处${DESCRIPTIONS[item.kind]}。这只是动作事实，还不知道对方的意图。` },
            questions: { attention: { type: 'choice',
              instructions: '判断是否值得及时注意并考虑回应，不要求确定对方真实意图。不能凭动作断言已求助。只选分类，不生成台词或动作。',
              criteria: CRITERIA } },
          }),
        });
        if (!response.ok) return null;
        return readAnswer(await response.json());
      })();
      const answer = await Promise.race([request, new Promise<null>(resolve => {
        timer = setTimeout(() => { outcome = 'timeout'; controller.abort(); resolve(null); }, timeout);
      })]);
      if (generation !== this.generation || JSON.stringify(cfg) !== JSON.stringify(this.config())) {
        outcome = 'stale'; return;
      }
      if (!answer) return;
      if (answer.confidence < cfg.minConfidence || answer.choice === 'uncertain') {
        core.log.debug('社交快判断证据不足', { cursor: item.event.cursor, choice: answer.choice,
          confidence: answer.confidence, latencyMs: answer.latencyMs });
        outcome = 'uncertain'; return;
      }
      outcome = answer.choice;
      if (answer.choice === 'interaction') core.injectInternal(
        `[快判断/推测] 观察事件#${item.event.cursor}中，玩家${item.name}的动作可能在向你互动（分类置信度${Math.round(answer.confidence * 100)}%）。`
        + '这不证明对方意图。结合当前视野、最近交谈和手头任务自行决定是否看向、打招呼、回答或做一个合适的动作；'
        + '可以边做事边回应，不必重复问候刚聊过的人。战斗和危险中的身体动作由现有执行器处理，分类器没有下达命令。这段判断不用口播。',
        'social-attention',
      );
      core.log.info('社交快判断', { cursor: item.event.cursor, player: item.name, kind: item.kind,
        choice: answer.choice, confidence: answer.confidence, latencyMs: answer.latencyMs,
        elapsedMs: this.now() - started });
    } catch { outcome = controller.signal.aborted ? 'timeout' : 'unavailable'; }
    finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
      if (outcome === 'timeout' || outcome === 'unavailable' || outcome === 'stale' || outcome === 'uncertain') {
        core.log.debug('社交快判断保留原事件', { cursor: item.event.cursor, outcome, elapsedMs: this.now() - started });
      }
    }
  }
}
