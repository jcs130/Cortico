import { afterEach, expect, it, vi } from "vitest";
// Browser-only module; exercised with a clocked audio device below.
// @ts-expect-error no declaration is emitted for the browser module
import { AudioOutput } from "../web/audio.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("starts singing activity only on real unpaused playback and returns to idle after stop", () => {
  const output = new AudioOutput({ onMouth() {}, onLyric() {}, onState() {} });
  output.current = "song";
  output.cues = { mouthSource: "lyrics" };
  output.music = {
    currentTime: 2,
    paused: true,
    ended: false,
    pause() {},
    removeAttribute() {},
    load() {},
  };
  expect(output.update()).toMatchObject({ playing: false, kind: "idle" });
  output.musicPlaying = true;
  output.music.paused = false;
  expect(output.update()).toMatchObject({
    playing: true,
    kind: "singing",
    actionId: "song",
    timeMs: 2000,
  });
  output.music.paused = true;
  expect(output.update().playing).toBe(false);
  output.stop();
  expect(output.update()).toMatchObject({ playing: false, kind: "idle" });
});

it("resumes audio inside the click before renderer registration or network, then claims the output", async () => {
  const order: string[] = [];
  const context = {
    state: "suspended",
    resume() {
      order.push("resume");
      this.state = "running";
      return Promise.resolve();
    },
  };
  vi.stubGlobal("AudioContext", function () {
    order.push("construct");
    return context;
  });
  vi.stubGlobal("fetch", async () => {
    order.push("claim");
    return Response.json({ ok: true });
  });
  const output = new AudioOutput({ sessionId: "page", onState() {} });
  const enabled = output.enable(async () => {
    order.push("register");
  });
  expect(order).toEqual(["construct", "resume", "register"]);
  await enabled;
  expect(order).toEqual(["construct", "resume", "register", "claim"]);
});

it("does not silently claim audio while browser autoplay is blocked, and supports the next click", async () => {
  vi.useFakeTimers();
  const context = {
    state: "suspended",
    resume: vi.fn(() => new Promise<void>(() => {})),
  };
  const fetch = vi.fn();
  vi.stubGlobal("AudioContext", function () {
    return context;
  });
  vi.stubGlobal("fetch", fetch);
  const output = new AudioOutput({ sessionId: "page", onState() {} });
  const failed = expect(output.enable()).rejects.toThrow("浏览器未允许播放");
  await vi.advanceTimersByTimeAsync(3100);
  await failed;
  expect(fetch).not.toHaveBeenCalled();
  context.resume.mockImplementation(() => {
    context.state = "running";
    return Promise.resolve();
  });
  fetch.mockResolvedValue(Response.json({ ok: true }));
  await output.enable();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("keeps another renderer ownership conflict explicit", async () => {
  vi.stubGlobal("AudioContext", function () {
    return { state: "running", resume: async () => {} };
  });
  vi.stubGlobal("fetch", async () =>
    Response.json(
      { error: "Another renderer owns the single audio output" },
      { status: 409 },
    ),
  );
  const output = new AudioOutput({ sessionId: "page", onState() {} });
  await expect(output.enable()).rejects.toThrow("Another renderer");
});

it("counts provider wait, identifies the audio action, and releases a cancelled voice before the next one", async () => {
  const started = performance.now();
  const sources = new Set<any>();
  const context = {
    state: "running",
    destination: {},
    get currentTime() {
      return (performance.now() - started) / 1000;
    },
    createBuffer: (_: number, length: number, sampleRate: number) => ({
      duration: length / sampleRate,
      copyToChannel() {},
    }),
    createBufferSource() {
      const source: any = {
        buffer: null,
        onended: null,
        connect() {},
        start(at: number) {
          sources.add(source);
          source.timer = setTimeout(
            () => {
              sources.delete(source);
              source.onended?.();
            },
            Math.max(
              0,
              (at - context.currentTime + source.buffer.duration) * 1000,
            ),
          );
        },
        stop() {
          clearTimeout(source.timer);
          sources.delete(source);
          source.onended?.();
        },
      };
      return source;
    },
  };
  const pcm = new Uint8Array(8820);
  const header = new Uint8Array(44),
    view = new DataView(header.buffer);
  header.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, pcm.length + 36, true);
  header.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 44100, true);
  view.setUint32(28, 88200, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  header.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, pcm.length, true);
  vi.stubGlobal("document", { body: { dataset: {} } });
  vi.stubGlobal("location", { href: "http://127.0.0.1:18000/" });
  vi.stubGlobal(
    "fetch",
    async (_url: string, options: { signal?: AbortSignal }) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      options.signal?.throwIfAborted();
      const bytes = new Uint8Array(header.length + pcm.length);
      bytes.set(header);
      bytes.set(pcm, header.length);
      return new Response(bytes, { headers: { "Content-Type": "audio/wav" } });
    },
  );
  const receipts: string[] = [];
  let opened!: () => void;
  let firstPlaying = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const output = new AudioOutput({
    sessionId: "renderer",
    receipt: (status: string, id: string) => {
      receipts.push(id + ":" + status);
      if (status === "playing") opened();
    },
    onMouth() {},
    onLyric() {},
    onState() {},
  });
  output.context = context;
  try {
    const first = output.command({
      kind: "speech",
      eventId: "old",
      targetSession: "renderer",
      url: "/speech/old",
    });
    await firstPlaying;
    expect(output.speechPlaying).toBe(true);
    expect(output.stats.actionId).toBe("old");
    expect(output.stats.firstPlaybackMs).toBeGreaterThanOrEqual(140);
    output.stop();
    await first;
    expect(output.speechPlaying).toBe(false);
    expect(output.stats).toMatchObject({
      actionId: "old",
      cancelled: true,
      activeSources: 0,
      bufferedSamples: 0,
    });
    expect(sources.size).toBe(0);
    expect(receipts).not.toContain("old:ended");

    firstPlaying = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const second = output.command({
      kind: "speech",
      eventId: "new",
      targetSession: "renderer",
      url: "/speech/new",
    });
    await firstPlaying;
    expect(output.stats.actionId).toBe("new");
    await second;
    expect(output.speechPlaying).toBe(false);
    expect(receipts).toContain("new:ended");
    expect(sources.size).toBe(0);
  } finally {
    output.stop();
    vi.unstubAllGlobals();
  }
});
