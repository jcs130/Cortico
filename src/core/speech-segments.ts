import { randomUUID } from "node:crypto";
import { assertWavComplete, wavInfo } from "./wav.ts";
import { SPEECH_MARKUP, termPattern } from "./speech-text.ts";

/** Pack short sentences; prefer clause boundaries, then whole words, never a character offset. */
export function splitSynthesisText(text: string, maxChars: number, protectedTerms: readonly string[] = []): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 8 || maxChars > 160)
    throw Error("Speech segment size must be 8–160 characters");
  type Unit = { text: string; size: number; boundary: number; cue?: boolean };
  const words = new Intl.Segmenter("zh", { granularity: "word" });
  const units: Unit[] = [];
  const size = (value: string) => [...value].filter(c => /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(c)).length;
  const plain = (value: string) => {
    for (const word of words.segment(value)) units.push({ text: word.segment, size: size(word.segment),
      boundary: /[。！？!?；;\n]/u.test(word.segment) || word.segment === "." ? 2 : /[，,：:]|\s/u.test(word.segment) ? 1 : 0 });
  };
  const expression = SPEECH_MARKUP + (protectedTerms.length ? "|" + [...protectedTerms].sort((a,b)=>b.length-a.length).map(termPattern).join("|") : "");
  let offset = 0;
  for (const match of text.matchAll(new RegExp(expression, "gu"))) {
    plain(text.slice(offset, match.index));
    const token = match[0], cue = /^\[/.test(token) || /^<\|speaker:/.test(token);
    const phoneme = token.startsWith("<|phoneme_start|>");
    units.push({ text: token, size: cue ? 0 : phoneme ? Math.max(1, (token.match(/<\|phoneme_start\|>/g) ?? []).length) : size(token.replace(/<[^>]*>/g,"")), boundary: 0, cue });
    offset = match.index! + token.length;
  }
  plain(text.slice(offset));
  const segments: string[] = [];
  let speaker = "", current: Unit[] = [];
  const count = (values: Unit[]) => values.reduce((sum, u) => sum + u.size, 0);
  const emit = (cut: number) => {
    const part = current.splice(0, cut);
    if (count(part)) segments.push(speaker + part.map(x => x.text).join("").trim());
  };
  for (const unit of units) {
    if (/^<\|speaker:\d+\|>$/.test(unit.text)) {
      emit(current.length); current = []; speaker = unit.text; continue;
    }
    if (unit.size > maxChars) throw Error("A speech word or markup span exceeds the segment budget; increase segmentMaxChars or use a shorter spoken form");
    while (count(current) + unit.size > maxChars) {
      let cut = current.length, best = 0, used = 0;
      for (const [i, item] of current.entries()) {
        used += item.size;
        if (used >= Math.floor(maxChars / 2) && item.boundary >= best && item.boundary) { cut = i + 1; best = item.boundary; }
      }
      // A sound/delivery cue belongs to the words that follow it, not the previous HTTP request.
      while (cut && current[cut - 1].cue) cut--;
      if (!cut || !count(current.slice(0, cut))) throw Error("Speech segment has no word boundary");
      emit(cut);
    }
    current.push(unit);
  }
  emit(current.length);
  if (!segments.length) throw Error("Speech contains no speakable text");
  return segments;
}

export function streamingHeader(sampleRate: number): Buffer {
  const b = Buffer.alloc(44);
  b.write("RIFF"); b.writeUInt32LE(0xffffffff, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36);
  b.writeUInt32LE(0xffffffff, 40);
  return b;
}

/** One WAV envelope, PCM payload only between sentences; the next request starts after EOF. */
export async function streamSpeechSegments(options: {
  text: string; maxChars: number; signal: AbortSignal;
  protectedTerms?: readonly string[];
  requireWavCompletion?: boolean;
  request(text: string, requestId: string): Promise<Response>;
  failure(response: Response): Promise<Error>;
  begin(response: Response): void;
  write(bytes: Uint8Array): Promise<void>;
  segment?(value: Record<string, unknown>): void;
}): Promise<number> {
  const parts = splitSynthesisText(options.text, options.maxChars, options.protectedTerms);
  let rate: number | null = null, bytes = 0;
  for (const [index, text] of parts.entries()) {
    options.signal.throwIfAborted();
    const requestId = randomUUID(), startedAt = Date.now();
    const response = await options.request(text, requestId);
    if (!response.ok || !response.body) throw await options.failure(response);
    const stop = assertWavComplete(response, options.requireWavCompletion);
    if (!/audio\/(wav|x-wav|wave)|application\/octet-stream/i.test(response.headers.get("content-type") ?? ""))
      throw Error("TTS did not return WAV");
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        options.signal.throwIfAborted(); length += chunk.byteLength;
        if (length > 16 * 1024 * 1024) throw Error("Speech segment exceeded WAV limit");
        chunks.push(chunk);
      }
    } finally { await response.body.cancel().catch(() => {}); }
    options.signal.throwIfAborted();
    const wav = Buffer.concat(chunks), info = wavInfo(wav);
    if (info.format !== 1 || info.channels !== 1 || info.bits !== 16 || info.dataSize < 2 || info.dataSize % 2)
      throw Error("Speech segments require mono PCM16 WAV");
    const declared = wav.readUInt32LE(info.dataOffset - 4);
    if (declared < 0x7fffffff && info.dataOffset + declared > wav.length)
      throw Error("Truncated speech segment WAV");
    if (rate !== null && rate !== info.sampleRate) throw Error("Speech segment sample rate changed");
    if (rate === null) {
      rate = info.sampleRate; options.begin(response);
      const header = streamingHeader(info.sampleRate); await options.write(header); bytes += header.length;
    }
    const pcm = wav.subarray(info.dataOffset, info.dataOffset + info.dataSize);
    bytes += pcm.length;
    if (bytes > 128 * 1024 * 1024) throw Error("Speech exceeded stream limit");
    await options.write(pcm);
    options.segment?.({ index, total: parts.length, requestId, input: text, startedAt, endedAt: Date.now(),
      status: response.status, bytes: pcm.length, durationMs: info.durationMs, stop,
      serverRequestId: response.headers.get("x-tts-request-id") });
  }
  return bytes;
}
