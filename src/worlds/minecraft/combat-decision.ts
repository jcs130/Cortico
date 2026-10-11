/** An asynchronous choice over a bounded, previously authored combat tactic. */
import { parseTypedChoice } from '../../protocol/typed-decision.ts';
import type { Battlefield } from './battlefield.ts';

export type CombatCandidate = { id: string; intent: string } & (
  { kind: 'cast'; spell: string; manaCost: number; ruleId: string }
  | { kind: 'engage'; targetId: number; uuid: string | null }
  | { kind: 'step'; destination: [number, number, number] }
  | { kind: 'retreat' }
);
export interface CombatDecisionFrame {
  battlefield: Battlefield;
  tacticRevision: number;
  mana: number | null;
  skills: Array<{ spell: string; available: boolean; manaCost: number | null;
    cooldownRemainingMs: number | null; block: string | null }>;
  candidates: CombatCandidate[];
  omittedCandidates: number;
}
export interface CombatDecisionConfig {
  enabled: boolean; mode: 'shadow' | 'act'; endpoint: string; timeoutMs: number;
  minIntervalMs: number; minConfidence: number; maxAgeMs: number; maxEntities: number; maxCandidates: number;
  allowMovement: boolean; allowEngage: boolean; engageScope: 'party' | 'hostile';
  movementStallMs: number;
}
export interface CombatDecisionOptions {
  config: () => CombatDecisionConfig;
  sample: () => CombatDecisionFrame | null;
  apply: (candidate: CombatCandidate) => boolean;
  fallback?: () => void;
  report: (event: string, data: Record<string, unknown>) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function sceneKey(frame: CombatDecisionFrame): string {
  const f = frame.battlefield;
  return JSON.stringify([f.connectionGeneration, f.dimension, frame.tacticRevision, frame.mana,
    f.self.health.current, f.self.health.max, f.self.food,
    [f.action.fighting, f.action.emergency, f.action.taskId, f.action.step, f.action.targetEntityId, f.action.canStep],
    frame.skills.map(s => [s.spell, s.available, s.manaCost, s.block,
      s.cooldownRemainingMs === null ? null : s.cooldownRemainingMs > 0]),
    f.actors.map(e => [e.entityId, e.uuid, e.type, e.relation,
      e.health.current, e.health.max, e.lineOfSight, e.targetEntityId])]);
}

export class CombatDecisionLoop {
  private inFlight = false;
  private lastCheckedAtMs = -Infinity;
  private lastEligible = false;
  constructor(private readonly options: CombatDecisionOptions) {}

  /** Called from the game clock. Neither this method nor the attack executor awaits inference. */
  tick(): boolean {
    const cfg = { ...this.options.config() };
    const now = this.options.now?.() ?? Date.now();
    if (!cfg.enabled || !cfg.endpoint) return false;
    if (this.inFlight) return true;
    if (now - this.lastCheckedAtMs < cfg.minIntervalMs) return this.lastEligible;
    this.lastCheckedAtMs = now;
    const frame = this.options.sample();
    this.lastEligible = !!frame && !frame.battlefield.action.emergency && frame.candidates.length > 0;
    if (!frame || !this.lastEligible) return false;
    this.inFlight = true;
    void this.choose(frame, cfg, now).finally(() => { this.inFlight = false; });
    return true;
  }

  private async choose(frame: CombatDecisionFrame, cfg: CombatDecisionConfig, startedAtMs: number): Promise<void> {
    const now = () => this.options.now?.() ?? Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const criteria: Record<string, string> = { keep: frame.battlefield.action.fighting
      ? 'Continue the current attack and movement without an extra action.'
      : 'Wait without engaging or moving. No attack is currently running.' };
    frame.candidates.forEach((c, i) => { criteria[`option_${i}`] = c.kind === 'cast'
      ? `${c.intent} Cast ${c.spell}, mana cost ${c.manaCost}.` : c.intent; });
    const body = JSON.stringify({ state: { ...frame, objective: 'Assist the party against eligible visible enemies, survive and preserve useful ongoing attacks.' }, questions: { tactic: {
      type: 'choice', instructions: 'Choose an immediate available combat action or keep the ongoing action. Use observed enemy and ally facts; null means unknown. Omitted entities may exist. Preserve health and useful ongoing attacks.', criteria,
    } } });
    const scope = { startedAtMs, connectionGeneration: frame.battlefield.connectionGeneration,
      sampledAtMs: frame.battlefield.sampledAtMs, tacticRevision: frame.tacticRevision };
    this.options.report('requested', { ...scope, mode: cfg.mode, frame, requestBytes: Buffer.byteLength(body) });
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, cfg.timeoutMs);
      });
      const payload = await Promise.race([(async () => {
        const response = await (this.options.fetchImpl ?? fetch)(cfg.endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal,
        });
        if (!response.ok) throw new Error(`http-${response.status}`);
        return await response.json() as { answers?: { tactic?: unknown }; latency_ms?: unknown; usage?: unknown };
      })(), timeout]);
      const answer = parseTypedChoice(payload.answers?.tactic, Object.keys(criteria));
      if (!answer) throw new Error('invalid-response');
      const liveCfg = this.options.config();
      const current = this.options.sample();
      const elapsedMs = now() - startedAtMs;
      const selected = answer.choice === 'keep' ? null : frame.candidates[Number(answer.choice.slice(7))];
      let outcome: string;
      if (!liveCfg.enabled || liveCfg.mode !== cfg.mode || liveCfg.endpoint !== cfg.endpoint) outcome = 'configuration-changed';
      else if (elapsedMs > Math.min(cfg.maxAgeMs, liveCfg.maxAgeMs)) outcome = 'expired';
      else if (!current || sceneKey(current) !== sceneKey(frame)) outcome = 'scene-changed';
      else if (Math.hypot(...current.battlefield.self.position.map((v, i) => v - frame.battlefield.self.position[i])) > 1.5) outcome = 'moved';
      else if (answer.choiceProbability < Math.max(cfg.minConfidence, liveCfg.minConfidence)) outcome = 'uncertain';
      else if (!selected) outcome = 'keep';
      else if (!current.candidates.some(c => c.id === selected.id && c.kind === selected.kind && c.intent === selected.intent)) outcome = 'no-longer-executable';
      else if (cfg.mode === 'shadow') outcome = 'shadow';
      else outcome = this.options.apply(selected) ? 'sent' : 'rejected';
      if (outcome === 'uncertain' && cfg.mode === 'act') this.options.fallback?.();
      this.options.report('result', { ...scope, elapsedMs, choice: answer.choice,
        probability: answer.choiceProbability, probabilities: answer.probabilities, outcome,
        modelMs: payload.latency_ms ?? null, usage: payload.usage ?? null,
        candidate: selected ?? null });
    } catch (error) {
      const live = this.options.config();
      if (cfg.mode === 'act' && live.enabled && live.mode === cfg.mode && live.endpoint === cfg.endpoint)
        this.options.fallback?.();
      this.options.report('error', { ...scope, elapsedMs: now() - startedAtMs,
        reason: controller.signal.aborted ? 'timeout' : error instanceof Error ? error.message : 'transport' });
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
