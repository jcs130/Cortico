import type { ServerResponse } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { bearer, endpoint, jsonRequest } from "./http.ts";
import type { VoiceConfig } from "./types.ts";
import { splitSynthesisText, streamSpeechSegments } from "./speech-segments.ts";
import { spokenText, validatePronunciations } from "./speech-text.ts";
import { streamPcmSse } from "./pcm-sse.ts";
import { assertWavComplete } from "./wav.ts";
import { dramaRsBody, dramaRsEndpoints, dramaRsVoices, streamDramaRs } from "./drama-rs.ts";
import {VoiceArtifacts, type VoiceArtifact} from './voice-artifacts.ts';
type Session = {
  artifact?: {metadata:VoiceArtifact;bytes:Buffer};
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
  segments?: Record<string, unknown>[];
  nativeStream?: Record<string, unknown>;
  wavStop?: string | null;
};
function upstreamUnavailable(error: unknown): boolean {
  return error instanceof TypeError || error instanceof Error &&
    (error.name === 'TimeoutError' || /^(TTS HTTP|drama-rs)/.test(error.message));
}
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
  readonly artifacts: VoiceArtifacts;
  private sessionId = "";
  private current: Session | null = null;
  private last: Record<string, unknown> | null = null;
  private availableVoices: string[] = [];
  private selectedVoice: string | null = null;
  private catalogError: string | null = null;
  private metadataAbort = new AbortController();
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryAt: number | null = null;
  private synthesisTail: Promise<void> = Promise.resolve();
  constructor(
    private readonly config: () => VoiceConfig | undefined,
    private readonly directory: string,
    private readonly report: (
      id: string,
      status: string,
      data: Record<string, unknown>,
    ) => void,
  ) {this.artifacts=new VoiceArtifacts(join(directory,'voice-artifacts'),(text,id,signal)=>this.renderArtifact(text,id,signal));}
  async start() {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null; this.recoveryAt = null;
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
    this.catalogError = null;
    this.selectedVoice = null;
    this.availableVoices = [
      ...new Set(
        [c?.voice, ...(c?.voices ?? [])].filter((v): v is string => !!v),
      ),
    ];
    if (c?.synthesisTransport === "drama-rs-wav") {
      // Unlike generic catalogs, only a verified server entry enables this voice.
      this.availableVoices = [];
      try {
        const remoteVoices = await dramaRsVoices(c.url, AbortSignal.any([
          this.metadataAbort.signal, AbortSignal.timeout(10000),
        ]));
        this.availableVoices = c.voices?.length
          ? remoteVoices.filter(v => v === c.voice || c.voices!.includes(v))
          : remoteVoices;
        if (!this.availableVoices.includes(c.voice)) throw Error("Configured voice is absent from drama-rs: " + c.voice);
      } catch (error) {
        this.catalogError = error instanceof Error ? error.message : String(error);
        this.scheduleRecovery();
      }
    } else if (c?.voicesUrl) {
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
      if (this.availableVoices.includes(saved.voice) || (c?.synthesisTransport === "drama-rs-wav" && typeof saved.voice === "string"))
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
    const native = c?.synthesisTransport === "drama-rs-wav";
    const selected = this.selectedVoice ?? c?.voice ?? null;
    const nativeVoiceAvailable = selected !== null && this.availableVoices.includes(selected);
    return {
      configured: !!c?.url && !(native && (this.catalogError || !nativeVoiceAvailable)),
      model: c?.model ?? null,
      voice: this.selectedVoice ?? c?.voice ?? null,
      voices: this.availableVoices,
      catalogError: this.catalogError ?? (native && !nativeVoiceAvailable ? "Selected drama-rs voice is unavailable" : null),
      recoveryAt: this.recoveryAt,
      sessionId: this.sessionId,
      prebufferMs: 480,
      transport: "chunked-wav",
      synthesisTransport: c?.synthesisTransport ?? "wav",
      ...(c?.synthesisTransport === "drama-rs-wav" ? { generationComplete: null,
        completionEvidence: "not-provided-by-native-api", capture: "native-wav" } : {}),
      pcmSampleRate: c?.pcmSampleRate ?? null,
      requireWavCompletion: c?.requireWavCompletion ?? false,
      rendererStartTimeoutMs: c?.rendererStartTimeoutMs ?? 15000,
      configuredSeed: typeof c?.extraBody?.seed === "number" ? c.extraBody.seed : null,
      textFormat: c?.textFormat ?? "plain",
      busyPolicy: c?.busyPolicy ?? 'replace',
      segmentMaxChars: c?.segmentMaxChars ?? null,
      pronunciations: c?.pronunciations ?? {},
      writingGuides: c?.writingGuides ?? null,
      writingGuide:
        c?.writingGuides?.[this.selectedVoice ?? c?.voice ?? ""] ?? (c?.textFormat === "drama-3"
          ? "Use short speakable sentences. Optional square-bracket voice directions, e.g. [warm, cheerful], are TTS delivery cues. Body/expression actions go through avatar_control. No narrator/character prefix or speaker switching for a single configured voice. See the World speech-writing guide for local backend limits."
          : "Natural speakable text; do not include stage directions or phonetic annotations unless this backend explicitly supports them."),
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
      rendererStartTimeoutMs: s.config.rendererStartTimeoutMs ?? 15000,
    };
  }
  /** Validate without starting synthesis or interrupting the current audio. */
  validate(text: unknown, voice?: unknown, seed?: unknown) {
    const c = this.config();
    if (!c?.url) throw Error("TTS is not configured");
    endpoint(c.url);
    if (c.extraBody !== undefined && (!c.extraBody || typeof c.extraBody !== "object" || Array.isArray(c.extraBody)))
      throw Error("TTS extraBody must be an object");
    if (![undefined, "wav", "pcm-sse", "drama-rs-wav"].includes(c.synthesisTransport)) throw Error("Unsupported synthesis transport");
    if (c.synthesisTransport === "drama-rs-wav") {
      if (this.catalogError) throw Error("drama-rs is unavailable: " + this.catalogError);
      dramaRsEndpoints(c.url);
      dramaRsBody("", c.voice, c.extraBody);
      if (c.segmentMaxChars) throw Error("drama-rs requires one complete utterance; disable client segmentation");
      if (c.requireWavCompletion) throw Error("drama-rs has no reliable full-text completion marker");
    }
    if (c.synthesisTransport === "pcm-sse") {
      if (!Number.isSafeInteger(c.pcmSampleRate) || c.pcmSampleRate! < 8000 || c.pcmSampleRate! > 192000)
        throw Error("Native PCM streaming requires the backend's verified sample rate");
      if (c.segmentMaxChars) throw Error("Native PCM streaming must use one synthesis context; disable client segmentation");
    }
    const protectedTerms = validatePronunciations(c.pronunciations);
    if (c.segmentMaxChars !== undefined && c.segmentMaxChars !== 0 && typeof text === "string")
      splitSynthesisText(spokenText(text, c.pronunciations), c.segmentMaxChars, [...protectedTerms, ...Object.values(c.pronunciations ?? {})]);
    if (
      !Number.isSafeInteger(c.synthesisTimeoutMs ?? 90000) ||
      (c.synthesisTimeoutMs ?? 90000) < 1 ||
      (c.synthesisTimeoutMs ?? 90000) > 2147483647
    )
      throw Error("Invalid synthesis timeout");
    if (!Number.isSafeInteger(c.rendererStartTimeoutMs ?? 15000)
      || (c.rendererStartTimeoutMs ?? 15000) < 1000 || (c.rendererStartTimeoutMs ?? 15000) > 300000)
      throw Error("Invalid renderer playback-start timeout");
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
    if (seed !== undefined && (!Number.isSafeInteger(seed) || Number(seed) < 0)) throw Error("Invalid explicit synthesis seed");
    const config = structuredClone(c);
    if (seed !== undefined) config.extraBody = { ...config.extraBody, seed };
    return { text: text.trim(), voice: selected, config };
  }
  /** Produce audio only: does not acquire a renderer, interrupt speech, emit playback, or use a broadcast floor. */
  private async renderArtifact(text:string,id:string,caller:AbortSignal) {
    const {voice,config:c}=this.validate(text);
    if(c.segmentMaxChars)throw Error('Audio artifacts require one full utterance, not independent clones');
    const signal=AbortSignal.any([caller,this.metadataAbort.signal,AbortSignal.timeout(c.synthesisTimeoutMs??90000)]);
    const previous=this.synthesisTail;let release!:()=>void;
    this.synthesisTail=new Promise<void>(resolve=>{release=resolve;});
    const chunks:Buffer[]=[];let size=0,generationComplete:boolean|null=null;
    const write=async(value:Uint8Array)=>{signal.throwIfAborted();size+=value.byteLength;
      if(size>4*1024*1024)throw Error('Game voice exceeds 4MiB/30s; line was not uploaded');chunks.push(Buffer.from(value));};
    try {
      await previous;signal.throwIfAborted();
      if(c.synthesisTransport==='drama-rs-wav') {
        await streamDramaRs({url:c.url,text:spokenText(text,c.pronunciations),voice,extraBody:c.extraBody,
          directory:this.directory,actionId:id,sessionId:this.sessionId,signal,failure,
          begin:()=>{},write,evidence:()=>{}});
      } else {
        const auth=await bearer(c),pcm=c.synthesisTransport==='pcm-sse';
        const response=await fetch(endpoint(c.url),{method:'POST',redirect:'error',signal,
          headers:{'Content-Type':'application/json',...auth,'x-client-request-id':id,'x-litellm-session-id':this.sessionId},
          body:JSON.stringify({...c.extraBody,model:c.model,input:spokenText(text,c.pronunciations),voice,
            response_format:pcm?'pcm':'wav',...(pcm?{stream_format:'sse'}:{}),...(c.instructions?{instructions:c.instructions}:{})})});
        if(!response.ok||!response.body)throw await failure(response);
        if(pcm){await streamPcmSse({response,sampleRate:c.pcmSampleRate!,signal,begin:()=>{},write,terminal:()=>{}});generationComplete=true;}
        else {
          try {const stop=assertWavComplete(response,c.requireWavCompletion);generationComplete=stop==='complete'?true:null;
            const reader=response.body.getReader();try {for(;;){const row=await reader.read();if(row.done)break;await write(row.value);}}
            finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
          }catch(error){await response.body.cancel().catch(()=>{});throw error;}
        }
      }
      return {bytes:Buffer.concat(chunks),voice,generationComplete};
    } catch (error) {
      if (!caller.aborted && !this.metadataAbort.signal.aborted && c.synthesisTransport === 'drama-rs-wav' && upstreamUnavailable(error)) {
        this.catalogError = 'drama-rs synthesis unavailable; health and configured voice must be reverified';
        this.scheduleRecovery();
      }
      throw error;
    } finally { release(); }
  }
  queueArtifact(id:string,artifact:{metadata:VoiceArtifact;bytes:Buffer}) {
    const artifactId=artifact.metadata.requestId,config=this.config();
    if(!config)throw Error('Stage voice configuration unavailable');
    this.interrupt('superseded');
    this.current={id,text:artifact.metadata.text??'',voice:artifact.metadata.voice??'external-audio',abort:new AbortController(),
      opened:false,finished:false,trace:{'x-audio-artifact-id':artifactId},config:structuredClone(config),artifact};
    return {id,url:'/audio/speech/'+encodeURIComponent(id),prebufferMs:480};
  }
  queue(id: string, text: unknown, voice?: unknown, seed?: unknown) {
    const validated = this.validate(text, voice, seed);
    this.interrupt("superseded");
    this.current = {
      id,
      text: validated.text,
      voice: validated.voice,
      abort: new AbortController(),
      opened: false,
      finished: false,
      trace: { "x-litellm-session-id": this.sessionId },
      config: validated.config,
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
    this.last = { id: s.id, status: reason, trace: s.trace,
      ...(s.nativeStream ? { nativeStream: s.nativeStream } : {}) };
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
    if(s.artifact) {
      try {
        res.writeHead(200,{'Content-Type':'audio/wav','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        this.report(s.id,'streaming',{audioArtifact:s.artifact.metadata.requestId,generationComplete:s.artifact.metadata.generationComplete});
        for(let at=0;at<s.artifact.bytes.length;at+=65536){s.abort.signal.throwIfAborted();
          if(!res.write(s.artifact.bytes.subarray(at,at+65536)))await once(res,'drain',{signal:s.abort.signal});}
        s.finished=true;s.transportFinishedAt=Date.now();res.end();
        this.last={id:s.id,status:'transport-complete',artifact:s.artifact.metadata};
        this.report(s.id,'transport-complete',{bytes:s.artifact.bytes.length,audioArtifact:s.artifact.metadata.requestId,
          generationComplete:s.artifact.metadata.generationComplete});
      }catch(error){if(!s.abort.signal.aborted)this.interrupt('artifact-playback-connection-failed');if(!res.destroyed)res.destroy();}
      return;
    }
    let release: (() => void) | undefined;
    try {
      const signal = AbortSignal.any([
        s.abort.signal,
        AbortSignal.timeout(s.config.synthesisTimeoutMs ?? 90000),
      ]);
      this.report(s.id, "synthesizing", {
        trace: s.trace,
        timeoutMs: s.config.synthesisTimeoutMs ?? 90000,
      });
      const auth = c.synthesisTransport === "drama-rs-wav" ? {} : await bearer(c);
      const previous = this.synthesisTail;
      this.synthesisTail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      signal.throwIfAborted();
      let bytes = 0;
      if (c.synthesisTransport === "drama-rs-wav") {
        const result = await streamDramaRs({
          url: c.url, text: spokenText(s.text, c.pronunciations), voice: s.voice, extraBody: c.extraBody,
          directory: this.directory, actionId: s.id, sessionId: this.sessionId, signal, failure,
          evidence: value => { s.nativeStream = { ...value };
            if (this.last?.id === s.id) this.last.nativeStream = s.nativeStream; },
          begin: () => {
            res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
            this.report(s.id, "streaming", { trace: s.trace, generationComplete: null });
          },
          write: async value => { if (!res.write(value)) await once(res, "drain", { signal }); },
        });
        bytes = result.bytes;
      } else if (c.synthesisTransport === "pcm-sse") {
        const requestId = randomUUID(), input = spokenText(s.text, c.pronunciations), startedAt = Date.now();
        s.nativeStream = { input, requestId, startedAt, stop: null };
        const response = await fetch(endpoint(c.url), {
          method: "POST", redirect: "error", signal,
          headers: { "Content-Type": "application/json", ...auth,
            "x-litellm-session-id": this.sessionId, "x-client-request-id": requestId },
          body: JSON.stringify({ ...c.extraBody, model: c.model, input, voice: s.voice,
            response_format: "pcm", stream_format: "sse", ...(c.instructions ? { instructions: c.instructions } : {}) }),
        });
        if (!response.ok) throw await failure(response);
        for (const key of ["x-litellm-call-id", "x-litellm-session-id", "x-tts-request-id"])
          s.trace[key] = response.headers.get(key) ?? s.trace[key] ?? null;
        const result = await streamPcmSse({ response, sampleRate: c.pcmSampleRate!, signal,
          terminal: value => { s.nativeStream = { input, requestId, startedAt, ...value }; },
          begin: () => {
            res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
            this.report(s.id, "streaming", { trace: s.trace });
          },
          write: async value => { if (!res.write(value)) await once(res, "drain", { signal }); },
        });
        s.nativeStream = { input, requestId, startedAt, ...result };
        bytes = result.bytes;
      } else if (c.segmentMaxChars !== undefined && c.segmentMaxChars !== 0) {
        s.segments = [];
        bytes = await streamSpeechSegments({
          text: spokenText(s.text, c.pronunciations), maxChars: c.segmentMaxChars,
          requireWavCompletion: c.requireWavCompletion,
          protectedTerms: [...Object.keys(c.pronunciations ?? {}), ...Object.values(c.pronunciations ?? {})], signal, failure,
          request: (text, requestId) => fetch(endpoint(c.url), {
            method: "POST", redirect: "error", signal,
            headers: { "Content-Type": "application/json", ...auth,
              "x-litellm-session-id": this.sessionId, "x-client-request-id": requestId },
            body: JSON.stringify({ ...c.extraBody, model: c.model, input: text, voice: s.voice,
              response_format: "wav", ...(c.instructions ? { instructions: c.instructions } : {}) }),
          }),
          begin: response => {
            for (const key of ["x-litellm-call-id", "x-litellm-session-id", "x-tts-request-id"])
              s.trace[key] = response.headers.get(key) ?? s.trace[key] ?? null;
            res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
            this.report(s.id, "streaming", { trace: s.trace });
          },
          write: async value => { if (!res.write(value)) await once(res, "drain", { signal }); },
          segment: value => { s.segments!.push(value); if (s.segments!.length > 16) s.segments!.shift(); },
        });
      } else {
      const response = await fetch(endpoint(c.url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...auth,
          "x-litellm-session-id": this.sessionId,
        },
        body: JSON.stringify({
          ...c.extraBody,
          model: c.model,
          input: spokenText(s.text, c.pronunciations),
          voice: s.voice,
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
      s.wavStop = response.headers.get("x-speech-stop");
      assertWavComplete(response, c.requireWavCompletion);
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
      for await (const value of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (s.abort.signal.aborted) break;
        bytes += value.byteLength;
        if (bytes > 128 * 1024 * 1024)
          throw Error("Speech exceeded stream limit");
        if (!res.write(value)) await once(res, "drain", { signal });
      }
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
          ...(s.segments ? { segments: s.segments } : {}),
          ...(s.nativeStream ? { nativeStream: s.nativeStream } : {}),
          ...(s.wavStop !== undefined ? { wavStop: s.wavStop } : {}),
        };
        this.report(s.id, "transport-complete", { trace: s.trace, bytes,
          ...this.generationEvidence(s.id) });
        void this.recordMetadata(s);
      }
    } catch (e) {
      if (!s.abort.signal.aborted) {
        if (s.config.synthesisTransport === 'drama-rs-wav' && upstreamUnavailable(e)) {
          this.catalogError = 'drama-rs synthesis unavailable; health and configured voice must be reverified';
          this.scheduleRecovery();
        }
        s.finished = true;
        this.current = null;
        this.last = { id: s.id, status: "failed", trace: s.trace,
          ...(s.nativeStream ? { nativeStream: s.nativeStream } : {}),
          ...(s.wavStop !== undefined ? { wavStop: s.wavStop } : {}) };
        // Also close an unread provider body (for example an incomplete WAV
        // rejected from its headers), rather than leaving generation running.
        s.abort.abort(e);
        this.report(s.id, "failed", {
          error: e instanceof Error ? e.message : String(e),
          trace: s.trace,
        });
        void this.recordMetadata(s);
        // A clean EOF after partial PCM could be mistaken for successful speech.
        // Fail the downstream stream so its player cancels already scheduled audio.
        if (res.headersSent) res.destroy(e instanceof Error ? e : Error(String(e)));
        else { res.writeHead(502); res.end(); }
      }
    } finally {
      release?.();
    }
  }
  finish(id: string) {
    if (this.current?.id === id) this.current = null;
  }
  generationEvidence(id: string): Record<string, unknown> {
    const s = this.current;
    if(s?.id===id&&s.artifact)return {generationComplete:s.artifact.metadata.generationComplete,
      audioArtifact:s.artifact.metadata.requestId,transportEnded:s.finished&&!!s.transportFinishedAt};
    if (!s || s.id !== id || s.config.synthesisTransport !== "drama-rs-wav") return {};
    return { generationComplete: null, generationStop: null,
      completionEvidence: "not-provided-by-native-api", transportEnded: s.finished && !!s.transportFinishedAt };
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
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.recoveryAt = null;
    this.metadataAbort.abort();
    this.interrupt("stage-stopped");
  }
  /** A failed utterance is never replayed. Probe only discovery after failure;
   * fresh speech can resume once this exact configured voice is available. */
  private scheduleRecovery() {
    if (this.recoveryTimer || this.metadataAbort.signal.aborted) return;
    this.recoveryAt = Date.now() + 30000;
    const lifetime = this.metadataAbort;
    this.recoveryTimer = setTimeout(async () => {
      this.recoveryTimer = null;
      const config = this.config();
      if (!config || config.synthesisTransport !== 'drama-rs-wav' || lifetime.signal.aborted) return;
      try {
        const voices = await dramaRsVoices(config.url, AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)]));
        const selected = this.selectedVoice ?? config.voice;
        if (!voices.includes(selected)) throw Error('Configured voice is absent from drama-rs');
        if (lifetime !== this.metadataAbort || lifetime.signal.aborted || this.config()?.url !== config.url) return;
        this.availableVoices = config.voices?.length ? voices.filter(v => v === config.voice || config.voices!.includes(v)) : voices;
        this.catalogError = null;
        this.recoveryAt = null;
      } catch {
        if (lifetime === this.metadataAbort && !lifetime.signal.aborted) this.scheduleRecovery();
      }
    }, 30000);
    this.recoveryTimer.unref();
  }
}
