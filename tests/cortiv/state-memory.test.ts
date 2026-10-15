import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorkspaceMemory } from '../../bots/cormini/persona/memory.ts';
import { CortiV, RECENT_FILE } from '../../bots/cortiv/persona/persona.ts';
import { FOREGROUND_CONTEXT_DEFAULTS } from '../../bots/cortiv/persona/foreground-context.ts';
import { DREAM_DEFAULTS } from '../../bots/cortiv/persona/dream-context.ts';
import { StateMemory, STATE_MEMORY_FILE, STATE_MEMORY_MAX_CHARS } from '../../bots/cortiv/persona/state-memory.ts';
import { ActivityAgenda, AGENDA_FILE } from '../../bots/cortiv/persona/activity-agenda.ts';
import { functionCall, functionResult, itemText, message } from '../../src/protocol/open-responses/context.ts';
import { nullLogger } from '../../src/core/util.ts';
import { toolOutcomeText } from '../../src/core/tool-outcome.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';

const dirs: string[] = [];
const personas: CortiV[] = [];
afterEach(() => {
  for (const persona of personas.splice(0)) persona.stopRhythm();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const oldAt = '2026-08-01T10:00:00Z', newAt = '2026-08-01T11:00:00Z';
const now = () => Date.parse('2026-08-01T12:00:00Z');
const ctx = { role: 'main', log: nullLogger() };
function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'state-memory-')); dirs.push(dir);
  const memory = new GitWorkspaceMemory({ memoryDir: dir });
  const state = new StateMemory(memory, now);
  return { dir, memory, state };
}
function set(state: StateMemory, value: string, observedAt: string, revision: number) {
  const evidence_id = state.observe({ source: 'world/task', observedAt, text: value })!;
  return state.operate({ operation: 'set', key: 'project/portal/access', value, expected_revision: revision, evidence_id });
}

describe('versioned current memory', () => {
  it('keeps completed access current after legacy text is copied into a freshly written note and after restart', () => {
    const { memory, state } = rig();
    memory.writeFileAtomic(RECENT_FILE, '门尚未点燃，缺材料'); state.migrate([RECENT_FILE]);
    expect(set(state, '实际穿门到另一维度，通行已验证', newAt, 0)).not.toHaveProperty('failed');
    memory.writeFileAtomic(RECENT_FILE, '刚整理：门尚未点燃，缺材料');
    const restarted = new StateMemory(memory, now);
    expect(restarted.summary()).toContain('通行已验证');
    expect(restarted.summary()).not.toContain('缺材料');
    expect(restarted.historicalSource(RECENT_FILE)).not.toContain('缺材料');
    const legacy = JSON.parse(memory.readFile(STATE_MEMORY_FILE)).legacy[RECENT_FILE];
    expect(memory.readFile(legacy.archive)).toBe('门尚未点燃，缺材料');
    restarted.migrate([RECENT_FILE]);
    expect(memory.readFile(legacy.archive)).toBe('门尚未点燃，缺材料');
  });

  it('rejects an older observation even after the writer rereads the current revision', () => {
    const { state } = rig(); set(state, '已通行', newAt, 0);
    expect(set(state, '旧记录缺材料', oldAt, 1)).toMatchObject({ failed: true });
    expect(state.summary()).toContain('已通行'); expect(state.summary()).not.toContain('缺材料');
  });

  it('compares revisions inside a shared file transaction for independent foreground and background instances', () => {
    const { state, memory } = rig(); const background = new StateMemory(memory, now);
    set(state, '已通行', oldAt, 0);
    expect(set(background, '新的观察', newAt, 0)).toMatchObject({ failed: true });
    expect(set(background, '新的观察', newAt, 1)).not.toHaveProperty('failed');
    expect(state.summary()).toContain('r2');
    const history = JSON.parse(state.operate({ operation: 'history', key: 'project/portal/access' }) as string);
    expect(history.claims.map((claim: { active: boolean }) => claim.active)).toEqual([false, true]);
  });

  it('excludes expired and retired claims from current retrieval while retaining tombstone revisions', () => {
    const { state, memory } = rig(); const evidence_id = state.observe({ source: 'world/read', observedAt: oldAt, text: '临时状态' });
    state.operate({ operation: 'set', key: 'temporary', value: '短时读数', expected_revision: 0, evidence_id,
      expires_at: '2026-08-01T12:01:00Z' });
    const expired = new StateMemory(memory, () => now() + 120_000);
    expect(expired.summary()).not.toContain('短时读数');
    expect(JSON.parse(expired.operate({ operation: 'read', key: 'temporary' }) as string).claims[0]).toMatchObject({ revision: 1, active: false });
    const later = state.observe({ source: 'world/read', observedAt: newAt, text: '已否定' });
    expect(state.operate({ operation: 'retire', key: 'temporary', value: '已否定', expected_revision: 1, evidence_id: later })).not.toHaveProperty('failed');
    expect(state.summary()).not.toContain('已否定');
    expect(state.operate({ operation: 'set', key: 'temporary', value: '重复旧读数', expected_revision: 2, evidence_id })).toMatchObject({ failed: true });
  });

  it('does not manufacture observation evidence from a note read, its modification time or assistant speech', () => {
    const { state } = rig();
    const records = [functionCall('read', 'read_file', '{"path":"old.md"}'),
      functionResult('read', '旧结论被新文件复制', { ts: newAt }), message('assistant', '我已经完成了', { ts: newAt }),
      functionCall('action', 'world_do', '{}'), functionResult('action', '受阻：无法执行', { ts: newAt })];
    state.observeRecords(records, new Set(['world_do']));
    const { observations } = JSON.parse(state.operate({ operation: 'evidence' }) as string);
    expect(observations).toHaveLength(1); expect(observations[0].text).toContain('受阻');
    expect(state.operate({ operation: 'set', key: 'a', value: '已完成', expected_revision: 0, evidence_id: 'file:old.md' })).toMatchObject({ failed: true });
  });

  it('finds all query terms in one delivered observation and keeps its source and write identity', () => {
    const { state } = rig();
    const body = '[World] Scout: 复核后，登记的路线仍在北边；下界近路尚未验证，desert 只是一条线索。';
    state.observeRecords([message('user', body, { ts: newAt, frame: { events: [
      { source: 'world', type: 'world.chat', cursor: 101, ts: newAt, start: 0, chars: body.length },
    ] } })], new Set());
    state.observe({ source: 'other/chat', observedAt: newAt, text: 'Scout 复核 登记' });
    state.observe({ source: 'other/chat', observedAt: newAt, text: '下界 近路 desert' });
    const result = JSON.parse(state.operate({ operation: 'evidence', query: '  scout  复核\n登记 下界 近路 DESERT ' }) as string);
    expect(result.observations).toHaveLength(1);
    const entry = result.observations[0];
    expect(entry).toMatchObject({ source: 'world/world.chat', reference: '101', observedAt: newAt, text: body, truncated: false });
    expect(JSON.parse(state.operate({ operation: 'evidence', query: 'world/world.chat 101' }) as string).observations[0].id).toBe(entry.id);
    expect(state.operate({ operation: 'set', key: 'route/north', expected_revision: 0, value: '尚未验证', evidence_id: '101' })).toMatchObject({ failed: true });
    expect(state.operate({ operation: 'set', key: 'route/north', expected_revision: 0, value: '尚未验证', evidence_id: entry.id })).not.toHaveProperty('failed');
    expect(JSON.parse(state.operate({ operation: 'read', key: 'route/north' }) as string).claims[0].observation.text).toBe(body);
  });

  it('paginates evidence by observation time and reports the bounded search scope when no terms match', () => {
    const { state } = rig();
    const newest = state.observe({ source: 'world/task', observedAt: newAt, text: 'route 三' });
    state.observe({ source: 'world/task', observedAt: oldAt, text: 'route 二' });
    state.observe({ source: 'world/task', observedAt: '2026-08-01T09:00:00Z', text: 'route 一' });
    const first = JSON.parse(state.operate({ operation: 'evidence', query: 'ROUTE', limit: 1 }) as string);
    expect(first.observations.map((entry: { id: string }) => entry.id)).toEqual([newest]);
    expect(first).toMatchObject({ total: 3, nextOffset: 1 });
    const remaining = JSON.parse(state.operate({ operation: 'evidence', query: 'route', offset: first.nextOffset, limit: 2 }) as string);
    expect(remaining.observations.map((entry: { text: string }) => entry.text)).toEqual(['route 二', 'route 一']);
    expect(remaining.nextOffset).toBeNull();
    expect(JSON.parse(state.operate({ operation: 'evidence', query: 'unknown' }) as string)).toMatchObject({
      observations: [], total: 0, nextOffset: null, scope: { kind: 'retained_observations', retained: 3, capacity: 128 },
    });
    for (const args of [{ offset: -1 }, { limit: 0 }, { limit: 21 }, { query: false }]) {
      expect(state.operate({ operation: 'evidence', ...args })).toMatchObject({ failed: true });
    }
  });

  it('re-resolves replayed Memory reads and writes without changing the original event records', () => {
    const { state } = rig(); set(state, '新观察已完成', newAt, 0);
    const records = [functionCall('old', 'memory_record', '{"operation":"read"}'), functionResult('old', '旧版本待办'),
      functionCall('note', 'read_file', JSON.stringify({ path: RECENT_FILE })), functionResult('note', '旧门没开'),
      functionCall('archive', 'read_file', JSON.stringify({ path: RECENT_FILE, history: true })), functionResult('archive', '当时门没开'),
      functionCall('legacy-search', 'grep_files', '{"pattern":"门"}'), functionResult('legacy-search', '旧搜索说门还没开')];
    const view = state.project(records, path => path === RECENT_FILE).map(record => itemText(record.item)).join('\n');
    expect(view).toContain('新观察已完成'); expect(view).not.toContain('旧版本待办'); expect(view).not.toContain('旧门没开');
    expect(view).toContain('当时门没开'); expect(itemText(records[1].item)).toBe('旧版本待办');
    expect(view).not.toContain('旧搜索说门还没开'); expect(view).toContain('原参数加 history:true');
  });

  it('bounds automatic summaries and evidence previews, retaining explicit full-source reads', () => {
    const { state } = rig();
    for (let index = 0; index < 15; index++) {
      const evidence_id = state.observe({ source: 'world/read', observedAt: newAt, text: `原文 ${index}` + '文'.repeat(7000) });
      state.operate({ operation: 'set', key: `object/${index}`, value: '结论'.repeat(250), expected_revision: 0, evidence_id });
    }
    expect(state.summary().length).toBeLessThanOrEqual(STATE_MEMORY_MAX_CHARS);
    const preview = state.operate({ operation: 'evidence' }) as string;
    expect(preview.length).toBeLessThan(4000);
    const id = JSON.parse(preview).observations[0].id;
    expect(JSON.parse(preview).observations[0].truncated).toBe(true);
    expect((state.operate({ operation: 'evidence', evidence_id: id }) as string).length).toBeGreaterThan(7000);
  });

  it('keeps a targeted version readable beyond the summary budget and preserves a failed write receipt', () => {
    const { state } = rig(); set(state, '较早有效结论', oldAt, 0);
    for (let index = 0; index < 10; index++) {
      const evidence_id = state.observe({ source: 'world/read', observedAt: newAt, text: `新观察 ${index}` });
      state.operate({ operation: 'set', key: `new/${index}`, value: '当前读数'.repeat(100), expected_revision: 0, evidence_id });
    }
    expect(state.summary()).not.toContain('较早有效结论');
    const records = [functionCall('target', 'memory_record', '{"operation":"read","key":"project/portal/access"}'),
      functionResult('target', '先前读数'), functionCall('failed', 'memory_record', '{"operation":"set","key":"project/portal/access"}'),
      functionResult('failed', '[memory failed] 版本冲突；未写入')];
    const projected = state.project(records, () => false);
    expect(JSON.parse(itemText(projected[1].item)).claims[0]).toMatchObject({ revision: 1, value: '较早有效结论' });
    expect(itemText(projected[3].item)).toBe('[memory failed] 版本冲突；未写入');
    const failed = toolOutcomeText({ failed: true, text: '[memory failed] 证据ID无效；未写入' });
    const failedRecords = [functionCall('bad-evidence', 'memory_record', JSON.stringify({
      operation: 'set', key: 'project/portal/access', expected_revision: 1, evidence_id: 'unknown', value: '新结论',
    })), functionResult('bad-evidence', failed)];
    expect(itemText(state.project(failedRecords, () => false)[1].item)).toBe(failed);
  });
});

describe('current memory across Persona read surfaces', () => {
  it('reports an unadopted agenda update as failed and accepts a verified retry after adoption', async () => {
    const { dir } = rig();
    const agenda = new ActivityAgenda(dir);
    agenda.propose(JSON.stringify({ summary: '先核验交付', items: [{ id: 'finish-fish', title: '交付鱼汤',
      why: '已接委托', doneWhen: '服务端确认交付', when: '物资够时', ifBlocked: '查实际缺项', references: [] }] }), agenda.revision(), newAt);
    const before = readFileSync(join(dir, AGENDA_FILE), 'utf8');
    const persona = new CortiV({ memoryDir: dir, dream: () => ({ ...DREAM_DEFAULTS, enabled: false }) });
    personas.push(persona); persona.attach(makeFakeHarnessApi());
    const tool = persona.declareSessions().find(session => session.id === 'main')!.tools().find(tool => tool.name === 'activity_plan')!;
    const args = { operation: 'update', id: 'finish-fish', status: 'done', note: '服务端确认已交付' };
    const result = await tool.handler(args, ctx);
    expect(result).toMatchObject({ failed: true, text: expect.stringContaining('尚未采用') });
    expect(readFileSync(join(dir, AGENDA_FILE), 'utf8')).toBe(before);
    const receipt = typeof result === 'string' ? result : toolOutcomeText(result);
    const records = [functionCall('agenda-error', tool.name, JSON.stringify(args)), functionResult('agenda-error', receipt)];
    const prepared = persona.prepareRequest({ sessionId: 'main', round: 2, messages: records }) ?? records;
    expect(itemText(prepared.find(record => record.item.type === 'function_call_output')!.item)).toBe(receipt);
    expect(receipt).toContain('[tool failed]');
    await tool.handler({ operation: 'adopt', id: 'finish-fish' }, ctx);
    expect(await tool.handler(args, ctx)).not.toHaveProperty('failed');
    expect(new ActivityAgenda(dir).state().items.find(item => item.id === 'finish-fish')?.status).toBe('done');
  });

  it('reports an invalid wait as failed without creating a task, then persists a valid retry', async () => {
    const { dir } = rig();
    const persona = new CortiV({ memoryDir: dir, dream: () => ({ ...DREAM_DEFAULTS, enabled: false }) });
    personas.push(persona); persona.attach(makeFakeHarnessApi());
    const tool = persona.declareSessions().find(session => session.id === 'main')!.tools().find(tool => tool.name === 'pending_work')!;
    const file = join(dir, 'pending-work.json');
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const result = await tool.handler({ operation: 'defer', id: 'fish', note: '等新的钓竿' }, ctx);
    expect(result).toMatchObject({ failed: true, text: expect.stringContaining('after_seconds 或 wait_for') });
    expect(existsSync(file) ? readFileSync(file, 'utf8') : null).toBe(before);
    expect(await tool.handler({ operation: 'defer', id: 'fish', note: '等新的钓竿', after_seconds: 120 }, ctx)).not.toHaveProperty('failed');
    expect(JSON.parse(readFileSync(file, 'utf8')).entries.find((entry: { id: string }) => entry.id === 'fish')?.status).toBe('waiting');
    await tool.handler({ operation: 'resolve', id: 'fish', result: '已确认新钓竿入包' }, ctx);
    expect(JSON.parse(readFileSync(file, 'utf8')).entries.find((entry: { id: string }) => entry.id === 'fish')?.status).toBe('resolved');
  });

  it('rejects an invalid history flag and reads the original after a boolean retry', async () => {
    const { dir, memory } = rig();
    const original = '2026-08-01T10:00:00Z 旧取材点 (-10,64,20)';
    memory.writeFileAtomic(RECENT_FILE, original);
    const persona = new CortiV({ memoryDir: dir, dream: () => ({ ...DREAM_DEFAULTS, enabled: false }) });
    personas.push(persona); persona.attach(makeFakeHarnessApi());
    const tools = persona.declareSessions().find(session => session.id === 'main')!.tools();
    const reader = tools.find(tool => tool.name === 'read_file')!;
    const grep = tools.find(tool => tool.name === 'grep_files')!;
    for (const history of ['True', 'false', null]) {
      for (const [tool, args] of [[reader, { path: RECENT_FILE }], [grep, { pattern: '旧取材点' }]] as const) {
        const result = await tool.handler({ ...args, history }, ctx);
        expect(result).toMatchObject({ failed: true, text: expect.stringContaining('history:true（不加引号）') });
        expect(JSON.stringify(result)).not.toContain('(-10,64,20)');
        expect(JSON.stringify(result)).not.toContain('[当前记忆视图；');
        const receipt = typeof result === 'string' ? result : toolOutcomeText(result);
        const records = [functionCall('invalid', tool.name, JSON.stringify({ ...args, history })),
          functionResult('invalid', receipt), message('user', '核对读取结果')];
        const prepared = persona.prepareRequest({ sessionId: 'main', round: 2, messages: records }) ?? records;
        const reply = prepared.find(record => record.item.type === 'function_call_output')!;
        expect(itemText(reply.item)).toBe(receipt);
      }
    }
    expect(await reader.handler({ path: RECENT_FILE, history: false }, ctx)).not.toContain(original);
    expect(await reader.handler({ path: RECENT_FILE, history: true }, ctx)).toContain(original);
    expect(await grep.handler({ pattern: '旧取材点', history: true }, ctx)).toContain(`${RECENT_FILE}:1:`);
    expect(memory.readFile(RECENT_FILE)).toBe(original);
  });

  it('discloses the current view before pagination and retrieves original coordinates through explicit history', async () => {
    const { dir, memory } = rig();
    const journal = [...Array.from({ length: 60 }, (_, index) => `旧经历 ${index + 1}`),
      '2026-08-01T10:00:00Z 取材回执：箱子 (-10,64,20) 存入原木2个'].join('\n');
    memory.writeFileAtomic(RECENT_FILE, journal);
    memory.writeFileAtomic('methods/example.md', '普通方法说明');
    const persona = new CortiV({ memoryDir: dir, dream: () => ({ ...DREAM_DEFAULTS, enabled: false }) });
    personas.push(persona); persona.attach(makeFakeHarnessApi());
    const tools = persona.declareSessions().find(session => session.id === 'main')!.tools();
    const reader = tools.find(tool => tool.name === 'read_file')!;
    const view = await reader.handler({ path: RECENT_FILE, offset: -1, limit: 1, max_chars: 1 }, ctx) as string;
    expect(view.startsWith('[当前记忆视图；')).toBe(true);
    expect(view).toContain('行号和分页只对应此视图');
    expect(view).toContain(JSON.stringify({ path: RECENT_FILE, history: true }));
    expect(view).not.toContain('(-10,64,20)');
    const readRecords = [functionCall('view', 'read_file', JSON.stringify({ path: RECENT_FILE, offset: -1, limit: 1, max_chars: 1 })),
      functionResult('view', view), message('user', '查原始经历')];
    const requestView = persona.prepareRequest({ sessionId: 'main', round: 2, messages: readRecords })!
      .filter(record => record.item.type === 'function_call_output').map(record => itemText(record.item)).join('\n');
    expect(requestView).toContain(RECENT_FILE);
    expect(requestView).toContain('history:true'); expect(requestView).not.toContain('(-10,64,20)');
    const history = await reader.handler({ path: RECENT_FILE, offset: -1, limit: 1, history: true }, ctx) as string;
    expect(history).toContain('第 61-61 行,共 61 行');
    expect(history).toContain('2026-08-01T10:00:00Z 取材回执：箱子 (-10,64,20) 存入原木2个');
    const grep = tools.find(tool => tool.name === 'grep_files')!;
    const search = await grep.handler({ pattern: '取材回执' }, ctx) as string;
    expect(search.startsWith('[检索范围：')).toBe(true);
    expect(search).toContain('原参数加 history:true'); expect(search).not.toContain('(-10,64,20)');
    expect(await grep.handler({ pattern: '取材回执', history: true }, ctx)).toContain(`${RECENT_FILE}:61:`);
    const methodSearch = await grep.handler({ pattern: '普通方法说明' }, ctx) as string;
    const searchRecords = [functionCall('method', 'grep_files', '{"pattern":"普通方法说明"}'), functionResult('method', methodSearch),
      functionCall('history', 'read_file', JSON.stringify({ path: RECENT_FILE, history: true })), functionResult('history', history)];
    const requestSearch = (persona.prepareRequest({ sessionId: 'main', round: 3, messages: searchRecords }) ?? searchRecords)
      .filter(record => record.item.type === 'function_call_output').map(record => itemText(record.item)).join('\n');
    expect(requestSearch).toContain('methods/example.md:1: 普通方法说明');
    expect(requestSearch).toContain('2026-08-01T10:00:00Z 取材回执');
    expect(await reader.handler({ path: 'methods/example.md' }, ctx)).not.toContain('[当前记忆视图；');
    expect(memory.readFile(RECENT_FILE)).toBe(journal);
  });

  it('keeps legacy text out of default reads, search, planning and handoff while allowing explicit history', async () => {
    const { dir, memory } = rig();
    writeFileSync(join(dir, 'CONSTITUTION.md'), '保留身份与原则');
    memory.writeFileAtomic(RECENT_FILE, '旧门缺材料'); memory.writeFileAtomic('goals/project.md', '旧项目状态也缺材料');
    const injected: string[] = [];
    const persona = new CortiV({ memoryDir: dir,
      dream: () => ({ ...DREAM_DEFAULTS, enabled: false }),
      foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS, memoryFiles: 'goals/project.md' }) });
    personas.push(persona); persona.attach(makeFakeHarnessApi({ injectExternal: value => { injected.push(value); } }));
    const tools = persona.declareSessions().find(session => session.id === 'main')!.tools();
    const reader = tools.find(tool => tool.name === 'read_file')!;
    expect(await reader.handler({ path: RECENT_FILE }, ctx)).not.toContain('旧门缺材料');
    expect(await reader.handler({ path: `alias/../${RECENT_FILE}` }, ctx)).not.toContain('旧门缺材料');
    expect(await reader.handler({ path: RECENT_FILE, history: true }, ctx)).toContain('旧门缺材料');
    const backup = JSON.parse(memory.readFile(STATE_MEMORY_FILE)).legacy[RECENT_FILE].archive;
    expect(await reader.handler({ path: backup }, ctx)).not.toContain('旧门缺材料');
    expect(await reader.handler({ path: backup, history: true }, ctx)).toContain('旧门缺材料');
    expect(await reader.handler({ path: STATE_MEMORY_FILE }, ctx)).not.toContain('"legacy":');
    expect(await reader.handler({ path: STATE_MEMORY_FILE, history: true }, ctx)).toContain('"legacy":');
    expect(await reader.handler({ path: 'CONSTITUTION.md' }, ctx)).toContain('保留身份与原则');
    const grep = tools.find(tool => tool.name === 'grep_files')!;
    expect(await grep.handler({ pattern: '缺材料' }, ctx)).not.toContain('旧门缺材料');
    expect(await grep.handler({ pattern: '缺材料', history: true }, ctx)).toContain('旧门缺材料');
    const records = [functionCall('legacy', 'read_file', JSON.stringify({ path: RECENT_FILE })),
      functionResult('legacy', '旧门缺材料', { ts: oldAt }), message('user', '继续当前工作')];
    expect(persona.prepareRequest({ sessionId: 'main', round: 1, messages: records })!.map(record => itemText(record.item)).join('\n')).not.toContain('旧门缺材料');
    await persona.onHandoff(records, { hardTokens: null });
    expect(injected.join('\n')).not.toContain('旧门缺材料');
    expect(await tools.find(tool => tool.name === 'write_file')!.handler({ path: STATE_MEMORY_FILE, content: '{}' }, ctx)).toContain('由记忆管理器维护');
    expect(await tools.find(tool => tool.name === 'write_file')!.handler({ path: `alias/../${STATE_MEMORY_FILE}`, content: '{}' }, ctx)).toContain('由记忆管理器维护');
  });
});
