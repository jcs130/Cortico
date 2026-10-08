import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CortiV, RECENT_FILE } from '../../bots/cortiv/persona/persona.ts';
import { StateMemory, STATE_MEMORY_MAX_CHARS } from '../../bots/cortiv/persona/state-memory.ts';
import { FOREGROUND_CONTEXT_DEFAULTS } from '../../bots/cortiv/persona/foreground-context.ts';
import { itemText, message, type ContextRecord } from '../../src/protocol/open-responses/context.ts';
import { validatePairing } from '../../src/core/truncate.ts';
import type { World } from '../../src/core/types.ts';
import { nullLogger } from '../../src/core/util.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rig() {
  const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-note-')); dirs.push(memoryDir);
  const config = { ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true };
  const world: World = { id: 'game', envPromptVars: () => ({}), tools: () => [], start: async () => {}, stop: async () => {},
    requestFacts: () => ({ text: 'Observed at 2026-01-01T00:00:10Z: workshop complete, queue idle.', snapshotTypes: ['game.state'] }) };
  const persona = new CortiV({ memoryDir, foreground: () => config, worlds: [world] });
  const state = new StateMemory(persona.memory);
  const records = [message('system', 'Environment contract'), message('user', 'A player asks about our next project.')];
  const prepare = () => persona.prepareRequest({ sessionId: 'main', round: 1, messages: records })!;
  const remember = (value: string, revision = 0) => {
    const evidence_id = state.observe({ source: 'game/result', observedAt: `2026-01-01T00:00:${String(10 + revision).padStart(2, '0')}Z`, text: value });
    return state.operate({ operation: 'set', key: 'project/bridge', value, expected_revision: revision, evidence_id });
  };
  return { persona, state, remember, memoryDir, config, records, prepare };
}
function text(records: readonly ContextRecord[]): string { return records.map(row => itemText(row.item)).join('\n'); }

describe('versioned continuity in foreground requests', () => {
  it('retains a dated claim after the rolling note is replaced or removed and after restart', () => {
    const r = rig(); r.remember('桥梁路线已核验，下一步准备桥面。');
    r.persona.memory.writeFileAtomic(RECENT_FILE, '旧记录：路线尚未勘测'); r.prepare();
    r.persona.memory.writeFileAtomic(RECENT_FILE, '刚整理：路线尚未勘测');
    expect(text(r.prepare())).toContain('桥梁路线已核验'); expect(text(r.prepare())).not.toContain('路线尚未勘测');
    rmSync(join(r.memoryDir, RECENT_FILE));
    const restored = new CortiV({ memoryDir: r.memoryDir, foreground: () => r.config });
    const next = restored.prepareRequest({ sessionId: 'main', round: 1, messages: r.records })!;
    expect(text(next)).toContain('桥梁路线已核验'); expect(validatePairing(next)).toEqual([]);
  });
  it('exposes configured historical entry points before World facts without injecting old project states', () => {
    const r = rig(); r.config.memoryFiles = 'goals/projects.md\ngoals/preferences.md';
    r.persona.memory.writeFileAtomic('goals/projects.md', '# 旧项目\n- 工作间尚未完成。');
    r.persona.memory.writeFileAtomic('goals/preferences.md', '# 当时的生活安排');
    const first = r.prepare(); const index = first.findIndex(row => itemText(row.item).startsWith('[长期记忆索引]'));
    expect(index).toBeGreaterThan(-1);
    expect(first.findIndex(row => itemText(row.item).includes('workshop complete'))).toBeGreaterThan(index);
    expect(itemText(first[index].item)).toContain('goals/projects.md'); expect(text(first)).not.toContain('工作间尚未完成');
    r.persona.memory.writeFileAtomic('goals/projects.md', '# 新写入的旧结论\n- 工作间尚未完成。');
    expect(text(r.prepare())).not.toContain('工作间尚未完成');
  });
  it('keeps current claims and newer World facts without modifying original notes or session records', () => {
    const r = rig(); r.remember('实际已验收的路线，详情 design/bridge.md。');
    const note = '旧计划：路线未验收'; r.persona.memory.writeFileAtomic(RECENT_FILE, note);
    const before = structuredClone(r.records); const view = r.prepare();
    const source = view.findIndex(row => itemText(row.item).startsWith('[当前记忆记录'));
    expect(view.findIndex(row => itemText(row.item).includes('workshop complete'))).toBeGreaterThan(source);
    expect(itemText(view[source].item)).toContain('design/bridge.md'); expect(text(view)).not.toContain(note);
    expect(readFileSync(join(r.memoryDir, RECENT_FILE), 'utf8')).toBe(note);
    expect(r.records).toEqual(before); expect(validatePairing(view)).toEqual([]);
  });
  it('removes superseded claim pins rather than keeping them in an append-only request prefix', () => {
    const r = rig(); r.remember('路线尚未核验'); expect(text(r.prepare())).toContain('路线尚未核验');
    r.remember('路线已通行验收', 1); const second = r.prepare();
    expect(text(second)).not.toContain('路线尚未核验'); expect(text(second)).toContain('路线已通行验收');
    expect(r.prepare()).toEqual(second);
    r.persona.memory.writeFileAtomic(RECENT_FILE, '路线尚未核验'); expect(text(r.prepare())).not.toContain('路线尚未核验');
  });
  it('removes a retired claim and does not infer retirement from a deleted prose note', () => {
    const r = rig(); r.remember('旧路线入口'); r.persona.memory.writeFileAtomic(RECENT_FILE, '旧路线入口'); r.prepare();
    rmSync(join(r.memoryDir, RECENT_FILE)); expect(text(r.prepare())).toContain('旧路线入口');
    const evidence_id = r.state.observe({ source: 'game/result', observedAt: '2026-01-01T00:00:11Z', text: '路线已封闭' });
    r.state.operate({ operation: 'retire', key: 'project/bridge', value: '路线已封闭', expected_revision: 1, evidence_id });
    expect(text(r.prepare())).not.toContain('旧路线入口');
  });
  it('bounds automatic current memory and retains full historical prose for explicit reading', async () => {
    const r = rig(); const note = '# 历史\n' + '带日期的旧观察。'.repeat(2000); r.persona.memory.writeFileAtomic(RECENT_FILE, note);
    const noteText = itemText(r.prepare().find(row => itemText(row.item).startsWith('[当前记忆记录'))!.item);
    expect(noteText.length).toBeLessThan(STATE_MEMORY_MAX_CHARS + 200); expect(noteText).toContain('history:true');
    const reader = r.persona.declareSessions()[0].tools().find(tool => tool.name === 'read_file')!;
    const read = await reader.handler({ path: RECENT_FILE, history: true, max_chars: 30000 }, { role: 'main', log: nullLogger() });
    expect(read).toContain(note); expect(r.persona.memory.readFile(RECENT_FILE)).toBe(note);
  });
  it('delivers changed structured state once when projection is disabled and ignores copied prose', () => {
    const r = rig(); const injected: string[] = [];
    r.persona.attach(makeFakeHarnessApi({ injectInternal: (body, type) => { if (type === 'recent_memory') injected.push(body); } }));
    r.remember('桥梁路线已核验'); r.config.enabled = false;
    r.persona.onDelivery({ events: [] }); r.persona.onDelivery({ events: [] });
    expect(injected).toHaveLength(1); expect(injected[0]).toContain('桥梁路线已核验');
    r.persona.memory.writeFileAtomic(RECENT_FILE, '桥梁路线未核验'); r.persona.onDelivery({ events: [] }); expect(injected).toHaveLength(1);
    r.remember('桥面实际验收通过', 1); r.persona.onDelivery({ events: [] });
    expect(injected).toHaveLength(2); expect(injected[1]).toContain('桥面实际验收通过');
  });
});
