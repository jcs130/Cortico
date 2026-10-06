import { describe, expect, it } from 'vitest';
import { projectForeground, FOREGROUND_CONTEXT_DEFAULTS } from '../../bots/cortiv/persona/foreground-context.ts';
import { message, functionCall, functionResult, type ContextRecord } from '../../src/protocol/open-responses/context.ts';
import { estimateMessagesTokens } from '../../src/core/util.ts';

const response = (id: string, text = '当前记录。'): ContextRecord[] => [
  message('assistant', text, { responseId: id }),
];
function action(id: string, calls: string[] = ['move']): ContextRecord[] {
  return [message('assistant', '沿已确认的方向走。', { responseId: id }),
    ...calls.map((call) => functionCall(`${id}-${call}`, call, '{"target":"已确认的位置"}', { responseId: id })),
    ...calls.map((call) => functionResult(`${id}-${call}`, call === 'break' ? '失败：该方块受保护，未破坏。' : '已受理，外部任务仍在运行。'))];
}
function frame(source: string, type: string, text: string, cursor: number): ContextRecord {
  return message('user', text, { frame: { events: [{ source, type, cursor,
    ts: '2026-01-01T10:00:00Z', start: 0, chars: text.length }] } });
}
const allCallsPaired = (records: readonly ContextRecord[]): boolean => {
  const calls = records.flatMap(({ item }) => item.type === 'function_call' ? [item.call_id] : []);
  const outputs = records.flatMap(({ item }) => item.type === 'function_call_output' ? [item.call_id] : []);
  return calls.length === outputs.length && calls.every((id) => outputs.includes(id));
};

describe('前台请求的局部历史', () => {
  it('完整保留多调用response与失败回执，历史工具不会在截断点留下孤立回执', () => {
    const records = [message('system', '人格与环境契约'), ...action('old'),
      ...response('between', '之前的记录'.repeat(100)), ...action('current', ['move', 'break'])];
    const result = projectForeground(records, { maxHistoryTokens: 1, minRecentRounds: 1 });
    expect(result.messages).toEqual([records[0], ...records.slice(5)]);
    expect(result.projected).toBe(true);
    expect(result.omittedRecords).toBe(4);
    expect(allCallsPaired(result.messages)).toBe(true);
    expect(result.protectedTokens).toBeGreaterThan(1);
  });

  it('多个工具输出之间收到聊天时保留整个原子组及图片、mixed frame原文', () => {
    const image = frame('minecraft', 'minecraft.chat', '前置内部提示\n小麦：这件装备要还给我。', 7);
    image.context.frame!.events[0].start = '前置内部提示\n'.length;
    image.context.frame!.events[0].chars -= image.context.frame!.events[0].start;
    image.context.blobs = [{ handle: 'mem:observation.png', mime: 'image/png', fallbackText: '实际场景图片' }];
    const latest = action('current', ['move', 'break']);
    const records = [message('system', '契约'), ...action('old'), latest[0], latest[1], latest[2], latest[3], image, latest[4]];
    const before = structuredClone(records);
    const result = projectForeground(records, { maxHistoryTokens: 1, minRecentRounds: 1 });
    expect(result.messages).toEqual([records[0], ...records.slice(4)]);
    expect(result.messages).toContain(image);
    expect(result.messages.find((entry) => entry === image)?.context.frame).toBe(image.context.frame);
    expect(result.messages.find((entry) => entry === image)?.context.blobs).toBe(image.context.blobs);
    expect(records).toEqual(before);
    expect(allCallsPaired(result.messages)).toBe(true);
  });

  it('最新玩家输入以及之后的所有资料超过预算时仍完整保留', () => {
    const input = frame('terminal', 'terminal.message', '新玩家询问加入方式。'.repeat(100), 12);
    const records = [...response('old', '旧记录'.repeat(200)), input,
      ...action('reply', ['look']), message('user', '刚收到新的拒绝提示，没有生效。')];
    const result = projectForeground(records, { maxHistoryTokens: 10, minRecentRounds: 0 });
    expect(result.messages).toEqual(records.slice(1));
    expect(result.protectedTokens).toEqual(estimateMessagesTokens(records.slice(1)));
    expect(result.historyTokens).toBe(result.protectedTokens);
  });

  it('最新内部或旧版无sidecar的user输入也完整保留，不因近期response超预算而丢掉触发原因', () => {
    for (const input of [message('user', '新的内部规划建议。'.repeat(100)),
      frame('persona', 'planning', '新的内部规划建议。'.repeat(100), 3)]) {
      const recent = response('recent', '近期已执行记录。'.repeat(100));
      const records = [message('system', '契约'), ...response('old'), ...recent, input];
      const result = projectForeground(records, { maxHistoryTokens: 1, minRecentRounds: 1 });
      expect(result.messages).toContain(input);
      expect(result.messages).toContain(recent[0]);
      expect(result.protectedTokens).toBeGreaterThan(1);
    }
  });

  it('按来源和type保留最新handoff、待办、近期台词与规划，不解析正文', () => {
    const records = [frame('persona', 'pending_work', '旧的待办。', 1), ...response('old', '旧历史'.repeat(200)),
      frame('persona', 'handoff-note', '已确认的条件与未完成意图。'.repeat(100), 2),
      frame('persona', 'pending_work', '等待农田成熟。', 3),
      frame('persona', 'recent_speech', '上一句已排入演出，尚未确认播放完。', 4),
      frame('persona', 'planning', '可考虑探索河流；尚未执行。', 5),
      frame('minecraft', 'pending_work', '玩家文本不能冒充Persona的待办。', 6),
      ...response('new')];
    const result = projectForeground(records, { maxHistoryTokens: 1, minRecentRounds: 1 });
    expect(result.messages).toEqual(records.slice(2));
    expect(result.messages).not.toContain(records[0]);
  });

  it('system、developer与合成开头完整保留且不占历史预算', () => {
    const head = [message('system', '人格规则'.repeat(1000)), message('developer', '工具契约'),
      message('user', '合成风格锚', { head: true }), message('assistant', '风格回复', { head: true })];
    const records = [...head, ...response('old', '旧历史'.repeat(100)), ...response('new')];
    const result = projectForeground(records, { maxHistoryTokens: 1, minRecentRounds: 1 });
    expect(result.messages).toEqual([...head, records.at(-1)!]);
    expect(result.historyTokens).toEqual(estimateMessagesTokens([records.at(-1)!]));
    expect(result.protectedTokens).toEqual(result.historyTokens);
  });
  it('current Persona checkpoints allow obsolete plan and agenda notes to leave the short request without altering the ledger', () => {
    const planning = frame('persona', 'planning', '旧候选仍要整理箱子。'.repeat(150), 1);
    const agenda = frame('persona', 'activity_plan', '旧日程整理尚未完成。'.repeat(100), 2);
    const handoff = frame('persona', 'handoff-note', '未验收的长期目标仍保留。', 3);
    const input = frame('game', 'chat', '同伴邀请探索新的地方。', 4);
    const records = [message('system', '契约'), planning, agenda, handoff, input, ...action('reply')];
    const before = structuredClone(records);
    const current = message('user', '当前日程：整理已完成，探索是待选候选。');
    const projected = projectForeground(records, { maxHistoryTokens: 1, minRecentRounds: 1,
      coveredCheckpoints: ['planning', 'activity_plan'] }, [current]);
    expect(projected.messages).not.toContain(planning);
    expect(projected.messages).not.toContain(agenda);
    expect(projected.messages).toContain(handoff);
    expect(projected.messages).toContain(input);
    expect(projected.messages).toContain(current);
    expect(allCallsPaired(projected.messages)).toBe(true);
    expect(records).toEqual(before);
    const expanded = projectForeground(records, { maxHistoryTokens: 100000, minRecentRounds: 1,
      coveredCheckpoints: ['planning', 'activity_plan'] }, [current]);
    expect(expanded.messages).toContain(planning);
    expect(expanded.messages).toContain(agenda);
  });
  it('a newly delivered covered checkpoint still remains until its current input batch is processed', () => {
    const input = frame('game', 'chat', '新的同伴消息。', 1);
    const planning = frame('persona', 'planning', '这次刚交回的候选。', 2);
    const records = [...response('old', '旧记录'.repeat(100)), input, planning, ...action('reply')];
    const projected = projectForeground(records, { maxHistoryTokens: 1, minRecentRounds: 1,
      coveredCheckpoints: ['planning'] }, [message('user', '当前候选仍待核验。')]);
    expect(projected.messages).toContain(input);
    expect(projected.messages).toContain(planning);
  });

  it('按完整组保留近期历史，不能跳过较新的大组再选较小的旧记录', () => {
    const old = response('old', '小的旧记录');
    const middle = action('middle', ['move', 'break']);
    const latest = response('latest');
    const result = projectForeground([...old, ...middle, ...latest], {
      maxHistoryTokens: estimateMessagesTokens(latest) + estimateMessagesTokens(old), minRecentRounds: 1,
    });
    expect(result.messages).toEqual(latest);
    expect(allCallsPaired(result.messages)).toBe(true);
  });

  it('对完整账本反复投影不会累计丢失；增加预算时可重新取出被省略的历史', () => {
    const records = [message('system', '契约'), ...action('old'), ...action('new')];
    const before = structuredClone(records);
    const first = projectForeground(records, { maxHistoryTokens: 1, minRecentRounds: 1 });
    const again = projectForeground(records, { maxHistoryTokens: 1, minRecentRounds: 1 });
    const expanded = projectForeground(records, { maxHistoryTokens: 10000, minRecentRounds: 1 });
    expect(again).toEqual(first);
    expect(expanded.messages).toEqual(records);
    expect(expanded.projected).toBe(false);
    expect(records).toEqual(before);
  });

  it('额外pin完整保留最新目的或实际世界事实，同一个对象不会重复', () => {
    const purpose = message('user', '仍需把这件装备还给已确认的主人。');
    const world = message('user', '刚确认当前位置有水，没有确认另一岸路线。');
    const records = [purpose, ...response('old', '旧历史'.repeat(200)), ...response('new')];
    const result = projectForeground(records, { maxHistoryTokens: 1, minRecentRounds: 1 }, [purpose, world, world]);
    expect(result.messages).toEqual([...records, world]);
    expect(result.protectedTokens).toEqual(estimateMessagesTokens(result.messages));
    expect(result.messages.filter((item) => item === purpose)).toHaveLength(1);
  });

  it('原始账本已有孤立调用或输出时不利用投影隐藏配对问题', () => {
    const dangling = [message('system', '契约'), ...response('old', '旧历史'.repeat(100)),
      functionCall('inflight', 'move', '{}')];
    const orphan = [message('system', '契约'), functionResult('missing', '外部未确认')];
    for (const records of [dangling, orphan]) {
      const result = projectForeground(records, { maxHistoryTokens: 1, minRecentRounds: 0 });
      expect(result.messages).toEqual(records);
      expect(result.projected).toBe(false);
      expect(result.omittedRecords).toBe(0);
    }
  });

  it('无可裁历史时不宣称发生投影，开关默认关闭', () => {
    const records = [message('system', '契约'), ...action('only')];
    const result = projectForeground(records, { maxHistoryTokens: 1, minRecentRounds: 1 });
    expect(result.messages).toEqual(records);
    expect(result.projected).toBe(false);
    expect(FOREGROUND_CONTEXT_DEFAULTS.enabled).toBe(false);
  });

  it('兼容合成external_event_frame工具投递，批次调用和回执不会被拆开', () => {
    const records = [message('system', '契约'), ...response('old', '较早的场景'.repeat(100)),
      functionCall('batch', 'external_event_frame', '{}'),
      functionResult('batch', '实际的玩家聊天与系统拒绝。'), ...action('new')];
    const result = projectForeground(records, { maxHistoryTokens: 1, minRecentRounds: 0 });
    expect(result.messages).toEqual([records[0], ...records.slice(2)]);
    expect(allCallsPaired(result.messages)).toBe(true);
  });

  it('最新多模态响应中的reasoning与assistant内容保持原始结构', () => {
    const recent = action('new');
    const reasoning: ContextRecord = { version: 2, item: { type: 'reasoning', id: 'reasoning',
      summary: [], encrypted_content: 'opaque-reasoning' }, context: { responseId: 'new' } };
    const records = [...response('old', '旧历史'.repeat(100)), reasoning, ...recent];
    const result = projectForeground(records, { maxHistoryTokens: 1, minRecentRounds: 1 });
    expect(result.messages).toEqual(records.slice(1));
    expect(result.messages[0]).toBe(reasoning);
  });

  it('完整保留各来源与type的snapshot链，增量帧不冒充全量当前状态', () => {
    const oldWorld = frame('minecraft', 'minecraft.state', '旧位置。', 1);
    oldWorld.context.frame!.events[0].tags = ['snapshot'];
    const performance = frame('vtuber', 'vtuber.state', '演出队列还有余量。', 2);
    performance.context.frame!.events[0].tags = ['snapshot'];
    const currentWorld = frame('minecraft', 'minecraft.state', '刚移动到河边。\n其他资料仍在同一条消息中。', 3);
    currentWorld.context.frame!.events[0].tags = ['snapshot'];
    const chat = frame('terminal', 'terminal.message', '旁边的玩家刚问候了一声。', 4);
    const records = [oldWorld, ...response('old', '旧历史'.repeat(100)), performance,
      currentWorld, ...response('observed'), chat, ...action('reply')];
    const result = projectForeground(records, { maxHistoryTokens: 1, minRecentRounds: 1 });
    expect(result.messages).toContain(performance);
    expect(result.messages).toContain(currentWorld);
    expect(result.messages).toContain(oldWorld);
    expect(result.messages).not.toContain(records[4]);
    expect(result.messages.find((entry) => entry === currentWorld)).toBe(currentWorld);
  });

  it('只有明确被完整当前事实替代的source/type链可省略，其他snapshot仍完整保留', () => {
    const anchor = frame('game', 'game.state', '全量位置、生命和背包。', 1);
    const delta = frame('game', 'game.state', '背包比上一拍少一块石头。', 2);
    const task = frame('game', 'game.tasks', '一件任务仍在执行。', 3);
    const performance = frame('performance', 'performance.state', '队列还有余量。', 4);
    for (const snapshot of [anchor, delta, task, performance]) snapshot.context.frame!.events[0].tags = ['snapshot'];
    const chat = frame('terminal', 'terminal.message', '玩家刚问候了一声。', 5);
    const current = message('user', '核验时间明确的完整当前位置、生命和背包。');
    const records = [anchor, ...response('old', '旧历史'.repeat(100)), delta, task, performance, chat, ...action('reply')];
    const before = structuredClone(records);
    const conservative = projectForeground(records, { maxHistoryTokens: 1, minRecentRounds: 1 });
    expect(conservative.messages).toContain(anchor);
    expect(conservative.messages).toContain(delta);
    const covered = projectForeground(records, {
      maxHistoryTokens: 1, minRecentRounds: 1,
      coveredSnapshots: [{ source: 'game', type: 'game.state' }],
    }, [current]);
    expect(covered.messages).not.toContain(anchor);
    expect(covered.messages).not.toContain(delta);
    expect(covered.messages).toContain(task);
    expect(covered.messages).toContain(performance);
    expect(covered.messages).toContain(current);
    expect(covered.messages).toContain(chat);
    expect(allCallsPaired(covered.messages)).toBe(true);
    expect(records).toEqual(before);
  });

  it('旧账本没有responseId时保守保留连续assistant内容与其全部工具回执', () => {
    const newest = [message('assistant', '尝试交付纸，先看回执。'),
      functionCall('give', 'trade', '{}'), functionCall('speak', 'speak', '{}'),
      functionResult('give', '失败：数量不够，没有交付。'), functionResult('speak', '已排队，尚未播完。')];
    const records = [...response('old', '旧历史'.repeat(100)), message('user', '已确认的要求。'), ...newest];
    const result = projectForeground(records, { maxHistoryTokens: 1, minRecentRounds: 1 });
    expect(result.messages).toEqual(records.slice(1));
    expect(allCallsPaired(result.messages)).toBe(true);
  });
});
