import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityAgenda, AGENDA_FILE, AGENDA_SUMMARY_MAX_CHARS, type AgendaPlan } from '../../bots/cortiv/persona/activity-agenda.ts';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { FOREGROUND_CONTEXT_DEFAULTS } from '../../bots/cortiv/persona/foreground-context.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';
import { nullLogger } from '../../src/core/util.ts';
import { message, itemText } from '../../src/protocol/open-responses/context.ts';

const dirs: string[] = [];
const now = () => Date.parse('2026-10-06T00:00:00Z');
const stamp = new Date(now()).toISOString();
function plan(): AgendaPlan {
  return { summary: '把当前作品收尾，再换一个可以推进的方向。', items: [
    { id: 'finish-home', title: '改善入口', why: '已有主体，不必反复重建', doneWhen: '入口可通行并实际验收',
      when: '现场安全且材料够一个阶段', ifBlocked: '记下阻碍，去沿河探索', references: ['goals/current-projects.md'] },
    { id: 'river', title: '沿河探索', why: '近期没去新地方', doneWhen: '发现并记录一个新地点',
      when: '携带够返程的补给', ifBlocked: '补给不足时先处理具体缺口', references: [] },
  ] };
}
function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'cortiv-agenda-')); dirs.push(dir);
  return { dir, agenda: new ActivityAgenda(dir, now) };
}
function adopt(agenda: ActivityAgenda, value = plan()) {
  agenda.propose(JSON.stringify(value), agenda.revision(), stamp);
  return agenda.operate({ operation: 'adopt' });
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('persistent Persona activity agenda', () => {
  it('background proposal does not select or execute an activity; adoption and focus are separate decisions', () => {
    const { agenda } = rig();
    agenda.propose(JSON.stringify(plan()), 0, stamp);
    expect(agenda.state().items).toEqual([]);
    expect(agenda.state().proposal?.items).toHaveLength(2);
    agenda.operate({ operation: 'adopt' });
    expect(agenda.state().items.every(item => item.status === 'queued')).toBe(true);
    agenda.operate({ operation: 'focus', id: 'river' });
    expect(agenda.state().items.find(item => item.status === 'active')?.id).toBe('river');
  });
  it('restores active progress and blocked alternatives across restart', () => {
    const { dir, agenda } = rig(); adopt(agenda);
    agenda.operate({ operation: 'focus', id: 'finish-home' });
    agenda.operate({ operation: 'update', id: 'finish-home', note: '已修两个入口格，待实际通行' });
    agenda.operate({ operation: 'update', id: 'river', status: 'deferred', note: '现在没带足够食物' });
    expect(new ActivityAgenda(dir, now).state()).toEqual(agenda.state());
    expect(new ActivityAgenda(dir, now).summary()).toContain('待实际通行');
  });
  it('a late proposal cannot overwrite foreground progress or completion', () => {
    const { agenda } = rig(); adopt(agenda);
    const captured = agenda.revision();
    agenda.operate({ operation: 'update', id: 'finish-home', status: 'done', note: '实际通行验收已通过' });
    agenda.propose(JSON.stringify(plan()), captured, stamp);
    expect(agenda.operate({ operation: 'adopt' })).toContain('不能覆盖');
    expect(agenda.state().items[0]).toMatchObject({ status: 'done', note: '实际通行验收已通过' });
  });
  it('fresh candidate preserves stable objective evidence; focus never reopens a completed phase', () => {
    const { agenda } = rig(); adopt(agenda);
    agenda.operate({ operation: 'update', id: 'finish-home', status: 'done', note: '通行验收通过' });
    adopt(agenda);
    expect(agenda.state().items[0]).toMatchObject({ status: 'done', note: '通行验收通过' });
    expect(agenda.operate({ operation: 'focus', id: 'finish-home' })).toContain('已完成');
    expect(agenda.operate({ operation: 'update', id: 'finish-home', status: 'queued', note: '又想检查' })).toContain('已完成');
  });
  it('switching focus retains evidence and only selects one phase; repeated focus is idempotent', () => {
    const { agenda } = rig(); adopt(agenda);
    agenda.operate({ operation: 'focus', id: 'finish-home' });
    const revision = agenda.revision();
    agenda.operate({ operation: 'focus', id: 'finish-home' });
    expect(agenda.revision()).toBe(revision);
    agenda.operate({ operation: 'focus', id: 'river' });
    expect(agenda.state().items.map(item => item.status)).toEqual(['queued', 'active']);
  });
  it('invalid, duplicate or oversized candidate leaves the accepted agenda and persisted file untouched', () => {
    const { dir, agenda } = rig(); adopt(agenda);
    const before = readFileSync(join(dir, AGENDA_FILE), 'utf8');
    const invalid = [ '正文建议', JSON.stringify({ summary: '任务', items: [{}] }),
      JSON.stringify({ ...plan(), items: [plan().items[0], plan().items[0]] }),
      JSON.stringify({ ...plan(), items: Array.from({ length: 9 }, (_, index) => ({ ...plan().items[0], id: String(index) })) }) ];
    for (const value of invalid) expect(agenda.propose(value, agenda.revision(), stamp)).toContain('未保存');
    expect(readFileSync(join(dir, AGENDA_FILE), 'utf8')).toBe(before);
  });
  it('progress requires evidence and rejects unsupported status', () => {
    const { agenda } = rig(); adopt(agenda); const before = agenda.state();
    for (const args of [{ operation: 'update', id: 'river', status: 'done' },
      { operation: 'update', id: 'river', status: 'active', note: '已发起' },
      { operation: 'focus', id: 'missing' }]) expect(agenda.operate(args)).toContain('错误');
    expect(agenda.state()).toEqual(before);
  });
  it('the per-call summary is bounded while full details remain readable', () => {
    const { agenda } = rig();
    const value = plan(); value.items = Array.from({ length: 8 }, (_, index) => ({ ...value.items[0],
      id: String(index), title: '较长活动标题'.repeat(15), doneWhen: '完成证据'.repeat(50),
      when: '可执行条件'.repeat(45), ifBlocked: '恢复条件'.repeat(50) }));
    adopt(agenda, value); agenda.operate({ operation: 'focus', id: '0' });
    expect(agenda.summary().length).toBeLessThanOrEqual(AGENDA_SUMMARY_MAX_CHARS);
    expect(JSON.parse(agenda.operate({ operation: 'read' })).items).toHaveLength(8);
  });
  it('bad saved data is preserved and reported rather than silently discarding intentions', () => {
    const { dir } = rig(); const saved = '{"version":1,"items":"broken"}';
    writeFileSync(join(dir, AGENDA_FILE), saved);
    expect(() => new ActivityAgenda(dir)).toThrow('原文件未修改');
    expect(readFileSync(join(dir, AGENDA_FILE), 'utf8')).toBe(saved);
  });
  it('Persona tools restore the plan, protect owned memory and pin its compact summary in short requests', async () => {
    const { dir, agenda } = rig(); adopt(agenda); agenda.operate({ operation: 'focus', id: 'river' });
    const persona = new CortiV({ memoryDir: dir, tickDelayMs: () => null,
      foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true }) });
    persona.attach(makeFakeHarnessApi());
    const tool = persona.declareSessions().find(session => session.id === 'main')!.tools().find(tool => tool.name === 'activity_plan')!;
    const reply = await tool.handler({ operation: 'read' }, { role: 'main', log: nullLogger() });
    expect(JSON.parse(String(reply)).items[1].status).toBe('active');
    const view = persona.prepareRequest({ sessionId: 'main', round: 1, messages: [message('user', '继续')] });
    expect(view!.map(record => itemText(record.item)).join('\n')).toContain('沿河探索');
    expect((persona as unknown as { writeGuard: (operation: 'write', path: string, role: string) => string | null })
      .writeGuard('write', AGENDA_FILE, 'main')).toContain('activity_plan');
  });
});
