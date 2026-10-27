import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentaryLane, COMMENTARY_DEFAULTS, parseCommentary, type SpeechAvailability } from "../src/core/commentary.ts";
import { CommentaryRuntimeGate } from "../src/core/commentary-runtime.ts";
import { CommentaryController, SPEECH_DRAFT_HEADER } from "../src/commentary-controller.ts";
import { checkSpeechFreshness } from "../src/speech-freshness.ts";

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
  const observe = (cursor = 1, type = "game.snapshot", text = "玩家 Jojo：我刚在村口看到了马。", source = "game") => lane.observe({ cursor, source, type, origin: "external", ts: new Date(now).toISOString(), text });
  const answer = (text = "刚才 Jojo 提到了村口的马。", evidence: number[] = [1]) => draft.resolve({ text: JSON.stringify({ script: text, evidence, kind: "observation" }) });
  return { config, speech, available, lane, observe, request, perform, answer, log,
    advance(ms: number) { now += ms; speech.observedAtMs = now; } };
}
describe("optional evidence-based game commentary", () => {
  it('revises a duplicate once with its rejection reason before submitting fresh speech', async () => {
    const r = rig(); r.lane.foregroundSpeech('刚才经过了路口。');
    r.observe(1, 'game.event', '路旁看到了瀑布。');
    r.request.mockResolvedValueOnce({text:JSON.stringify({script:'刚才经过了路口。',kind:'observation',evidence:[1]})})
      .mockResolvedValueOnce({text:JSON.stringify({script:'刚才路边还看到了一道瀑布。',kind:'observation',timeframe:'recent',evidence:[1]})});
    r.lane.tick(); await settle();
    expect(r.request).toHaveBeenCalledTimes(2);
    expect(r.request.mock.calls[1][0]).toContain('duplicate-script');
    expect(r.request.mock.calls[1][0]).toContain(JSON.stringify({
      rejectedCandidate: { script: '刚才经过了路口。', evidence: [1], timeframe: 'current' },
    }).slice(1, -1));
    expect(r.perform).toHaveBeenCalledTimes(1);
    expect(r.perform).toHaveBeenCalledWith('刚才路边还看到了一道瀑布。',1,[1],'recent');
  });
  it('returns current-claim rejection to the drafter without refreshing the observed clock', async () => {
    const r = rig(); Object.assign(r.config,{liveFactAgeSec:2});
    r.observe(1,'game.event','连接尝试被拒。');
    let n = 0;
    r.request.mockImplementation(async () => {
      if (++n === 1) { r.advance(3000); return {text:JSON.stringify({script:'现在还连接不上。',kind:'observation',timeframe:'current',evidence:[1]})}; }
      return {text:JSON.stringify({script:'刚才连接没成功。',kind:'observation',timeframe:'recent',evidence:[1]})};
    });
    r.lane.tick(); await settle();
    expect(r.request).toHaveBeenCalledTimes(2);
    expect(r.request.mock.calls[1][0]).toContain('cited-evidence-changed');
    // The task cognition port has no conversation state: a rejection reason
    // alone cannot tell the next request which wording needs revision.
    expect(r.request.mock.calls[1][0]).toContain(JSON.stringify({
      rejectedCandidate: { script: '现在还连接不上。', evidence: [1], timeframe: 'current' },
    }).slice(1, -1));
    expect(r.request.mock.calls[1][0]).toContain('1970-01-01T00:01:40.000Z');
    expect(r.perform).toHaveBeenCalledWith('刚才连接没成功。',1,[1],'recent');
  });
  it('bounds duplicate correction and does not call TTS when both drafts repeat', async () => {
    const r=rig();r.lane.foregroundSpeech('已经说过。');r.observe();
    r.request.mockResolvedValue({text:JSON.stringify({script:'已经说过。',kind:'thought',evidence:[]})});
    r.lane.tick();await settle();r.advance(3000);r.lane.tick();await settle();
    expect(r.request).toHaveBeenCalledTimes(2);expect(r.perform).not.toHaveBeenCalled();
  });
  it('discards a corrected draft if foreground speech arrives during revision', async () => {
    const r=rig();r.lane.foregroundSpeech('已经说过。');r.observe();
    const revised=pending<{text:string}>();
    r.request.mockResolvedValueOnce({text:JSON.stringify({script:'已经说过。',kind:'thought',evidence:[]})}).mockReturnValueOnce(revised.promise);
    r.lane.tick();await settle();expect(r.request).toHaveBeenCalledTimes(2);
    r.lane.foregroundSpeech('主意识正在回答。');
    revised.resolve({text:JSON.stringify({script:'另一句。',kind:'thought',evidence:[]})});await settle();
    expect(r.perform).not.toHaveBeenCalled();
  });
  it('keeps a scene and its body progress despite a flood of status receipts', () => {
    const r = rig(); r.observe(1, 'game.snapshot', '当前位置\n'+ '可见方块'.repeat(400) + '\n身体任务仍在向南走');
    for(let i=2;i<40;i++)r.observe(i,'game.result','命令已受理 '+i);
    r.lane.tick(); const brief=r.request.mock.calls[0][0];
    expect(brief).toContain('当前位置'); expect(brief).toContain('身体任务仍在向南走');
    expect(brief).not.toContain('可见方块'.repeat(400));
    expect(r.log).toHaveBeenCalledWith('commentary-request',expect.objectContaining({evidence:expect.arrayContaining([1])}));
  });
  it('keeps an observed outcome beside later cleanup without turning it into current state', async () => {
    const r=rig();
    r.lane.observe({cursor:1,ts:new Date(100_000).toISOString(),source:'game',type:'game.event',origin:'external',
      text:'角色因箭伤死亡',execution:{kind:'observation',id:'episode-52',terminal:true,evidence:{outcome:'death'}}});
    r.advance(105_000);
    for(let i=2;i<40;i++)r.observe(i,'game.result','已结束登记，退出队伍 '+i);
    r.lane.tick(); expect(r.request.mock.calls[0][0]).toContain('角色因箭伤死亡');
    r.answer('现在主动退出了',[1]);await settle();
    expect(r.perform).not.toHaveBeenCalled(); // old outcome cannot support a current claim
  });
  it('admits a dated outcome after newer telemetry while retaining its original cursor', async () => {
    const r=rig();
    r.lane.observe({cursor:1,ts:new Date(100_000).toISOString(),source:'game',type:'game.event',origin:'external',text:'因箭伤死亡',
      execution:{kind:'observation',id:'episode-52',terminal:true,evidence:{outcome:'death'}}});
    r.advance(105_000);r.observe(2,'game.result','退出登记完成');
    r.request.mockResolvedValue({text:JSON.stringify({script:'刚才倒下了，后来才清理了登记。',kind:'observation',timeframe:'recent',evidence:[1,2]})});
    r.lane.tick();await settle();expect(r.perform).toHaveBeenCalledWith(expect.any(String),1,[1,2],'recent');
  });
  it.each([
    ['{"skip":"No new scene result."}', 'model-skip'],
    ['not JSON', 'invalid-json'],
    ['{"script":"Hello","kind":"observation","evidence":[999]}', 'invalid-output'],
  ])('separates skip from invalid output without storing the full response: %s', async (answer, reason) => {
    const r=rig();r.request.mockResolvedValue({text:answer});r.observe();r.lane.tick();await settle();
    expect(r.log).toHaveBeenCalledWith('commentary-skipped',expect.objectContaining({requestId:1,reason}));
    expect(r.perform).not.toHaveBeenCalled();
  });
  it('bounds and redacts skip diagnostics instead of logging raw model material',async()=>{
    const r=rig();r.request.mockResolvedValue({text:JSON.stringify({skip:'password=private-fixture '+ 'x'.repeat(2000)})});
    r.observe();r.lane.tick();await settle();
    expect(r.log).toHaveBeenCalledWith('commentary-skipped',{requestId:1,reason:'model-skip',skipReason:'[redacted]'});
  });
  it('drafts during confirmed playback, holds one candidate and submits at the next idle gap without another model call', async () => {
    const r = rig(); r.config.retrySec = 10;
    Object.assign(r.speech, { busy: true, playing: true, idleSinceMs: null, queueRevision: 7, backlogMs: 6000 });
    r.observe(); r.lane.tick();
    expect(r.request).toHaveBeenCalledTimes(1);
    expect(r.log).toHaveBeenCalledWith('commentary-request', expect.objectContaining({ duringPlayback: true, queueRevision: 7 }));
    r.advance(4000); r.answer(); await settle();
    expect(r.perform).not.toHaveBeenCalled(); expect(r.lane.facts()).toContain('候选等待音频空隙');
    r.observe(2, 'game.result', '另一个任务结束。'); r.lane.tick();
    expect(r.request).toHaveBeenCalledTimes(1);
    r.advance(1000); Object.assign(r.speech, { busy: false, playing: false, idleSinceMs: 105000 }); r.lane.tick();
    expect(r.perform).not.toHaveBeenCalled();
    r.advance(2000); r.lane.tick(); await settle();
    expect(r.perform).toHaveBeenCalledWith('刚才 Jojo 提到了村口的马。', 1, [1]);
    expect(r.request).toHaveBeenCalledTimes(1);
    expect(r.log).toHaveBeenCalledWith('commentary-submitted', expect.objectContaining({ duringPlayback: true, draftMs: 4000, heldMs: 3000 }));
  });
  it.each(['queued', 'music', 'long-speech', 'missing-revision'])('does not prefetch for %s', kind => {
    const r = rig();
    Object.assign(r.speech, { busy: true, playing: true, idleSinceMs: null, queueRevision: 7, backlogMs: 5000 });
    if (kind === 'queued') r.speech.playing = false;
    if (kind === 'music') r.speech.musicPlaying = true;
    if (kind === 'long-speech') r.speech.backlogMs = 60000;
    if (kind === 'missing-revision') delete r.speech.queueRevision;
    r.observe(); r.lane.tick(); expect(r.request).not.toHaveBeenCalled();
    if (kind === 'long-speech') {
      r.speech.backlogMs = 6000; r.lane.tick(); expect(r.request).toHaveBeenCalledTimes(1);
    }
  });
  it.each(['foreground', 'new-chat', 'pause', 'stop', 'disabled', 'revision', 'expired', 'changed-fact', 'format', 'heartbeat'])(
    'never submits a prefetched candidate after %s', async reason => {
      const r = rig(); Object.assign(r.speech, { busy: true, playing: true, idleSinceMs: null, queueRevision: 7 });
      r.observe(); r.lane.tick(); r.answer(); await settle();
      expect(r.perform).not.toHaveBeenCalled();
      if (reason === 'foreground') r.lane.foregroundSpeech('主线程已经接话。');
      if (reason === 'new-chat') r.observe(2, 'game.chat', '有人向主播提问。');
      if (reason === 'pause') r.available.active = false;
      if (reason === 'stop') r.lane.stop();
      if (reason === 'disabled') r.config.enabled = false;
      if (reason === 'revision') r.speech.queueRevision = 8;
      if (reason === 'expired') r.advance(31000);
      if (reason === 'changed-fact') r.observe(2, 'game.snapshot', '现场发生变化。');
      if (reason === 'format') r.speech.textFormat = 'drama-3';
      Object.assign(r.speech, { busy: false, playing: false, idleSinceMs: 100000 });
      r.advance(3000);
      if (reason === 'heartbeat') r.speech.observedAtMs -= 6000;
      r.lane.tick(); await settle(); expect(r.perform).not.toHaveBeenCalled();
    });
  it('finishes a playback-time draft after natural audio end and makes at most one prefetch request per revision', async () => {
    const r = rig(); Object.assign(r.speech, { busy: true, playing: true, idleSinceMs: null, queueRevision: 7 });
    r.observe(); r.lane.tick(); r.advance(2000);
    Object.assign(r.speech, { busy: false, playing: false, idleSinceMs: 102000 });
    r.advance(2000); r.answer(); await settle();
    expect(r.perform).toHaveBeenCalledTimes(1);
    Object.assign(r.speech, { busy: true, playing: true, idleSinceMs: null });
    r.observe(2, 'game.result', '又有新材料。'); r.advance(3000); r.lane.tick();
    expect(r.request).toHaveBeenCalledTimes(1);
    r.speech.queueRevision = 8; r.lane.tick(); expect(r.request).toHaveBeenCalledTimes(2);
  });
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
    if (reason === "cited-replaced") r.observe(2, 'game.snapshot', '刚才那条读数已经发生变化。');
    if (reason === "old-result") r.advance(31_000);
    r.answer(); await settle(); expect(r.perform).not.toHaveBeenCalled();
    expect(r.lane.facts()).toContain("stale");
  });
  it('does not cancel a pending draft for system chat transport or outgoing echoes', async () => {
    const r = rig(); r.observe(); r.lane.tick();
    r.lane.observe({ cursor: 2, ts: new Date(100000).toISOString(), source: 'game', type: 'game.chat',
      origin: 'external', text: 'Room state: five enemies.', meta: { channel: 'system' } });
    r.lane.observe({ cursor: 3, ts: new Date(100000).toISOString(), source: 'game', type: 'game.chat',
      origin: 'external', text: 'Our sent message echo.', meta: { outgoing: true } });
    r.answer(); await settle();
    expect(r.perform).toHaveBeenCalledTimes(1);
  });
  it('keeps unchanged telemetry eligible while preserving the original cited clock', async () => {
    const r = rig(); r.observe(); r.lane.tick(); r.advance(3000); r.observe(2);
    r.answer(); await settle();
    expect(r.perform).toHaveBeenCalledWith('刚才 Jojo 提到了村口的马。', 1, [1]);
    const expired = rig(); expired.observe(); expired.lane.tick(); expired.advance(31000); expired.observe(2);
    expired.answer(); await settle();
    expect(expired.perform).not.toHaveBeenCalled();
  });
  it('retains distinct server outcomes while drafting without refreshing their original clock', async () => {
    const r = rig(); r.observe(1, 'game.event', 'Task A completed.'); r.lane.tick();
    r.advance(3000); r.observe(2, 'game.event', 'Task B started.');
    r.answer('刚才完成了任务 A。'); await settle();
    expect(r.perform).toHaveBeenCalledWith('刚才完成了任务 A。', 1, [1]);
    const expired = rig(); expired.observe(1, 'game.event', 'Task A completed.'); expired.lane.tick();
    expired.advance(31000); expired.observe(2, 'game.event', 'Task B started.'); expired.answer(); await settle();
    expect(expired.perform).not.toHaveBeenCalled();
  });
  it('bounds the evidence task and excludes hidden receipt/config metadata while retaining attribution', () => {
    const r = rig();
    r.lane.observe({cursor:1, ts:new Date(100000).toISOString(),source:'game',type:'game.event',origin:'external',
      senderKey:'server',text:'Task A completed.', meta:{channel:'system',outgoing:false,
        receipt:'x'.repeat(100000), config:{password:'private-fixture'}, arbitrary:'hidden'}});
    r.lane.tick(); const brief = r.request.mock.calls[0][0];
    expect(brief.length).toBeLessThan(4000); expect(brief).toContain('"senderKey":"server"');
    expect(brief).toContain('"channel":"system"'); expect(brief).toContain('"truncated":true');
    expect(brief).not.toContain('private-fixture'); expect(brief).not.toContain('"receipt"');
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

it('the controller drafts during real speech playback and hands the ready line over only after the same audio revision drains', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({loop:{running:true,paused:false}}));
  const response = pending<{text:string}>(), request = vi.fn(() => response.promise), speak = vi.fn(async () => ({accepted:true,status:'queued',id:'next-voice'}));
  const event = {cursor:51,ts:new Date().toISOString(),source:'game',type:'game.result',origin:'external',text:'正在行走的任务通过了路口。'};
  let latest = 50;
  const stage:any = {audioOwner:'desktop',audioRevision:9,voice:{configured:true},foreground:'playing-voice',
    actions:[{id:'playing-voice',kind:'speech',status:'playing',updatedAt:100000,evidence:{audioTimeMs:0,durationMs:11000}}]};
  const controller = new CommentaryController({config:()=>({enabled:true,port:0,dataDir:'',avatars:[],speechObservationMaxAgeSeconds:15,
    commentary:{enabled:true,sources:'game',idleSec:1,retrySec:10,factAgeSec:30,hostStatusUrl:'http://127.0.0.1/status'}}),
    state:async()=>stage,speak});
  controller.start({store:{latestCursor:()=>latest,get:(cursor:number)=>cursor===51?event:null},cognition:{request},log:{emit:vi.fn(),warn:vi.fn()}} as never);
  try {
    latest=51; await vi.advanceTimersByTimeAsync(2100); expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000); expect(request).toHaveBeenCalledTimes(1);
    response.resolve({text:JSON.stringify({script:'刚才经过了路口。',evidence:[51],kind:'observation'})});
    await vi.advanceTimersByTimeAsync(0); expect(speak).not.toHaveBeenCalled();
    stage.foreground=null; await vi.advanceTimersByTimeAsync(2000);
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ifIdleRevision:9,observed_at:event.ts}),expect.any(String));
    expect(request).toHaveBeenCalledTimes(1);
  } finally {controller.stop();}
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
  const speak = vi.fn(async (args: Record<string, unknown>) => {
    checkSpeechFreshness(args, 15);
    return { accepted: true, status: "queued", id: "real-ledger-action" };
  });
  const stage = { audioOwner: "browser", audioRevision: 3, voice: { configured: true, textFormat }, foreground: null };
  const controller = new CommentaryController({ config: () => ({ enabled: true, port: 0, dataDir: "", avatars: [], speechObservationMaxAgeSeconds: 15, commentary: {
    enabled: true, sources: "game", hostStatusUrl: "http://127.0.0.1/status", idleSec: 1, retrySec: 1, factAgeSec: 30 } }),
    state: async () => stage, speak });
  try {
    controller.start({ store: { latestCursor: () => latest, get }, cognition: { request }, log: { emit: vi.fn(), warn: vi.fn() } } as never);
    events.set(51, { cursor: 51, source: "game", type: "game.result", origin: "external", ts: new Date().toISOString(), text: "任务 a 终态完成，位移 4 格。" }); latest = 51;
    await vi.advanceTimersByTimeAsync(2100);
    expect(get.mock.calls.map(([cursor]) => cursor)).toEqual([51, 51]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({ tools: [], hint: { rounds: 1 } });
    expect(request.mock.calls[0][0].brief.startsWith(SPEECH_DRAFT_HEADER + "\n")).toBe(true);
    expect(request.mock.calls[0][0].brief).toContain('当前语音契约 ' + textFormat);
    expect(speak).toHaveBeenCalledWith({ action: "speak", text: textFormat === "drama-3" ? "[轻快] 刚才走过了一段路。" : "刚才走过了一段路。", ifIdleRevision: 3, observed_at: new Date(100_000).toISOString() }, expect.stringMatching(/^avatar-commentary-/));
  } finally { controller.stop(); }
});

function controllerRig() {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({loop:{running:true,paused:false}})));
  let latest = 50;
  const events = new Map<number, any>(), log = vi.fn();
  const response = pending<{text:string}>(), request = vi.fn(() => response.promise);
  const speak = vi.fn(async (args:Record<string,unknown>) => {
    checkSpeechFreshness(args,15);
    return {accepted:true,status:'queued',id:'speech-with-evidence'};
  });
  const controller = new CommentaryController({config:()=>({enabled:true,port:0,dataDir:'',avatars:[],speechObservationMaxAgeSeconds:15,
    commentary:{enabled:true,sources:'game',idleSec:1,retrySec:1,factAgeSec:30,hostStatusUrl:'http://127.0.0.1/status'}}),
    state:async()=>({audioOwner:'desktop',audioRevision:3,voice:{configured:true},foreground:null}),speak});
  controller.start({store:{latestCursor:()=>latest,get:(cursor:number)=>events.get(cursor)},cognition:{request},log:{emit:log,warn:vi.fn()}} as never);
  return {controller,events,request,speak,log,
    event(cursor:number,ts:string,type='game.result'){latest=cursor;events.set(cursor,{cursor,ts,type,source:'game',origin:'external',text:'任务实际发生了变化。'});},
    answer(evidence:number[],kind='observation',timeframe?:string){response.resolve({text:JSON.stringify({script:'刚才看到了新的变化。',evidence,kind,...(timeframe?{timeframe}:{})})});}};
}

it('uses the oldest original cited event time, independent of draft completion time',async()=>{
  const r=controllerRig();
  try{
    r.event(51,'1970-01-01T00:01:31.000Z','game.result');
    r.event(52,'1970-01-01T00:01:38.000Z','game.snapshot');
    await vi.advanceTimersByTimeAsync(2100);
    r.answer([52,51]);await vi.advanceTimersByTimeAsync(0);
    expect(r.speak).toHaveBeenCalledWith(expect.objectContaining({observed_at:'1970-01-01T00:01:31.000Z'}),expect.any(String));
  }finally{r.controller.stop();}
});

it('can recount a dated event beyond the live-state window without replacing its clock',async()=>{
  const r=controllerRig();
  try{
    r.event(51,'1970-01-01T00:01:20.000Z');
    await vi.advanceTimersByTimeAsync(2100);
    expect(r.request).toHaveBeenCalledTimes(1);
    r.answer([51],'observation','recent');await vi.advanceTimersByTimeAsync(0);
    expect(r.speak).toHaveBeenCalledWith(expect.objectContaining({observed_at:'1970-01-01T00:01:20.000Z',evidence_mode:'recent'}),expect.any(String));
  }finally{r.controller.stop();}
});

it('discards a draft that outlives the speech window even when commentary allows longer',async()=>{
  const r=controllerRig();
  try{
    r.event(51,new Date().toISOString());await vi.advanceTimersByTimeAsync(2100);
    expect(r.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(16000);r.answer([51]);await vi.advanceTimersByTimeAsync(0);
    expect(r.speak).not.toHaveBeenCalled();expect(r.log.mock.calls.some(([,event])=>event==='commentary-stale')).toBe(true);
  }finally{r.controller.stop();}
});

it.each(['missing-cited-event','uncited-thought'])('does not synthesize a clock for %s under a source-time policy',async reason=>{
  const r=controllerRig();
  try{
    r.event(51,new Date().toISOString());await vi.advanceTimersByTimeAsync(2100);
    if(reason==='missing-cited-event')r.events.delete(51);
    r.answer(reason==='missing-cited-event'?[51]:[],reason==='uncited-thought'?'thought':'observation');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.speak).not.toHaveBeenCalled();
    expect(r.log.mock.calls.some(([,event])=>event==='commentary-stale')).toBe(true);
  }finally{r.controller.stop();}
});
