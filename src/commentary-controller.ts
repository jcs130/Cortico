import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { WorldHost, EventEnvelope } from "cortico/core/types.ts";
import { CommentaryLane, COMMENTARY_DEFAULTS, type SpeechAvailability, type CommentaryConfig } from "./core/commentary.ts";
import { CommentaryRuntimeGate } from "./core/commentary-runtime.ts";
import type { StageEvent, WorldConfig } from "./core/types.ts";

export const SPEECH_DRAFT_HEADER = "[broadcast-speech-draft/v1]";
/** Optional fallback: the Persona drafts from fresh World evidence; the stage plays it. */
export class CommentaryController {
  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;
  private sampling = false;
  private epoch = 0;
  private state: Record<string, any> | null = null;
  private speech: SpeechAvailability | null = null;
  private lastRevision: number | null = null;
  private readonly lane: CommentaryLane;
  private readonly runtime: CommentaryRuntimeGate;
  constructor(private readonly ports: {
    config(): WorldConfig;
    state(): Promise<Record<string, any>>;
    speak(args: Record<string, unknown>, requestId: string): Promise<Record<string, unknown>>;
    observe?(event:EventEnvelope):void;
    tick?():void;
  }) {
    this.runtime = new CommentaryRuntimeGate({
      url: () => this.config().hostStatusUrl,
      get: async (url) => {
        const r = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "error" });
        if (!r.ok) throw Error("Host status HTTP " + r.status);
        return r.json();
      },
      invalidate: () => this.lane?.foregroundSpeech(),
    });
    this.lane = new CommentaryLane({
      config: () => this.config(),
      availability: () => ({ live: !!this.host && !!(this.state?.audioOwner || this.state?.presentationReady) && !this.state.stopped,
        active: this.runtime.active(false), speech: this.speech }),
      request: (brief) => this.host?.cognition?.request({ brief: SPEECH_DRAFT_HEADER + "\n" + brief,
        tools: [], hint: { rounds: 1 } }) ?? Promise.resolve({ error: "Host speech cognition is unavailable" }),
      perform: async (text, serial, evidence) => {
        if (!this.host || !this.runtime.active(false) || !this.state || this.state.foreground)
          return { accepted: false, reason: "Output is not idle" };
        // The draft returns identifiers, never a replacement source clock. Resolve
        // the cited envelopes and carry their oldest original timestamp through
        // the same admission contract used by foreground speech.
        const cited = evidence.map(cursor => this.host!.store.get(cursor));
        if (cited.some(event => !event || !Number.isFinite(Date.parse(event.ts))))
          return { accepted: false, reason: "Cited speech evidence is unavailable" };
        const oldest = cited.reduce<(typeof cited)[number] | undefined>((at, event) =>
          !at || Date.parse(event!.ts) < Date.parse(at.ts) ? event : at, undefined);
        if (!oldest && (this.ports.config().speechObservationMaxAgeSeconds ?? 0) > 0)
          return { accepted: false, reason: "Speech requires source observation evidence" };
        const requestId = "avatar-commentary-" + randomUUID();
        const result = await this.ports.speak({ action: "speak", text, ifIdleRevision: this.state.audioRevision,
          ...(oldest ? { observed_at: oldest.ts } : {}),
          ...(this.state.textReady ? { evidence } : {}) }, requestId);
        const accepted = result.accepted === true && ["queued", "playing", "completed"].includes(String(result.status));
        this.host?.log.emit("info", "解说播出提交", { event: "commentary-admission", data: { serial, evidence,
          requestId, actionId: result.id, accepted, status: result.status, reason: result.reason } });
        return { accepted, actionId: typeof result.id === "string" ? result.id : undefined, reason: String(result.reason ?? "") };
      },
      log: (event, data) => this.host?.log.emit("info", event, { event, data }),
    });
  }
  private config(): CommentaryConfig {
    const world = this.ports.config(), config = { ...COMMENTARY_DEFAULTS, ...world.commentary };
    const maxAge = world.speechObservationMaxAgeSeconds ?? 0;
    // Reject stale drafting material before spending a model request, using the
    // effective speech policy rather than a separate, longer commentary window.
    if (Number.isFinite(maxAge) && maxAge > 0) config.factAgeSec = Math.min(config.factAgeSec, maxAge);
    return config;
  }
  start(host: WorldHost): void {
    this.host = host; this.cursor = host.store?.latestCursor() ?? 0;
    this.runtime.resume(); this.lane.resume();
    this.timer = setInterval(() => void this.sample(), 1000); this.timer.unref();
  }
  event(event: StageEvent): void {
    if (event.type === 'avatar.speech.waiting') this.lane.foregroundSpeech();
    if (event.type === "avatar.speech.submitted" && typeof event.data.text === "string"
      && !String(event.data.requestId).startsWith("avatar-commentary-")) this.lane.foregroundSpeech(event.data.text);
  }
  facts(): string { return this.lane.facts(); }
  presentationState(): Record<string, any> | null {
    return this.runtime.active(false) && this.speech && Date.now() - this.speech.observedAtMs <= 2500 ? this.state : null;
  }
  async sample(): Promise<void> {
    const host = this.host;
    if (!host || this.sampling) return;
    if (!this.config().enabled && !this.ports.observe) { this.lane.tick(); return; }
    this.sampling = true;
    const epoch = this.epoch;
    try {
      this.runtime.tick();
      const state = await this.ports.state();
      if (epoch !== this.epoch || host !== this.host) return;
      this.state = state;
      const now = Date.now(), busy = !!state.foreground;
      const revision = typeof state.audioRevision === "number" ? state.audioRevision : null;
      const action = Array.isArray(state.actions) ? state.actions.find(row => row.id === state.foreground) : null;
      const playing = action?.kind === 'speech' && action.status === 'playing';
      const duration = action?.evidence?.durationMs, position = action?.evidence?.audioTimeMs ?? 0;
      const backlogMs = playing && Number.isFinite(duration) && duration > 0 && Number.isFinite(position)
        && Number.isFinite(action.updatedAt)
        ? Math.max(0, duration - position - Math.max(0, now - action.updatedAt)) : undefined;
      const idleSince = busy ? null : this.speech?.idleSinceMs !== null && revision === this.lastRevision
        ? this.speech?.idleSinceMs ?? now : now;
      this.speech = { observedAtMs: now, idleSinceMs: idleSince, busy, ttsReady: state.voice?.configured === true, textReady: state.textReady === true,
        textFormat: state.voice?.textFormat === "drama-3" ? "drama-3" : "plain",
        playing, musicPlaying: action?.kind === 'music-play', backlogMs,
        ...(revision !== null ? { queueRevision: revision } : {}) };
      this.lastRevision = revision;
      const latest = host.store.latestCursor();
      // Progress through newly appended envelopes; never scan old run history.
      const end = Math.min(latest, this.cursor + 512);
      for (let cursor = this.cursor + 1; cursor <= end; cursor++) {
        if (epoch !== this.epoch) return;
        const event = host.store.get(cursor);
        if (event) { this.lane.observe(event);this.ports.observe?.(event); }
        this.cursor = cursor;
        if (cursor % 64 === 0) await setImmediate();
      }
      this.lane.tick();
      this.ports.tick?.();
    } catch (error) {
      if (epoch === this.epoch) {
        this.state = null; this.speech = null;
        host.log.warn("解说观察暂不可用", { error: String(error) });
      }
    } finally { this.sampling = false; }
  }
  stop(): void {
    this.epoch++; this.host = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.runtime.stop(); this.lane.stop(); this.state = null; this.speech = null;
  }
}
