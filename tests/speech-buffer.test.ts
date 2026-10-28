import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error browser source is tested through its AudioContext boundary
import { playSpeech } from '../web/speech.js';

afterEach(() => vi.useRealTimers());
const trace = JSON.parse(readFileSync(new URL('./fixtures/pcm-arrivals-20261028.json', import.meta.url), 'utf8')) as {
  sampleRate: number; doneAtMs: number; frames: Array<{atMs: number; samples: number}>;
};

async function replay(prebufferMs?: number, source = trace) {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const total = source.frames.reduce((n, frame) => n + frame.samples, 0);
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36 + total * 2, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(trace.sampleRate, 24); header.writeUInt32LE(trace.sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(total * 2, 40);
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    source.frames.forEach((frame, index) => setTimeout(() => {
      const pcm = Buffer.alloc(frame.samples * 2, Buffer.from([index + 1, 0]));
      controller.enqueue(index === 0 ? Buffer.concat([header, pcm]) : pcm);
    }, frame.atMs));
    setTimeout(() => controller.close(), source.doneAtMs);
  } });
  const scheduled: Array<{at: number; samples: number; rate: number; firstSample: number}> = [];
  const context = { state: 'running', destination: {}, get currentTime() { return Date.now() / 1000; },
    createBuffer: (_channels: number, samples: number, rate: number) => ({samples, rate, firstSample: 0,
      copyToChannel(values: Float32Array) { this.firstSample = values[0]; } }),
    createBufferSource: () => {
      let timer: ReturnType<typeof setTimeout>;
      const node: any = { connect() {}, buffer: null, onended: null,
        start(at: number) { const b = this.buffer; scheduled.push({at, samples: b.samples, rate: b.rate, firstSample: b.firstSample});
          timer = setTimeout(() => this.onended?.(), Math.max(0, (at + b.samples / b.rate - context.currentTime) * 1000)); },
        stop() { clearTimeout(timer); } };
      return node;
    } };
  const started = vi.fn(), ended = vi.fn(), abort = new AbortController();
  const operation = playSpeech({ url: 'http://fixture.invalid/continuous', context, signal: abort.signal,
    ...(prebufferMs === undefined ? {} : {prebufferMs}), fetchAudio: async () => new Response(body), onStart: started, onEnd: ended });
  await vi.advanceTimersByTimeAsync(60000);
  const result = await operation;
  const gaps = scheduled.slice(1).map((row, i) => Math.max(0, row.at - (scheduled[i].at + scheduled[i].samples / scheduled[i].rate)) * 1000);
  return {result, scheduled, total, started, ended, gapMs: gaps.reduce((n, value) => n + value, 0)};
}

it('reproduces repeated starvation with the previous 480ms prebuffer on a real PCM arrival trace', async () => {
  const r = await replay(480);
  expect(r.result.underruns).toBeGreaterThanOrEqual(3);
  expect(r.gapMs).toBeGreaterThan(3000);
});

it('keeps the same samples continuous on that trace and starts well before generation ends', async () => {
  const r = await replay();
  expect(r.result.underruns).toBe(0); expect(r.gapMs).toBeLessThan(1);
  expect(r.scheduled[0].at * 1000).toBeLessThan(trace.doneAtMs - 20000);
  expect(r.result.samples).toBe(r.total); expect(r.result.sampleRate).toBe(trace.sampleRate);
  expect(r.scheduled.map(row => row.samples)).toEqual(trace.frames.map(row => row.samples));
  expect(r.scheduled.every(row => row.rate === 44100)).toBe(true);
  expect(r.scheduled.map(row => row.firstSample)).toEqual(trace.frames.map((_, i) => (i + 1) / 32768));
  expect(r.started).toHaveBeenCalledOnce(); expect(r.ended).toHaveBeenCalledOnce();
});

it('releases a short complete clip immediately instead of waiting three wall-clock seconds', async () => {
  const r = await replay(undefined, { sampleRate: 44100, doneAtMs: 100, frames: [{atMs: 50, samples: 22050}] });
  expect(r.scheduled[0].at * 1000).toBeLessThan(200);
  expect(r.result.samples).toBe(22050); expect(r.ended).toHaveBeenCalledOnce();
});

it('cancels while filling startup headroom without emitting a playback completion', async () => {
  const stop = new AbortController(), started = vi.fn(), ended = vi.fn(), body = new ReadableStream({start() {}});
  const context = {currentTime: 0, state: 'running', destination: {}};
  const operation = playSpeech({url:'http://fixture.invalid/buffering', context, signal:stop.signal,
    fetchAudio:async()=>new Response(body),onStart:started,onEnd:ended});
  await Promise.resolve(); await Promise.resolve(); stop.abort(); await operation;
  expect(started).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled();
});
