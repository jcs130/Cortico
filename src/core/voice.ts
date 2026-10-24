import type { ServerResponse } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { bearer, endpoint, jsonRequest } from "./http.ts";
import type { VoiceConfig } from "./types.ts";
type Session = {
  id: string;
  text: string;
  voice: string;
  abort: AbortController;
  opened: boolean;
  finished: boolean;
  openedAt?: number;
  transportFinishedAt?: number;
  trace: Record<string, string | null>;
  config: VoiceConfig;
  response?: ServerResponse;
};
/** Forward typed recovery identifiers, never raw provider error text. */
async function failure(response: Response): Promise<Error> {
  const basic = "TTS HTTP " + response.status;
  if (!/application\/json/i.test(response.headers.get("content-type") ?? "") || !response.body)
    return Error(basic);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const row = await reader.read();
      if (row.done) break;
      bytes += row.value.length;
      if (bytes > 2048) return Error(basic);
      parts.push(row.value);
    }
    const error = JSON.parse(Buffer.concat(parts).toString("utf8")).error;
    if (!error || typeof error !== "object") return Error(basic);
    const valid = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(v);
    return Error(basic + (valid(error.code) ? "; " + error.code : "")
      + (valid(error.recovery?.tool) ? "; use tool " + error.recovery.tool : ""));
  } catch { return Error(basic); }
  finally { await reader.cancel().catch(() => {}); }
}
export class VoiceService {
  private sessionId = "";
  private current: Session | null = null;
  private last: Record<string, unknown> | null = null;
  private availableVoices: string[] = [];
  private selectedVoice: string | null = null;
  private catalogError: string | null = null;
  private metadataAbort = new AbortController();
  constructor(
    private readonly config: () => VoiceConfig | undefined,
    private readonly directory: string,
    private readonly report: (
      id: string,
      status: string,
      data: Record<string, unknown>,
    ) => void,
  ) {}
  async start() {
    this.metadataAbort = new AbortController();
    await mkdir(this.directory, { recursive: true });
    const file = join(this.directory, "tts-session.json");
    try {
      this.sessionId = JSON.parse(await readFile(file, "utf8")).sessionId;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.sessionId = "avatar-" + randomUUID();
      await writeFile(file, JSON.stringify({ sessionId: this.sessionId }));
    }
    if (this.config()?.sessionId) this.sessionId = this.config()!.sessionId!;
    if (!/^[\w:.-]{1,150}$/.test(this.sessionId))
      throw Error("Invalid stable TTS session id");
    const c = this.config();
    this.availableVoices = [
      ...new Set(
        [c?.voice, ...(c?.voices ?? [])].filter((v): v is string => !!v),
      ),
    ];
    if (c?.voicesUrl) {
      try {
        const catalog = await jsonRequest(endpoint(c.voicesUrl), {
          headers: await bearer(c),
        });
        const values = catalog.voices;
        if (!Array.isArray(values) || values.length > 200)
          throw Error("Invalid voice catalog");
        const voices = values.map((v) =>
          typeof v === "string" ? v : typeof v?.id === "string" ? v.id : null,
        );
        if (voices.some((v) => !v || v.length > 150))
          throw Error("Invalid voice catalog");
        this.availableVoices = [
          ...new Set([...this.availableVoices, ...(voices as string[])]),
        ];
      } catch (e) {
        this.catalogError = e instanceof Error ? e.message : String(e);
      }
    }
    try {
      const saved = JSON.parse(
        await readFile(join(this.directory, "voice-selection.json"), "utf8"),
      );
      if (this.availableVoices.includes(saved.voice))
        this.selectedVoice = saved.voice;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  async select(voice: unknown) {
    if (typeof voice !== "string" || !this.availableVoices.includes(voice))
      throw Error("Voice is unavailable");
    this.selectedVoice = voice;
    await writeFile(
      join(this.directory, "voice-selection.json"),
      JSON.stringify({ voice }),
    );
    return this.status();
  }
  status() {
    const c = this.config();
    return {
      configured: !!c?.url,
      model: c?.model ?? null,
      voice: this.selectedVoice ?? c?.voice ?? null,
      voices: this.availableVoices,
      catalogError: this.catalogError,
      sessionId: this.sessionId,
      prebufferMs: 480,
      transport: "chunked-wav",
      textFormat: c?.textFormat ?? "plain",
      writingGuide:
        c?.textFormat === "drama-3"
          ? "Use short speakable sentences. Optional square-bracket voice directions, e.g. [warm, cheerful], are TTS delivery cues. Body/expression actions go through avatar_control. No narrator/character prefix or speaker switching for a single configured voice. See the World speech-writing guide for local backend limits."
          : "Natural speakable text; do not include stage directions or phonetic annotations unless this backend explicitly supports them.",
      current: this.current
        ? {
            id: this.current.id,
            voice: this.current.voice,
            opened: this.current.opened,
            phase: !this.current.opened
              ? "awaiting-renderer"
              : this.current.finished
                ? "awaiting-playback"
                : "synthesizing",
            trace: this.current.trace,
          }
        : null,
      last: this.last,
    };
  }
  /** Transport progress is evidence of waiting, never evidence of audible playback. */
  playbackWait(id: string) {
    const s = this.current;
    if (!s || s.id !== id || !s.opened || s.abort.signal.aborted) return null;
    return {
      synthesizing: !s.finished,
      deadline: s.openedAt! + (s.config.synthesisTimeoutMs ?? 90000),
      rendererSince: s.transportFinishedAt,
    };
  }
  queue(id: string, text: unknown, voice?: unknown) {
    const c = this.config();
    if (!c?.url) throw Error("TTS is not configured");
    endpoint(c.url);
    if (
      !Number.isSafeInteger(c.synthesisTimeoutMs ?? 90000) ||
      (c.synthesisTimeoutMs ?? 90000) < 1 ||
      (c.synthesisTimeoutMs ?? 90000) > 2147483647
    )
      throw Error("Invalid synthesis timeout");
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 2000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)
    )
      throw Error("Speech requires 1–2000 characters of synthesis text");
    const selected = voice ?? this.selectedVoice ?? c.voice;
    if (
      typeof selected !== "string" ||
      !this.availableVoices.includes(selected)
    )
      throw Error("Voice is not configured");
    this.interrupt("superseded");
    this.current = {
      id,
      text: text.trim(),
      voice: selected,
      abort: new AbortController(),
      opened: false,
      finished: false,
      trace: { "x-litellm-session-id": this.sessionId },
      config: { ...c },
    };
    return {
      id,
      url: "/audio/speech/" + encodeURIComponent(id),
      prebufferMs: 480,
    };
  }
  interrupt(reason = "interrupted") {
    const s = this.current;
    if (!s) return null;
    this.current = null;
    s.abort.abort();
    s.response?.destroy();
    this.last = { id: s.id, status: reason, trace: s.trace };
    this.report(s.id, "cancelled", { reason, trace: s.trace });
    if (s.opened && !s.finished) void this.recordMetadata(s);
    return this.last;
  }
  async stream(id: string, res: ServerResponse) {
    const s = this.current,
      c = s?.config;
    if (!s || s.id !== id || s.opened || !c)
      throw Error("Speech stream is unavailable or already consumed");
    s.opened = true;
    s.openedAt = Date.now();
    s.response = res;
    res.once("close", () => {
      if (!s.finished && !s.abort.signal.aborted)
        this.interrupt("playback-connection-closed");
    });
    try {
      const signal = AbortSignal.any([
        s.abort.signal,
        AbortSignal.timeout(s.config.synthesisTimeoutMs ?? 90000),
      ]);
      this.report(s.id, "synthesizing", {
        trace: s.trace,
        timeoutMs: s.config.synthesisTimeoutMs ?? 90000,
      });
      const auth = await bearer(c);
      const response = await fetch(endpoint(c.url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...auth,
          "x-litellm-session-id": this.sessionId,
        },
        body: JSON.stringify({
          model: c.model,
          input: s.text,
          voice: s.voice,
          speed: 1,
          response_format: "wav",
          ...(c.instructions ? { instructions: c.instructions } : {}),
        }),
        signal,
        redirect: "error",
      });
      for (const key of [
        "x-litellm-call-id",
        "x-litellm-session-id",
        "x-tts-request-id",
      ])
        s.trace[key] = response.headers.get(key) ?? s.trace[key] ?? null;
      if (!response.ok || !response.body)
        throw await failure(response);
      if (
        !/audio\/(wav|x-wav|wave)|application\/octet-stream/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        throw Error("TTS did not return WAV");
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...Object.fromEntries(
          Object.entries(s.trace).filter(([, v]) => v !== null) as [
            string,
            string,
          ][],
        ),
      });
      this.report(s.id, "streaming", { trace: s.trace });
      let bytes = 0;
      for await (const value of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (s.abort.signal.aborted) break;
        bytes += value.byteLength;
        if (bytes > 128 * 1024 * 1024)
          throw Error("Speech exceeded stream limit");
        if (!res.write(value)) await once(res, "drain", { signal });
      }
      if (!s.abort.signal.aborted) {
        s.finished = true;
        s.transportFinishedAt = Date.now();
        res.end();
        this.last = {
          id: s.id,
          status: "transport-complete",
          trace: s.trace,
          bytes,
        };
        this.report(s.id, "transport-complete", { trace: s.trace, bytes });
        void this.recordMetadata(s);
      }
    } catch (e) {
      if (!s.abort.signal.aborted) {
        s.finished = true;
        this.current = null;
        this.last = { id: s.id, status: "failed", trace: s.trace };
        this.report(s.id, "failed", {
          error: e instanceof Error ? e.message : String(e),
          trace: s.trace,
        });
        void this.recordMetadata(s);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      }
    }
  }
  finish(id: string) {
    if (this.current?.id === id) this.current = null;
  }
  private async recordMetadata(s: Session) {
    if (!s.config.metricsUrl) return;
    try {
      await new Promise<void>((ok, fail) => {
        const signal = this.metadataAbort.signal;
        const done = () => {
          signal.removeEventListener("abort", cancel);
          ok();
        };
        const timer = setTimeout(done, 250);
        const cancel = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          fail(signal.reason);
        };
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
      const metrics = await jsonRequest(
        endpoint(s.config.metricsUrl),
        { headers: await bearer(s.config) },
        this.metadataAbort.signal,
      );
      const records = [
        ...(Array.isArray(metrics.gateway_active)
          ? metrics.gateway_active
          : []),
        ...(Array.isArray(metrics.gateway_recent)
          ? metrics.gateway_recent
          : []),
      ].filter(
        (r: any) =>
          r.session_id === s.trace["x-litellm-session-id"] &&
          (r.request_id === s.trace["x-litellm-call-id"] ||
            r.native_request_id === s.trace["x-tts-request-id"]),
      );
      if (!this.metadataAbort.signal.aborted)
        this.report(s.id, "metadata", {
          trace: s.trace,
          server: { schema: metrics.schema, requests: records },
        });
    } catch (e) {
      if (!this.metadataAbort.signal.aborted)
        this.report(s.id, "metadata-unavailable", {
          trace: s.trace,
          error: e instanceof Error ? e.message : String(e),
        });
    }
  }
  async metrics() {
    const c = this.config();
    if (!c?.metricsUrl) throw Error("TTS metrics endpoint is not configured");
    return jsonRequest(endpoint(c.metricsUrl), { headers: await bearer(c) });
  }
  stop() {
    this.metadataAbort.abort();
    this.interrupt("stage-stopped");
  }
}
