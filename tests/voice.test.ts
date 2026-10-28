import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { VoiceService } from "../src/core/voice.ts";
// @ts-expect-error Browser module is deliberately framework-free JavaScript.
import { playSpeech } from "../web/speech.js";
// @ts-expect-error Browser module is deliberately framework-free JavaScript.
import { AudioOutput } from "../web/audio.js";
const cleanup: Array<() => Promise<unknown>> = [];
it.each([
  [{ error: { code: "SPEECH_COORDINATOR_REQUIRED", recovery: { tool: "omni_report" }, message: "secret-provider-body" } }, "TTS HTTP 409; SPEECH_COORDINATOR_REQUIRED; use tool omni_report"],
  [{ error: "secret-provider-body" }, "TTS HTTP 409"],
  [{ error: { code: "Bearer secret-provider-body", recovery: { tool: "bad tool" } } }, "TTS HTTP 409"],
  [{ error: { code: "VALID", padding: "x".repeat(4096) } }, "TTS HTTP 409"],
])("preserves safe TTS recovery identifiers and bounds untrusted errors %#", async (body, expected) => {
  const directory = await mkdtemp(join(tmpdir(), "voice-recovery-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const events: any[] = [];
  const voice = new VoiceService(() => ({url:"http://127.0.0.1:19001/speech",model:"fixture",voice:"a"}), directory,
    (id,status,data)=>events.push({id,status,...data}));
  await voice.start(); cleanup.push(async()=>voice.stop());
  voice.queue("original", "Backend draft", "a");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body,{status:409}));
  const res: any = new EventEmitter(); res.headersSent=false; res.writeHead=vi.fn(); res.end=vi.fn();
  await voice.stream("original",res);
  expect(events.find(row=>row.status==="failed")?.error).toBe(expected);
  expect(JSON.stringify(events)).not.toContain("secret-provider-body");
  expect(res.writeHead).toHaveBeenCalledWith(502);
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(["cancelled", "failed"])(
  "reconciles %s when HTTP closes before the browser receives its terminal event",
  async (terminal) => {
    vi.stubGlobal("location", { href: "http://127.0.0.1:1000/" });
    const networkError = new TypeError("network error");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: terminal })),
      );
    const receipt = vi.fn(),
      state = vi.fn();
    const output = new AudioOutput({
      sessionId: "one",
      receipt,
      onMouth: vi.fn(),
      onLyric: vi.fn(),
      onState: state,
    });
    output.context = { state: "running" };
    const command = output.command({
      kind: "speech",
      targetSession: "one",
      eventId: "original",
      url: "/audio/speech/original",
    });
    if (terminal === "cancelled") {
      await command;
      expect(output.current).toBeNull();
      expect(state).toHaveBeenLastCalledWith("播放已打断");
    } else await expect(command).rejects.toBe(networkError);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(receipt).not.toHaveBeenCalled();
  },
);
function wav(seconds = 1, rate = 48000) {
  const samples = Math.round(rate * seconds),
    b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples * 2, 40);
  return b;
}
it("plays standard 24kHz cloud WAV without speed or pitch changes", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(wav(1, 24000)));
  const createBuffer = vi.fn(() => ({ copyToChannel() {} }));
  const context = {
    currentTime: 0,
    state: "running",
    destination: {},
    createBuffer,
    createBufferSource: () => ({ connect() {}, start() {}, stop() {} }),
  };
  const abort = new AbortController();
  const playback = playSpeech({
    url: "http://127.0.0.1/cloud",
    context,
    signal: abort.signal,
  });
  await vi.waitFor(() =>
    expect(createBuffer).toHaveBeenCalledWith(1, 24000, 24000),
  );
  abort.abort();
  await playback;
});
it("keeps cancellation attached after all WAV bytes arrive and clears already scheduled audio", async () => {
  const bytes = wav(1),
    sources: any[] = [],
    starts = vi.fn(),
    ends = vi.fn(),
    stats = vi.fn();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(bytes, { headers: { "Content-Type": "audio/wav" } }),
  );
  const context: any = {
    currentTime: 0,
    state: "running",
    destination: {},
    createBuffer: () => ({ copyToChannel() {} }),
    createBufferSource: () => {
      const source = {
        connect() {},
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      sources.push(source);
      return source;
    },
  };
  const abort = new AbortController();
  let returned = false;
  const result = playSpeech({
    url: "http://127.0.0.1/fixture",
    context,
    signal: abort.signal,
    onStart: starts,
    onEnd: ends,
    onStats: stats,
  }).then(() => (returned = true));
  await vi.waitFor(() => expect(sources.length).toBeGreaterThan(0));
  expect(returned).toBe(false);
  context.currentTime = 0.1;
  await new Promise((r) => setTimeout(r, 20));
  expect(starts).toHaveBeenCalledOnce();
  abort.abort();
  await result;
  expect(ends).not.toHaveBeenCalled();
  expect(sources.every((s) => s.stop.mock.calls.length === 1)).toBe(true);
  expect(stats).toHaveBeenLastCalledWith(
    expect.objectContaining({
      cancelled: true,
      activeSources: 0,
      bufferedSamples: 0,
    }),
  );
});
it("stops queued PCM and never completes playback after an upstream stream failure", async () => {
  let producer!:ReadableStreamDefaultController<Uint8Array>;
  const body=new ReadableStream<Uint8Array>({start(c){producer=c;}}), sources:any[]=[], ended=vi.fn();
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(body,{headers:{'content-type':'audio/wav'}}));
  const context={state:'running',currentTime:0,destination:{},createBuffer:()=>({copyToChannel(){}}),
    createBufferSource:()=>{const source={connect(){},start(){},stop:vi.fn()};sources.push(source);return source;}};
  const result=playSpeech({url:'http://fixture.invalid/partial',context,signal:new AbortController().signal,onEnd:ended});
  const failed=expect(result).rejects.toThrow('provider disconnected');
  producer.enqueue(wav(2,44100));await vi.waitFor(()=>expect(sources.length).toBeGreaterThan(0));
  producer.error(Error('provider disconnected'));await failed;
  expect(sources.every(n=>n.stop.mock.calls.length===1)).toBe(true);expect(ended).not.toHaveBeenCalled();
});
it("streams before provider completion, snapshots the chosen voice, and aborts the old upstream HTTP request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "avatar-voice-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let requestBody: any,
    providerClosed = false,
    complete = false;
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    requestBody = JSON.parse(raw);
    res.writeHead(200, {
      "Content-Type": "audio/wav",
      "x-litellm-call-id": "call-one",
      "x-tts-request-id": "native-one",
    });
    res.write(wav(10).subarray(0, 44));
    const timer = setInterval(() => res.write(Buffer.alloc(9600)), 20);
    res.once("close", () => {
      clearInterval(timer);
      providerClosed = !complete;
    });
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  cleanup.push(
    () =>
      new Promise<void>((ok) => {
        upstream.closeAllConnections();
        upstream.close(() => ok());
      }),
  );
  const events: any[] = [],
    voice = new VoiceService(
      () => ({
        url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/audio/speech`,
        model: "fixture",
        voice: "a",
        voices: ["a", "b"],
      }),
      directory,
      (id, status, data) => events.push({ id, status, ...data }),
    );
  await voice.start();
  cleanup.push(async () => voice.stop());
  voice.queue("original", "Plain words", "a");
  await voice.select("b");
  const proxy = createServer((req, res) => void voice.stream("original", res));
  await new Promise<void>((ok) => proxy.listen(0, "127.0.0.1", ok));
  cleanup.push(
    () =>
      new Promise<void>((ok) => {
        proxy.closeAllConnections();
        proxy.close(() => ok());
      }),
  );
  const response = await fetch(
      `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
    ),
    reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  expect(requestBody.voice).toBe("a");
  expect(requestBody.input).toBe("Plain words");
  expect(complete).toBe(false);
  voice.interrupt();
  await vi.waitFor(() => expect(providerClosed).toBe(true));
  expect(events).toContainEqual(
    expect.objectContaining({
      id: "original",
      status: "cancelled",
      trace: expect.objectContaining({
        "x-litellm-call-id": "call-one",
        "x-tts-request-id": "native-one",
      }),
    }),
  );
  await reader.cancel().catch(() => {});
});
