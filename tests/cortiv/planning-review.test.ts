import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeriodicPlanningReview, planningMessages, PLANNING, PLANNING_DEFAULTS,
  PLANNING_TIMER_OWNER, type PlanningConfig } from '../../bots/cortiv/persona/planning-review.ts';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import definition, { CORTIV_PLANNING_CONFIG_GROUP, CORTIV_FAST_ATTENTION_CONFIG_GROUP } from '../../bots/cortiv/index.ts';
import { coerceGroupValues, readGroupValues } from '../../src/core/config-schema.ts';
import { TimerStore } from '../../src/core/timers.ts';
import { nullLogger, estimateMessagesTokens } from '../../src/core/util.ts';
import type { CoreApi, ForkOptions } from '../../src/core/types.ts';
import { message, functionCall, functionResult, itemText, type ContextRecord } from '../../src/protocol/open-responses/context.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';
import { ActivityAgenda } from '../../bots/cortiv/persona/activity-agenda.ts';

const cleanup: Array<() => void> = [];
const stamp = () => new Date().toISOString();

function rig(patch: Partial<PlanningConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cortiv-planning-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const timers = new TimerStore(join(dir, 'runtime'));
  cleanup.push(() => timers.stop());
  const cfg = { ...PLANNING_DEFAULTS, enabled: true, provider: 'configured-planner', ...patch };
  let snapshot: ContextRecord[] = [message('user', '钓鱼两次，一次成功，一次失败', { ts: stamp() })];
  const forks: ForkOptions[] = [];
  const injected: Array<{ text: string; kind?: string }> = [];
  let reply: (options: ForkOptions) => Promise<string> = async () => '可考虑沿河探索，先确认食物与回家路线。';
  const gate = vi.fn(() => { throw new Error('后台复盘不得阻断前台'); });
  const memory = vi.fn((files: readonly string[]) => ({ constitution: '自由探索，尊重别人。',
    memories: files.map((file) => ({ file, text: file === 'missing.md' ? '[文件不存在]' : '曾想在河边建据点' })),
    pending: '稍后检查农田是否成熟；尚未完成' }));
  const core = { timers, log: nullLogger(),
    sessionInfo: () => ({ id: 'main', running: 0, snapshot, estTokens: null, hardTokens: null }),
    spawnFork: async (options: ForkOptions) => { forks.push(options); return reply(options); },
    injectInternal: (text: string, kind?: string) => { injected.push({ text, kind }); },
    deliveryGate: { set: gate, clear: gate, isBlocked: () => false },
  } as unknown as CoreApi;
  const agenda = new ActivityAgenda(dir);
  const review = new PeriodicPlanningReview({ core, config: () => cfg, memory, agenda });
  cleanup.push(() => review.stop());
  timers.onDue((entry) => review.onDue(entry));
  timers.start();
  review.start();
  return { cfg, core, review, timers, forks, injected, memory, gate, agenda,
    snapshot: (value: ContextRecord[]) => { snapshot = value; },
    reply: (value: typeof reply) => { reply = value; } };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T10:00:00Z')); });
afterEach(() => { for (const run of cleanup.splice(0).reverse()) run(); vi.useRealTimers(); });

describe('Persona长期复盘', () => {
  const candidate = JSON.stringify({ summary: '收尾已有目标后尝试新的活动', items: [
    { id: 'create', title: '创作一个作品', why: '尚未完成的兴趣', doneWhen: '现场验收一个可用阶段',
      when: '资源足够且安全', ifBlocked: '记录缺口后去探索', references: [] },
  ] });
  it('启用日程时异步保存候选，main核验后采用，后台仍无动作工具', async () => {
    const r = rig({ agendaEnabled: true }); r.reply(async () => candidate);
    expect(r.review.review().accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.agenda.state().proposal?.items[0].id).toBe('create');
    expect(r.agenda.state().items).toEqual([]);
    expect(r.forks[0].tools).toEqual([]); expect(r.gate).not.toHaveBeenCalled();
    expect(r.injected[0].text).toContain('待核验采用');
    expect(r.forks[0].messages.map(record => itemText(record.item)).join('\n')).toContain('只返回JSON');
    r.agenda.operate({ operation: 'adopt' });
    expect(r.agenda.state().items[0].status).toBe('queued');
  });
  it('格式错误结果可观察、可重新规划，不替换当前日程', async () => {
    const r = rig({ agendaEnabled: true }); r.reply(async () => '不是JSON');
    r.review.review(); await vi.advanceTimersByTimeAsync(0);
    expect(r.review.state()).toMatchObject({ lastOutcome: 'failed', lastFailure: { code: 'invalid_plan' } });
    expect(r.agenda.state().proposal).toBeNull(); expect(r.injected).toEqual([]);
    expect(r.review.review().accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
  });
  it('新规划读取当前阶段证据，旧背景说明仍在账本中但不作为当前事实重复投递', async () => {
    const r = rig({ agendaEnabled: true });
    const oldSummary = '背包全满，必须先一直整理箱子才能探索';
    r.agenda.propose(JSON.stringify({ ...JSON.parse(candidate), summary: oldSummary }), 0, stamp());
    r.agenda.operate({ operation: 'adopt' });
    r.agenda.operate({ operation: 'update', id: 'create', status: 'done', note: '已验收作品；背包还有空位' });
    r.reply(async () => candidate); r.review.review(); await vi.advanceTimersByTimeAsync(0);
    const material = r.forks[0].messages.map(record => itemText(record.item)).join('\n');
    expect(material).toContain('已完成 1 项');
    expect(material).toContain('已验收作品；背包还有空位');
    expect(material).not.toContain(oldSummary);
    expect(JSON.parse(r.agenda.operate({ operation: 'read' })).summary).toBe(oldSummary);
    expect(r.agenda.state().items[0].status).toBe('done');
  });
  it('日程生成期间前台的新证据使候选不能覆盖；格式开关热更也丢弃旧输出', async () => {
    const r = rig({ agendaEnabled: true });
    r.agenda.propose(candidate, 0, stamp()); r.agenda.operate({ operation: 'adopt' });
    let finish!: (value: string) => void;
    r.reply(() => new Promise(resolve => { finish = resolve; })); r.review.review();
    r.agenda.operate({ operation: 'update', id: 'create', status: 'done', note: '已实际验收' });
    finish(candidate); await vi.advanceTimersByTimeAsync(0);
    expect(r.agenda.operate({ operation: 'adopt' })).toContain('不能覆盖');
    expect(r.agenda.state().items[0].status).toBe('done');
    r.review.noteSnapshot([message('user', '新的目标', { ts: stamp() })]); r.review.review();
    const before = r.agenda.state(); r.cfg.agendaEnabled = false;
    finish(candidate); await vi.advanceTimersByTimeAsync(0);
    expect(r.agenda.state()).toEqual(before); expect(r.review.state().lastOutcome).toBe('discarded');
  });
  it('30分钟定时读取活动及Memory，只给main投递候选短笺，独立provider和空工具', async () => {
    const r = rig({ memoryFiles: 'goals.md\nmissing.md\ngoals.md' });
    expect(r.forks).toEqual([]);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(r.forks).toHaveLength(1);
    expect(r.forks[0]).toMatchObject({ id: PLANNING, provider: 'configured-planner',
      maxOutputTokens: 1600, tools: [] });
    expect(r.forks[0].signal).toBeInstanceOf(AbortSignal);
    expect(r.memory).toHaveBeenCalledWith(['goals.md', 'missing.md']);
    expect(r.forks[0].messages.map((entry) => itemText(entry.item)).join('\n')).toContain('尚未完成');
    expect(r.injected).toHaveLength(1);
    expect(r.injected[0]).toMatchObject({ kind: 'planning' });
    expect(r.injected[0].text).toContain('建议尚未执行');
    expect(r.timers.list().filter((timer) => timer.payload.owner === PLANNING_TIMER_OWNER)).toHaveLength(1);
    expect(r.gate).not.toHaveBeenCalled();
  });

  it('即时入口与周期共用单实例；慢模型不中断主活动，重复请求不排队', async () => {
    const r = rig({ timeoutMs: 4_000_000, maxResultAgeMs: 4_000_000 });
    let finish!: (text: string) => void;
    r.reply(() => new Promise((resolve) => { finish = resolve; }));
    expect(r.review.review().accepted).toBe(true);
    expect(r.review.review()).toMatchObject({ accepted: false, reason: '已有复盘正在运行' });
    r.review.noteSnapshot([message('user', '身边有玩家挥手', { ts: stamp() })]);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(r.forks).toHaveLength(1);
    expect(r.review.state().running).toBe(true);
    expect(r.gate).not.toHaveBeenCalled();
    finish('稍后问问那位玩家在做什么，主意识自行决定。');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.injected).toHaveLength(1);
    expect(r.review.state().running).toBe(false);
    expect(r.review.review().accepted).toBe(true); // 请求期间的新活动仍可复盘
  });

  it('共享模型 fallback 可热切换；每次复盘绑定请求时的调度预算', async () => {
    const r = rig();
    let finish!: (text: string) => void;
    r.reply(() => new Promise(resolve => { finish = resolve; }));
    r.review.review();
    expect(r.forks[0].generationPriority).toBeUndefined();
    r.cfg.yieldToForeground = true;
    r.cfg.generationWaitTimeoutMs = 12_345;
    r.review.noteSnapshot([message('user', '刚和同伴交换了地图', { ts: stamp() })]);
    finish('(nothing)');
    await vi.advanceTimersByTimeAsync(0);
    r.review.review();
    expect(r.forks[1]).toMatchObject({ generationPriority: 'background', generationWaitTimeoutMs: 12_345 });
    expect(r.forks[0].generationPriority).toBeUndefined();
    finish('(nothing)');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.injected).toEqual([]);
    expect(r.gate).not.toHaveBeenCalled();
  });

  it('超时发出AbortSignal，迟到结果不投递且未真正结束前不重开', async () => {
    const r = rig({ timeoutMs: 20 });
    let finish!: (text: string) => void;
    r.reply(() => new Promise((resolve) => { finish = resolve; }));
    r.review.review();
    await vi.advanceTimersByTimeAsync(20);
    expect(r.forks[0].signal?.aborted).toBe(true);
    expect(r.review.state()).toMatchObject({ running: true, lastOutcome: 'timed_out', lastFinishedAt: null,
      lastFailure: { code: 'timeout' }, lastResultAgeMs: 20 });
    expect(r.review.review().accepted).toBe(false);
    finish('迟到的计划');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.injected).toEqual([]);
    expect(r.review.state().running).toBe(false);
    expect(r.review.state()).toMatchObject({ lastOutcome: 'timed_out', lastFailure: { code: 'timeout' } });
    expect(r.review.review().accepted).toBe(true);
  });

  it('云结果年龄从材料采样起算；过期不投递、不标已复盘，可重新请求', async () => {
    const r = rig({ timeoutMs: 10_000, maxResultAgeMs: 1_000, yieldToForeground: true });
    let finish!: (text: string) => void;
    r.reply(() => new Promise(resolve => { finish = resolve; }));
    r.review.review();
    const capturedAt = stamp();
    await vi.advanceTimersByTimeAsync(1_001);
    finish('根据已过期材料生成的建议');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.injected).toEqual([]);
    expect(r.review.state()).toMatchObject({ running: false, lastStartedAt: capturedAt,
      lastFinishedAt: stamp(), lastCompletedAt: null, lastOutcome: 'expired', lastResultAgeMs: 1_001,
      lastFailure: { code: 'result_expired', at: stamp() } });
    expect(r.forks[0]).toMatchObject({ provider: 'configured-planner', tools: [], generationPriority: 'background' });
    expect(r.gate).not.toHaveBeenCalled();
    expect(r.review.review().accepted).toBe(true);
    finish('新的采样值得沿河探索，先让主意识核验现场。');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.injected).toHaveLength(1);
    expect(r.review.state()).toMatchObject({ lastOutcome: 'completed', lastFailure: null });
  });

  it('普通前台活动不中断有效期内结果；过期预算按请求时配置固定', async () => {
    const r = rig({ maxResultAgeMs: 1_000 });
    let finish!: (text: string) => void;
    r.reply(() => new Promise(resolve => { finish = resolve; }));
    r.review.review();
    r.cfg.maxResultAgeMs = 1;
    await vi.advanceTimersByTimeAsync(1_000);
    r.review.noteSnapshot([message('user', '刚和路过玩家打了招呼', { ts: stamp() })]);
    finish('稍后可以继续探索河流，出发前复核食物与现场。');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.injected).toHaveLength(1);
    expect(r.injected[0].text).toContain('建议尚未执行');
    expect(r.review.state()).toMatchObject({ lastOutcome: 'completed', lastResultAgeMs: 1_000, lastFailure: null });
    expect(r.gate).not.toHaveBeenCalled();
    expect(r.review.review().accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    finish('第二次已经超过新预算的建议');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.injected).toHaveLength(1);
    expect(r.review.state()).toMatchObject({ lastOutcome: 'expired', lastResultAgeMs: 2 });
  });

  it('请求失败可观察且不会回退主provider；成功空结果清除失败状态', async () => {
    const r = rig();
    r.reply(async () => { throw new Error('云端请求失败，模拟提供方私有错误内容'); });
    r.review.review();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.review.state()).toMatchObject({ running: false, lastOutcome: 'failed', lastCompletedAt: null,
      lastFailure: { code: 'request_failed', at: stamp() } });
    expect(JSON.stringify(r.review.state())).not.toContain('私有错误内容');
    expect(r.forks).toHaveLength(1);
    expect(r.forks[0].provider).toBe('configured-planner');
    expect(r.injected).toEqual([]);
    r.reply(async () => '(nothing)');
    expect(r.review.review().accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.review.state()).toMatchObject({ lastOutcome: 'empty', lastFailure: null, lastCompletedAt: stamp() });
    expect(r.gate).not.toHaveBeenCalled();
  });

  it('生命周期取消不被稍后的超时误记；迟到结果仍不可投递', async () => {
    const r = rig({ timeoutMs: 100 });
    let finish!: (text: string) => void;
    r.reply(() => new Promise(resolve => { finish = resolve; }));
    r.review.review();
    r.review.stop();
    await vi.advanceTimersByTimeAsync(101);
    finish('取消后晚到的计划');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.review.state()).toMatchObject({ running: false, lastOutcome: 'cancelled', lastFailure: null });
    expect(r.injected).toEqual([]);
  });

  it('停节奏只取消本owner并取消请求；配置变动后旧provider结果失效', async () => {
    const r = rig();
    let finish!: (text: string) => void;
    r.reply(() => new Promise((resolve) => { finish = resolve; }));
    r.review.review();
    r.cfg.provider = 'new-planner';
    finish('旧provider的计划');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.injected).toEqual([]);
    r.review.review();
    r.timers.set(new Date(Date.now() + 60_000).toISOString(), { owner: 'other' });
    r.review.stop();
    expect(r.forks[1].signal?.aborted).toBe(true);
    expect(r.timers.list().map((timer) => timer.payload.owner)).toEqual(['other']);
    finish('已停节奏后的结果');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.injected).toEqual([]);
  });

  it('disabled或provider空不回退主模型；相同快照和(nothing)不反复复盘', async () => {
    const r = rig({ enabled: false });
    expect(r.review.review().accepted).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(r.forks).toEqual([]);
    r.cfg.enabled = true; r.cfg.provider = '';
    expect(r.review.review().accepted).toBe(false);
    expect(r.forks).toEqual([]);
    r.cfg.provider = 'configured-planner';
    r.reply(async () => '(nothing)');
    r.review.review();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.injected).toEqual([]);
    expect(r.review.review().accepted).toBe(false);
    expect(r.forks).toHaveLength(1);
  });

  it('采样区分调用意图和实际失败，去重；不把旧事件或自己的复盘当新活动', async () => {
    const r = rig();
    const actual = [functionCall('c1', 'mc_do', '{"action":"fish"}', { ts: stamp() }),
      functionResult('c1', '失败：没有鱼竿', { ts: stamp() })];
    r.snapshot(actual); r.review.noteSnapshot(actual); r.review.noteSnapshot(actual);
    r.review.review();
    const input = r.forks[0].messages.map((entry) => itemText(entry.item)).join('\n');
    expect(input.match(/没有鱼竿/g)).toHaveLength(1);
    expect(input).toContain('调用 mc_do'); expect(input).toContain('实际工具回执');
    await vi.advanceTimersByTimeAsync(0);
    r.snapshot([message('user', '上周刷塔', { ts: '2025-12-25T10:00:00Z' }),
      message('user', '自己的复盘', { frame: { events: [{ source: 'persona', type: 'planning', cursor: 5,
        ts: stamp(), start: 0, chars: 5 }] } })]);
    expect(r.review.review().accepted).toBe(false);
    expect(r.forks).toHaveLength(1);
  });

  it('材料按token估算预算裁剪并说明缺失；保留最新活动，不导入完整main前缀', () => {
    const records = planningMessages({ constitution: '原则'.repeat(10_000),
      memories: [{ file: 'goal.md', text: '旧目标'.repeat(10_000) }], pending: '',
      activity: '旧活动'.repeat(10_000) + '最新实际回执：沿河发现村庄', capturedAt: stamp() }, 1024);
    expect(estimateMessagesTokens(records)).toBeLessThanOrEqual(1024);
    const input = records.map((entry) => itemText(entry.item)).join('\n');
    expect(input).toContain('部分记录未展开'); expect(input).toContain('最新实际回执');
    expect(records).toHaveLength(2);
  });

  it('巨大的现场或技能状态不能挤掉后面的偏好、长期目标与待办', () => {
    const records = planningMessages({ constitution: '原则'.repeat(10_000), observations: '库存技能'.repeat(30_000),
      memories: [{ file: 'preferences.md', text: '补给够用后探索学习，已验证的技能可以造食物。' },
        { file: 'project.md', text: '房屋主体完成，下一阶段检查入口通行。' }],
      pending: '等待环境改变，期间继续其他活动', activity: '最新现场', capturedAt: stamp() }, 4096, true);
    const input = records.map(record => itemText(record.item)).join('\n');
    expect(input).toContain('已验证的技能可以造食物'); expect(input).toContain('下一阶段检查入口通行');
    expect(input).toContain('期间继续其他活动'); expect(estimateMessagesTokens(records)).toBeLessThanOrEqual(4096);
  });

  it('Persona声明不接收事件且没有任何工具；console手动复盘遵守disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortiv-planning-persona-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const persona = new CortiV({ memoryDir: dir, tickDelayMs: () => null });
    persona.attach(makeFakeHarnessApi());
    persona.startRhythm(); cleanup.push(() => persona.stopRhythm());
    const decl = persona.declareSessions().find((session) => session.id === PLANNING)!;
    expect(decl).toMatchObject({ persistent: false, receivesEvents: false });
    expect(decl.tools()).toEqual([]); expect(decl.rounds()).toEqual({ soft: 1, hard: 1 });
    const console = persona.console();
    expect(console.panels?.find((panel) => panel.id === 'planning')?.getMethods).toEqual(['state']);
    expect(await console.invoke!('planning', 'review', [])).toMatchObject({ accepted: false, reason: '长期复盘未启用' });
    expect(await console.invoke!('planning', 'state', [])).toMatchObject({ enabled: false, running: false });
  });

  it('owner配置默认关闭，provider引用和文件指针可热更，模型强度保留provider配置', () => {
    const cfg = definition.defaults();
    expect(cfg.planning).toMatchObject({ enabled: false, provider: '', intervalMinutes: 30 });
    expect(CORTIV_PLANNING_CONFIG_GROUP.owner).toBe('persona');
    expect(CORTIV_FAST_ATTENTION_CONFIG_GROUP.owner).toBe('persona');
    expect(readGroupValues(cfg, CORTIV_PLANNING_CONFIG_GROUP)['planning.memoryFiles']).toBe('sessions/_recent.md');
    expect(coerceGroupValues(CORTIV_PLANNING_CONFIG_GROUP, { 'planning.memoryFiles': 'goals.md\nexperience.md' }))
      .toEqual({ values: { 'planning.memoryFiles': 'goals.md\nexperience.md' } });
    expect(CORTIV_PLANNING_CONFIG_GROUP.schema.properties).not.toHaveProperty('planning.model');
  });
});
