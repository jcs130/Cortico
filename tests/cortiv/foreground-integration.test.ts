import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { FOREGROUND_CONTEXT_DEFAULTS } from '../../bots/cortiv/persona/foreground-context.ts';
import { PLANNING_DEFAULTS } from '../../bots/cortiv/persona/planning-review.ts';
import { DREAM_DEFAULTS } from '../../bots/cortiv/persona/dream-context.ts';
import { FAST_FOREGROUND_DEFAULTS } from '../../bots/cortiv/persona/foreground-adviser.ts';
import { functionCall, functionResult, itemText, message, type ContextRecord } from '../../src/protocol/open-responses/context.ts';
import { estimateMessagesTokens, estimateTokens, nullLogger } from '../../src/core/util.ts';
import { validatePairing } from '../../src/core/truncate.ts';
import type { EventEnvelope, World, WorldRequestFacts } from '../../src/core/types.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function rig(worlds: World[] = [], agendaEnabled = false) {
  const memoryDir = mkdtempSync(join(tmpdir(), 'foreground-persona-'));
  dirs.push(memoryDir);
  const config = { ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true, maxHistoryTokens: 1024, minRecentRounds: 1 };
  const persona = new CortiV({ memoryDir, foreground: () => config, worlds,
    planning: () => ({ ...PLANNING_DEFAULTS, agendaEnabled }) });
  const messages: ContextRecord[] = [message('system', 'Environment contract')];
  for (let i = 0; i < 12; i++) {
    messages.push(functionCall(`c${i}`, 'inspect', '{}', { responseId: `r${i}` }),
      functionResult(`c${i}`, `Observation ${i}: ` + 'older local observation '.repeat(100)));
  }
  messages.push(message('user', 'The player asks what we are building.', { frame: { events: [
    { cursor: 20, source: 'game', type: 'chat', ts: '2026-01-01T00:00:00Z', start: 0, chars: 45 },
  ] } }));
  return { persona, config, messages };
}

describe('CortiV foreground request context', () => {
  function adaptiveRig() {
    const memoryDir = mkdtempSync(join(tmpdir(), 'adaptive-foreground-')); dirs.push(memoryDir);
    const cfg = { ...FAST_FOREGROUND_DEFAULTS, enabled: true, endpoint: 'http://fixture/decision',
      minIntervalMs: 0, focusedHistoryTokens: 1024, deferQueueTail: true, maxDeferMs: 50 };
    let reading = 'focused';
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ answers: {
      reading: { choice: reading, confidence: .98, probabilities: Object.fromEntries(['focused','connected']
        .map(key => [key, key === reading ? .98 : .02])) },
      timing: { choice: 'continue', confidence: .98, probabilities: { continue: .98, respond: .02 } },
    } })));
    const records = [message('system', 'Environment contract'), message('assistant', 'Existing response', { responseId: 'before' })];
    const injected: Array<{ text: string; kind?: string }> = [];
    const diagnostics: unknown[] = [];
    const api = { ...makeFakeHarnessApi({
      injectInternal: (text, kind) => { injected.push({ text, kind }); },
      log: { ...nullLogger(), emit: (_level, _text, options) => { if (options?.event === 'foreground-context') diagnostics.push(options.data); } },
    }), sessionInfo: (id: string) => ({ id, running: 0, snapshot: records, estTokens: null, hardTokens: null }) };
    const persona = new CortiV({ memoryDir, tickDelayMs: () => null,
      foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true, maxHistoryTokens: 6000, minRecentRounds: 1 }),
      fastForeground: () => cfg,
    });
    persona.attach(api);
    const event: EventEnvelope = { origin: 'external', source: 'game', type: 'game.task.queue', cursor: 42,
      ts: new Date().toISOString(), text: 'Moving to the bridge; still executing.', tags: ['snapshot'],
      meta: { minecraftQueueTail: { schemaVersion: 1, taskId: 7, stepIndex: 0, stepCount: 1 } } };
    const frame = message('user', event.text, { frame: { events: [{ source: event.source, type: event.type,
      cursor: event.cursor, ts: event.ts, tags: event.tags, start: 0, chars: event.text.length }] } });
    records.push(frame);
    return { persona, cfg, records, event, frame, injected, diagnostics, reading: (value: string) => { reading = value; } };
  }

  it('deferred input survives compact requests and failed generations, then releases after an actual response', async () => {
    const { persona, records, event, frame, diagnostics } = adaptiveRig();
    expect(await persona.beforeDecision({ events: [event], messages: records })).toBe(false);
    persona.onTurnEnded(); // A failed generation produced no model record.
    for (let index = 0; index < 8; index++) records.push(functionCall(`read-${index}`, 'inspect', '{}', { responseId: `read-${index}` }),
      functionResult(`read-${index}`, 'Old local observation. '.repeat(200)));
    const fresh = message('user', 'Meet the player at the bridge; do not change that goal.'); records.push(fresh);
    const archive = structuredClone(records);
    const view = persona.prepareRequest({ sessionId: 'main', round: 1, messages: records })!;
    expect(view).toContainEqual(frame); expect(view).toContainEqual(fresh);
    expect(validatePairing(view)).toEqual([]); expect(records).toEqual(archive);
    expect(diagnostics.at(-1)).toMatchObject({ reading: 'focused', maxHistoryTokens: 1024, deferredInputRecords: 1 });
    persona.onTurnEnded();
    persona.prepareRequest({ sessionId: 'main', round: 2, messages: records });
    expect(diagnostics.at(-1)).toMatchObject({ deferredInputRecords: 0 });
    persona.stopRhythm();
  });

  it('a queue input deferred after an established epoch occurs once through failed generations', async () => {
    const { persona, records, event, frame } = adaptiveRig();
    persona.prepareRequest({ sessionId: 'main', round: 1, messages: records.slice(0, -1) });
    expect(await persona.beforeDecision({ events: [event], messages: records })).toBe(false);
    const archive = structuredClone(records);
    for (const round of [2, 3]) {
      const view = persona.prepareRequest({ sessionId: 'main', round, messages: structuredClone(records) })!;
      expect(view.filter(row => row.item.id === frame.item.id)).toEqual([frame]);
      const ids = view.map(row => row.item.id).filter(Boolean);
      expect(new Set(ids).size).toBe(ids.length);
      expect(validatePairing(view)).toEqual([]);
      persona.onTurnEnded(); // No successful model output; the queue input must stay protected.
    }
    expect(records).toEqual(archive);
    persona.stopRhythm();
  });

  it('deferral has a deadline and new substantive input or shutdown cancels the deadline', async () => {
    vi.useFakeTimers();
    const { persona, records, event, injected } = adaptiveRig();
    expect(await persona.beforeDecision({ events: [event], messages: records })).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(injected.filter(row => row.kind === 'foreground-check')).toHaveLength(1);
    event.ts = new Date().toISOString();
    expect(await persona.beforeDecision({ events: [event], messages: records })).toBe(false);
    persona.onDelivery({ events: [{ ...event, type: 'game.chat', text: 'Please answer.', tags: [], meta: undefined }] });
    await vi.advanceTimersByTimeAsync(50);
    expect(injected.filter(row => row.kind === 'foreground-check')).toHaveLength(1);
    event.ts = new Date().toISOString();
    expect(await persona.beforeDecision({ events: [event], messages: records })).toBe(false);
    persona.stopRhythm();
    await vi.advanceTimersByTimeAsync(50);
    expect(injected.filter(row => row.kind === 'foreground-check')).toHaveLength(1);
  });

  it('automatic reading changes keep the current prefix and full expansion remains immediate', async () => {
    const { persona, records, event, reading, diagnostics } = adaptiveRig();
    await persona.beforeDecision({ events: [event], messages: records });
    const first = persona.prepareRequest({ sessionId: 'main', round: 1, messages: records })!;
    expect(diagnostics.at(-1)).toMatchObject({ maxHistoryTokens: 1024 });
    reading('connected');
    expect(await persona.beforeDecision({ events: [{ ...event, type: 'game.chat', meta: undefined }], messages: records })).toBe(true);
    const next = persona.prepareRequest({ sessionId: 'main', round: 2, messages: records })!;
    expect(diagnostics.at(-1)).toMatchObject({ reading: 'connected', maxHistoryTokens: 1024,
      requestedMaxHistoryTokens: 6000, rebuilt: false });
    expect(next.slice(0, first.length)).toEqual(first);
    const expand = persona.declareSessions().find(session => session.id === 'main')!.tools().find(tool => tool.name === 'expand_context')!;
    await expand.handler({ reason: 'Review earlier agreement.' }, { role: 'main', log: nullLogger() });
    expect(persona.prepareRequest({ sessionId: 'main', round: 3, messages: records })).toBeNull();
    persona.stopRhythm();
  });

  it('carries recent causal evidence into a new session after a real handoff, with original provenance and no old tool partners', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'causal-handoff-')); dirs.push(memoryDir);
    const options = { memoryDir, tickDelayMs: () => null,
      dream: () => ({ ...DREAM_DEFAULTS, onHandoff: false }),
      foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true, maxHistoryTokens: 1, minRecentRounds: 0 }),
      planning: () => ({ ...PLANNING_DEFAULTS, agendaEnabled: true, maxResultAgeMs: 300_000 }) };
    const persona = new CortiV(options); persona.attach(makeFakeHarnessApi());
    const now = Date.now();
    const review = (cursor: number, age: number, text: string) => functionResult(`batch-${cursor}`, text, { frame: { events: [
      { source: 'persona', type: 'causal_review', cursor, ts: new Date(now - age).toISOString(), start: 0, chars: text.length },
    ] } });
    const stale = review(1, 301_000, '已经过期的机制猜测。');
    const recent = review(2, 20_000, '原始终态显示回到起点，净高度没有累计。');
    const latest = review(3, 1_000, '冷却7秒是暂缓，不代表施法成功。');
    const snapshot = [message('system', 'Contract'), functionCall('batch-1', 'external_event_frame', '{}'), stale,
      functionCall('batch-2', 'external_event_frame', '{}'), recent,
      functionCall('batch-3', 'external_event_frame', '{}'), latest];
    const before = structuredClone(snapshot);
    const handoff = await persona.onHandoff(snapshot, { hardTokens: null });
    const restarted = new CortiV(options); restarted.attach(makeFakeHarnessApi());
    const records = [message('system', 'Contract'), ...handoff.tail!, message('user', '继续当前目标。')];
    const view = restarted.prepareRequest({ sessionId: 'main', round: 1, messages: records })!;
    const text = view.map(record => itemText(record.item)).join('\n');
    expect(text).toContain(itemText(recent.item)); expect(text).toContain(itemText(latest.item));
    expect(text).not.toContain(itemText(stale.item));
    const refs = handoff.tail!.flatMap(record => record.context.frame?.events ?? []);
    expect(refs.map(event => event.cursor)).toEqual([2, 3]);
    expect(refs[0].ts).toBe(recent.context.frame!.events[0].ts);
    const nextHandoff = await restarted.onHandoff(records, { hardTokens: null });
    expect(nextHandoff.tail!.flatMap(record => record.context.frame?.events.map(event => event.cursor) ?? [])).toEqual([2, 3]);
    expect(validatePairing(view)).toEqual([]); expect(snapshot).toEqual(before);
  });
  it('retains the latest causal review independently of the current agenda after history compaction', () => {
    const { persona, config, messages } = rig([], true); persona.attach(makeFakeHarnessApi());
    config.maxHistoryTokens = 1;
    const review = (cursor: number, text: string) => message('user', text, { frame: { events: [
      { source: 'persona', type: 'causal_review', cursor, ts: '2026-01-01T00:00:00Z', start: 0, chars: text.length },
    ] } });
    const old = review(1, '旧复核：原方案尚未证实。');
    messages.splice(1, 0, old);
    const first = persona.prepareRequest({ sessionId: 'main', round: 1, messages })!;
    expect(first).toContainEqual(old);
    expect(first.map(record => itemText(record.item)).join('\n')).toContain('排队 0 项');
    const latest = review(2, '新复核：实际回到起点，净变化为零；原因未知。');
    const records = [...messages, latest, functionCall('later-review', 'inspect', '{}', { responseId: 'later-review' }),
      functionResult('later-review', '较晚现场'.repeat(1000)), message('user', '新的同伴发言。')];
    const before = structuredClone(records);
    const next = persona.prepareRequest({ sessionId: 'main', round: 2, messages: records })!;
    expect(next).toContainEqual(latest); expect(next).not.toContainEqual(old);
    expect(validatePairing(next)).toEqual([]); expect(records).toEqual(before);
  });
  it('keeps an older action receipt and adjacent chat while replacing its covered obsolete snapshot body with a source pointer', () => {
    const world: World = { id: 'game', envPromptVars: () => ({}), tools: () => [],
      start: async () => {}, stop: async () => {}, requestFacts: () => ({
        text: 'Observed at 2026-01-01T00:01:00Z: bread 12, queue idle.', snapshotTypes: ['game.state'],
      }) };
    const { persona } = rig([world]);
    const stale = 'Old observation: bread 0, queue running. '.repeat(300);
    const chat = 'A player asks to meet at the bridge.';
    const old = functionResult('build', stale + '\n' + chat + '\nBridge support placed and verified.', { frame: { events: [
      { source: 'game', type: 'game.state', tags: ['snapshot'], cursor: 1,
        ts: '2026-01-01T00:00:00Z', start: 0, chars: stale.length },
      { source: 'game', type: 'game.chat', cursor: 2,
        ts: '2026-01-01T00:00:00Z', start: stale.length + 1, chars: chat.length },
    ] } });
    const records = [message('system', 'Contract'), functionCall('build', 'game_build', '{}', { responseId: 'r1' }),
      old, message('user', 'A new request.', {
        frame: { events: [{ source: 'game', type: 'game.chat', cursor: 3,
          ts: '2026-01-01T00:02:00Z', start: 0, chars: 'A new request.'.length }] },
      })];
    const before = structuredClone(records);
    const view = persona.prepareRequest({ sessionId: 'main', round: 1, messages: records })!;
    const body = view.find(row => row.item.id === old.item.id)!;
    expect(itemText(body.item)).not.toContain(stale);
    expect(itemText(body.item)).toContain(chat);
    expect(itemText(body.item)).toContain('事件#1');
    expect(view.some(row => itemText(row.item).includes('Bridge support placed and verified.'))).toBe(true);
    expect(view.some(row => itemText(row.item).includes('bread 12, queue idle.'))).toBe(true);
    expect(validatePairing(view)).toEqual([]);
    expect(records).toEqual(before);
  });
  it('current agenda state supersedes old agenda prose embedded alongside a protected handoff', () => {
    const { persona, config } = rig(); persona.attach(makeFakeHarnessApi());
    config.maxHistoryTokens = 1;
    const stale = '之前背包已满，需要继续整理箱子。'.repeat(30);
    const handoff = '长期建筑目标仍未验收。';
    const old = message('user', stale + '\n' + handoff, { frame: { events: [
      { cursor: 1, source: 'persona', type: 'activity_plan', ts: '2026-01-01T00:00:01Z', start: 0, chars: stale.length },
      { cursor: 2, source: 'persona', type: 'handoff-note', ts: '2026-01-01T00:00:01Z', start: stale.length + 1, chars: handoff.length },
    ] } });
    const records = [message('system', '契约'), old, message('user', '同伴邀请一起探索。')];
    const before = structuredClone(records);
    const view = persona.prepareRequest({ sessionId: 'main', round: 1, messages: records })!;
    const note = view.find(record => record.item.id === old.item.id)!;
    expect(itemText(note.item)).toContain(handoff);
    expect(itemText(note.item)).not.toContain(stale);
    expect(itemText(note.item)).toContain('已由本轮最新状态替代');
    expect(view.map(record => itemText(record.item)).join('\n')).toContain('排队 0 项');
    expect(records).toEqual(before);
  });
  it('pins action requests and their receipts when older spoken plans leave the short history', () => {
    const { persona, messages } = rig();
    persona.attach(makeFakeHarnessApi({ toolsTagged: tag => new Set(
      tag === 'act' ? ['execute'] : tag === 'speak' ? ['perform'] : ['inspect']),
    }));
    messages.splice(-1, 0,
      functionCall('action', 'execute', '{"destination":"workshop"}'),
      functionResult('action', 'Rejected: workshop entrance unavailable.'),
      functionCall('speech', 'perform', '{"script":"I will work in the workshop."}'),
      functionResult('speech', 'Speech queued.'),
      ...Array.from({ length: 6 }, (_, index) => [
        functionCall(`later-${index}`, 'inspect', '{}', { responseId: `later-${index}` }),
        functionResult(`later-${index}`, 'Current local observation '.repeat(100)),
      ]).flat(),
    );
    const before = structuredClone(messages);
    const projected = persona.prepareRequest({ sessionId: 'main', round: 1, messages })!;
    const text = projected.map(row => itemText(row.item)).join('\n');
    expect(text).toContain('[行动对账]');
    expect(text).toContain('行动 1、发言 1');
    expect(text).toContain('Rejected: workshop entrance unavailable.');
    expect(projected.some(row => row.item.type === 'function_call' && row.item.call_id === 'action')).toBe(false);
    expect(messages).toEqual(before);
  });

  it('uses recent complete receipts and current input without changing the archive', () => {
    const { persona, messages } = rig();
    const original = structuredClone(messages);
    const projected = persona.prepareRequest({ sessionId: 'main', round: 1, messages })!;
    expect(projected.length).toBeLessThan(messages.length);
    expect(projected[0]).toEqual(messages[0]);
    expect(projected).toContainEqual(messages.at(-1));
    expect(projected.some(row => row.item.type === 'function_call_output' && row.item.call_id === 'c11')).toBe(true);
    expect(messages).toEqual(original);
    expect(persona.prepareRequest({ sessionId: 'planning', round: 1, messages })).toBeNull();
  });

  it('expands the next request and then resumes compact requests', async () => {
    const { persona, messages } = rig();
    const tool = persona.declareSessions().find(session => session.id === 'main')!.tools()
      .find(tool => tool.name === 'expand_context')!;
    await tool.handler({ reason: 'Read the earlier player instruction.' }, { role: 'main', log: nullLogger() });
    expect(persona.prepareRequest({ sessionId: 'main', round: 2, messages })).toBeNull();
    expect(persona.prepareRequest({ sessionId: 'main', round: 3, messages })).toBeNull();
    messages.push(message('assistant', 'I have read the expanded context.', { responseId: 'expanded' }));
    expect(persona.prepareRequest({ sessionId: 'main', round: 4, messages })).not.toBeNull();
  });

  it('hot disabling restores complete requests', () => {
    const { persona, config, messages } = rig();
    expect(persona.prepareRequest({ sessionId: 'main', round: 1, messages })).not.toBeNull();
    config.enabled = false;
    expect(persona.prepareRequest({ sessionId: 'main', round: 2, messages })).toBeNull();
  });

  it('only replaces an old snapshot chain when the World supplies complete current facts', () => {
    let facts: WorldRequestFacts | null = { text: 'Observed at 2026-01-01T00:00:05Z: 12 bread, queue running.',
      snapshotTypes: ['game.state'] };
    const world: World = { id: 'game', envPromptVars: () => ({}), tools: () => [],
      start: async () => {}, stop: async () => {}, requestFacts: () => facts };
    const { persona, messages } = rig([world]);
    const old = message('user', 'Old complete state: ' + 'position inventory health '.repeat(300), { frame: { events: [
      { cursor: 1, source: 'game', type: 'game.state', tags: ['snapshot'],
        ts: '2026-01-01T00:00:01Z', start: 0, chars: 7200 },
    ] } });
    messages.splice(1, 0, old);
    const projected = persona.prepareRequest({ sessionId: 'main', round: 1, messages })!;
    expect(projected).not.toContainEqual(old);
    expect(JSON.stringify(projected)).toContain(facts!.text);
    expect(projected).toContainEqual(messages.at(-1));
    facts = null;
    const withoutCache = persona.prepareRequest({ sessionId: 'main', round: 2, messages })!;
    expect(withoutCache).toContainEqual(old);
  });

  it('appends changed fact parts without replaying stable inventory, then rebuilds with the full current set', () => {
    const bag = '已核验物品与存放位置。'.repeat(400);
    let parts = [{ key: 'sample', text: '采样 00:00:01' }, { key: 'inventory', text: bag },
      { key: 'health', text: '生命 10/20' }, { key: 'nearby', text: '附近有一个敌人' }];
    const world: World = { id: 'game', envPromptVars: () => ({}), tools: () => [],
      start: async () => {}, stop: async () => {}, requestFacts: () => ({
        text: parts.map(part => part.text).join('\n'), parts, snapshotTypes: ['game.state'],
      }) };
    const { persona, config, messages } = rig([world]);
    config.currentStateOnly = false;
    const archive = structuredClone(messages);
    const first = persona.prepareRequest({ sessionId: 'main', round: 1, messages })!;
    parts = [parts[0], parts[1], { key: 'health', text: '生命 8/20' }, { key: 'nearby', text: '' }];
    parts[0] = { key: 'sample', text: '采样 00:00:02' };
    const next = persona.prepareRequest({ sessionId: 'main', round: 2, messages })!;
    expect(next.slice(0, first.length)).toEqual(first);
    const appended = next.slice(first.length).map(record => itemText(record.item)).join('\n');
    expect(appended).toContain('生命 8/20');
    expect(appended).toContain('采样 00:00:02');
    expect(appended).toContain('nearby]\n本项当前无内容');
    expect(appended).not.toContain(bag);
    expect(estimateMessagesTokens(next.slice(first.length))).toBeLessThan(estimateTokens(bag) / 10);
    expect(persona.prepareRequest({ sessionId: 'main', round: 3, messages })).toEqual(next);
    config.maxHistoryTokens = 1;
    const rebuilt = persona.prepareRequest({ sessionId: 'main', round: 4, messages })!;
    const current = rebuilt.map(record => itemText(record.item)).join('\n');
    expect(current).toContain(bag);
    expect(current).toContain('生命 8/20');
    expect(current).not.toContain('生命 10/20');
    expect(current).toContain('nearby]\n本项当前无内容');
    expect(messages).toEqual(archive);
  });

  it('keeps the projection notice identity stable and explicitly reports empty active work', () => {
    const { persona, messages } = rig();
    const first = persona.prepareRequest({ sessionId: 'main', round: 1, messages })!;
    messages.push(message('assistant', 'An additional local observation.', { responseId: 'next' }));
    const next = persona.prepareRequest({ sessionId: 'main', round: 2, messages })!;
    const sourceIds = new Set(messages.slice(0,-1).map(record => record.item.id));
    const base = first.filter(record => sourceIds.has(record.item.id) || itemText(record.item).startsWith('[即时调用]'));
    expect(next.slice(0, base.length)).toStrictEqual(base);
    expect(JSON.stringify(next)).toContain('当前没有等待中或待复核的事项');
  });

  it('uses an old handoff excerpt even when every record fits, and expands its original text', async () => {
    const { persona } = rig();
    const originalText = 'An old handoff note with the confirmed outcome. '.repeat(120);
    const note = message('user', originalText, { frame: { events: [{ cursor: 1, source: 'persona', type: 'handoff-note',
      ts: '2026-01-01T00:00:01Z', start: 0, chars: originalText.length }] } });
    const records = [message('system', 'Environment contract'), note, message('assistant', 'Previous response.', { responseId: 'previous' }),
      message('user', 'The current player input.')];
    const before = structuredClone(records);
    const reading = persona.prepareRequest({ sessionId: 'main', round: 1, messages: records })!;
    expect(reading.map(record => record.item.id)).toContain(note.item.id);
    expect(JSON.stringify(reading)).toContain('交接笔记原文节选');
    expect(JSON.stringify(reading)).not.toContain(originalText);
    expect(records).toEqual(before);
    const tool = persona.declareSessions().find(session => session.id === 'main')!.tools()
      .find(tool => tool.name === 'expand_context')!;
    await tool.handler({ reason: 'Read the old outcome exactly.' }, { role: 'main', log: nullLogger() });
    expect(persona.prepareRequest({ sessionId: 'main', round: 2, messages: records })).toBeNull();
    expect(records[1]).toEqual(note);
  });

  it('retains a same-ID receipt correction in full when its source body changes inside an old handoff', () => {
    const { persona } = rig();
    const lead = 'Earlier verified observation. '.repeat(180);
    const tail = 'Later verified observation. '.repeat(180);
    const oldText = lead + 'The earlier outcome still needs verification.\n' + tail;
    const receipt = functionResult('handoff-events', oldText, { frame: { events: [{ cursor: 1,
      source: 'persona', type: 'handoff-note', ts: '2026-01-01T00:00:01Z', start: 0, chars: oldText.length }] } });
    const records = [message('system', 'Environment contract'),
      functionCall('handoff-events', 'external_event_frame', '{}'), receipt,
      message('assistant', 'I read the earlier receipt.', { responseId: 'prior' }),
      message('user', 'Current local input.')];
    const first = persona.prepareRequest({ sessionId: 'main', round: 1, messages: records })!;
    expect(itemText(first.find(({ item }) => item.id === receipt.item.id)!.item)).toContain('交接笔记原文节选');
    const changed = structuredClone(records);
    const correction = 'CORRECTION: The operation was refused; no transfer happened.';
    const correctedText = lead + correction + '\n' + tail;
    if (changed[2].item.type !== 'function_call_output') throw new Error('fixture');
    changed[2].item.output = correctedText;
    changed[2].context.frame!.events[0].chars = correctedText.length;
    const archive = structuredClone(changed);
    const projected = persona.prepareRequest({ sessionId: 'main', round: 2, messages: changed })!;
    const receipts = projected.filter(({ item }) => item.type === 'function_call_output' && item.call_id === 'handoff-events');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toEqual(changed[2]);
    expect(itemText(receipts[0].item)).toContain(correction);
    expect(validatePairing(projected)).toEqual([]);
    expect(changed).toEqual(archive);
    expect(records[2]).toEqual(receipt);
    const repeated = persona.prepareRequest({ sessionId: 'main', round: 3, messages: structuredClone(changed) })!;
    expect(repeated).toEqual(projected);
  });

  it('keeps a newly delivered tool receipt in its atomic group before later user input', () => {
    const { persona, messages } = rig();
    persona.prepareRequest({ sessionId: 'main', round: 1, messages });
    const text = 'The full newly delivered operation result. '.repeat(180);
    const receipt = functionResult('new-handoff-events', text, { frame: { events: [{ cursor: 30,
      source: 'game', type: 'game.result', ts: '2026-01-01T00:00:03Z', start: 0, chars: text.length }] } });
    messages.push(functionCall('new-handoff-events', 'external_event_frame', '{}'), receipt,
      message('assistant', 'This response follows the delivery.', { responseId: 'delivery-followup' }),
      message('user', 'Another current input.'));
    const archive = structuredClone(messages);
    const projected = persona.prepareRequest({ sessionId: 'main', round: 2, messages })!;
    const callIndex = projected.findIndex(({ item }) => item.type === 'function_call' && item.call_id === 'new-handoff-events');
    const receiptIndex = projected.findIndex(({ item }) => item.type === 'function_call_output' && item.call_id === 'new-handoff-events');
    expect(callIndex).toBeGreaterThan(0);
    expect(receiptIndex).toBe(callIndex + 1);
    expect(projected[receiptIndex]).toEqual(receipt);
    expect(projected.filter(({ item }) => item.type === 'function_call_output' && item.call_id === 'new-handoff-events')).toHaveLength(1);
    expect(validatePairing(projected)).toEqual([]);
    expect(messages).toEqual(archive);
  });

  it.each(['initial', 'source_changed'])('immediately excerpts a large automatic handoff on %s while retaining its short current section', async (mode) => {
    const { persona, config, messages } = rig();
    config.maxHistoryTokens = 6000;
    if (mode === 'source_changed') {
      for (let index = 0; messages.length < 278; index++) {
        messages.splice(messages.length - 1, 0,
          functionCall(`extra-${index}`, 'inspect', '{}', { responseId: `extra-response-${index}` }),
          functionResult(`extra-${index}`, 'Earlier confirmed receipt.'));
      }
      expect(messages).toHaveLength(278);
      persona.prepareRequest({ sessionId: 'main', round: 1, messages });
    }
    const history = '已经确认的历史动作与回执。'.repeat(3000);
    const current = '当前回执。'.repeat(826).slice(0, 4128);
    const lead = 'Delivery header\n';
    const output = functionResult('handoff-batch', lead + history + '\n' + current, { frame: { events: [
      { cursor: 60, source: 'persona', type: 'handoff-note', ts: '2026-01-01T00:05:00Z', start: lead.length, chars: history.length },
      { cursor: 61, source: 'persona', type: 'handoff-note', ts: '2026-01-01T00:05:00Z', start: lead.length + history.length + 1, chars: current.length },
    ] } });
    const records = [messages[0], message('user', 'The automatic handoff has completed.'),
      functionCall('handoff-batch', 'external_event_frame', '{}'), output];
    const archive = structuredClone(records);
    expect(estimateTokens(history)).toBeGreaterThan(config.maxHistoryTokens);
    expect(estimateTokens(current)).toBeLessThan(config.maxHistoryTokens);
    const projected = persona.prepareRequest({ sessionId: 'main', round: 2, messages: records })!;
    const receipt = projected.find(({ item }) => item.type === 'function_call_output' && item.call_id === 'handoff-batch')!;
    expect(itemText(receipt.item)).toContain('交接笔记原文节选');
    expect(itemText(receipt.item)).not.toContain(history);
    const ref = receipt.context.frame!.events[1];
    expect(itemText(receipt.item).slice(ref.start, ref.start + ref.chars)).toBe(current);
    expect(estimateMessagesTokens(projected)).toBeLessThan(config.maxHistoryTokens);
    expect(projected.filter(({ item }) => item.type === 'function_call_output' && item.call_id === 'handoff-batch')).toHaveLength(1);
    expect(validatePairing(projected)).toEqual([]);
    expect(records).toEqual(archive);
    const nextRecords = [...records, message('assistant', 'Continue the current activity.', { responseId: 'continued' })];
    const next = persona.prepareRequest({ sessionId: 'main', round: 3, messages: nextRecords })!;
    const sourceIds = new Set(records.map(record => record.item.id));
    const base = projected.filter(record => sourceIds.has(record.item.id) || itemText(record.item).startsWith('[即时调用]'));
    expect(next.slice(0, base.length)).toEqual(base);
    const rotatedRecords = [...nextRecords, message('assistant', 'New observed activity. '.repeat(8000), { responseId: 'rotation' })];
    const rotated = persona.prepareRequest({ sessionId: 'main', round: 4, messages: rotatedRecords })!;
    const rotatedReceipt = rotated.find(({ item }) => item.type === 'function_call_output' && item.call_id === 'handoff-batch')!;
    expect(itemText(rotatedReceipt.item)).not.toContain(history);
    expect(itemText(rotatedReceipt.item)).toBe(itemText(receipt.item));
    const expand = persona.declareSessions().find(session => session.id === 'main')!.tools().find(tool => tool.name === 'expand_context')!;
    await expand.handler({ reason: 'Read the complete earlier receipts.' }, { role: 'main', log: nullLogger() });
    expect(persona.prepareRequest({ sessionId: 'main', round: 5, messages: rotatedRecords })).toBeNull();
    expect(records).toEqual(archive);
    expect(itemText(records[3].item)).toContain(history);
  });

  it('preserves new receipts, media, outside text and a long user input in the new handoff frame', () => {
    const { persona, config, messages } = rig();
    config.maxHistoryTokens = 6000;
    persona.prepareRequest({ sessionId: 'main', round: 1, messages });
    const lead = 'Fresh internal instruction: verify the actual response.\n';
    const history = '历史记录。'.repeat(7000);
    const actual = 'The container transfer was rejected. '.repeat(160) + 'EXACT_CURRENT_REJECTION';
    const source = lead + history + '\n' + actual;
    const output = functionResult('mixed-handoff', source, { frame: { events: [
      { cursor: 70, source: 'persona', type: 'handoff-note', ts: '2026-01-01T00:05:00Z', start: lead.length, chars: history.length },
      { cursor: 71, source: 'game', type: 'game.result', ts: '2026-01-01T00:05:01Z', start: lead.length + history.length + 1, chars: actual.length },
    ] }, blobs: [{ handle: 'mem:current.png', mime: 'image/png', fallbackText: 'Current visual observation.' }] });
    if (output.item.type !== 'function_call_output') throw new Error('fixture');
    const image = { type: 'input_image' as const, image_url: 'data:image/png;base64,current', detail: 'auto' as const };
    output.item.output = [{ type: 'input_text', text: source.slice(0, lead.length + 60) }, image,
      { type: 'input_text', text: source.slice(lead.length + 60) }];
    const user = message('user', 'Fresh player instruction. '.repeat(1200) + 'EXACT_MIDDLE_USER_CHANGE');
    const records = [messages[0], functionCall('mixed-handoff', 'external_event_frame', '{}'), output, user];
    const archive = structuredClone(records);
    const projected = persona.prepareRequest({ sessionId: 'main', round: 2, messages: records })!;
    const receipt = projected.find(({ item }) => item.type === 'function_call_output' && item.call_id === 'mixed-handoff')!;
    expect(itemText(receipt.item)).toContain(lead);
    expect(itemText(receipt.item)).not.toContain(history);
    const ref = receipt.context.frame!.events[1];
    expect(itemText(receipt.item).slice(ref.start, ref.start + ref.chars)).toBe(actual);
    expect(receipt.context.blobs).toEqual(output.context.blobs);
    if (receipt.item.type !== 'function_call_output' || !Array.isArray(receipt.item.output)) throw new Error('result');
    expect(receipt.item.output[1]).toEqual(image);
    expect(projected).toContainEqual(user);
    expect(validatePairing(projected)).toEqual([]);
    expect(records).toEqual(archive);
  });
});
