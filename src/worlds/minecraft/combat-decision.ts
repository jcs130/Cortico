/** An asynchronous choice over a bounded, previously authored combat tactic. */
import { parseTypedChoice } from '../../protocol/typed-decision.ts';
import type { Battlefield } from './battlefield.ts';
import type { CombatProgram } from './combat-program.ts';

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
  program?: CombatProgram;
  actionPool?: CombatCandidate[];
  policy?: { name: string; sourceHash: string; instructions: string };
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
  apply: (candidate: CombatCandidate, frame: CombatDecisionFrame) => boolean;
  prepare?: (frame: CombatDecisionFrame) => Promise<CombatDecisionFrame>;
  fallback?: () => void;
  report: (event: string, data: Record<string, unknown>) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function sceneFacts(frame: CombatDecisionFrame) {
  const f = frame.battlefield;
  return { connection: [f.connectionGeneration, f.dimension], tactic: frame.tacticRevision,
    self: [f.self.entityId, f.self.health.current, f.self.health.max, f.self.food],
    action: [f.action.fighting, f.action.emergency, f.action.taskId, f.action.step, f.action.targetEntityId, f.action.canStep],
    skills: frame.skills.map(s => [s.spell, s.available, s.manaCost, s.block,
      s.cooldownRemainingMs === null ? null : s.cooldownRemainingMs > 0]),
    actors: [...f.actors].sort((a, b) => (a.entityId ?? -1) - (b.entityId ?? -1)
      || (a.uuid ?? '').localeCompare(b.uuid ?? '')).map(e => [e.entityId, e.uuid, e.type, e.relation,
      e.health.current, e.health.max, e.lineOfSight, e.targetEntityId]) };
}

function sceneChanges(before: CombatDecisionFrame, after: CombatDecisionFrame): string[] {
  const prior = sceneFacts(before), current = sceneFacts(after);
  const changed: string[] = (Object.keys(prior) as Array<keyof typeof prior>)
    .filter(key => JSON.stringify(prior[key]) !== JSON.stringify(current[key]));
  // Regeneration preserves a still-eligible choice; spending and unknown readings invalidate it.
  if (before.mana !== after.mana && !(before.mana !== null && after.mana !== null && after.mana >= before.mana))
    changed.push('mana');
  return changed;
}

export class CombatDecisionLoop {
  private inFlight = false;
  private lastCheckedAtMs = -Infinity;
  private lastEligible = false;
  private serial = 0;
  private readonly decisions: Array<Record<string, unknown>> = [];
  constructor(private readonly options: CombatDecisionOptions) {}

  inspect(id?: number): unknown {
    if (id !== undefined) return structuredClone(this.decisions.find(d => d.id === id) ?? null);
    return this.decisions.map(({ frame: _frame, ...entry }) => structuredClone(entry));
  }

  /** Called from the game clock. Neither this method nor the attack executor awaits inference. */
  tick(): boolean {
    const cfg = { ...this.options.config() };
    const now = this.options.now?.() ?? Date.now();
    if (!cfg.enabled || !cfg.endpoint) return false;
    if (this.inFlight) return true;
    if (now - this.lastCheckedAtMs < cfg.minIntervalMs) return this.lastEligible;
    this.lastCheckedAtMs = now;
    const frame = this.options.sample();
    this.lastEligible = !!frame && !frame.battlefield.action.emergency && (frame.candidates.length > 0 || !!frame.program);
    if (!frame || !this.lastEligible) return false;
    this.inFlight = true;
    void this.choose(frame, cfg, now).finally(() => { this.inFlight = false; });
    return true;
  }

  private async choose(frame: CombatDecisionFrame, cfg: CombatDecisionConfig, startedAtMs: number): Promise<void> {
    const now = () => this.options.now?.() ?? Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const id = ++this.serial;
    const entry: Record<string, unknown> = { id, startedAtMs, tacticRevision: frame.tacticRevision };
    this.decisions.push(entry);
    if (this.decisions.length > 8) this.decisions.shift();
    try {
      if (frame.program && this.options.prepare) frame = await this.options.prepare(frame);
    } catch (error) {
      entry.outcome = 'program-error'; entry.reason = String(error);
      this.options.report('error', { ...entry }); this.options.fallback?.(); return;
    }
    if (!frame.candidates.length) { entry.outcome = 'program-idle'; return; }
    const criteria: Record<string, string> = { keep: frame.battlefield.action.fighting
      ? 'Continue the current attack and movement without an extra action.'
      : 'Wait without engaging or moving. No attack is currently running.' };
    frame.candidates.forEach((c, i) => { criteria[`option_${i}`] = c.kind === 'cast'
      ? `${c.intent} Cast ${c.spell}, mana cost ${c.manaCost}.` : c.intent; });
    const { program: _program, actionPool: _pool, ...publicFrame } = frame;
    const body = JSON.stringify({ state: { ...publicFrame, objective: 'Assist the party against eligible visible enemies, survive and preserve useful ongoing attacks.' }, questions: { tactic: {
      type: 'choice', instructions: 'Choose an immediate available combat action or keep the ongoing action. Use observed enemy and ally facts; null means unknown. Omitted entities may exist. Preserve health and useful ongoing attacks.'
        + (frame.policy ? '\nAgent-authored tactic: ' + frame.policy.instructions : ''), criteria,
    } } });
    const scope = { id, startedAtMs, connectionGeneration: frame.battlefield.connectionGeneration,
      sampledAtMs: frame.battlefield.sampledAtMs, tacticRevision: frame.tacticRevision,
      program: frame.policy ? { name: frame.policy.name, sourceHash: frame.policy.sourceHash } : null };
    Object.assign(entry, scope, { frame: publicFrame });
    this.options.report('requested', { ...scope, mode: cfg.mode, frame: publicFrame, requestBytes: Buffer.byteLength(body) });
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
      let current = this.options.sample();
      if (current?.program && this.options.prepare) current = await this.options.prepare(current);
      const elapsedMs = now() - startedAtMs;
      const selected = answer.choice === 'keep' ? null : frame.candidates[Number(answer.choice.slice(7))];
      const executable = selected && current?.candidates.find(c => c.id === selected.id && c.kind === selected.kind
        && (selected.kind !== 'cast' || (c.kind === 'cast' && c.spell === selected.spell && c.ruleId === selected.ruleId))
        && (selected.kind !== 'engage' || (c.kind === 'engage' && c.targetId === selected.targetId && c.uuid === selected.uuid)));
      const changed = current ? sceneChanges(frame, current) : ['unavailable'];
      let outcome: string;
      if (!liveCfg.enabled || liveCfg.mode !== cfg.mode || liveCfg.endpoint !== cfg.endpoint) outcome = 'configuration-changed';
      else if (elapsedMs > Math.min(cfg.maxAgeMs, liveCfg.maxAgeMs)) outcome = 'expired';
      else if (!current || changed.length) outcome = 'scene-changed';
      else if (Math.hypot(...current.battlefield.self.position.map((v, i) => v - frame.battlefield.self.position[i])) > 1.5) outcome = 'moved';
      else if (answer.choiceProbability < Math.max(cfg.minConfidence, liveCfg.minConfidence)) outcome = 'uncertain';
      else if (!selected) outcome = 'keep';
      else if (!executable) outcome = 'no-longer-executable';
      else if (cfg.mode === 'shadow') outcome = 'shadow';
      // Movement prose includes measured distance; apply the freshly checked candidate.
      else outcome = this.options.apply(executable, current) ? 'sent' : 'rejected';
      if (outcome === 'uncertain' && cfg.mode === 'act') this.options.fallback?.();
      const result = { ...scope, elapsedMs, choice: answer.choice,
        probability: answer.choiceProbability, probabilities: answer.probabilities, outcome,
        sceneChanges: changed,
        modelMs: payload.latency_ms ?? null, usage: payload.usage ?? null,
        candidate: (outcome === 'sent' ? executable : selected) ?? null };
      Object.assign(entry, result);
      this.options.report('result', result);
      if (outcome === 'sent') {
        const before = current!.battlefield;
        const targetId = executable?.kind === 'engage' ? executable.targetId : before.action.targetEntityId;
        const timer = setTimeout(() => {
          const after = this.options.sample()?.battlefield;
          const observation = !after || after.connectionGeneration !== before.connectionGeneration || after.dimension !== before.dimension
            ? { verified: false, reason: 'connection-or-dimension-changed' }
            : { verified: true, sampledAtMs: after.sampledAtMs, positionBefore: before.self.position,
              positionAfter: after.self.position, displacement: Math.hypot(...after.self.position.map((v, i) => v - before.self.position[i])),
              healthBefore: before.self.health.current, healthAfter: after.self.health.current,
              actionBefore: before.action, actionAfter: after.action,
              targetBefore: before.actors.find(a => a.entityId === targetId) ?? null,
              targetAfter: after.actors.find(a => a.entityId === targetId) ?? null };
          entry.observation = observation;
          this.options.report('observation', { ...scope, candidate: executable, observation });
        }, 1000);
        timer.unref?.();
      }
    } catch (error) {
      const live = this.options.config();
      if (cfg.mode === 'act' && live.enabled && live.mode === cfg.mode && live.endpoint === cfg.endpoint)
        this.options.fallback?.();
      const failure = { ...scope, outcome: 'error', elapsedMs: now() - startedAtMs,
        reason: controller.signal.aborted ? 'timeout' : error instanceof Error ? error.message : 'transport' };
      Object.assign(entry, failure); this.options.report('error', failure);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
