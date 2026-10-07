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
