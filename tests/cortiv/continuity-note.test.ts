import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CortiV, RECENT_FILE } from '../../bots/cortiv/persona/persona.ts';
import { FOREGROUND_CONTEXT_DEFAULTS } from '../../bots/cortiv/persona/foreground-context.ts';
import { itemText, message, type ContextRecord } from '../../src/protocol/open-responses/context.ts';
import { validatePairing } from '../../src/core/truncate.ts';
import type { World } from '../../src/core/types.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function rig() {
  const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-note-'));
  dirs.push(memoryDir);
  const config = { ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true };
  const world: World = { id: 'game', envPromptVars: () => ({}), tools: () => [],
    start: async () => {}, stop: async () => {}, requestFacts: () => ({
      text: 'Observed at 2026-01-01T00:00:10Z: workshop complete, queue idle.', snapshotTypes: ['game.state'],
    }) };
  const persona = new CortiV({ memoryDir, foreground: () => config, worlds: [world] });
  const records = [message('system', 'Environment contract'), message('user', 'A player asks about our next project.')];
  const prepare = () => persona.prepareRequest({ sessionId: 'main', round: 1, messages: records })!;
  return { persona, memoryDir, records, config, prepare };
}

function text(records: readonly ContextRecord[]): string { return records.map(row => itemText(row.item)).join('\n'); }

describe('latest continuity note in foreground requests', () => {
  it('retains configured long-term intentions after the rolling note is replaced or removed, including after a new Persona is created', () => {
    const r = rig();
    Object.assign(r.config, { memoryFiles: 'goals/projects.md' });
    const projects = '# 未完成成果\n- 房屋改善：入口和外观待验收。\n- 修路：先核验起止地形。\n';
    r.persona.memory.writeFileAtomic('goals/projects.md', projects);
    r.persona.memory.writeFileAtomic(RECENT_FILE, '房屋和修路待办见 goals/projects.md。');
    r.prepare();
    r.persona.memory.writeFileAtomic(RECENT_FILE, '刚交付面包，背包有两块铜。');
    const view = r.prepare();
    expect(text(view)).toContain('房屋改善');
    expect(text(view)).toContain('修路');
    rmSync(join(r.memoryDir, RECENT_FILE));
    const restored = new CortiV({ memoryDir: r.memoryDir, foreground: () => r.config });
    const next = restored.prepareRequest({ sessionId: 'main', round: 1, messages: [message('user', '委托结束了，接下来做什么？')] })!;
    expect(text(next)).toContain('房屋改善');
    expect(text(next)).toContain('修路');
    expect(text(next)).toContain('goals/projects.md');
    expect(r.persona.memory.readFile('goals/projects.md')).toBe(projects);
    expect(validatePairing(next)).toEqual([]);
  });

  it('places a bounded independent Memory index before current World facts, then appends only changed source content', () => {
    const r = rig();
    Object.assign(r.config, { memoryFiles: 'goals/projects.md\ngoals/preferences.md' });
    r.persona.memory.writeFileAtomic('goals/projects.md', '# 项目\n- 旧观察：工作间尚未完成。\n- 建桥：先勘测。\n');
    r.persona.memory.writeFileAtomic('goals/preferences.md', '# 偏好\n自由探索、与同伴交往。');
    const first = r.prepare();
    const index = first.findIndex(row => itemText(row.item).startsWith('[长期记忆索引]'));
    expect(index).toBeGreaterThan(-1);
    expect(first.findIndex(row => itemText(row.item).includes('workshop complete'))).toBeGreaterThan(index);
    expect(itemText(first[index].item)).toContain('历史线索');
    expect(r.prepare()).toEqual(first);
    r.persona.memory.writeFileAtomic('goals/projects.md', '# 项目\n- 建桥：勘测已核验，下一步准备桥面。');
    const second = r.prepare();
    expect(second.slice(0, first.length)).toEqual(first);
    expect(text(second.slice(first.length))).toContain('勘测已核验');
    expect(r.prepare()).toEqual(second);
    rmSync(join(r.memoryDir, 'goals/projects.md'));
    expect(text(r.prepare())).toContain('文件不可读');
    const injected: string[] = [];
    r.persona.attach(makeFakeHarnessApi({ injectInternal: (body, type) => { if (type === 'memory_index') injected.push(body); } }));
    r.config.enabled = false;
    r.persona.onDelivery({ events: [] });
    r.persona.onDelivery({ events: [] });
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain('goals/preferences.md');
  });

  it('retains an existing intention and its detail pointer, followed by newer World facts, without changing Memory or the session', () => {
    const r = rig();
    const note = '# 续做入口\n## 未完成成果\n修路尚未验收，先勘测。详情 goals/projects.md。\n';
    r.persona.memory.writeFileAtomic(RECENT_FILE, note);
    const before = structuredClone(r.records);
    const view = r.prepare();
    const source = view.findIndex(row => itemText(row.item).startsWith('[续做笔记 ·'));
    const facts = view.findIndex(row => itemText(row.item).includes('workshop complete'));
    expect(source).toBeGreaterThan(-1);
    expect(facts).toBeGreaterThan(source);
    expect(itemText(view[source].item)).toContain('详情 goals/projects.md');
    expect(itemText(view[source].item)).toContain('历史线索');
    expect(itemText(view[source].item)).toContain('没有与本版正文绑定的观察时间');
    expect(readFileSync(join(r.memoryDir, RECENT_FILE), 'utf8')).toBe(note);
    expect(r.records).toEqual(before);
    expect(validatePairing(view)).toEqual([]);
  });

  it('keeps the previous request prefix intact and appends a changed note once, including a return to an older body', () => {
    const r = rig();
    r.persona.memory.writeFileAtomic(RECENT_FILE, '修路待勘测。');
    const first = r.prepare();
    expect(r.prepare()).toEqual(first);
    r.persona.memory.writeFileAtomic(RECENT_FILE, '路线已核验，下一步收集石材。');
    const second = r.prepare();
    expect(second.slice(0, first.length)).toEqual(first);
    expect(text(second.slice(first.length))).toContain('路线已核验');
    expect(r.prepare()).toEqual(second);
    r.persona.memory.writeFileAtomic(RECENT_FILE, '修路待勘测。');
    const third = r.prepare();
    expect(third.slice(0, second.length)).toEqual(second);
    expect(text(third.slice(second.length))).toContain('修路待勘测');
  });

  it('reports a removed note instead of leaving the previous intention as the latest state', () => {
    const r = rig();
    r.persona.memory.writeFileAtomic(RECENT_FILE, '去旧工地。');
    const first = r.prepare();
    rmSync(join(r.memoryDir, RECENT_FILE));
    const cleared = r.prepare();
    expect(cleared.slice(0, first.length)).toEqual(first);
    expect(text(cleared.slice(first.length))).toContain('当前没有短笺');
    expect(r.prepare()).toEqual(cleared);
  });

  it('excerpts a long note and retains the full original for explicit reading', () => {
    const r = rig();
    const note = '# 续做入口\n## 未完成成果\n路面仍待验收，详情 goals/projects.md。\n## 历史\n' + '带日期的历史观察。'.repeat(2000);
    r.persona.memory.writeFileAtomic(RECENT_FILE, note);
    const noteText = itemText(r.prepare().find(row => itemText(row.item).startsWith('[续做笔记 ·'))!.item);
    expect(noteText.length).toBeLessThan(1500);
    expect(noteText).toContain('goals/projects.md');
    expect(noteText).toContain(`read_file 读取 ${RECENT_FILE}`);
    expect(r.persona.memory.readFile(RECENT_FILE)).toBe(note);
    expect(r.persona.prepareRequest({ sessionId: 'dream', round: 1, messages: r.records })).toBeNull();
  });

  it('delivers a changed note when foreground projection is disabled without repeatedly injecting unchanged content', () => {
    const r = rig();
    const injected: string[] = [];
    r.persona.attach(makeFakeHarnessApi({ injectInternal: (body, type) => { if (type === 'recent_memory') injected.push(body); } }));
    r.persona.memory.writeFileAtomic(RECENT_FILE, '研究桥梁结构，详情 goals/bridge.md。');
    r.persona.onOpening({ reason: 'restarted' });
    expect(text(r.prepare())).toContain('goals/bridge.md');
    expect(injected).toHaveLength(0);
    r.config.enabled = false;
    r.persona.onDelivery({ events: [] });
    r.persona.onDelivery({ events: [] });
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain('goals/bridge.md');
  });
});
