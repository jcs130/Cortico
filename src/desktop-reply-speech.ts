import type { EventEnvelope } from "cortico/core/types.ts";
export interface ReplySpeechConfig {
  enabled: boolean;
  sources: string;
}
export const REPLY_SPEECH_DEFAULTS: Readonly<ReplySpeechConfig> = Object.freeze(
  { enabled: false, sources: "" },
);
/** Speaks literal tool-authored desktop replies through the existing stage audio owner. */
export class DesktopReplySpeech {
  private seen = new Set<string>();
  private stopped = false;
  constructor(
    private readonly ports: {
      config(): ReplySpeechConfig;
      speak(text: string, requestId: string): Promise<Record<string, unknown>>;
      log(data: Record<string, unknown>): void;
    },
  ) {}
  observe(event: EventEnvelope) {
    const cfg = this.ports.config();
    if (
      this.stopped ||
      !cfg.enabled ||
      !cfg.sources.split(/[\s,]+/).includes(event.source) ||
      event.type !== event.source + ".self" ||
      !['say','ask'].includes(String(event.meta?.kind)) ||
      event.meta?.via !== "tool" ||
      Date.now() - Date.parse(event.ts) > 30_000
    )
      return;
    const beats = event.meta.beats;
    if (event.meta.kind==='say' && (
      !Array.isArray(beats) ||
      beats.some((b) => !b || typeof b.text !== "string")
    ))
      return;
    const text = event.meta.kind==='ask' ? String(event.meta.question ?? '').trim() : (beats as Array<{text:string}>)
      .map((b) => b.text as string)
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!text) return;
    if (text.length > 2000) { this.ports.log({source:event.source,cursor:event.cursor,accepted:false,reason:'Reply exceeds the desktop audio text limit; original text remains available'});return; }
    const requestId = "desktop-reply:" + event.run + ":" + event.cursor;
    if (this.seen.has(requestId)) return;
    this.seen.add(requestId);
    while (this.seen.size > 128)
      this.seen.delete(this.seen.values().next().value!);
    const started = Date.now();
    void this.ports
      .speak(text, requestId)
      .then((result) =>
        this.ports.log({
          source: event.source,
          cursor: event.cursor,
          requestId,
          chars: text.length,
          accepted: result.accepted === true,
          actionId: result.id ?? null,
          status: result.status ?? null,
          reason: result.reason ?? null,
          elapsedMs: Date.now() - started,
        }),
      )
      .catch((error) =>
        this.ports.log({
          source: event.source,
          cursor: event.cursor,
          requestId,
          accepted: false,
          error: String(error),
          elapsedMs: Date.now() - started,
        }),
      );
  }
  stop() {
    this.stopped = true;
  }
}
