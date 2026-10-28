import { randomUUID } from "node:crypto";
import { wavInfo } from "./wav.ts";

/** Split speakable text without cutting speaker/delivery tokens or Unicode characters. */
export function splitSynthesisText(text: string, maxChars: number): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 8 || maxChars > 160)
    throw Error("Speech segment size must be 8–160 characters");
  const tokens = text.match(/<\|speaker:\d+\|>|\[[^\]\r\n]{1,120}\]|[\s\S]/gu) ?? [];
  const segments: string[] = [];
  let speaker = "", delivery = "", current = "", count = 0;
  const flush = () => {
    if (count) segments.push(current.trim());
    current = ""; count = 0;
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (/^<\|speaker:\d+\|>$/.test(token)) {
      flush(); speaker = token; delivery = ""; current = token; continue;
    }
    if (/^\[[^\]\r\n]+\]$/.test(token)) {
      if (!count) { delivery = token; current = speaker + token; }
      else current += token;
      continue;
    }
    if (count >= maxChars) flush();
    if (!current) current = speaker + delivery;
    current += token;
    if (!/\s/u.test(token)) count++;
    const period = token === "." && !(/\d/.test(tokens[index - 1] ?? "") && /\d/.test(tokens[index + 1] ?? ""));
    if (/[。！？!?；;\n]/u.test(token) || period) flush();
  }
  flush();
  if (!segments.length) throw Error("Speech contains no speakable text");
  return segments;
}

function streamingHeader(sampleRate: number): Buffer {
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
  request(text: string, requestId: string): Promise<Response>;
  failure(response: Response): Promise<Error>;
  begin(response: Response): void;
  write(bytes: Uint8Array): Promise<void>;
  segment?(value: Record<string, unknown>): void;
}): Promise<number> {
  const parts = splitSynthesisText(options.text, options.maxChars);
  let rate: number | null = null, bytes = 0;
  for (const [index, text] of parts.entries()) {
    options.signal.throwIfAborted();
    const requestId = randomUUID(), startedAt = Date.now();
    const response = await options.request(text, requestId);
    if (!response.ok || !response.body) throw await options.failure(response);
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
    options.segment?.({ index, total: parts.length, requestId, startedAt, endedAt: Date.now(),
      status: response.status, bytes: pcm.length, durationMs: info.durationMs,
      serverRequestId: response.headers.get("x-tts-request-id") });
  }
  return bytes;
}
