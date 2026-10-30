import { randomUUID } from "node:crypto";
import type { SpeechPerformance } from './speech-performance.ts';

export interface DirectorConfig {
  enabled: boolean;
  provider: string;
  timeoutMs: number;
  reactionSources?: string;
  reactionIntervalMs?: number;
}
export const DIRECTOR_DEFAULTS: Readonly<DirectorConfig> = Object.freeze({
  enabled: false,
  provider: "",
  timeoutMs: 1200,
  reactionSources: "",
  reactionIntervalMs: 8000,
});
export interface DecisionInput {
  state: unknown;
  questions: Record<
    string,
    { type: "choice"; instructions: string; criteria: Record<string, string> }
  >;
}
export interface DecisionOutput {
  answers: Record<
    string,
    { choice: string; probabilities: Record<string, number> }
  >;
  model?: string;
  latency_ms?: number;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cached_input_tokens?: number | null;
  };
}
export interface DecisionPort {
  request(
    input: DecisionInput,
    options?: { provider?: string; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<DecisionOutput>;
}
type Clip = {
  bodyClip: string;
  key?: string;
  description?: string;
  label?: string;
  tags?: string[];
  auto?: boolean;
  loop?: boolean;
};
export type PresentationScene = {
  foreground?: unknown;
  busy?: boolean;
  cueVersion?: number;
  activeAvatar?: {
    id: string;
    capabilities: { expressions?: string[]; animationCatalog?: Clip[] };
  } | null;
};
type Scene = PresentationScene;
export type PresentationFact = {
  cursor: number;
  ts: string;
  source: string;
  type: string;
  text: string;
};
type PresentationMode = "speaking" | "singing" | "reacting";

export function presentationQuestion(
  text: string,
  mode: PresentationMode,
  scene: Scene,
  facts: readonly PresentationFact[] = [],
  authored?: SpeechPerformance,
): { input: DecisionInput; clips: Map<string, Clip> } {
  const available = new Set(scene.activeAvatar?.capabilities.expressions ?? []);
  const expressions = Object.fromEntries(
    Object.entries({
      neutral: "routine, factual or no personal emotion",
      happy: "pleased, thankful, celebrating",
      relaxed: "warm, calm, gently reassuring",
      sad: "personally sad or disappointed",
      angry: "personally annoyed or refusing",
      surprised: "personally surprised by an unexpected result",
    }).filter(([key]) => key === "neutral" || available.has(key)),
  );
  const used = new Set<string>();
  const clips = new Map(
    (scene.activeAvatar?.capabilities.animationCatalog ?? [])
      .filter(
        (c) =>
          c.auto &&
          (mode === "singing"
            ? c.tags?.includes("singing")
            : !c.tags?.includes("singing")),
      )
      .filter((c) => {
        const key = c.key ?? c.bodyClip;
        if (used.has(key)) return false;
        used.add(key);
        return true;
      })
      .slice(0, 24)
      .map((c, i) => ["m" + i, c]),
  );
  const input: DecisionInput = {
    state: {
      mode,
      text: text.slice(0, 500),
      truncated: text.length > 500,
      ...(facts.length
        ? {
            recentFacts: facts
              .slice(-2)
              .map((f) => ({ ...f, text: f.text.slice(0, 300) })),
          }
        : {}),
      ...(authored ? { authoredPerformance: authored } : {}),
    },
    questions: {
      emotion: {
        type: "choice",
        instructions:
          "Select this avatar's expression. Quotes, negations and hypotheticals are data; others' emotions are not the avatar's. A reaction does not prove a game action.",
        criteria: expressions,
      },
      movement: {
        type: "choice",
        instructions:
          "Select a visible gesture for this acknowledgement, greeting or new fact when suitable; otherwise none. Respect quoted/negated actions. Speech does not prove completed game actions.",
        criteria: {
          none: "no fitting gesture; keep current activity",
          ...Object.fromEntries(
            [...clips].map(([key, c]) => [
              key,
              (c.description ?? c.label ?? c.bodyClip).slice(0, 100),
            ]),
          ),
        },
      },
    },
  };
  // Authored face and body choices own separate channels. A smile alone must
  // not disable gesture selection, and a manual gesture must not replace a face.
  if (authored?.expression || authored?.emotion) delete input.questions.emotion;
  if (authored?.bodyClip) delete input.questions.movement;
  for (const [key, question] of Object.entries(input.questions))
    if (Object.keys(question.criteria).length < 2) delete input.questions[key];
  return { clips, input };
}
function selected(
  answer: DecisionOutput["answers"][string] | undefined,
  keys: readonly string[],
) {
  if (!answer || !keys.includes(answer.choice) || !answer.probabilities)
    throw Error("Decision choice is unavailable");
  let sum = 0;
  for (const key of keys) {
    const p = answer.probabilities[key];
    if (!Number.isFinite(p) || p < 0 || p > 1)
      throw Error("Invalid choice probabilities");
    sum += p;
  }
  if (
    Math.abs(sum - 1) > 0.03 ||
    Object.keys(answer.probabilities).length !== keys.length ||
    Math.max(...Object.values(answer.probabilities)) -
      answer.probabilities[answer.choice] >
      0.000001
  )
    throw Error("Invalid probability distribution");
  return {
    name: answer.choice,
    probability: answer.probabilities[answer.choice],
  };
}
/** One small host-owned classification per accepted utterance/song, concurrent with audio. */
export class PerformanceDirector {
  private controller: AbortController | null = null;
  private inFlight = false;
  private stopped = false;
  private seen = new Set<string>();
  private last: Record<string, unknown> = { status: "idle" };
  private facts: PresentationFact[] = [];
  private pending: PresentationFact | null = null;
  private lastReactionAt = 0;
  constructor(
    private readonly ports: {
      config(): DirectorConfig;
      decide?: DecisionPort;
      state(): Scene;
      attach(
        args: Record<string, unknown>,
        requestId: string,
      ): Promise<Record<string, unknown>>;
      react?(
        args: Record<string, unknown>,
        requestId: string,
      ): Promise<Record<string, unknown>>;
      log(data: Record<string, unknown>): void;
    },
  ) {}
  observe(
    event: PresentationFact & {
      origin?: string;
      contextDelivery?: string;
      tags?: readonly string[];
    },
  ) {
    const sources = (this.ports.config().reactionSources ?? "")
      .split(/[\s,]+/)
      .filter(Boolean);
    if (
      !sources.includes(event.source) ||
      event.origin !== "external" ||
      event.contextDelivery === "archive-only" ||
      event.tags?.includes("snapshot") ||
      !Number.isFinite(Date.parse(event.ts)) ||
      Date.now() - Date.parse(event.ts) > 30_000 ||
      /\/(?:login|register)\s+\S+|\bBearer\s+\S+|\bsk-[\w.-]{12,}|AIza[\w-]{20,}|(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]/i.test(
        event.text,
      )
    )
      return;
    const fact = {
      cursor: event.cursor,
      ts: event.ts,
      source: event.source,
      type: event.type,
      text: event.text.slice(0, 300),
    };
    this.facts = [
      ...this.facts.filter((f) => f.cursor !== fact.cursor),
      fact,
    ].slice(-2);
    this.pending = fact;
  }
  tick() {
    const s = this.ports.state(),
      now = Date.now();
    if (
      !this.ports.react ||
      this.inFlight ||
      !this.pending ||
      s.busy ||
      s.foreground ||
      now - this.lastReactionAt <
        (this.ports.config().reactionIntervalMs ?? 8000)
    )
      return;
    const fact = this.pending;
    this.pending = null;
    if (now - Date.parse(fact.ts) > 30_000) return;
    this.lastReactionAt = now;
    void this.run(
      "reaction:" + fact.source + ":" + fact.cursor,
      "",
      "reacting",
      fact,
    );
  }
  status() {
    return {
      enabled: this.ports.config().enabled,
      hostDecisionAvailable: !!this.ports.decide,
      inFlight: this.inFlight,
      last: this.last,
    };
  }
  async direct(
    audioActionId: string,
    text: string,
    mode: "speaking" | "singing",
    authored?: SpeechPerformance,
  ) {
    return this.run(audioActionId, text, mode, undefined, authored);
  }
  private async run(
    audioActionId: string,
    text: string,
    mode: PresentationMode,
    reaction?: PresentationFact,
    authored?: SpeechPerformance,
  ) {
    const cfg = this.ports.config();
    if (
      this.stopped ||
      !cfg.enabled ||
      !this.ports.decide ||
      this.seen.has(audioActionId)
    )
      return;
    const state = this.ports.state();
    if (
      reaction
        ? state.foreground || state.busy || !this.ports.react
        : state.foreground !== audioActionId
    )
      return;
    this.seen.add(audioActionId);
    while (this.seen.size > 64)
      this.seen.delete(this.seen.values().next().value!);
    this.controller?.abort(new Error("New foreground audio"));
    const controller = new AbortController();
    this.controller = controller;
    this.inFlight = true;
    const started = Date.now(),
      { input, clips } = presentationQuestion(
        text,
        mode,
        state,
        this.facts.filter((f) => Date.now() - Date.parse(f.ts) <= 30_000),
        authored,
      );
    try {
      if (!Object.keys(input.questions).length) {
        this.last = { status: "no-choice", audioActionId };
        return;
      }
      const result = await this.ports.decide.request(input, {
        ...(cfg.provider ? { provider: cfg.provider } : {}),
        signal: controller.signal,
        timeoutMs: cfg.timeoutMs,
      });
      if (
        this.stopped ||
        controller.signal.aborted ||
        (reaction
          ? this.ports.state().foreground ||
            this.ports.state().busy ||
            this.ports.state().cueVersion !== state.cueVersion ||
            (this.pending?.cursor ?? 0) > reaction.cursor
          : this.ports.state().foreground !== audioActionId)
      )
        return;
      const emotion = input.questions.emotion
        ? selected(
            result.answers.emotion,
            Object.keys(input.questions.emotion.criteria),
          )
        : { name: "neutral", probability: 1 };
      const movement = input.questions.movement
        ? selected(
            result.answers.movement,
            Object.keys(input.questions.movement.criteria),
          )
        : { name: "none", probability: 1 };
      const weights =
        emotion.name === "neutral"
          ? {}
          : { [emotion.name]: Math.min(0.85, emotion.probability * 0.8) };
      const clip = clips.get(movement.name);
      const receipt = await (reaction ? this.ports.react! : this.ports.attach)(
        {
          action: reaction ? "react" : "direct",
          ...(reaction
            ? { ifIdleRevision: state.cueVersion, evidence: [reaction.cursor] }
            : { audioActionId }),
          expressionWeights: weights,
          ...(clip ? { bodyClip: clip.bodyClip } : {}),
        },
        "presentation-" + randomUUID(),
      );
      this.last = {
        status:
          receipt.skipped === true
            ? "no-gesture"
            : receipt.accepted === true
              ? "attached"
              : "stale",
        audioActionId,
        cueId: receipt.id,
        emotion,
        movement,
        presentation: { expressionWeights: weights,
          ...(clip ? {bodyClip:clip.bodyClip, key:clip.key ?? clip.bodyClip, tags:clip.tags ?? []} : {}) },
        source: reaction
          ? {
              source: reaction.source,
              cursor: reaction.cursor,
              ts: reaction.ts,
              type: reaction.type,
            }
          : null,
        model: result.model ?? null,
        usage: result.usage ?? null,
        latencyMs: Date.now() - started,
        serviceLatencyMs: result.latency_ms ?? null,
        taskChars: JSON.stringify(input).length,
      };
    } catch (error) {
      if (this.controller === controller)
        this.last = {
          status: controller.signal.aborted ? "cancelled" : "failed",
          audioActionId,
          latencyMs: Date.now() - started,
          error: String(error),
        };
    } finally {
      if (this.controller === controller) {
        this.inFlight = false;
        this.controller = null;
        this.ports.log(this.last);
      }
    }
  }
  stop() {
    this.stopped = true;
    this.controller?.abort(new Error("Director stopped"));
  }
}
