import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { FAST_FOREGROUND_DEFAULTS } from '../../bots/cortiv/persona/foreground-adviser.ts';
import { message } from '../../src/protocol/open-responses/context.ts';
import type { EventEnvelope, ModelSpec, World } from '../../src/core/types.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rig(extraWorlds: World[] = []) {
  const memoryDir = mkdtempSync(join(tmpdir(), 'adaptive-reasoning-')); dirs.push(memoryDir);
  const cfg = { ...FAST_FOREGROUND_DEFAULTS, enabled: true, endpoint: 'http://fixture/decision',
    reasoningEnabled: true, reasoningModel: 'local-model', minIntervalMs: 10000 };
  const requests: any[] = [];
  let choice = 'deliberate';
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ answers: {
      reading: { choice: 'connected', confidence: .98, probabilities: { focused: .02, connected: .98 } },
      reasoning: { choice, confidence: .96, probabilities: Object.fromEntries(['immediate', 'routine', 'deliberate']
        .map(key => [key, key === choice ? .96 : .02])) },
    } }));
  });
  const world: World = { id: 'game', start: async () => {}, stop: async () => {}, tools: () => [], envPromptVars: () => ({}),
    requestFacts: () => ({ text: 'Observed now: moving normally, destination not reached.', snapshotTypes: [],
      decision: { sampledAtMs: Date.now(), state: { health: 20, danger: null,
        action: { taskId: 7, progress: 'distance reduced from 120 to 100 blocks; no obstruction' },
        completed: false } }, parts: [
      { key: 'sample', text: `Observed ${new Date().toISOString()}` },
      { key: 'inventory', text: 'older inventory detail '.repeat(5000) },
      { key: 'queue', text: 'Task #7 executing, distance reduced from 120 to 100 blocks; no obstruction.' },
      { key: 'lastTask', text: 'Previous tool was accepted; not evidence that the task finished.' },
    ] }) };
  const records = [message('system', 'Environment contract'), message('user', 'Compare possible supports during this journey.')];
  const persona = new CortiV({ memoryDir, worlds: [world, ...extraWorlds], fastForeground: () => cfg });
  persona.attach({ ...makeFakeHarnessApi(), sessionInfo: id => ({ id, running: 0, snapshot: records, estTokens: null, hardTokens: null }) });
  const event: EventEnvelope = { source: 'game', origin: 'external', type: 'game.chat', cursor: 42,
    ts: new Date().toISOString(), text: 'During the journey, compare how to support the bridge.' };
  const spec: ModelSpec = { model: 'local-model', thinking: false, maxTokens: 6000, contextWindow: 262144 };
  const select = () => persona.requestReasoning({ sessionId: 'main', round: 1, spec, signal: new AbortController().signal });
  return { persona, cfg, records, requests, event, spec, select, choice: (value: string) => { choice = value; } };
}

describe('request-local reasoning fallback', () => {
  const context = (request: any) => {
    const instructions = request.questions.reasoning.instructions;
    return JSON.parse(instructions.slice(instructions.indexOf('{')));
  };
  it('retains actual music occupancy beyond the first two worlds and uses the configured deeper level', async () => {
    let audio = '[演出当前读数；观察 ' + new Date().toISOString() + ']\n正在播放歌曲「Example」；在播及排队约 90 秒';
    const world = (id: string, text: () => string): World => ({ id, start: async () => {}, stop: async () => {},
      tools: () => [], envPromptVars: () => ({}), requestFacts: () => ({ text: text(), snapshotTypes: [] }) });
    const r = rig([world('other', () => 'A different current observation'), world('vtuber', () => audio)]);
    r.cfg.minIntervalMs = 0; r.cfg.reasoningDeliberateEffort = 'xhigh';
    await r.persona.beforeDecision({ events: [r.event], messages: r.records });
    expect(await r.select()).toEqual({ thinking: true, reasoningEffort: 'xhigh' });
    expect(context(r.requests[0]).performance.text).toContain('90 秒');
    expect(context(r.requests[0]).facts.map((fact: any) => fact.source)).toEqual(['game', 'other']);
    expect(JSON.stringify(r.requests[0]).length).toBeLessThan(5000);
    audio = '[演出当前读数；观察 ' + new Date().toISOString() + ']\n安静';
    const event = { ...r.event, cursor: 43, text: 'Please respond now.' };
    r.persona.onDelivery({ events: [event] }); r.choice('immediate');
    await r.persona.beforeDecision({ events: [event], messages: r.records });
    expect(await r.select()).toEqual({ thinking: false });
    expect(context(r.requests.at(-1)).performance.text).toContain('安静');
    expect(context(r.requests.at(-1)).performance.text).not.toContain('Example');
    r.persona.stopRhythm();
  });

  it('reuses a fresh batch classification once, then inherits configuration during cooldown', async () => {
    const r = rig();
    expect(await r.persona.beforeDecision({ events: [r.event], messages: r.records })).toBe(true);
    expect(await r.select()).toEqual({ thinking: true, reasoningEffort: 'medium' });
    expect(await r.select()).toBeNull();
    expect(r.requests).toHaveLength(1);
    expect(r.spec.thinking).toBe(false);
    const facts = context(r.requests[0]).facts[0];
    expect(facts.state.action.progress).toContain('distance reduced');
    expect(JSON.stringify(r.requests[0])).not.toContain('older inventory');
    expect(JSON.stringify(r.requests[0]).length).toBeLessThan(4000);
    r.persona.stopRhythm();
  });

  it('new speech invalidates a pending deeper choice even when the classifier is cooling down', async () => {
    const r = rig();
    await r.persona.beforeDecision({ events: [r.event], messages: r.records });
    r.persona.onDelivery({ events: [{ ...r.event, cursor: 43, text: 'Please answer me now.' }] });
    expect(await r.select()).toBeNull();
    expect(r.requests).toHaveLength(1);
    r.persona.stopRhythm();
  });

  it('a failed read supersedes old movement acceptance in the next classification', async () => {
    const r = rig(); r.cfg.minIntervalMs = 0;
    await r.persona.beforeDecision({ events: [r.event], messages: r.records });
    r.persona.onToolOutcome({ role: 'main', tool: 'inspect', args: { area: 'north' },
      outcome: { failed: true, text: 'Observation unavailable; do not infer a cliff from this failure.' } });
    r.choice('routine');
    expect(await r.select()).toEqual({ thinking: true, reasoningEffort: 'low' });
    expect(context(r.requests.at(-1)).latestResult).toMatchObject({ tool: 'inspect', receipt: expect.stringContaining('[执行失败]') });
    r.persona.stopRhythm();
  });

  it.each(['disabled', 'different-model', 'empty-model', 'changed-config'])('inherits configured reasoning for %s', async mode => {
    const r = rig();
    await r.persona.beforeDecision({ events: [r.event], messages: r.records });
    if (mode === 'disabled') r.cfg.reasoningEnabled = false;
    if (mode === 'different-model') r.spec.model = 'another-local-model';
    if (mode === 'empty-model') r.cfg.reasoningModel = '';
    if (mode === 'changed-config') r.cfg.reasoningDeliberateEffort = 'high';
    expect(await r.select()).toBeNull();
    expect(r.requests).toHaveLength(1);
    r.persona.stopRhythm();
  });

  it('new observations can change a later request from complex planning to an immediate response', async () => {
    const r = rig(); r.cfg.minIntervalMs = 0;
    await r.persona.beforeDecision({ events: [r.event], messages: r.records });
    expect(await r.select()).toEqual({ thinking: true, reasoningEffort: 'medium' });
    const event = { ...r.event, cursor: 43, text: 'Taking damage; an immediate action is needed.' };
    r.persona.onDelivery({ events: [event] }); r.choice('immediate');
    await r.persona.beforeDecision({ events: [event], messages: r.records });
    expect(await r.select()).toEqual({ thinking: false });
    expect(r.requests.at(-1).state.observations.at(-1).text).toContain('Taking damage');
    r.persona.stopRhythm();
  });
});
