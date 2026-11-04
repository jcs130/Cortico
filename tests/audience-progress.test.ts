import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudienceProgressSpeaker, AUDIENCE_PROGRESS_DEFAULTS, audienceSpeechQuestion, normalizeAudienceProgress } from '../src/core/audience-progress.ts';
import { AvatarStageServer } from '../src/server.ts';
import { AvatarStageClient } from '../src/sdk.ts';

const packet = (at: number, patch = {}) => ({ schema: 'audience-progress/v1', id: 'review-1',
  at: new Date(at).toISOString(), expiresAt: new Date(at + 60_000).toISOString(), phase: 'reviewing',
  topic: '绕过障碍的路线', text: '复盘已提交，等待核对结果。', speech: '我想核对一下绕过障碍的路线。', ...patch });
it('strictly projects only the explicit public fields, rejecting secrets, stale clocks and reasoning as input', () => {
  const now = Date.now();
  const clean = normalizeAudienceProgress({ ...packet(now), reasoning: 'private', memory: 'private' }, now);
  expect(JSON.stringify(clean)).not.toContain('private');
  expect(normalizeAudienceProgress({ reasoning: 'private' }, now)).toBeNull();
  expect(normalizeAudienceProgress(packet(now, { text: '/login private-password' }), now)).toBeNull();
  expect(normalizeAudienceProgress(packet(now - 61_000), now)).toBeNull();
  expect(normalizeAudienceProgress(packet(now + 5000), now)).toBeNull();
});
const choice = (value = 'speak') => ({ answers: { broadcast: { choice: value,
  probabilities: Object.fromEntries(['speak', 'display', 'skip'].map(k => [k, k === value ? .8 : .1])) } },
  model: 'local-decision', latency_ms: 25, usage: { input_tokens: 271, output_tokens: 0 } });
function rig(hasDecision = true) {
  let now = Date.now(), state: any = { audioOwner: 'page', foreground: null, audioRevision: 8, voice: { configured: true } };
  const config = { ...AUDIENCE_PROGRESS_DEFAULTS, enabled: true, speechEnabled: true };
  const speak = vi.fn(async (..._args: unknown[]) => ({ accepted: true, status: 'queued', id: 'audio-1' }));
  const log = vi.fn();
  const decide = vi.fn(async (..._args: any[]) => choice());
  const speaker = new AudienceProgressSpeaker({ config: () => config, state: () => state, now: () => now, speak, log,
    decide: hasDecision ? { request: decide } : undefined });
  return { speaker, speak, decide, log, config, now: () => now, advance: (ms: number) => { now += ms; }, state: (v: any) => { state = v; } };
}
it('submits at most once with the observed idle revision; admission is not playback', async () => {
  const r = rig(); r.speaker.observe(packet(r.now())); r.speaker.tick(); expect(r.speak).not.toHaveBeenCalled();
  r.advance(3500); r.speaker.tick(); r.speaker.tick(); await vi.waitFor(() => expect(r.speak).toHaveBeenCalledTimes(1));
  expect(r.speak).toHaveBeenCalledTimes(1); expect(r.speak.mock.calls[0][1]).toBe(8);
  expect(r.log).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'submitted', status: 'queued' }));
});
it.each(['busy', 'paused', 'muted', 'stale', 'cancelled'])('does not queue or synthesize %s progress', async kind => {
  const r = rig(); r.speaker.observe(packet(r.now())); r.advance(4000);
  if (kind === 'busy') r.state({ audioOwner: 'page', foreground: 'song', audioRevision: 9, voice: { configured: true } });
  if (kind === 'paused') r.state(null);
  if (kind === 'muted') r.config.speechEnabled = false;
  if (kind === 'stale') r.advance(20_000);
  if (kind === 'cancelled') r.speaker.observe(packet(r.now(), { phase: 'cancelled', speech: '' }));
  r.speaker.tick(); await Promise.resolve(); expect(r.speak).not.toHaveBeenCalled(); expect(r.decide).not.toHaveBeenCalled();
  r.state({ audioOwner: 'page', audioRevision: 10, voice: { configured: true } });
  r.speaker.tick(); expect(r.speak).not.toHaveBeenCalled();
});
it('completion replaces old queued progress and cannot be overwritten by delayed accepted status', async () => {
  const r = rig(); r.speaker.observe(packet(r.now()));
  r.speaker.observe(packet(r.now(), { phase: 'completed', speech: '建议已整理好，仍需现场核验。' }));
  r.speaker.observe(packet(r.now(), { phase: 'accepted' })); r.advance(4000); r.speaker.tick();
  await vi.waitFor(() => expect(r.speak).toHaveBeenCalledTimes(1));
  expect(r.speak.mock.calls[0][0]).toBe('建议已整理好，仍需现场核验。');
  r.speaker.stop(); r.advance(60_000); r.speaker.observe(packet(r.now(), { id: 'new' })); r.speaker.tick();
  expect(r.speak).toHaveBeenCalledTimes(1);
});
it.each(['display', 'skip'])('uses System One probabilities to choose %s without speech', async selection => {
  const r = rig(); r.decide.mockResolvedValue(choice(selection)); r.speaker.observe(packet(r.now()));
  r.advance(4000); r.speaker.tick();
  await vi.waitFor(() => expect(r.log).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'selected', choice: selection })));
  expect(r.speak).not.toHaveBeenCalled(); r.speaker.tick(); expect(r.decide).toHaveBeenCalledTimes(1);
});
it.each(['missing', 'error', 'bad-probabilities'])('keeps text without speculative speech on %s decision', async kind => {
  const r = rig(kind !== 'missing');
  if (kind === 'error') r.decide.mockRejectedValue(Error('provider private detail'));
  if (kind === 'bad-probabilities') r.decide.mockResolvedValue({ ...choice(), answers: {
    broadcast: { choice: 'speak', probabilities: { speak: .1, display: .8, skip: .1 } } } });
  r.speaker.observe(packet(r.now())); r.advance(4000); r.speaker.tick();
  await vi.waitFor(() => expect(r.log).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'display' })));
  expect(r.speak).not.toHaveBeenCalled(); expect(JSON.stringify(r.log.mock.calls)).not.toContain('private detail');
});
it.each(['phase', 'busy', 'revision', 'speech', 'disabled', 'stopped', 'expiry'])('rejects a delayed speak selection after %s changes', async kind => {
  const r = rig(); let done!: (value: ReturnType<typeof choice>) => void;
  r.decide.mockImplementation(() => new Promise(resolve => { done = resolve; }));
  r.speaker.observe(packet(r.now())); r.advance(4000); r.speaker.tick(); expect(r.decide).toHaveBeenCalledTimes(1);
  if (kind === 'phase') r.speaker.observe(packet(r.now(), { phase: 'organizing', speech: '' }));
  if (kind === 'busy') r.state({ audioOwner: 'page', foreground: 'song', audioRevision: 8, voice: { configured: true } });
  if (kind === 'revision') r.state({ audioOwner: 'page', foreground: null, audioRevision: 9, voice: { configured: true } });
  if (kind === 'speech') r.speaker.noteSpeech('我先回应一下刚来的朋友。');
  if (kind === 'disabled') r.config.speechEnabled = false;
  if (kind === 'stopped') r.speaker.stop();
  if (kind === 'expiry') r.advance(20_000);
  done(choice()); await vi.waitFor(() => expect(r.log).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'display' })));
  expect(r.speak).not.toHaveBeenCalled();
});
it('deadline releases an ignored-abort request and its late answer never speaks', async () => {
  vi.useFakeTimers();
  try {
    const r = rig(); r.config.timeoutMs = 100;
    let done!: (value: ReturnType<typeof choice>) => void;
    r.decide.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    r.speaker.observe(packet(r.now())); r.advance(4000); r.speaker.tick();
    await vi.advanceTimersByTimeAsync(101);
    expect(r.decide.mock.calls[0][1].signal.aborted).toBe(true);
    r.speaker.observe(packet(r.now(), { phase: 'completed' })); r.advance(4000); r.speaker.tick();
    await vi.advanceTimersByTimeAsync(1); expect(r.speak).toHaveBeenCalledTimes(1);
    done(choice()); await vi.advanceTimersByTimeAsync(1); expect(r.speak).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
it('projects compact public inputs and routes through the configured System One provider', async () => {
  const r = rig(); r.config.provider = 'lan-system-one';
  r.speaker.noteSpeech('刚才到达了路口。');
  r.speaker.observeEvent({ source: 'mymc', type: 'task.completed', origin: 'external', ts: new Date(r.now()).toISOString(),
    text: 'private event body', memory: 'not for broadcast' } as any);
  r.speaker.observe(packet(r.now())); r.advance(4000); r.speaker.tick();
  const [input, options] = r.decide.mock.calls[0];
  expect(input.state.signals).toEqual([{ source: 'mymc', type: 'task.completed' }]);
  expect(input.state.recentSubmitted[0].text).toBe('刚才到达了路口。');
  expect(JSON.stringify(input)).not.toMatch(/private|not for broadcast/);
  expect(options).toMatchObject({ provider: 'lan-system-one', timeoutMs: 1200 });
  const max = audienceSpeechQuestion(packet(r.now()) as any, r.now(), [], [{ text: 'x'.repeat(10_000), at: r.now() }]);
  expect(JSON.stringify(max).length).toBeLessThan(1400);
  await vi.waitFor(() => expect(r.speak).toHaveBeenCalled());
});
it('SDK and HTTP preserve the status card without creating actions or model calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audience-progress-'));
  const events: any[] = [];
  const server = new AvatarStageServer({ port: 0, dataDir: directory, avatars: [] }, e => events.push(e));
  let client: AvatarStageClient | undefined;
  try {
    await server.start(); client = new AvatarStageClient(server.url); await client.start();
    const now = Date.now();
    expect(await client.publishAudienceProgress(packet(now))).toMatchObject({ accepted: true });
    expect((await fetch(server.url + '/api/state').then(r => r.json())).audienceProgress).toMatchObject({ topic: '绕过障碍的路线' });
    expect(events.filter(e => e.type === 'audience.progress')).toHaveLength(1);
    expect(server.stage.ledger.history(10)).toHaveLength(0);
    expect(await client.publishAudienceProgress(packet(now, { phase: 'completed' }))).toMatchObject({ accepted: true });
    expect(await client.publishAudienceProgress(packet(now, { phase: 'accepted' }))).toMatchObject({ accepted: false });
    const cross = await fetch(server.url + '/api/audience-progress', { method: 'POST', headers: { origin: 'http://untrusted.invalid' }, body: JSON.stringify(packet(now)) });
    expect(cross.status).toBe(403);
  } finally { await client?.stop(); await server.stop(); await rm(directory, { recursive: true, force: true }); }
});
