import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorkspaceMemory } from '../../bots/cormini/persona/memory.ts';
import { CortiV, RECENT_FILE } from '../../bots/cortiv/persona/persona.ts';
import { FOREGROUND_CONTEXT_DEFAULTS } from '../../bots/cortiv/persona/foreground-context.ts';
import { DREAM_DEFAULTS } from '../../bots/cortiv/persona/dream-context.ts';
import { StateMemory, STATE_MEMORY_FILE, STATE_MEMORY_MAX_CHARS } from '../../bots/cortiv/persona/state-memory.ts';
import { functionCall, functionResult, itemText, message } from '../../src/protocol/open-responses/context.ts';
import { nullLogger } from '../../src/core/util.ts';
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

  it('re-resolves replayed Memory reads and writes without changing the original event records', () => {
    const { state } = rig(); set(state, '新观察已完成', newAt, 0);
    const records = [functionCall('old', 'memory_record', '{"operation":"read"}'), functionResult('old', '旧版本待办'),
      functionCall('note', 'read_file', JSON.stringify({ path: RECENT_FILE })), functionResult('note', '旧门没开'),
      functionCall('archive', 'read_file', JSON.stringify({ path: RECENT_FILE, history: true })), functionResult('archive', '当时门没开')];
    const view = state.project(records, path => path === RECENT_FILE).map(record => itemText(record.item)).join('\n');
    expect(view).toContain('新观察已完成'); expect(view).not.toContain('旧版本待办'); expect(view).not.toContain('旧门没开');
    expect(view).toContain('当时门没开'); expect(itemText(records[1].item)).toBe('旧版本待办');
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
  });
});

describe('current memory across Persona read surfaces', () => {
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
    const history = await reader.handler({ path: RECENT_FILE, offset: -1, limit: 1, history: true }, ctx) as string;
    expect(history).toContain('第 61-61 行,共 61 行');
    expect(history).toContain('2026-08-01T10:00:00Z 取材回执：箱子 (-10,64,20) 存入原木2个');
    const grep = tools.find(tool => tool.name === 'grep_files')!;
    const search = await grep.handler({ pattern: '取材回执' }, ctx) as string;
    expect(search.startsWith('[检索范围：')).toBe(true);
    expect(search).toContain('原参数加 history:true'); expect(search).not.toContain('(-10,64,20)');
    expect(await grep.handler({ pattern: '取材回执', history: true }, ctx)).toContain(`${RECENT_FILE}:61:`);
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
