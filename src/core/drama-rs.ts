import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { endpoint } from "./http.ts";
import { wavInfo } from "./wav.ts";

export function dramaRsEndpoints(speakUrl: string) {
  const speak = endpoint(speakUrl);
  if (!speak.pathname.endsWith("/v1/speak"))
    throw Error("drama-rs requires its native /v1/speak endpoint");
  const base = new URL(speak);
  base.pathname = speak.pathname.slice(0, -"/v1/speak".length) + "/";
  return {
    speak,
    health: new URL("health", base),
    voices: new URL("v1/voices", base),
  };
}

async function smallResponse(url: URL, signal: AbortSignal) {
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error("drama-rs discovery HTTP " + response.status);
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    if (!response.body) throw Error("Empty drama-rs discovery response");
    for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += part.length;
      if (size > 65536) throw Error("Oversized drama-rs discovery response");
      parts.push(part);
    }
    return Buffer.concat(parts).toString("utf8");
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}

/** Only the remote catalog authorizes a voice; configuration is never a fallback. */
export async function dramaRsVoices(
  url: string,
  signal: AbortSignal,
): Promise<string[]> {
  const urls = dramaRsEndpoints(url);
  const health = (await smallResponse(urls.health, signal)).trim();
  if (health !== "ok") {
    let value: unknown;
    try {
      value = JSON.parse(health);
    } catch {
      /* checked below */
    }
    if (
      !value ||
      typeof value !== "object" ||
      (value as { status?: unknown }).status !== "ok"
    )
      throw Error("drama-rs health check did not confirm readiness");
  }
  const voices: unknown = JSON.parse(await smallResponse(urls.voices, signal));
  if (
    !Array.isArray(voices) ||
    voices.length > 200 ||
    voices.some((v) => typeof v !== "string" || !v || v.length > 150)
  )
    throw Error("Invalid drama-rs voice catalog");
  return [...new Set(voices as string[])];
}

export function dramaRsBody(
  text: string,
  voice: string,
  extra: Record<string, unknown> = {},
) {
  const allowed = new Set(["top_k", "max_new", "seed", "top_p", "temperature"]);
  if (Object.keys(extra).some((key) => !allowed.has(key)))
    throw Error(
      "drama-rs extraBody supports only top_k, max_new, top_p, temperature and an explicit seed",
    );
  const body = {
    text,
    voice,
    stream: true,
    split: false,
    top_k: 4097,
    max_new: 2048,
    ...extra,
  };
  for (const key of ["top_k", "max_new"] as const) {
    if (!Number.isSafeInteger(body[key]) || Number(body[key]) < 1)
      throw Error("Invalid drama-rs " + key);
  }
  if (
    Object.hasOwn(extra, "seed") &&
    (!Number.isSafeInteger(extra.seed) || Number(extra.seed) < 0)
  )
    throw Error("Invalid explicit drama-rs seed");
  for (const key of ["top_p", "temperature"])
    if (
      Object.hasOwn(extra, key) &&
      (typeof extra[key] !== "number" || !Number.isFinite(extra[key]))
    )
      throw Error("Invalid drama-rs " + key);
  return body;
}

/** A header may be split at any byte. Do not buffer the utterance to parse it. */
function headerInfo(prefix: Buffer) {
  if (prefix.length < 12) return null;
  if (
    prefix.toString("ascii", 0, 4) !== "RIFF" ||
    prefix.toString("ascii", 8, 12) !== "WAVE"
  )
    throw Error("drama-rs did not return RIFF WAV");
  for (let at = 12; at + 8 <= prefix.length;) {
    const size = prefix.readUInt32LE(at + 4);
    if (prefix.toString("ascii", at, at + 4) === "data") {
      const info = wavInfo(prefix);
      if (
        info.format !== 1 ||
        info.channels !== 1 ||
        info.bits !== 16 ||
        info.sampleRate !== 44100
      )
        throw Error("drama-rs requires 44100 Hz mono PCM16 WAV");
      return {
        offset: info.dataOffset,
        declared: size > 0 && size < 0x7fffffff ? size : null,
      };
    }
    if (at + size + 8 > 65536) throw Error("Oversized drama-rs WAV header");
    if (at + size + 8 > prefix.length) return null;
    at += 8 + size + (size % 2);
  }
  return null;
}

export type DramaRsEvidence = {
  protocol: "drama-rs-wav";
  requestId: string;
  startedAt: number;
  endedAt: number | null;
  httpStatus: number | null;
  bytes: number;
  samples: number | null;
  sampleRate: 44100;
  firstAudioAt: number | null;
  transportEnded: boolean;
  generationComplete: null;
  generationStop: null;
  completionEvidence: "not-provided-by-native-api";
  rawWav: string;
  requestLog: string;
  transportLog: string;
  rawSha256?: string;
  cancelled?: boolean;
  error?: string;
};

/** One HTTP request, one original WAV. EOF proves transport only, never text coverage. */
export async function streamDramaRs(options: {
  url: string;
  text: string;
  voice: string;
  extraBody?: Record<string, unknown>;
  directory: string;
  actionId: string;
  sessionId: string;
  signal: AbortSignal;
  begin(): void;
  write(bytes: Uint8Array): Promise<void>;
  failure(response: Response): Promise<Error>;
  evidence(value: DramaRsEvidence): void;
}): Promise<DramaRsEvidence> {
  const url = dramaRsEndpoints(options.url).speak;
  const body = dramaRsBody(options.text, options.voice, options.extraBody);
  const requestId = randomUUID(),
    startedAt = Date.now();
  const directory = join(options.directory, "native-wav");
  await mkdir(directory, { recursive: true });
  const stem = join(directory, requestId);
  const result: DramaRsEvidence = {
    protocol: "drama-rs-wav",
    requestId,
    startedAt,
    endedAt: null,
    httpStatus: null,
    bytes: 0,
    samples: null,
    sampleRate: 44100,
    firstAudioAt: null,
    transportEnded: false,
    generationComplete: null,
    generationStop: null,
    completionEvidence: "not-provided-by-native-api",
    rawWav: stem + ".wav",
    requestLog: stem + ".request.json",
    transportLog: stem + ".transport.json",
  };
  await writeFile(
    result.requestLog,
    JSON.stringify(
      {
        at: new Date(startedAt).toISOString(),
        actionId: options.actionId,
        sessionId: options.sessionId,
        requestId,
        method: "POST",
        url: url.href,
        body,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  const raw = await open(result.rawWav, "wx"),
    hash = createHash("sha256");
  let response: Response | undefined,
    prefix = Buffer.alloc(0);
  let info: ReturnType<typeof headerInfo> = null;
  options.evidence(result);
  try {
    options.signal.throwIfAborted();
    response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: options.signal,
      headers: {
        "Content-Type": "application/json",
        "x-client-request-id": requestId,
      },
      body: JSON.stringify(body),
    });
    result.httpStatus = response.status;
    if (!response.ok) throw await options.failure(response);
    if (
      !response.body ||
      !/^audio\/(wav|x-wav|wave)\b/i.test(
        response.headers.get("content-type") ?? "",
      )
    )
      throw Error("drama-rs did not return streaming WAV");
    for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
      options.signal.throwIfAborted();
      result.bytes += part.length;
      if (result.bytes > 128 * 1024 * 1024)
        throw Error("Speech exceeded stream limit");
      await raw.writeFile(part);
      hash.update(part);
      let output: Uint8Array = part;
      if (!info) {
        // Inspect only the bounded header, even if the first chunk also has audio.
        const needed = Math.min(part.length, 65537 - prefix.length);
        prefix = Buffer.concat([prefix, part.subarray(0, needed)]);
        info = headerInfo(prefix);
        if (!info) {
          if (prefix.length > 65536)
            throw Error("Oversized drama-rs WAV header");
          continue;
        }
        options.begin();
        await options.write(prefix);
        output = part.subarray(needed);
        prefix = Buffer.alloc(0);
      }
      if (result.bytes > info.offset && result.firstAudioAt === null)
        result.firstAudioAt = Date.now();
      if (output.length) await options.write(output);
    }
    options.signal.throwIfAborted();
    const pcmBytes = info ? result.bytes - info.offset : 0;
    if (!info || pcmBytes <= 0 || pcmBytes % 2)
      throw Error("Truncated or empty drama-rs PCM WAV");
    if (info.declared !== null && info.declared !== pcmBytes)
      throw Error("drama-rs WAV data length mismatch");
    result.samples = pcmBytes / 2;
    result.transportEnded = true;
    return result;
  } catch (error) {
    result.cancelled = options.signal.aborted;
    result.error = String(error instanceof Error ? error.message : error).slice(
      0,
      500,
    );
    throw error;
  } finally {
    await response?.body?.cancel().catch(() => {});
    await raw.close();
    result.endedAt = Date.now();
    result.rawSha256 = hash.digest("hex");
    await writeFile(
      result.transportLog,
      JSON.stringify(result, null, 2) + "\n",
    );
    options.evidence(result);
  }
}
