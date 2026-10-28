import { streamingHeader } from "./speech-segments.ts";

export interface PcmSseResult {
  bytes: number;
  samples: number;
  frames: number;
  seed: number | null;
  stop: string;
  firstAudioAt: number;
  completedAt: number;
}

/** Forward one native synthesis context as one WAV; never synthesize independent sub-takes. */
export async function streamPcmSse(options: {
  response: Response;
  sampleRate: number;
  signal: AbortSignal;
  begin(): void;
  write(bytes: Uint8Array): Promise<void>;
  terminal?(value: Record<string, unknown>): void;
}): Promise<PcmSseResult> {
  const { response, sampleRate, signal } = options;
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000)
    throw Error("Native PCM streaming requires the backend's verified sample rate");
  if (!response.ok || !response.body || !/^text\/event-stream\b/i.test(response.headers.get("content-type") ?? ""))
    throw Error("TTS did not return a native PCM event stream");
  const decoder = new TextDecoder();
  let buffer = "", data: string[] = [], dataSize = 0, pcmBytes = 0, frames = 0;
  let firstAudioAt: number | null = null, done: Record<string, unknown> | null = null;
  const consume = async () => {
    const payload = data.join("\n"); data = []; dataSize = 0;
    if (!payload || payload === "[DONE]") return;
    const event = JSON.parse(payload);
    if (event.type === "error" || event.type === "speech.audio.error" || event.error) {
      options.terminal?.({ stop: "error", samples: pcmBytes / 2, pcmBytes, frames,
        firstAudioAt, completedAt: Date.now() });
      throw Error("TTS native stream reported an error");
    }
    if (event.type === "speech.audio.delta") {
      if (done) throw Error("TTS audio arrived after completion");
      if (typeof event.audio !== "string" || !event.audio.length || event.audio.length % 4
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.audio)) throw Error("Invalid native PCM base64 frame");
      const pcm = Buffer.from(event.audio, "base64");
      if (!pcm.length || pcm.length % 2) throw Error("Unaligned native PCM16 frame");
      pcmBytes += pcm.length;
      if (pcmBytes > 128 * 1024 * 1024) throw Error("Speech exceeded stream limit");
      if (firstAudioAt === null) {
        firstAudioAt = Date.now(); options.begin(); await options.write(streamingHeader(sampleRate));
      }
      signal.throwIfAborted(); await options.write(pcm); frames++;
    } else if (event.type === "speech.audio.done") {
      if (done) throw Error("Duplicate native speech completion");
      done = event;
      // Retain failed/empty terminal evidence as well as successful generations.
      options.terminal?.({ samples: event.samples, seed: event.seed ?? null, stop: event.stop ?? null,
        firstAudioAt, completedAt: Date.now(), pcmBytes, frames });
    }
  };
  const line = async (raw: string) => {
    const value = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!value) return consume();
    if (!value.startsWith("data:")) return;
    const part = value.slice(5).replace(/^ /, "");
    dataSize += part.length;
    if (dataSize > 4 * 1024 * 1024) throw Error("TTS event exceeded frame limit");
    data.push(part);
  };
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      signal.throwIfAborted(); buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) { await line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (buffer.length > 4 * 1024 * 1024) throw Error("TTS event exceeded frame limit");
    }
    buffer += decoder.decode();
    if (buffer.length) await line(buffer);
    if (data.length) await consume();
  } finally { await response.body.cancel().catch(() => {}); }
  signal.throwIfAborted();
  if (!done || firstAudioAt === null || !pcmBytes) throw Error("TTS stream ended without confirmed audio completion");
  const terminal = done as Record<string, unknown>;
  if (!Number.isSafeInteger(terminal.samples) || terminal.samples !== pcmBytes / 2)
    throw Error("TTS native sample count does not match PCM bytes");
  if (terminal.stop !== "complete") {
    const stop = typeof terminal.stop === "string" && /^[a-z_]{1,48}$/i.test(terminal.stop) ? terminal.stop : "unknown";
    throw Error("TTS generation incomplete: " + stop);
  }
  return { bytes: pcmBytes + 44, samples: pcmBytes / 2, frames,
    seed: typeof terminal.seed === "number" && Number.isSafeInteger(terminal.seed) ? terminal.seed : null,
    stop: "complete", firstAudioAt, completedAt: Date.now() };
}
