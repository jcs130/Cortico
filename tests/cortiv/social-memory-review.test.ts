import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialMemoryReview, SOCIAL_REVIEW_LIMITS, isRoomEnded, verifySocialReviewProof,
  type SocialReviewEntry, type SocialReviewHistory, type SocialReviewPage } from '../../bots/cortiv/persona/social-memory-review.ts';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { DREAM_DEFAULTS } from '../../bots/cortiv/persona/dream-context.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';
import { nullLogger } from '../../src/core/util.ts';
import type { EventEnvelope } from '../../src/core/types.ts';
import type { FixtureForkOptions } from '../core/fixture-protocol.ts';

const dirs: string[] = [], personas: CortiV[] = [];
afterEach(() => {
  for (const p of personas.splice(0)) p.stopRhythm();
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'social-memory-')); dirs.push(dir); return dir; };
const at = '2026-01-02T21:00:00Z';
const audience = (cursor = 1): Extract<SocialReviewEntry, { kind: 'audience' }> => ({ kind: 'audience', at,
  source: 'stream', senderKey: '123456', uname: '访客', cursor, type: 'stream.danmaku', text: '我明天还来看你，记得我吗？' });
const event = (patch: Partial<EventEnvelope> = {}): EventEnvelope => ({ cursor: 1, ts: at, origin: 'external',
  source: 'stream', type: 'stream.danmaku', senderKey: '123456', meta: { uname: '访客', body: audience().text },
  text: audience().text, ...patch });
const history = (entries: SocialReviewEntry[] = [audience()]): SocialReviewHistory => ({ auditId: 'audited-evening', cutoffAt: at, entries });
const proof = (p: SocialReviewPage, files: string[] = []): string => JSON.stringify({ schemaVersion: 1,
  materialDigest: p.materialDigest, fromSeq: p.fromSeq, toSeq: p.toSeq, cutoffAt: p.cutoffAt,
  decision: files.length ? 'retained' : 'no_durable_facts', files, summary: '核对完本页，只有原文支持的事实才记入。' });
const state = async (p: CortiV) => p.console().invoke!('dream', 'state', []) as Promise<{
  lastOutcome: { status: string } | null; social: { pendingEntries: number; committedSeq: number; scheduled: boolean } }>;
const review = (p: CortiV, input: unknown = {}) => p.console().invoke!('dream', 'review', [input]);
async function completePage(options: FixtureForkOptions, dir: string, files: string[] = []): Promise<string> {
  const untilSeq = Number(/本页 \d+\.\.(\d+)/.exec(String(options.messages[0].content))?.[1]);
  const page = new SocialMemoryReview(dir).nextPage(untilSeq)!;
  const ctx = { role: 'social-memory', log: nullLogger() };
  const write = options.tools!.find(t => t.name === 'write_file')!;
  for (const file of files) {
    if (existsSync(join(dir, file))) await options.tools!.find(t => t.name === 'read_file')!.handler({ path: file }, ctx);
    await write.handler({ path: file, content: '访客曾在夜里来聊天，说了明天见；受理回执不能证明播完。' }, ctx);
  }
  if (existsSync(join(dir, page.proofPath))) await options.tools!.find(t => t.name === 'read_file')!.handler({ path: page.proofPath }, ctx);
  await write.handler({ path: page.proofPath, content: proof(page, files) }, ctx);
  return '本页已核对。';
}

describe('durable audience evidence pages', () => {
  it('retains one delivered message and native failures across restart without enrolling a profile', () => {
    const dir = temp(), r = new SocialMemoryReview(dir);
    r.observe([event({ contextDelivery: 'archive-only' }), event(), event(), event({ origin: 'internal', cursor: 2 })]);
    r.noteSpeech('speech', { script: '明天见' }, { text: 'Rejected.', failed: true }, at);
    const restored = new SocialMemoryReview(dir), p = restored.nextPage()!;
    expect(p.entries).toHaveLength(2);
    expect(p.entries[1].entry).toMatchObject({ kind: 'speech', failed: true, receipt: 'Rejected.' });
    expect(p.profilePaths).toEqual(['viewers/stream/123456.md']);
    expect(existsSync(join(dir, p.profilePaths[0]))).toBe(false);
  });

  it('archives paid audience messages as conversation without treating gifts or arrivals as chat', () => {
    const journal = new SocialMemoryReview(temp());
    journal.observe([event({ cursor: 1, type: 'stream.superchat', text: '想听一首新歌', meta: { uname: '观众', message: '想听一首新歌' } }),
      event({ cursor: 2, type: 'stream.gift' }), event({ cursor: 3, type: 'stream.enter' })]);
    const page = journal.nextPage()!;
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].entry).toMatchObject({ kind: 'audience', type: 'stream.superchat', text: '想听一首新歌' });
  });

  it('reconstructs a cursor saved after the journal append but before state persistence', () => {
    const dir = temp(), r = new SocialMemoryReview(dir); r.observe([event()]);
    const path = join(dir, '.social-review/state.json'), s = JSON.parse(readFileSync(path, 'utf8'));
    s.lastCursors = {}; writeFileSync(path, JSON.stringify(s));
    const restored = new SocialMemoryReview(dir); restored.observe([event()]);
    expect(restored.stateInfo().pendingEntries).toBe(1);
  });

  it('imports only bounded audited evidence and deduplicates both retry and previously delivered cursors', () => {
    const dir = temp(), r = new SocialMemoryReview(dir); r.observe([event()]);
    expect(r.importHistory(history([audience(), audience(2)]), () => true).added).toBe(1);
    expect(r.importHistory(history([audience(), audience(2)]), () => true).added).toBe(0);
    expect(() => r.importHistory(history([audience(3)]), () => true)).toThrow('auditId');
    expect(r.stateInfo().pendingEntries).toBe(2);
    expect(() => r.importHistory(history([{ ...audience(), senderKey: '../escape' }]), () => true)).toThrow();
    expect(() => r.importHistory(history([{ kind: 'speech', at, tool: 'not_native', script: '你好', receipt: 'OK', failed: false }]), () => false)).toThrow('native speak');
    expect(() => r.importHistory({ ...history(), cutoffAt: '2026-01-01T00:00:00Z' }, () => true)).toThrow('截止');
    const oversized = { ...history(Array.from({ length: 40 }, (_, i) => ({ ...audience(i), text: '中'.repeat(1000) }))), auditId: 'too-big' };
    expect(JSON.stringify(oversized).length).toBeLessThan(SOCIAL_REVIEW_LIMITS.importChars);
    expect(() => r.importHistory(oversized, () => true)).toThrow('上限');
  });

  it('keeps pending pages finite while new arrivals remain after the captured cutoff', () => {
    const r = new SocialMemoryReview(temp());
    r.importHistory(history(Array.from({ length: SOCIAL_REVIEW_LIMITS.pageEntries + 3 }, (_, i) => audience(i))), () => true);
    const p = r.nextPage()!;
    expect(p.entries).toHaveLength(SOCIAL_REVIEW_LIMITS.pageEntries);
    r.acknowledge(p); const tail = r.nextPage()!;
    expect(tail.entries).toHaveLength(3);
    r.observe([event({ cursor: 100 })]); r.acknowledge(tail);
    expect(r.nextPage(tail.toSeq)).toBeNull();
    expect(r.nextPage()!.entries[0].entry).toMatchObject({ cursor: 100 });
  });

  it('does not create partner aliases from display names and requires audited stable ids for an existing partner file', () => {
    const dir = temp(), r = new SocialMemoryReview(dir); writeFileSync(join(dir, 'PHANT.md'), '既有伙伴档案');
    r.observe([event({ meta: { uname: '凡特Phant' } })]);
    expect(r.nextPage()!.profilePaths).toEqual(['viewers/stream/123456.md']);
    r.importHistory({ ...history([audience(2)]), profileAliases: [{ source: 'stream', senderKey: '123456', path: 'PHANT.md' }] }, () => true);
    expect(new SocialMemoryReview(dir).nextPage()!.profilePaths).toEqual(['PHANT.md']);
    expect(() => r.importHistory({ ...history(), auditId: 'bad-alias', profileAliases: [{ source: 'stream', senderKey: '999', path: 'PHANT.md' }] }, () => true)).toThrow('可信');
  });

  it('acknowledges only a matching proof from this task and actual durable file writes', () => {
    const r = new SocialMemoryReview(temp()); r.observe([event()]); const p = r.nextPage()!;
    expect(verifySocialReviewProof(p, proof(p), () => false)).toBe(false);
    expect(verifySocialReviewProof(p, proof(p), path => path === p.proofPath)).toBe(true);
    expect(verifySocialReviewProof(p, proof(p, p.profilePaths), path => path === p.proofPath)).toBe(false);
    expect(verifySocialReviewProof(p, proof(p, ['sessions/_recent.md']), () => true)).toBe(false);
    expect(verifySocialReviewProof(p, proof({ ...p, materialDigest: 'wrong' }), () => true)).toBe(false);
  });

  it('uses only structured external room edges, without interpreting chat text', () => {
    const metadata = { liveRoomState: { schemaVersion: 1, living: false, via: 'poll' } };
    expect(isRoomEnded(event({ type: 'stream.room', meta: metadata }))).toBe(true);
    expect(isRoomEnded(event({ type: 'stream.room', text: '下播了' }))).toBe(false);
    expect(isRoomEnded(event({ meta: metadata }))).toBe(false);
    expect(isRoomEnded(event({ type: 'stream.room', origin: 'internal', meta: metadata }))).toBe(false);
    expect(isRoomEnded(event({ type: 'stream.room', meta: { liveRoomState: { schemaVersion: 1, living: false, via: 'chat' } } }))).toBe(false);
  });
});

describe('Persona social review with real Memory tools', () => {
  function rig(fork: (options: FixtureForkOptions, dir: string) => Promise<string>) {
    const dir = temp(); const p = new CortiV({ memoryDir: dir, dream: () => ({ ...DREAM_DEFAULTS, onHandoff: false }) }); personas.push(p);
    p.attach(makeFakeHarnessApi({ toolsTagged: tag => new Set(tag === 'speak' ? ['speech'] : []), spawnFork: options => fork(options, dir) }));
    return { p, dir };
  }

  it('manual review retains an audited one-message visitor with a verified profile and proof, without writing game notes', async () => {
    const { p, dir } = rig((options, root) => completePage(options, root, ['viewers/stream/123456.md']));
    const result = await review(p, { history: history(), reason: '补核昨晚' });
    expect(result).toMatchObject({ accepted: true, imported: { added: 1 } });
    await vi.waitFor(async () => expect((await state(p)).social.scheduled).toBe(false), { timeout: 10_000 });
    expect((await state(p)).social.pendingEntries).toBe(0);
    expect(readFileSync(join(dir, 'viewers/stream/123456.md'), 'utf8')).toContain('明天见');
    expect(existsSync(join(dir, 'sessions/_recent.md'))).toBe(false);
    expect((await state(p)).lastOutcome?.status).toBe('completed');
  });

  it('a spoken assertion or unverified no-facts conclusion does not advance the durable watermark', async () => {
    const { p, dir } = rig(async options => {
      const denied = await options.tools!.find(t => t.name === 'write_file')!.handler(
        { path: 'sessions/_recent.md', content: '我记得他了' }, { role: 'social-memory', log: nullLogger() });
      expect(denied).toMatchObject({ failed: true });
      return '没有值得记的内容，已经记住了。';
    });
    await review(p, { history: history() });
    await vi.waitFor(async () => expect((await state(p)).lastOutcome?.status).toBe('failed'));
    expect(new SocialMemoryReview(dir).stateInfo().pendingEntries).toBe(1);
  });

  it('allows an explicit no-durable-facts proof without forcing a visitor profile', async () => {
    const { p, dir } = rig((options, root) => completePage(options, root));
    await review(p, { history: history() });
    await vi.waitFor(async () => expect((await state(p)).social.pendingEntries).toBe(0));
    expect(existsSync(join(dir, 'viewers/stream/123456.md'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'social/reviews/1-1.json'), 'utf8')).decision).toBe('no_durable_facts');
  });

  it('retains an interrupted page across stop and restart; late Memory writes are rejected', async () => {
    vi.useFakeTimers(); let captured!: FixtureForkOptions;
    const { p, dir } = rig(async options => { captured = options; return new Promise<string>(() => {}); });
    await review(p, { history: history() }); await vi.advanceTimersByTimeAsync(0); p.stopRhythm(); await vi.advanceTimersByTimeAsync(0);
    await expect(captured.tools!.find(t => t.name === 'write_file')!.handler(
      { path: 'viewers/stream/123456.md', content: '迟到' }, { role: 'social-memory', log: nullLogger() })).rejects.toThrow();
    expect(new SocialMemoryReview(dir).stateInfo().pendingEntries).toBe(1);
    expect((await state(p)).lastOutcome?.status).toBe('cancelled');
  });

  it('does not acknowledge a generation failure even after a real profile write', async () => {
    const { p, dir } = rig(async options => {
      await options.tools!.find(t => t.name === 'write_file')!.handler(
        { path: 'viewers/stream/123456.md', content: '已经写入的部分事实' }, { role: 'social-memory', log: nullLogger() });
      throw new Error('generation disconnected');
    });
    await review(p, { history: history() });
    await vi.waitFor(async () => expect((await state(p)).lastOutcome?.status).toBe('failed'));
    expect(readFileSync(join(dir, 'viewers/stream/123456.md'), 'utf8')).toBe('已经写入的部分事实');
    expect(new SocialMemoryReview(dir).stateInfo().committedSeq).toBe(0);
  });

  it('processes several finite pages without acknowledging arrivals after the queued cutoff', async () => {
    let forks = 0;
    const { p } = rig(async (options, root) => {
      const result = await completePage(options, root); forks++;
      if (forks === 1) await p.onDelivery({ events: [event({ cursor: 100 })] });
      return result;
    });
    await review(p, { history: history(Array.from({ length: SOCIAL_REVIEW_LIMITS.pageEntries + 3 }, (_, i) => audience(i))) });
    // Both pages wait for real Memory writes and Git checkpoints, not just fork completion.
    await vi.waitFor(async () => expect((await state(p)).social.scheduled).toBe(false), { timeout: 10_000 });
    expect(forks).toBe(2);
    expect((await state(p)).social).toMatchObject({ committedSeq: SOCIAL_REVIEW_LIMITS.pageEntries + 3, pendingEntries: 1 });
  });

  it('a sleep review includes audience evidence retained before the current foreground window', async () => {
    const calls: FixtureForkOptions[] = [], dir = temp();
    const p = new CortiV({ memoryDir: dir, dream: () => ({ ...DREAM_DEFAULTS, onHandoff: false }),
      sleepReview: () => ({ enabled: true, eventTypes: 'game.sleep' }) }); personas.push(p);
    p.attach(makeFakeHarnessApi({ toolsTagged: tag => new Set(tag === 'speak' ? ['speech'] : []),
      sessionInfo: id => ({ id, running: 0, snapshot: [{ role: 'user', content: '当前只剩新游戏日的场景。' }], estTokens: null, hardTokens: null }),
      spawnFork: async options => { calls.push(options); return options.id === 'social-memory' ? completePage(options, dir) : '(nothing)'; } }));
    await p.onDelivery({ events: [event()] });
    await p.onDelivery({ events: [event({ source: 'game', type: 'game.sleep', senderKey: undefined, cursor: 2,
      meta: { sleeping: true, world: 'local-world', gameDay: 10, timeOfDay: 14000 } })] });
    p.onToolOutcome({ role: 'main', tool: 'speech', args: { text: '让我回顾今天' }, outcome: { text: 'Accepted.' } });
    p.onBatchEnd();
    // The second fork starts after a real Memory write and its Git checkpoint finish.
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 10_000 });
    await vi.waitFor(async () => expect((await state(p)).social.pendingEntries).toBe(0), { timeout: 10_000 });
    expect(calls[0].messages.map(m => m.content).join('\n')).toContain(audience().text);
    expect(calls[0].messages.map(m => m.content).join('\n')).toContain('123456');
    expect(calls[1].id).toBe('dream');
  });

  it('uses a real room-ended fact to schedule review even when handoff dreaming is disabled', async () => {
    const { p } = rig((options, root) => completePage(options, root));
    await p.onDelivery({ events: [event()] });
    expect((await state(p)).social.scheduled).toBe(false);
    await p.onDelivery({ events: [event({ type: 'stream.room', cursor: 2,
      meta: { liveRoomState: { schemaVersion: 1, living: false, via: 'websocket' } } })] });
    await vi.waitFor(async () => expect((await state(p)).social.pendingEntries).toBe(0));
  });
});
