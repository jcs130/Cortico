import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityAgenda, AGENDA_FILE, AGENDA_MAX_ITEMS, AGENDA_RECENT_COMPLETIONS, AGENDA_SUMMARY_MAX_CHARS, type AgendaPlan } from '../../bots/cortiv/persona/activity-agenda.ts';
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
  it('invalidates dependent candidates after a premise correction, including a late result across restart', () => {
    const { agenda, dir } = rig(); adopt(agenda);
    const candidate = { ...plan().items[1], id: 'new-route', title: '沿新路线探索' };
    const draft = { summary: '按当前前提出发', items: [candidate] };
    const capturedRevision = agenda.revision();
    agenda.propose(JSON.stringify(draft), capturedRevision, stamp);
    agenda.operate({ operation: 'update', id: 'river', note: '普通进度更新', when: '已有补给可出发' });
    expect(agenda.state().proposal).not.toBeNull();
    const revision = agenda.revision();
    agenda.operate({ operation: 'update', id: 'river', expected_revision: revision,
      why: '原路线依据被最新现场否定', note: '新观测确认原前提不成立，需要重新规划' });
    expect(agenda.state().proposal).toBeNull();
    const restored = new ActivityAgenda(dir, now);
    expect(restored.operate({ operation: 'adopt', id: 'new-route' })).toContain('没有候选');
    const corrected = readFileSync(join(dir, AGENDA_FILE), 'utf8');
    expect(restored.propose(JSON.stringify(draft), capturedRevision, stamp)).toContain('日程候选未保存');
    expect(readFileSync(join(dir, AGENDA_FILE), 'utf8')).toBe(corrected);
    expect(restored.state().items.some(item => item.id === 'new-route')).toBe(false);
    restored.propose(JSON.stringify(draft), restored.revision(), stamp);
    restored.operate({ operation: 'update', id: 'river', expected_revision: restored.revision(),
      why: '原路线依据被最新现场否定', note: '同一前提再次核对，没有订正' });
    expect(restored.state().proposal).not.toBeNull();
    restored.operate({ operation: 'adopt', id: 'new-route' });
    expect(restored.state().items.some(item => item.id === 'new-route')).toBe(true);
  });
  it('conservatively retires a legacy candidate when dated premise corrections lack a revision boundary', () => {
    const { agenda, dir } = rig(); adopt(agenda);
    agenda.operate({ operation: 'update', id: 'river', expected_revision: agenda.revision(),
      why: '有现场证据的新前提', note: '原前提已订正' });
    agenda.propose(JSON.stringify({ summary: '新候选', items: [{ ...plan().items[1], id: 'new-route' }] }), agenda.revision(), stamp);
    const file = join(dir, AGENDA_FILE), legacy = JSON.parse(readFileSync(file, 'utf8'));
    delete legacy.premiseRevision;
    writeFileSync(file, JSON.stringify(legacy));
    const restored = new ActivityAgenda(dir, now);
    expect(restored.state().proposal).toBeNull();
    expect(restored.state().items).toEqual(agenda.state().items);
    expect(restored.state().revision).toBe(agenda.revision());
    expect(restored.propose(JSON.stringify(plan()), agenda.revision() - 1, stamp)).toContain('日程候选未保存');
  });
  it('revises an adopted premise by revision, preserves its dated history and excludes that history from planning', () => {
    const { dir } = rig(); let at = now();
    const agenda = new ActivityAgenda(dir, () => at); adopt(agenda);
    agenda.operate({ operation: 'focus', id: 'river' });
    const original = agenda.state().items.find(item => item.id === 'river')!;
    const current = JSON.parse(agenda.operate({ operation: 'read', id: 'river' }));
    at += 60_000;
    agenda.operate({ operation: 'update', id: 'river', expected_revision: current.revision,
      why: '新地点已经发现，尚需记录该地点', note: '最新探索回执确认新地点存在，原背景已失效' });
    const restored = new ActivityAgenda(dir, () => at);
    const corrected = JSON.parse(restored.operate({ operation: 'read', id: 'river' })).items[0];
    expect(corrected).toMatchObject({ ...original, why: '新地点已经发现，尚需记录该地点',
      whyUpdatedAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(),
      note: '最新探索回执确认新地点存在，原背景已失效',
      whyHistory: [{ why: original.why, sourceAt: stamp, correctedAt: new Date(at).toISOString(),
        correctionNote: '最新探索回执确认新地点存在，原背景已失效' }] });
    const planning = JSON.parse(restored.planningReadout());
    expect(planning.items.find((item: { id: string }) => item.id === 'river')).toMatchObject({
      why: corrected.why, whyUpdatedAt: corrected.whyUpdatedAt, status: 'active', doneWhen: original.doneWhen });
    expect(planning.items.find((item: { id: string }) => item.id === 'river')).not.toHaveProperty('whyHistory');
    expect(restored.planningReadout()).not.toContain(original.why);
    expect(JSON.parse(restored.operate({ operation: 'read' })).items.find((item: { id: string }) => item.id === 'river')).not.toHaveProperty('whyHistory');
    adopt(restored);
    expect(restored.state().items.find(item => item.id === 'river')).toEqual(corrected);
    at += 60_000;
    restored.operate({ operation: 'update', id: 'river', expected_revision: restored.revision(),
      why: '记录已补足，等待实际验收', note: '新增地点记录已经核对' });
    const twice = JSON.parse(restored.operate({ operation: 'read', id: 'river' })).items[0];
    expect(twice.whyHistory[1]).toMatchObject({ why: corrected.why, sourceAt: corrected.whyUpdatedAt });
    expect(twice.sourceCapturedAt).toBe(stamp);
    expect(twice.doneWhen).toBe(original.doneWhen);
  });
  it('rejects stale, malformed and out-of-scope premise corrections without changing persisted state', () => {
    const { agenda, dir } = rig(); adopt(agenda);
    const revision = agenda.revision();
    const input = { operation: 'update', id: 'river', expected_revision: revision, why: '新的背景', note: '新的现场回执' };
    const before = readFileSync(join(dir, AGENDA_FILE), 'utf8'), state = agenda.state();
    for (const change of [{ expected_revision: undefined }, { expected_revision: revision - 1 },
      { expected_revision: 1.5 }, { why: '' }, { why: '   ' }, { why: null }, { why: '字'.repeat(241) },
      { note: undefined }, { operation: 'focus' }, { operation: 'amend' }, { doneWhen: '偷改目标' }]) {
      expect(agenda.operate({ ...input, ...change })).toContain('错误');
      expect(agenda.state()).toEqual(state);
      expect(readFileSync(join(dir, AGENDA_FILE), 'utf8')).toBe(before);
    }
    agenda.operate({ operation: 'update', id: 'finish-home', note: '并发进度更新' });
    const concurrent = readFileSync(join(dir, AGENDA_FILE), 'utf8');
    expect(agenda.operate(input)).toContain('错误');
    expect(readFileSync(join(dir, AGENDA_FILE), 'utf8')).toBe(concurrent);
    agenda.operate({ operation: 'update', id: 'river', status: 'done', note: '已验收' });
    const closed = readFileSync(join(dir, AGENDA_FILE), 'utf8');
    expect(agenda.operate({ ...input, expected_revision: agenda.revision() })).toContain('记录保留');
    expect(readFileSync(join(dir, AGENDA_FILE), 'utf8')).toBe(closed);
  });
  it('exposes premise correction through the restored Persona tool without changing completion criteria', async () => {
    const { dir, agenda } = rig(); adopt(agenda);
    const persona = new CortiV({ memoryDir: dir, tickDelayMs: () => null });
    persona.attach(makeFakeHarnessApi());
    const tool = persona.declareSessions().find(session => session.id === 'main')!.tools().find(tool => tool.name === 'activity_plan')!;
    const read = JSON.parse(String(await tool.handler({ operation: 'read', id: 'river' }, { role: 'main', log: nullLogger() })));
    await tool.handler({ operation: 'update', id: 'river', why: '补给点已确认，仍需记录路线',
      expected_revision: read.revision, note: '本次现场发现了补给点，订正规划时前提' }, { role: 'main', log: nullLogger() });
    const restored = new ActivityAgenda(dir, now);
    expect(restored.state().items.find(item => item.id === 'river')).toMatchObject({ why: '补给点已确认，仍需记录路线',
      doneWhen: plan().items[1].doneWhen, sourceCapturedAt: stamp });
    expect(restored.planningReadout()).not.toContain(plan().items[1].why);
  });
  it('retains the sampled source time through delayed adoption, progress and restart', () => {
    const { dir } = rig(); let at = now();
    const agenda = new ActivityAgenda(dir, () => at);
    agenda.propose(JSON.stringify(plan()), agenda.revision(), stamp);
    at += 45 * 60_000;
    agenda.operate({ operation: 'adopt', id: 'river' });
    agenda.operate({ operation: 'focus', id: 'river' });
    at += 60_000;
    agenda.operate({ operation: 'update', id: 'river', note: '最新观察改变了补给条件', when: '按新库存安排返程' });
    const restored = new ActivityAgenda(dir, () => at);
    const item = JSON.parse(restored.operate({ operation: 'read', id: 'river' })).items[0];
    expect(item).toMatchObject({ sourceCapturedAt: stamp, updatedAt: new Date(at).toISOString(), when: '按新库存安排返程' });
    const summary = restored.summary();
    expect(summary).toContain(`规划来源采样于 ${stamp}`);
    expect(summary).toContain(`阶段记录更新于 ${item.updatedAt}`);
    expect(summary).toContain('最新观察改变了补给条件');
    agenda.operate({ operation: 'update', id: 'river', status: 'done', note: '实际发现并记录了新地点' });
    at += 60_000;
    const freshStamp = new Date(at).toISOString();
    agenda.propose(JSON.stringify(plan()), agenda.revision(), freshStamp);
    agenda.operate({ operation: 'adopt' });
    expect(agenda.state().items.find(entry => entry.id === 'river')?.sourceCapturedAt).toBe(stamp);
    expect(agenda.state().items.find(entry => entry.id === 'finish-home')?.sourceCapturedAt).toBe(freshStamp);
  });
  it('keeps legacy source time unknown and rejects malformed new source timestamps without rewriting evidence', () => {
    const { agenda, dir } = rig(); adopt(agenda);
    agenda.operate({ operation: 'focus', id: 'river' });
    const legacy = agenda.state();
    legacy.items.forEach(item => { delete item.sourceCapturedAt; });
    writeFileSync(join(dir, AGENDA_FILE), JSON.stringify(legacy));
    const restored = new ActivityAgenda(dir, now);
    expect(restored.summary()).toContain('规划来源采样于 未记录');
    expect(restored.state()).toEqual(legacy);
    const malformed = { ...legacy, items: legacy.items.map(item => ({ ...item, sourceCapturedAt: 'yesterday' })) };
    const saved = JSON.stringify(malformed);
    writeFileSync(join(dir, AGENDA_FILE), saved);
    expect(() => new ActivityAgenda(dir, now)).toThrow('格式无效');
    expect(readFileSync(join(dir, AGENDA_FILE), 'utf8')).toBe(saved);
  });
  it('corrects closed evidence by revision without reopening the stage or erasing the earlier note', () => {
    const { agenda, dir } = rig(); adopt(agenda);
    agenda.operate({ operation: 'update', id: 'river', status: 'done', note: '最初记录的奖励数量有误' });
    const revision = agenda.revision();
    agenda.operate({ operation: 'amend', id: 'river', expected_revision: revision, note: '按原始回执订正奖励数量' });
    const item = new ActivityAgenda(dir, now).state().items.find(item => item.id === 'river')!;
    expect(item.status).toBe('done'); expect(item.note).toContain('订正');
    expect(item.corrections).toEqual([{ note: '最初记录的奖励数量有误', updatedAt: stamp }]);
    expect(agenda.operate({ operation: 'amend', id: 'river', expected_revision: revision, note: '旧线程覆盖' })).toContain('错误');
    expect(agenda.operate({ operation: 'amend', id: 'river', expected_revision: agenda.revision(), note: '复活阶段', status: 'queued' })).toContain('错误');
    expect(agenda.state().items.find(item => item.id === 'river')!.note).toBe(item.note);
  });
  it('reopens a mistaken completion with its dated closure preserved across restart and the current stage unchanged', () => {
    const { dir } = rig(); let at = now();
    const agenda = new ActivityAgenda(dir, () => at); adopt(agenda);
    agenda.operate({ operation: 'focus', id: 'river' });
    agenda.operate({ operation: 'update', id: 'finish-home', status: 'done', note: '原记录认为入口全部通行' });
    const before = agenda.state();
    const read = JSON.parse(agenda.operate({ operation: 'read', id: 'finish-home' }));
    at += 60_000;
    const reply = JSON.parse(agenda.operate({ operation: 'reopen', id: 'finish-home', expected_revision: read.revision,
      note: '新通行回执确认入口仍有一处阻挡，尚未完成' }));
    expect(reply.revision).toBe(read.revision + 1);
    expect(reply.completedCount).toBe(0);
    expect(reply.items[0]).toEqual({ ...before.items[0], status: 'queued',
      note: '新通行回执确认入口仍有一处阻挡，尚未完成', updatedAt: new Date(at).toISOString(),
      corrections: [{ status: 'done', note: before.items[0].note, updatedAt: before.items[0].updatedAt }] });
    expect(agenda.state().items[1]).toEqual(before.items[1]);
    const restored = new ActivityAgenda(dir, () => at);
    expect(restored.state()).toEqual(agenda.state());
    expect(restored.summary()).toContain('候选 id="finish-home"');
    expect(restored.summary()).not.toContain('已结案 id="finish-home"');
    expect(JSON.parse(restored.planningReadout()).items[0]).toMatchObject({ status: 'queued' });
  });
  it('rejected reopening leaves both persisted evidence and current state unchanged', () => {
    const { agenda, dir } = rig(); adopt(agenda);
    agenda.operate({ operation: 'update', id: 'finish-home', status: 'done', note: '原完成证据' });
    agenda.operate({ operation: 'update', id: 'river', status: 'cancelled', note: '用户明确撤销行程' });
    const before = readFileSync(join(dir, AGENDA_FILE), 'utf8'), state = agenda.state();
    const input = { operation: 'reopen', id: 'finish-home', expected_revision: agenda.revision(), note: '新的反例回执' };
    for (const change of [{ expected_revision: undefined }, { expected_revision: agenda.revision() - 1 },
      { expected_revision: 1.5 }, { note: undefined }, { note: '' }, { note: '   ' }, { note: '字'.repeat(401) },
      { id: 'river' }, { id: 'absent' }, { status: 'queued' }, { when: '同时偷改条件' }, { ifBlocked: '同时偷改策略' }]) {
      expect(agenda.operate({ ...input, ...change })).toContain('错误');
      expect(agenda.state()).toEqual(state);
      expect(readFileSync(join(dir, AGENDA_FILE), 'utf8')).toBe(before);
    }
    agenda.operate(input);
    const reopened = readFileSync(join(dir, AGENDA_FILE), 'utf8');
    expect(agenda.operate({ ...input, expected_revision: agenda.revision() })).toContain('错误');
    expect(readFileSync(join(dir, AGENDA_FILE), 'utf8')).toBe(reopened);
  });
  it('corrects a completion at capacity, restores it after restart and still limits newly adopted goals', () => {
    const { agenda, dir } = rig();
    adopt(agenda, { ...plan(), items: Array.from({ length: AGENDA_MAX_ITEMS }, (_, index) => ({ ...plan().items[0], id: `stage-${index}` })) });
    agenda.operate({ operation: 'update', id: 'stage-0', status: 'done', note: '原完成记录' });
    agenda.propose(JSON.stringify({ ...plan(), items: [plan().items[1]] }), agenda.revision(), stamp);
    agenda.operate({ operation: 'adopt', id: 'river' });
    agenda.operate({ operation: 'focus', id: 'river' });
    const retained = agenda.state().items.filter(item => item.id !== 'stage-0');
    agenda.operate({ operation: 'reopen', id: 'stage-0', expected_revision: agenda.revision(), note: '复核发现未完成' });
    expect(agenda.state().items.filter(item => !['done', 'cancelled'].includes(item.status))).toHaveLength(AGENDA_MAX_ITEMS + 1);
    expect(agenda.state().items.filter(item => item.id !== 'stage-0')).toEqual(retained);
    const restored = new ActivityAgenda(dir, now);
    expect(restored.state()).toEqual(agenda.state());
    expect(restored.state().items[0]).toMatchObject({ status: 'queued', note: '复核发现未完成', corrections: [{ status: 'done', note: '原完成记录' }] });
    expect(JSON.parse(restored.operate({ operation: 'read' })).page.nextOffset).toBe(AGENDA_MAX_ITEMS);
    expect(restored.summary().length).toBeLessThanOrEqual(AGENDA_SUMMARY_MAX_CHARS);
    restored.propose(JSON.stringify({ ...plan(), items: [{ ...plan().items[1], id: 'new-goal' }] }), restored.revision(), stamp);
    const pending = readFileSync(join(dir, AGENDA_FILE), 'utf8');
    expect(restored.operate({ operation: 'adopt', id: 'new-goal' })).toContain('上限');
    expect(readFileSync(join(dir, AGENDA_FILE), 'utf8')).toBe(pending);
    restored.operate({ operation: 'update', id: 'stage-0', status: 'cancelled', note: '未达到原条件，决定不继续本次目标' });
    expect(restored.operate({ operation: 'adopt', id: 'new-goal' })).toContain('上限');
    restored.operate({ operation: 'update', id: 'stage-1', status: 'done', note: '该阶段实际验收通过' });
    restored.operate({ operation: 'adopt', id: 'new-goal' });
    expect(restored.state().items.find(item => item.id === 'new-goal')).toMatchObject({ status: 'queued' });
    expect(new ActivityAgenda(dir, now).state()).toEqual(restored.state());
  });
  it('rejects over-capacity persisted goals that have no completion correction evidence', () => {
    const { agenda, dir } = rig();
    adopt(agenda, { ...plan(), items: Array.from({ length: AGENDA_MAX_ITEMS }, (_, index) => ({ ...plan().items[0], id: `stage-${index}` })) });
    const malformed = agenda.state(); malformed.items.push({ ...malformed.items[0], id: 'extra' });
    const text = JSON.stringify(malformed); writeFileSync(join(dir, AGENDA_FILE), text);
    expect(() => new ActivityAgenda(dir, now)).toThrow('格式无效');
    expect(readFileSync(join(dir, AGENDA_FILE), 'utf8')).toBe(text);
  });
  it('a background proposal cannot undo a reopened completion or replace its correction evidence', () => {
    const { agenda } = rig(); adopt(agenda);
    agenda.operate({ operation: 'update', id: 'finish-home', status: 'done', note: '原完成记录' });
    const captured = agenda.revision();
    agenda.propose(JSON.stringify(plan()), captured, stamp);
    agenda.operate({ operation: 'reopen', id: 'finish-home', expected_revision: captured, note: '新回执否定原判断' });
    const corrected = agenda.state().items;
    expect(agenda.operate({ operation: 'adopt' })).toContain('不能覆盖');
    expect(agenda.operate({ operation: 'adopt', id: 'finish-home' })).toContain('进展保留');
    adopt(agenda);
    expect(agenda.state().items).toEqual(corrected);
  });
  it('restored Persona exposes the reopening tool and projects the corrected stage and evidence into the next request', async () => {
    const { dir, agenda } = rig(); adopt(agenda);
    agenda.operate({ operation: 'update', id: 'finish-home', status: 'done', note: '原完成记录' });
    const persona = new CortiV({ memoryDir: dir, tickDelayMs: () => null,
      foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true }) });
    persona.attach(makeFakeHarnessApi());
    const tool = persona.declareSessions().find(session => session.id === 'main')!.tools().find(tool => tool.name === 'activity_plan')!;
    const read = JSON.parse(String(await tool.handler({ operation: 'read', id: 'finish-home' }, { role: 'main', log: nullLogger() })));
    const reopened = JSON.parse(String(await tool.handler({ operation: 'reopen', id: 'finish-home', expected_revision: read.revision,
      note: '最新回执确认入口仍有阻挡' }, { role: 'main', log: nullLogger() })));
    expect(reopened.items[0]).toMatchObject({ status: 'queued', corrections: [{ status: 'done', note: '原完成记录' }] });
    await tool.handler({ operation: 'focus', id: 'finish-home' }, { role: 'main', log: nullLogger() });
    const restored = new CortiV({ memoryDir: dir, tickDelayMs: () => null,
      foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true }) });
    restored.attach(makeFakeHarnessApi());
    for (const instance of [persona, restored]) {
      const request = instance.prepareRequest({ sessionId: 'main', round: 1, messages: [message('user', '继续')] })!;
      const summary = request.map(record => itemText(record.item)).find(text => text.startsWith('[活动日程'))!;
      expect(summary).toContain('当前 id="finish-home"');
      expect(summary).toContain('最新回执确认入口仍有阻挡');
      expect(summary).not.toContain('原完成记录');
    }
  });
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
  it('revises an existing strategy with dated evidence while retaining its objective and closed history', () => {
    const { dir } = rig();
    let at = now();
    const agenda = new ActivityAgenda(dir, () => at); adopt(agenda);
    agenda.operate({ operation: 'update', id: 'finish-home', status: 'done', note: '入口实际通行验收通过' });
    agenda.operate({ operation: 'focus', id: 'river' });
    const original = agenda.state();
    at += 60_000;
    const revision = agenda.revision();
    agenda.operate({ operation: 'update', id: 'river', when: '补给已补足，现场路线可走',
      ifBlocked: '核验具体阻碍，保留已走通的路段再选替代路线', note: '现场已查到食物和可走的河岸路线，原缺粮条件已改变' });
    const restored = new ActivityAgenda(dir, () => at);
    expect(restored.revision()).toBe(revision + 1);
    expect(restored.state().items[0]).toEqual(original.items[0]);
    expect(restored.state().items[1]).toMatchObject({ ...original.items[1],
      when: '补给已补足，现场路线可走', ifBlocked: '核验具体阻碍，保留已走通的路段再选替代路线',
      note: '现场已查到食物和可走的河岸路线，原缺粮条件已改变', updatedAt: new Date(at).toISOString() });
    expect(restored.summary()).toContain('补给已补足，现场路线可走');
    expect(restored.summary()).not.toContain(plan().items[1].ifBlocked);
    const revisedWhen = restored.state().items[1].when;
    restored.operate({ operation: 'update', id: 'river', ifBlocked: '只记录实际不可通行的位置，再探查旁路', note: '进一步探路发现前方一处落差' });
    expect(restored.state().items[1].when).toBe(revisedWhen);
  });
  it('adoption cannot silently restore obsolete strategy conditions or rewrite closed records', () => {
    const { dir, agenda } = rig(); adopt(agenda);
    agenda.operate({ operation: 'update', id: 'finish-home', status: 'done', note: '验收通过' });
    agenda.operate({ operation: 'focus', id: 'river' });
    const captured = agenda.revision();
    agenda.operate({ operation: 'update', id: 'river', when: '新观察确认可以继续', ifBlocked: '定向探路后重新选择路线', note: '原阻碍已消失' });
    const revised = agenda.state().items;
    agenda.propose(JSON.stringify(plan()), captured, stamp);
    expect(agenda.operate({ operation: 'adopt' })).toContain('不能覆盖');
    const candidate = plan();
    candidate.items[0].when = '后台改写的已完成阶段条件';
    candidate.items[1].ifBlocked = '旧候选又要求补给后休息';
    adopt(agenda, candidate);
    expect(new ActivityAgenda(dir, now).state().items).toEqual(revised);
  });
  it('invalid strategy revisions and revisions on other operations leave the persisted agenda unchanged', () => {
    const { dir, agenda } = rig(); adopt(agenda);
    const before = readFileSync(join(dir, AGENDA_FILE), 'utf8');
    const state = agenda.state();
    for (const invalid of [{ when: '' }, { when: '   ' }, { when: null }, { when: 12 },
      { when: '条'.repeat(241) }, { ifBlocked: [] }, { ifBlocked: '' }, { ifBlocked: '条'.repeat(241) },
      { doneWhen: '偷偷改变完成目标' }]) {
      expect(agenda.operate({ operation: 'update', id: 'river', note: '新证据', ...invalid })).toContain('错误');
    }
    expect(agenda.operate({ operation: 'update', id: 'river', when: '缺少依据的修订' })).toContain('错误');
    expect(agenda.operate({ operation: 'focus', id: 'river', when: '不能偷偷修订' })).toContain('错误');
    expect(agenda.state()).toEqual(state);
    expect(readFileSync(join(dir, AGENDA_FILE), 'utf8')).toBe(before);
  });
  it('explicit condition revisions cannot modify completed or cancelled evidence', () => {
    const { dir, agenda } = rig(); adopt(agenda);
    agenda.operate({ operation: 'update', id: 'finish-home', status: 'done', note: '通行验收通过' });
    agenda.operate({ operation: 'update', id: 'river', status: 'cancelled', note: '用户撤销行程' });
    const before = readFileSync(join(dir, AGENDA_FILE), 'utf8');
    for (const id of ['finish-home', 'river']) {
      expect(agenda.operate({ operation: 'update', id, when: '重新出发', ifBlocked: '重新安排', note: '后台建议重做' })).toContain('记录保留');
    }
    expect(readFileSync(join(dir, AGENDA_FILE), 'utf8')).toBe(before);
  });
  it('a late proposal cannot overwrite foreground progress or completion', () => {
    const { agenda } = rig(); adopt(agenda);
    const captured = agenda.revision();
    agenda.operate({ operation: 'update', id: 'finish-home', status: 'done', note: '实际通行验收已通过' });
    agenda.propose(JSON.stringify(plan()), captured, stamp);
    expect(agenda.operate({ operation: 'adopt' })).toContain('不能覆盖');
    expect(agenda.state().items[0]).toMatchObject({ status: 'done', note: '实际通行验收已通过' });
  });
  it('explicitly adopts a new candidate after concurrent progress without replacing any existing evidence', () => {
    const { dir, agenda } = rig(); adopt(agenda);
    const captured = agenda.revision();
    agenda.operate({ operation: 'focus', id: 'river' });
    agenda.operate({ operation: 'update', id: 'finish-home', status: 'done', note: '现场验收通过' });
    const before = agenda.state();
    const candidate = { ...plan(), items: [
      { ...plan().items[1], id: 'meet-neighbor', title: '与附近同伴交流', doneWhen: '得到实际回应或留下可回访条件' },
      { ...plan().items[1], id: 'new-place', title: '侦查一个新地点' },
    ] };
    agenda.propose(JSON.stringify(candidate), captured, stamp);
    agenda.operate({ operation: 'adopt', id: 'meet-neighbor' });
    expect(agenda.state().items.slice(0, 2)).toEqual(before.items);
    expect(agenda.state().items[2]).toMatchObject({ id: 'meet-neighbor', status: 'queued', note: '' });
    expect(agenda.state().items.filter(item => item.status === 'active')).toHaveLength(1);
    expect(agenda.state().proposal?.items.map(item => item.id)).toEqual(['new-place']);
    expect(new ActivityAgenda(dir, now).state()).toEqual(agenda.state());
    agenda.operate({ operation: 'adopt', id: 'new-place' });
    expect(agenda.state().proposal).toBeNull();
  });
  it('an unknown selected id cannot silently adopt the whole proposal', () => {
    const { dir, agenda } = rig();
    agenda.propose(JSON.stringify(plan()), 0, stamp);
    const before = readFileSync(join(dir, AGENDA_FILE), 'utf8');
    expect(agenda.operate({ operation: 'adopt', id: 'not-in-proposal' })).toContain('输入错误');
    expect(readFileSync(join(dir, AGENDA_FILE), 'utf8')).toBe(before);
    expect(agenda.state().items).toEqual([]);
  });
  it('selected adoption cannot reset existing progress or reuse a completed id with a different objective', () => {
    const { agenda } = rig(); adopt(agenda);
    agenda.operate({ operation: 'update', id: 'finish-home', status: 'done', note: '验收通过' });
    agenda.operate({ operation: 'focus', id: 'river' });
    const candidate = plan(); candidate.items[0].title = '重新建设入口';
    agenda.propose(JSON.stringify(candidate), 0, stamp);
    const before = agenda.state();
    expect(agenda.operate({ operation: 'adopt', id: 'finish-home' })).toContain('已完成');
    expect(agenda.operate({ operation: 'adopt', id: 'river' })).toContain('进展保留');
    expect(agenda.state()).toEqual(before);
  });
  it('selected adoption at capacity leaves the ledger and proposal unchanged', () => {
    const { agenda } = rig();
    adopt(agenda, { ...plan(), items: Array.from({ length: 8 }, (_, index) => ({ ...plan().items[0], id: String(index) })) });
    agenda.propose(JSON.stringify(plan()), agenda.revision(), stamp);
    const before = agenda.state();
    expect(agenda.operate({ operation: 'adopt', id: 'river' })).toContain('上限');
    expect(agenda.state()).toEqual(before);
  });
  it('completed stages release capacity and retain evidence across selected adoption and restart', () => {
    const { dir, agenda } = rig();
    adopt(agenda, { ...plan(), items: Array.from({ length: AGENDA_MAX_ITEMS }, (_, index) => ({ ...plan().items[0], id: String(index) })) });
    for (const item of agenda.state().items) agenda.operate({ operation: 'update', id: item.id, status: 'done', note: `实际验收 ${item.id}` });
    const evidence = agenda.state().items;
    const captured = agenda.revision();
    agenda.propose(JSON.stringify(plan()), captured, stamp);
    const receipt = agenda.operate({ operation: 'adopt', id: 'river' });
    expect(receipt).toContain('排队 1 项');
    expect(agenda.state().items.slice(0, AGENDA_MAX_ITEMS)).toEqual(evidence);
    const restored = new ActivityAgenda(dir, now);
    expect(restored.state()).toEqual(agenda.state());
    restored.operate({ operation: 'focus', id: 'river' });
    const read = JSON.parse(restored.operate({ operation: 'read' }));
    expect(read.items.map((item: { id: string }) => item.id)).toEqual(['river']);
    expect(read.completedCount).toBe(AGENDA_MAX_ITEMS);
    expect(JSON.parse(restored.operate({ operation: 'read', id: '0' })).items[0].note).toBe(evidence[0].note);
    const history = JSON.parse(restored.operate({ operation: 'read', includeCompleted: true, limit: 2 }));
    expect(history.items).toEqual(evidence.slice(0, 2));
    expect(history.page.nextOffset).toBe(2);
    const next = JSON.parse(restored.operate({ operation: 'read', includeCompleted: true, limit: 2, offset: history.page.nextOffset }));
    expect(next.items).toEqual(evidence.slice(2, 4));
  });
  it('whole adoption preserves completed history and cannot reuse a completed id for another objective', () => {
    const { dir, agenda } = rig(); adopt(agenda);
    agenda.operate({ operation: 'update', id: 'finish-home', status: 'done', note: '实际通行通过' });
    const completed = agenda.state().items[0];
    adopt(agenda, { ...plan(), items: [plan().items[1]] });
    expect(agenda.state().items[0]).toEqual(completed);
    const changed = plan(); changed.items[0].doneWhen = '新目标尚未执行';
    agenda.propose(JSON.stringify(changed), agenda.revision(), stamp);
    const before = agenda.state();
    expect(agenda.operate({ operation: 'adopt' })).toContain('不能改成新目标');
    expect(agenda.state()).toEqual(before);
    expect(new ActivityAgenda(dir, now).state()).toEqual(before);
  });
  it('planning reads open stages and recent completion evidence without expanding all history', () => {
    const { agenda } = rig();
    for (let index = 0; index < AGENDA_MAX_ITEMS + 2; index++) {
      const item = { ...plan().items[0], id: `stage${index}` };
      adopt(agenda, { ...plan(), items: [item] });
      agenda.operate({ operation: 'update', id: item.id, status: 'done', note: `回执 ${index}` });
    }
    expect(agenda.summary()).toContain('当前没有未完成阶段');
    adopt(agenda, { ...plan(), items: [plan().items[1]] });
    const reading = JSON.parse(agenda.planningReadout());
    expect(reading.items.map((item: { id: string }) => item.id)).toEqual(['river', ...Array.from({ length: AGENDA_MAX_ITEMS }, (_, index) => `stage${index + 2}`)]);
    expect(reading.completedCount).toBe(AGENDA_MAX_ITEMS + 2);
    expect(agenda.state().items).toHaveLength(AGENDA_MAX_ITEMS + 3);
  });
  it('compact context shows actual agenda status and candidate identities while historical background is available on read', () => {
    const { agenda } = rig();
    const value = { ...plan(), summary: '之前背包已满，需要继续整理。' };
    adopt(agenda, value);
    agenda.operate({ operation: 'update', id: 'finish-home', status: 'done', note: '验收通过' });
    agenda.operate({ operation: 'update', id: 'river', status: 'deferred', note: '等同伴确认时间，其余活动照常' });
    agenda.propose(JSON.stringify({ ...plan(), summary: '生成时还未返回旧地点。' }), 0, stamp);
    const summary = agenda.summary();
    expect(summary).toContain('已完成 1 项，排队 0 项，挂起 1 项');
    expect(summary).toContain(stamp);
    expect(summary).toContain('整份已落后');
    expect(summary).toContain('"river"');
    expect(summary).not.toContain(value.summary);
    expect(summary).not.toContain('生成时还未返回旧地点');
    const detail = JSON.parse(agenda.operate({ operation: 'read' }));
    expect(detail.summary).toBe(value.summary);
    expect(detail.interpretation).toContain('不是当前现场读数');
    expect(detail.items).toMatchObject([{ id: 'river', status: 'deferred', note: '等同伴确认时间，其余活动照常' }]);
  });
  it('restored deferred intentions expose their dated blocker without a background proposal or automatic resumption', () => {
    const { dir, agenda } = rig(); adopt(agenda);
    agenda.operate({ operation: 'update', id: 'river', status: 'deferred', note: '食物不足，获得返程补给后复核' });
    const restored = new ActivityAgenda(dir, now);
    const before = restored.state();
    const summary = restored.summary();
    expect(summary).toContain('挂起 id="river" 沿河探索');
    expect(summary).toContain(`${stamp} 记录的依据：食物不足，获得返程补给后复核`);
    expect(summary).toContain('新观察是否改变条件须核验');
    expect(restored.state()).toEqual(before);
    expect(before.proposal).toBeNull();
    expect(before.items.find(item => item.id === 'river')?.status).toBe('deferred');
  });
  it('a bounded context places the newest deferred evidence before oversized background candidates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortiv-agenda-')); dirs.push(dir);
    let clock = now();
    const agenda = new ActivityAgenda(dir, () => clock);
    adopt(agenda, { ...plan(), items: Array.from({ length: AGENDA_MAX_ITEMS }, (_, index) => ({
      ...plan().items[1], id: `stage-${index}`, title: `探索阶段${index}`,
    })) });
    for (let index = 0; index < AGENDA_MAX_ITEMS; index++) {
      clock += 1000;
      agenda.operate({ operation: 'update', id: `stage-${index}`, status: 'deferred',
        note: index === AGENDA_MAX_ITEMS - 1 ? '桥未连接，接通后可以复核' : '此前观察的障碍'.repeat(20) });
    }
    agenda.propose(JSON.stringify({ ...plan(), items: Array.from({ length: AGENDA_MAX_ITEMS }, (_, index) => ({
      ...plan().items[1], id: `candidate-${index}`, title: '后台候选活动标题'.repeat(12),
    })) }), 0, stamp);
    const summary = agenda.summary();
    expect(summary.length).toBeLessThanOrEqual(AGENDA_SUMMARY_MAX_CHARS);
    expect(summary).toContain(`挂起 id="stage-${AGENDA_MAX_ITEMS - 1}"`);
    expect(summary).toContain('桥未连接，接通后可以复核');
    expect(summary).toContain(new Date(clock).toISOString());
    expect(summary.indexOf(`"stage-${AGENDA_MAX_ITEMS - 1}"`)).toBeLessThan(summary.indexOf('"stage-0"') < 0
      ? summary.length : summary.indexOf('"stage-0"'));
    expect(JSON.parse(agenda.operate({ operation: 'read' })).items).toHaveLength(AGENDA_MAX_ITEMS);
  });
  it('restored foreground keeps proposal retrieval and adoption visible beside long progress history', () => {
    const { dir, agenda } = rig();
    const historical = { ...plan(), items: Array.from({ length: AGENDA_MAX_ITEMS }, (_, index) => ({
      ...plan().items[0], id: `completed-${index}`, title: '已经完成的阶段标题'.repeat(8),
    })) };
    adopt(agenda, historical);
    for (const item of agenda.state().items) {
      agenda.operate({ operation: 'update', id: item.id, status: 'done', note: '已核对实际世界变化'.repeat(30) });
    }
    adopt(agenda, { ...plan(), items: Array.from({ length: 3 }, (_, index) => ({
      ...plan().items[1], id: `blocked-${index}`, title: '等待条件变化再复核'.repeat(8),
    })) });
    for (const item of agenda.state().items.filter(item => item.status !== 'done')) {
      agenda.operate({ operation: 'update', id: item.id, status: 'deferred', note: '当前条件尚未改变'.repeat(35) });
    }
    agenda.propose(JSON.stringify({ ...plan(), items: Array.from({ length: AGENDA_MAX_ITEMS }, (_, index) => ({
      ...plan().items[1], id: `new-${index}`, title: '尚未选择的新阶段'.repeat(10),
    })) }), agenda.revision(), stamp);
    const before = agenda.state();
    const persona = new CortiV({ memoryDir: dir, tickDelayMs: () => null,
      foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true }) });
    persona.attach(makeFakeHarnessApi());
    const request = persona.prepareRequest({ sessionId: 'main', round: 1, messages: [message('user', '继续')] });
    const summary = request!.map(record => itemText(record.item)).find(text => text.startsWith('[活动日程'))!;
    expect(summary.length).toBeLessThanOrEqual(AGENDA_SUMMARY_MAX_CHARS);
    expect(summary).toContain(`后台候选采样于 ${stamp}`);
    expect(summary).toContain('待核验采用');
    expect(summary).toContain('activity_plan read');
    expect(summary).toContain('adopt');
    expect(summary).toContain('update');
    const reading = JSON.parse(agenda.operate({ operation: 'read' }));
    expect(reading.proposal.items.map((item: { id: string }) => item.id))
      .toEqual(Array.from({ length: AGENDA_MAX_ITEMS }, (_, index) => `new-${index}`));
    expect(new ActivityAgenda(dir, now).state()).toEqual(before);
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
  it('pins the active stage record time across restoration without claiming observed world progress', () => {
    const { dir, agenda } = rig(); adopt(agenda);
    agenda.operate({ operation: 'focus', id: 'river' });
    const restored = new ActivityAgenda(dir, () => now() + 30 * 60_000);
    const before = restored.state();
    const summary = restored.summary();
    expect(summary).toContain(`阶段记录更新于 ${stamp}`);
    expect(summary).toContain('记录时间不证明世界已变化');
    expect(restored.state()).toEqual(before);
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
  it('reads an unadopted candidate by id without expanding unrelated goals or old planning background', () => {
    const { agenda } = rig(); adopt(agenda);
    const candidate = { ...plan(), summary: '旧库存背景不能当作当前读数', items: [
      { ...plan().items[0], id: 'delivery', title: '交付铜料' },
      { ...plan().items[1], id: 'unrelated', title: '不相关的远行安排' },
    ] };
    agenda.propose(JSON.stringify(candidate), agenda.revision(), stamp);
    const before = agenda.state();
    const result = agenda.operate({ operation: 'read', id: 'delivery' });
    const reading = JSON.parse(result);
    expect(reading.items).toEqual([]);
    expect(reading.proposal).toMatchObject({ baseRevision: agenda.revision(), capturedAt: stamp, items: [candidate.items[0]] });
    expect(result).not.toContain('不相关的远行安排');
    expect(result).not.toContain('改善入口');
    expect(result).not.toContain(candidate.summary);
    const receipt = agenda.operate({ operation: 'update', id: 'delivery', status: 'done', note: '服务端已交付' });
    expect(receipt).toContain('尚未采用');
    expect(receipt).toContain('adopt');
    expect(receipt).toContain('delivery');
    expect(agenda.state()).toEqual(before);
    agenda.operate({ operation: 'adopt', id: 'delivery' });
    agenda.operate({ operation: 'update', id: 'delivery', status: 'done', note: '服务端已交付' });
    expect(agenda.state().items.find(item => item.id === 'delivery')).toMatchObject({ status: 'done', note: '服务端已交付' });
  });
  it('explicit cancellation releases capacity and restores its dated reason without claiming completion', () => {
    const { dir, agenda } = rig();
    adopt(agenda, { ...plan(), items: Array.from({ length: AGENDA_MAX_ITEMS }, (_, index) => ({ ...plan().items[0], id: String(index) })) });
    agenda.operate({ operation: 'focus', id: '0' });
    const before = agenda.state();
    expect(agenda.operate({ operation: 'update', id: '0', status: 'cancelled' })).toContain('错误');
    expect(agenda.state()).toEqual(before);
    agenda.operate({ operation: 'update', id: '0', status: 'cancelled', note: '用户已撤销旧委托，未完成也不再等待' });
    agenda.propose(JSON.stringify({ ...plan(), items: [plan().items[1]] }), agenda.revision(), stamp);
    agenda.operate({ operation: 'adopt', id: 'river' });
    const restored = new ActivityAgenda(dir, now);
    expect(restored.state().items.filter(item => item.status === 'active')).toEqual([]);
    expect(restored.state().items.find(item => item.id === '0')).toMatchObject({ status: 'cancelled', updatedAt: stamp });
    expect(restored.summary()).toContain('已撤销');
    expect(restored.summary()).not.toContain('已结案 id="0"');
    const reading = JSON.parse(restored.operate({ operation: 'read' }));
    expect(reading.items).toHaveLength(AGENDA_MAX_ITEMS);
    expect(reading.completedCount).toBe(0);
    expect(reading.cancelledCount).toBe(1);
    expect(JSON.parse(restored.operate({ operation: 'read', id: '0' })).items[0].note).toContain('用户已撤销');
    const history = JSON.parse(restored.operate({ operation: 'read', includeClosed: true, limit: 1 }));
    expect(history.items[0].status).toBe('cancelled');
    expect(JSON.parse(restored.planningReadout()).items.find((item: { id: string }) => item.id === '0').status).toBe('cancelled');
  });
  it('a cancelled goal cannot be reopened or rewritten by focus, update or a later proposal', () => {
    const { dir, agenda } = rig(); adopt(agenda);
    agenda.operate({ operation: 'update', id: 'river', status: 'cancelled', note: '决定不再推进这次行程' });
    const evidence = agenda.state().items.find(item => item.id === 'river');
    expect(agenda.operate({ operation: 'focus', id: 'river' })).toContain('已撤销');
    expect(agenda.operate({ operation: 'update', id: 'river', status: 'done', note: '旧建议又要求出发' })).toContain('已撤销');
    adopt(agenda);
    expect(agenda.state().items.find(item => item.id === 'river')).toEqual(evidence);
    agenda.propose(JSON.stringify(plan()), agenda.revision(), stamp);
    expect(agenda.operate({ operation: 'adopt', id: 'river' })).toContain('已撤销');
    const changed = plan(); changed.items[1].doneWhen = '另一个新目的';
    agenda.propose(JSON.stringify(changed), agenda.revision(), stamp);
    const before = agenda.state();
    expect(agenda.operate({ operation: 'adopt' })).toContain('不能改成新目标');
    expect(agenda.state()).toEqual(before);
    expect(new ActivityAgenda(dir, now).state()).toEqual(before);
  });
  it('whole adoption retains omitted goals until an explicit cancellation, including across restart', () => {
    const { dir, agenda } = rig(); adopt(agenda);
    agenda.operate({ operation: 'focus', id: 'finish-home' });
    const existing = agenda.state().items;
    const candidate = { ...plan(), items: [{ ...plan().items[1], id: 'new-trip' }] };
    adopt(agenda, candidate);
    expect(agenda.state().items.filter(item => existing.some(old => old.id === item.id))).toEqual(existing);
    expect(new ActivityAgenda(dir, now).state().items.map(item => item.id)).toEqual(['finish-home', 'river', 'new-trip']);
  });
  it('whole adoption cannot silently drop open goals to make room at capacity', () => {
    const { agenda } = rig();
    adopt(agenda, { ...plan(), items: Array.from({ length: AGENDA_MAX_ITEMS }, (_, index) => ({ ...plan().items[0], id: String(index) })) });
    agenda.propose(JSON.stringify(plan()), agenda.revision(), stamp);
    const before = agenda.state();
    expect(agenda.operate({ operation: 'adopt' })).toContain('上限');
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
  it('a tool revision replaces obsolete strategy conditions in the next short request and survives Persona restoration', async () => {
    const { dir, agenda } = rig(); adopt(agenda); agenda.operate({ operation: 'focus', id: 'river' });
    const persona = new CortiV({ memoryDir: dir, tickDelayMs: () => null,
      foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true }) });
    persona.attach(makeFakeHarnessApi());
    const tool = persona.declareSessions().find(session => session.id === 'main')!.tools().find(tool => tool.name === 'activity_plan')!;
    await tool.handler({ operation: 'update', id: 'river', when: '现场确认补给已补足',
      ifBlocked: '核验具体阻碍再选替代路线', note: '河岸已探明，保留已走通的部分' }, { role: 'main', log: nullLogger() });
    const restored = new CortiV({ memoryDir: dir, tickDelayMs: () => null,
      foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true }) });
    restored.attach(makeFakeHarnessApi());
    for (const instance of [persona, restored]) {
      const view = instance.prepareRequest({ sessionId: 'main', round: 1, messages: [message('user', '继续沿河探索')] })!;
      const summary = view.map(record => itemText(record.item)).find(text => text.startsWith('[活动日程'))!;
      expect(summary).toContain('现场确认补给已补足');
      expect(summary).toContain('核验具体阻碍再选替代路线');
      expect(summary).not.toContain(plan().items[1].when);
      expect(summary).not.toContain(plan().items[1].ifBlocked);
    }
    expect(new ActivityAgenda(dir, now).state().items[1]).toMatchObject({ id: 'river', status: 'active', doneWhen: plan().items[1].doneWhen });
  });
  it('crowded agenda context retains revised active conditions and evidence beside proposals and closed history', () => {
    const { dir, agenda } = rig();
    adopt(agenda, { ...plan(), items: Array.from({ length: 4 }, (_, index) => ({ ...plan().items[0], id: `closed-${index}` })) });
    for (const [index, item] of agenda.state().items.entries()) {
      agenda.operate({ operation: 'update', id: item.id, status: index === 0 ? 'cancelled' : 'done', note: '历史记录及依据'.repeat(30) });
    }
    adopt(agenda, { ...plan(), items: Array.from({ length: AGENDA_MAX_ITEMS }, (_, index) => ({ ...plan().items[1], id: `open-${index}`,
      doneWhen: '发现一个新地点，现场确认可站立的落脚点、去程与返程路线、视野及附近环境，记录坐标和实际到达回执，并留下一条与此处有关的新观察，未达成这些条件不关闭阶段。' })) });
    for (const item of agenda.state().items.filter(item => item.status === 'queued')) {
      agenda.operate({ operation: 'update', id: item.id, status: 'deferred', note: '此前的阻碍和待复核条件'.repeat(20) });
    }
    agenda.operate({ operation: 'focus', id: 'open-0' });
    const when = '补给已确认足够，路线的各段都有落脚点，当前现场安全，可以沿已核验的路线继续';
    const ifBlocked = '先核验本次具体阻碍，保留已走通的路段；只对受阻位置重新探路，未知区域保留待查';
    const note = '现场回执确认已到河岸上层，原缺粮条件已变化。';
    agenda.operate({ operation: 'update', id: 'open-0', when, ifBlocked, note });
    agenda.propose(JSON.stringify({ ...plan(), items: Array.from({ length: AGENDA_MAX_ITEMS }, (_, index) => ({
      ...plan().items[1], id: `candidate-${index}`, title: '后台候选活动标题'.repeat(10),
    })) }), agenda.revision(), stamp);
    const persona = new CortiV({ memoryDir: dir, tickDelayMs: () => null,
      foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true }) });
    persona.attach(makeFakeHarnessApi());
    const request = persona.prepareRequest({ sessionId: 'main', round: 1, messages: [message('user', '继续当前路线')] })!;
    const summary = request.map(record => itemText(record.item)).find(text => text.startsWith('[活动日程'))!;
    expect(summary.length).toBeLessThanOrEqual(AGENDA_SUMMARY_MAX_CHARS);
    expect(summary).toContain(when);
    expect(summary).toContain(ifBlocked);
    expect(summary).toContain(note);
    expect(summary).toContain(agenda.state().items.find(item => item.id === 'open-0')!.doneWhen);
    expect(summary).toContain('activity_plan read');
  });
  it('restored Persona tools retain cancellation evidence in the request without putting the goal back in the open list', async () => {
    const { dir, agenda } = rig(); adopt(agenda);
    const persona = new CortiV({ memoryDir: dir, tickDelayMs: () => null,
      foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true }) });
    persona.attach(makeFakeHarnessApi());
    const tool = persona.declareSessions().find(session => session.id === 'main')!.tools().find(tool => tool.name === 'activity_plan')!;
    await tool.handler({ operation: 'update', id: 'river', status: 'cancelled', note: '用户已撤回这次行程' }, { role: 'main', log: nullLogger() });
    const restored = new CortiV({ memoryDir: dir, tickDelayMs: () => null,
      foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true }) });
    restored.attach(makeFakeHarnessApi());
    const request = restored.prepareRequest({ sessionId: 'main', round: 1, messages: [message('user', '继续自己的生活')] })!;
    const summary = request.map(record => itemText(record.item)).find(text => text.startsWith('[活动日程'))!;
    expect(summary).toContain('已撤销 id="river"');
    expect(summary).toContain('用户已撤回这次行程');
    expect(summary).not.toContain('候选 id="river"');
    expect(new ActivityAgenda(dir, now).state().items.find(item => item.id === 'river')?.status).toBe('cancelled');
  });
  it('short foreground requests retain a deferred goal and its resumption evidence after Persona restoration', () => {
    const { dir, agenda } = rig(); adopt(agenda);
    agenda.operate({ operation: 'focus', id: 'finish-home' });
    agenda.operate({ operation: 'update', id: 'river', status: 'deferred', note: '缺少返程口粮，补足后复核' });
    const persona = new CortiV({ memoryDir: dir, tickDelayMs: () => null,
      foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true }) });
    persona.attach(makeFakeHarnessApi());
    const view = persona.prepareRequest({ sessionId: 'main', round: 1, messages: [message('user', '补给已经到手')] });
    const context = view!.map(record => itemText(record.item)).join('\n');
    expect(context).toContain('挂起 id="river" 沿河探索');
    expect(context).toContain('缺少返程口粮，补足后复核');
    expect(context).toContain(stamp);
    expect(context).toContain('改善入口');
    expect(new ActivityAgenda(dir, now).state().items.find(item => item.id === 'river')?.status).toBe('deferred');
  });

  it('restored foreground requests retain a completed result beside an older related waiting stage', () => {
    const { dir, agenda } = rig();
    const value = plan();
    value.items[0].title = '交付收集任务';
    value.items[1].title = '等待同一批材料';
    adopt(agenda, value);
    agenda.operate({ operation: 'update', id: 'river', status: 'deferred', note: '此前材料还不够，等产出后再交' });
    agenda.operate({ operation: 'update', id: 'finish-home', status: 'done', note: '服务端确认已交付，材料扣除，奖励到账' });
    const before = new ActivityAgenda(dir, now).state();
    const persona = new CortiV({ memoryDir: dir, tickDelayMs: () => null,
      foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true }) });
    persona.attach(makeFakeHarnessApi());
    const view = persona.prepareRequest({ sessionId: 'main', round: 1, messages: [message('user', '继续当前活动')] });
    const context = view!.map(record => itemText(record.item)).join('\n');
    expect(context).toContain('已结案 id="finish-home" 交付收集任务');
    expect(context).toContain('服务端确认已交付，材料扣除，奖励到账');
    expect(context).toContain(stamp);
    expect(context).toContain('外部生效仍以实际回执为准');
    expect(context).toContain('挂起 id="river"');
    expect(new ActivityAgenda(dir, now).state()).toEqual(before);
  });

  it('bounds recent completion evidence while retaining older results for explicit reads', () => {
    const { dir } = rig();
    let at = now();
    const agenda = new ActivityAgenda(dir, () => at);
    const value = plan();
    value.items = Array.from({ length: AGENDA_RECENT_COMPLETIONS + 1 }, (_, index) => ({
      ...value.items[0], id: `stage-${index}`, title: `阶段 ${index}`,
    }));
    adopt(agenda, value);
    for (const item of value.items) {
      at += 1000;
      agenda.operate({ operation: 'update', id: item.id, status: 'done', note: `回执确认 ${item.id}` });
    }
    const summary = new ActivityAgenda(dir, () => at).summary();
    expect(summary.length).toBeLessThanOrEqual(AGENDA_SUMMARY_MAX_CHARS);
    expect(summary.match(/已结案 id=/g)).toHaveLength(AGENDA_RECENT_COMPLETIONS);
    expect(summary).not.toContain('已结案 id="stage-0"');
    expect(summary).toContain(`回执确认 stage-${AGENDA_RECENT_COMPLETIONS}`);
    expect(JSON.parse(agenda.operate({ operation: 'read', id: 'stage-0' })).items)
      .toMatchObject([{ id: 'stage-0', status: 'done', note: '回执确认 stage-0' }]);
  });
});
