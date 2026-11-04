import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { VoiceService } from "../src/core/voice.ts";
import { dramaRsBody } from "../src/core/drama-rs.ts";
// @ts-expect-error Browser playback is intentionally framework-free JavaScript.
import { playSpeech } from "../web/speech.js";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function wav(samples = 30000, rate = 44100, finite = false) {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(finite ? bytes.length - 8 : 0xffffffff, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(finite ? samples * 2 : 0xffffffff, 40);
  return bytes;
}
class Output extends EventEmitter {
  chunks: Buffer[] = [];
  headersSent = false;
  ended = false;
  destroyed = false;
  writeHead() {
    this.headersSent = true;
  }
  write(b: Uint8Array) {
    this.chunks.push(Buffer.from(b));
    return true;
  }
  end() {
    this.ended = true;
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}
async function fixture(
  options: {
    voices?: string[];
    allowedVoices?: string[];
    savedVoice?: string;
    extra?: Record<string, unknown>;
    response?: (signal: AbortSignal) => Response;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "stage-drama-rs-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  if (options.savedVoice)
    await writeFile(
      join(directory, "voice-selection.json"),
      JSON.stringify({ voice: options.savedVoice }),
    );
  const bodies: Record<string, unknown>[] = [],
    calls: string[] = [],
    events: any[] = [];
  vi.stubGlobal("fetch", async (input: any, init: RequestInit = {}) => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (url.pathname === "/health")
      return Response.json({ status: "ok", runtime: "drama-rs" });
    if (url.pathname === "/v1/voices")
      return Response.json(options.voices ?? ["cormy", "yui"]);
    if (url.pathname !== "/v1/speak") throw Error("Unexpected route");
    bodies.push(JSON.parse(String(init.body)));
    return (
      options.response?.(init.signal!) ??
      new Response(wav(), { headers: { "content-type": "audio/wav" } })
    );
  });
  const config = {
    url: "http://fixture.invalid/v1/speak",
    model: "drama-3",
    voice: "cormy",
    ...(options.allowedVoices ? { voices: options.allowedVoices } : {}),
    synthesisTransport: "drama-rs-wav" as const,
    segmentMaxChars: 0,
    requireWavCompletion: false,
    extraBody: options.extra ?? { top_k: 4097, max_new: 2048 },
  };
  const voice = new VoiceService(
    () => config,
    directory,
    (id, status, data) => events.push({ id, status, ...data }),
  );
  await voice.start();
  cleanups.push(() => voice.stop());
  return { voice, config, directory, bodies, calls, events };
}

describe("native drama-rs", () => {
  it("preserves an explicit voice allowlist instead of enabling other server voices", async () => {
    const f = await fixture({ allowedVoices: ["cormy"] });
    expect(f.voice.status().voices).toEqual(["cormy"]);
    await expect(f.voice.select("yui")).rejects.toThrow("unavailable");
    expect(f.voice.validate("自己的音色。").voice).toBe("cormy");
  });
  it("verifies health and the actual catalog, never synthesizing or selecting an unknown voice", async () => {
    const f = await fixture();
    expect(f.calls).toEqual(["/health", "/v1/voices"]);
    expect(f.voice.status()).toMatchObject({
      configured: true,
      voice: "cormy",
      generationComplete: null,
    });
    expect(() => f.voice.queue("bad", "你好。", "missing")).toThrow(
      "Voice is not configured",
    );
    await expect(f.voice.select("missing")).rejects.toThrow("unavailable");
    expect(f.bodies).toHaveLength(0);
  });
  it("does not trust configured voices absent from the server", async () => {
    const f = await fixture({ voices: ["yui"] });
    expect(f.voice.status()).toMatchObject({
      configured: false,
      voices: ["yui"],
      catalogError: expect.stringContaining("absent"),
    });
    expect(() => f.voice.queue("no-fallback", "可米自己的声音。")).toThrow(
      "absent",
    );
    expect(f.bodies).toHaveLength(0);
  });
  it("retains an unknown saved selection as an error instead of falling back", async () => {
    const f = await fixture({ savedVoice: "removed" });
    expect(f.voice.status().voice).toBe("removed");
    expect(() => f.voice.queue("no-fallback", "不能换人。")).toThrow(
      "Voice is not configured",
    );
    await f.voice.select("cormy");
    expect(f.voice.validate("恢复明确选择。").voice).toBe("cormy");
  });
  it("forwards an entire 204-character utterance once and retains exact raw bytes and request JSON", async () => {
    const bytes = wav(1000, 44100, true);
    const f = await fixture({
      response: () =>
        new Response(
          new ReadableStream({
            start(c) {
              // Header fields and PCM samples cross arbitrary byte boundaries.
              for (let i = 0; i < bytes.length; i += 3)
                c.enqueue(bytes.subarray(i, i + 3));
              c.close();
            },
          }),
          { headers: { "content-type": "audio/wav" } },
        ),
    });
    const text = "可米和桐人、结衣在负数坐标附近，先核对地图。"
      .repeat(10)
      .slice(0, 204);
    expect(text).toHaveLength(204);
    f.voice.queue("whole", text);
    const output = new Output();
    await f.voice.stream("whole", output as any);
    expect(f.bodies).toEqual([
      {
        text,
        voice: "cormy",
        stream: true,
        split: false,
        top_k: 4097,
        max_new: 2048,
      },
    ]);
    expect(Buffer.concat(output.chunks)).toEqual(bytes);
    const evidence: any = f.voice.status().last?.nativeStream;
    expect(evidence).toMatchObject({
      transportEnded: true,
      samples: 1000,
      generationComplete: null,
      generationStop: null,
    });
    expect(await readFile(evidence.rawWav)).toEqual(bytes);
    expect(evidence.rawSha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(
      JSON.parse(await readFile(evidence.requestLog, "utf8")).body,
    ).toEqual(f.bodies[0]);
    expect(
      JSON.parse(await readFile(evidence.transportLog, "utf8"))
        .generationComplete,
    ).toBeNull();
    expect(
      f.events.some((e) =>
        ["playing", "ended", "completed"].includes(e.status),
      ),
    ).toBe(false);
    expect(f.voice.generationEvidence("whole")).toMatchObject({
      generationComplete: null,
      transportEnded: true,
    });
  });
  it("starts forwarding open-ended WAV before EOF without fabricating a complete marker", async () => {
    let producer!: ReadableStreamDefaultController<Uint8Array>;
    const f = await fixture({
      response: () =>
        new Response(
          new ReadableStream({
            start(c) {
              producer = c;
              c.enqueue(wav());
            },
          }),
          { headers: { "content-type": "audio/wav" } },
        ),
    });
    f.voice.queue("stream", "一条完整台词，不切成多个请求。");
    const output = new Output(),
      pending = f.voice.stream("stream", output as any);
    await vi.waitFor(() => expect(output.chunks.length).toBeGreaterThan(0));
    expect(output.ended).toBe(false);
    expect(f.bodies).toHaveLength(1);
    expect(f.events.some((e) => e.status === "transport-complete")).toBe(false);
    producer.close();
    await pending;
    expect(output.ended).toBe(true);
    expect(
      f.events.find((e) => e.status === "transport-complete"),
    ).toMatchObject({ generationComplete: null, generationStop: null });
  });
  it.each([0, 12345])(
    "preserves explicit per-call seed=%s and leaves ordinary calls unseeded",
    async (seed) => {
      const f = await fixture();
      f.voice.queue("seeded", "同一段实验台词。", undefined, seed);
      await f.voice.stream("seeded", new Output() as any);
      expect(f.bodies[0].seed).toBe(seed);
      f.voice.queue("normal", "日常台词。");
      await f.voice.stream("normal", new Output() as any);
      expect(f.bodies[1]).not.toHaveProperty("seed");
    },
  );
  it("rejects segmentation, fake completion requirements and incompatible legacy fields before POST", async () => {
    const f = await fixture();
    f.config.segmentMaxChars = 24;
    expect(() => f.voice.queue("split", "第一句。第二句。")).toThrow(
      "complete utterance",
    );
    f.config.segmentMaxChars = 0;
    f.config.requireWavCompletion = true;
    expect(() => f.voice.queue("marker", "没有完成标志。")).toThrow(
      "no reliable",
    );
    f.config.requireWavCompletion = false;
    f.config.extraBody = { max_seconds: 30 };
    expect(() => f.voice.queue("old", "旧接口参数。")).toThrow("supports only");
    expect(f.bodies).toHaveLength(0);
    expect(dramaRsBody("完整句。", "cormy", { seed: 7 })).toMatchObject({
      seed: 7,
      split: false,
    });
  });
  it.each(["wrong-rate", "odd-pcm", "finite-truncated"])(
    "retains %s raw audio as failed, never as transport completion",
    async (kind) => {
      let bytes = wav(
        1000,
        kind === "wrong-rate" ? 48000 : 44100,
        kind === "finite-truncated",
      );
      if (kind !== "wrong-rate")
        bytes = bytes.subarray(0, bytes.length - (kind === "odd-pcm" ? 1 : 2));
      const f = await fixture({
        response: () =>
          new Response(bytes, { headers: { "content-type": "audio/wav" } }),
      });
      f.voice.queue("bad-audio", "结构校验失败。");
      const output = new Output();
      await f.voice.stream("bad-audio", output as any);
      expect(f.voice.status().last).toMatchObject({
        status: "failed",
        nativeStream: { transportEnded: false, generationComplete: null },
      });
      const evidence: any = f.voice.status().last?.nativeStream;
      expect(await readFile(evidence.rawWav)).toEqual(bytes);
      expect(f.events.some((e) => e.status === "transport-complete")).toBe(
        false,
      );
    },
  );
  it("fails a read-side disconnect and retains partial bytes with unknown generation coverage", async () => {
    let producer!: ReadableStreamDefaultController<Uint8Array>;
    const f = await fixture({
      response: () =>
        new Response(
          new ReadableStream({
            start(c) {
              producer = c;
              c.enqueue(wav());
            },
          }),
          { headers: { "content-type": "audio/wav" } },
        ),
    });
    f.voice.queue("lost", "断流不是成功。");
    const output = new Output();
    const pending = f.voice.stream("lost", output as any);
    await vi.waitFor(() => expect(output.chunks.length).toBeGreaterThan(0));
    producer.error(Error("provider disconnected"));
    await pending;
    expect(output.destroyed).toBe(true);
    expect(output.ended).toBe(false);
    expect(f.voice.status().last).toMatchObject({
      status: "failed",
      nativeStream: { generationComplete: null, transportEnded: false },
    });
  });
});

it("closes the real native upstream HTTP response when the renderer disconnects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drama-rs-http-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let closed = false;
  const provider = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.end("ok\n");
      return;
    }
    if (req.url === "/v1/voices") {
      res.end(JSON.stringify(["cormy"]));
      return;
    }
    for await (const _ of req) {
      /* consume request */
    }
    res.writeHead(200, { "content-type": "audio/wav" });
    res.write(wav());
    res.once("close", () => {
      closed = true;
    });
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  cleanups.push(async () => {
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
  });
  const voice = new VoiceService(
    () => ({
      url: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1/speak`,
      model: "drama-3",
      voice: "cormy",
      synthesisTransport: "drama-rs-wav",
    }),
    directory,
    () => {},
  );
  await voice.start();
  cleanups.push(() => voice.stop());
  voice.queue("cancel", "取消时关闭请求。");
  const output = new Output();
  const pending = voice.stream("cancel", output as any);
  await vi.waitFor(() => expect(output.chunks.length).toBeGreaterThan(0));
  output.destroy();
  await pending;
  await vi.waitFor(() => expect(closed).toBe(true));
  expect(voice.status().last).toMatchObject({
    status: "playback-connection-closed",
    nativeStream: {
      cancelled: true,
      generationComplete: null,
      transportEnded: false,
    },
  });
});

it("schedules native 44.1kHz samples before the last bytes on a 48kHz output context", async () => {
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      producer = c;
    },
  });
  const buffers: any[] = [],
    nodes: any[] = [],
    started = vi.fn(),
    ended = vi.fn();
  const context = {
    sampleRate: 48000,
    state: "running",
    currentTime: 0,
    destination: {},
    createBuffer: (channels: number, length: number, rate: number) => {
      buffers.push({ channels, length, rate });
      return { copyToChannel() {} };
    },
    createBufferSource: () => {
      const node = { connect() {}, start: vi.fn(), stop: vi.fn() };
      nodes.push(node);
      return node;
    },
  };
  const abort = new AbortController();
  const playing = playSpeech({
    url: "http://fixture.invalid/native",
    context,
    signal: abort.signal,
    fetchAudio: async () =>
      new Response(stream, { headers: { "content-type": "audio/wav" } }),
    onStart: started,
    onEnd: ended,
  });
  producer.enqueue(wav());
  await vi.waitFor(() => expect(nodes.length).toBeGreaterThan(0));
  expect(buffers.every((row) => row.rate === 44100 && row.channels === 1)).toBe(
    true,
  );
  context.currentTime = 0.1;
  await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(ended).not.toHaveBeenCalled();
  abort.abort();
  await playing;
  expect(nodes.every((node) => node.stop.mock.calls.length === 1)).toBe(true);
});
