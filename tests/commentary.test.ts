import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentaryLane, COMMENTARY_DEFAULTS, parseCommentary, type SpeechAvailability } from "../src/core/commentary.ts";
import { CommentaryRuntimeGate } from "../src/core/commentary-runtime.ts";
import { CommentaryController, SPEECH_DRAFT_HEADER } from "../src/commentary-controller.ts";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
function rig() {
  let now = 100_000;
  const config = { ...COMMENTARY_DEFAULTS, enabled: true, sources: "game", idleSec: 2, retrySec: 2, factAgeSec: 30 };
  const speech: SpeechAvailability = { observedAtMs: now, idleSinceMs: now - 5000, busy: false, ttsReady: true };
  const available = { live: true, active: true, speech };
  const draft = pending<{ text: string }>();
  const request = vi.fn((_brief: string) => draft.promise), perform = vi.fn(async (_script: string, _serial: number, _evidence: number[]) => ({ accepted: true })), log = vi.fn();
  const lane = new CommentaryLane({ config: () => config, availability: () => available, request, perform, log, now: () => now });
  const observe = (cursor = 1, type = "game.result", text = "玩家 Jojo：我刚在村口看到了马。", source = "game") => lane.observe({ cursor, source, type, origin: "external", ts: new Date(now).toISOString(), text });
  const answer = (text = "刚才 Jojo 提到了村口的马。", evidence: number[] = [1]) => draft.resolve({ text: JSON.stringify({ script: text, evidence, kind: "observation" }) });
  return { config, speech, available, lane, observe, request, perform, answer, log,
    advance(ms: number) { now += ms; speech.observedAtMs = now; } };
}
describe("optional evidence-based game commentary", () => {
  it('can draft for an explicitly ready text renderer while TTS is disabled', async () => {
    const r = rig(); r.speech.ttsReady = false; r.speech.textReady = true;
    r.observe(); r.lane.tick(); r.answer(); await settle();
    expect(r.perform).toHaveBeenCalledWith('刚才 Jojo 提到了村口的马。', 1, [1]);
    const offline = rig(); offline.speech.ttsReady = false; offline.observe(); offline.lane.tick();
    expect(offline.request).not.toHaveBeenCalled();
  });
  it("does not call a model without fresh permitted facts, or while disabled, paused or busy", () => {
    const r = rig(); r.lane.tick(); r.observe(1, "chat", "hello", "other"); r.lane.tick();
    r.observe(2, "chat", "/login private-material"); r.lane.tick();
    expect(r.request).not.toHaveBeenCalled();
    r.observe(); r.config.enabled = false; r.lane.tick(); r.config.enabled = true;
    r.available.active = false; r.lane.tick(); r.available.active = true;
    r.speech.busy = true; r.lane.tick(); r.speech.busy = false;
    r.advance(31_000); r.lane.tick(); expect(r.request).not.toHaveBeenCalled();
  });
  it("drafts through cognition without tools, preserves source/speaker and submits once without claiming playback", async () => {
    const r = rig(); r.observe(); r.lane.tick();
    expect(r.request).toHaveBeenCalledTimes(1);
    const brief = r.request.mock.calls[0][0];
    expect(brief).toContain('"source":"game"'); expect(brief).toContain('Jojo：我刚');
    expect(brief).toContain('引用他人的“我”不能转成主播亲历');
    r.answer(); await settle();
    expect(r.perform).toHaveBeenCalledWith("刚才 Jojo 提到了村口的马。", 1, [1]);
    expect(r.lane.facts()).toContain("submitted"); expect(r.lane.facts()).toContain("不证明观众端播放");
    r.advance(2100); r.lane.tick(); await settle();
    expect(r.perform).toHaveBeenCalledTimes(1); expect(r.request).toHaveBeenCalledTimes(1);
    r.observe(2); r.lane.tick(); expect(r.request).toHaveBeenCalledTimes(1);
  });
  it.each(["new-chat", "foreground", "pause", "stop", "cited-replaced", "old-result"])("discards a late draft after %s", async reason => {
    const r = rig(); r.observe(); r.lane.tick();
    if (reason === "new-chat") r.observe(2, "game.chat", "Jojo：等等。");
    if (reason === "foreground") r.lane.foregroundSpeech("主线程先接话。");
    if (reason === "pause") r.available.active = false;
    if (reason === "stop") r.lane.stop();
    if (reason === "cited-replaced") r.observe(2);
    if (reason === "old-result") r.advance(31_000);
    r.answer(); await settle(); expect(r.perform).not.toHaveBeenCalled();
    expect(r.lane.facts()).toContain("stale");
  });
  it("keeps a hanging cognition slot and treats admission refusal as no submission", async () => {
    const r = rig(); r.observe(); r.lane.tick(); r.advance(3000); r.lane.tick();
    expect(r.request).toHaveBeenCalledTimes(1);
    r.perform.mockResolvedValue({ accepted: false }); r.answer(); await settle();
    expect(r.lane.facts()).not.toContain("最近提交台词"); expect(r.lane.facts()).toContain("stale");
  });
  it("normalizes lossless provider evidence identifiers while rejecting invented references", () => {
    const parse = (evidence: unknown[]) => parseCommentary(JSON.stringify({ script: "先看看这边。", kind: "observation", evidence }), new Set([7]));
    expect(parse(["7"])?.evidence).toEqual([7]);
    for (const value of ["7.0", "编号7", 8, "9007199254740992"]) expect(parse([value])).toBeNull();
  });
  it("preserves vocal directions for Drama3 and removes legacy action markers", () => {
    const script = '<wave>大家晚上好！[warm, cheerful] 今天沿小路旅行。【抬手】';
    const raw = JSON.stringify({ script, kind: "observation", evidence: [7] });
    expect(parseCommentary(raw, new Set([7]), "drama-3")?.script).toBe('大家晚上好！[warm, cheerful] 今天沿小路旅行。');
    expect(parseCommentary(raw, new Set([7]))?.script).toBe('大家晚上好！ 今天沿小路旅行。');
    for (const script of ['[sighs]', '大家好[未闭合', '大家好[nested[cue]]']) {
      expect(parseCommentary(JSON.stringify({ script, kind: "thought", evidence: [] }), new Set(), "drama-3")).toBeNull();
    }
  });
  it("uses the current backend contract and ignores delivery cues when detecting repeated speech", async () => {
    const r = rig(); r.speech.textFormat = "drama-3";
    r.lane.foregroundSpeech('刚才 Jojo 提到了村口的马。');
    r.observe(); r.lane.tick();
    expect(r.request.mock.calls[0][0]).toContain('当前语音契约 drama-3');
    r.answer('[轻快] 刚才 Jojo 提到了村口的马。'); await settle();
    expect(r.perform).not.toHaveBeenCalled();
  });
  it("discards a draft if the synthesis format changes while the model is working", async () => {
    const r = rig(); r.speech.textFormat = "drama-3"; r.observe(); r.lane.tick();
    r.speech.textFormat = "plain"; r.answer('[warm] 刚才 Jojo 提到了村口的马。'); await settle();
    expect(r.perform).not.toHaveBeenCalled(); expect(r.lane.facts()).toContain('stale');
  });
});

it("requires a fresh running, unpaused host status and fences late responses across stop", async () => {
  let now = 10_000; const response = pending<unknown>(), get = vi.fn(() => response.promise), invalidate = vi.fn();
  const gate = new CommentaryRuntimeGate({ url: () => "http://127.0.0.1/status", get, invalidate, now: () => now });
  expect(gate.active(false)).toBe(false); gate.tick(); gate.tick(); expect(get).toHaveBeenCalledTimes(1);
  response.resolve({ loop: { running: true, paused: false } }); await settle(); expect(gate.active(false)).toBe(true);
  now += 5001; expect(gate.active(false)).toBe(false);
  gate.stop(); gate.tick(); expect(get).toHaveBeenCalledTimes(1);
  gate.resume(); const late = pending<unknown>(); get.mockReturnValueOnce(late.promise); gate.tick(); gate.stop();
  late.resolve({ loop: { running: true, paused: false } }); await settle(); expect(gate.active(false)).toBe(false);
  expect(invalidate).toHaveBeenCalled();
});

it.each(["plain", "drama-3"] as const)("the World controller carries %s from the actual speech service into drafting and synthesis", async textFormat => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ loop: { running: true, paused: false } })));
  const events = new Map<number, any>(); let latest = 50;
  const get = vi.fn((cursor: number) => events.get(cursor)), request = vi.fn(async (_req: { brief: string; tools: unknown[]; hint?: unknown }) => ({ text: JSON.stringify({ script: "[轻快] 刚才走过了一段路。", evidence: [51], kind: "observation" }) }));
  const speak = vi.fn(async () => ({ accepted: true, status: "queued", id: "real-ledger-action" }));
  const stage = { audioOwner: "browser", audioRevision: 3, voice: { configured: true, textFormat }, foreground: null };
  const controller = new CommentaryController({ config: () => ({ enabled: true, port: 0, dataDir: "", avatars: [], commentary: {
    enabled: true, sources: "game", hostStatusUrl: "http://127.0.0.1/status", idleSec: 1, retrySec: 1, factAgeSec: 30 } }),
    state: async () => stage, speak });
  try {
    controller.start({ store: { latestCursor: () => latest, get }, cognition: { request }, log: { emit: vi.fn(), warn: vi.fn() } } as never);
    events.set(51, { cursor: 51, source: "game", type: "game.result", origin: "external", ts: new Date().toISOString(), text: "任务 a 终态完成，位移 4 格。" }); latest = 51;
    await vi.advanceTimersByTimeAsync(2100);
    expect(get.mock.calls.map(([cursor]) => cursor)).toEqual([51]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({ tools: [], hint: { rounds: 1 } });
    expect(request.mock.calls[0][0].brief.startsWith(SPEECH_DRAFT_HEADER + "\n")).toBe(true);
    expect(request.mock.calls[0][0].brief).toContain('当前语音契约 ' + textFormat);
    expect(speak).toHaveBeenCalledWith({ action: "speak", text: textFormat === "drama-3" ? "[轻快] 刚才走过了一段路。" : "刚才走过了一段路。", ifIdleRevision: 3 }, expect.stringMatching(/^avatar-commentary-/));
  } finally { controller.stop(); }
});
