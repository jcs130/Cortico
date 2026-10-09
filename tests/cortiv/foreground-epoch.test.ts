import { describe, expect, it } from 'vitest';
import { ForegroundEpoch } from '../../bots/cortiv/persona/foreground-epoch.ts';
import { projectForeground } from '../../bots/cortiv/persona/foreground-context.ts';
import { excerptHandoffRecords } from '../../bots/cortiv/persona/context-excerpts.ts';
import { validatePairing } from '../../src/core/truncate.ts';
import { responseRequest } from '../../src/protocol/open-responses/context-helpers.ts';
import { functionCall, functionResult, itemText, message, type ContextRecord } from '../../src/protocol/open-responses/context.ts';

const options = { maxHistoryTokens: 600, minRecentRounds: 1 };
const wire = (records: readonly ContextRecord[]) => responseRequest({ model: 'local-fixture', thinking: false }, records).input!;
function action(id: string, calls = ['walk']): ContextRecord[] {
  return [message('assistant', '根据刚收到的真实状态继续。', { responseId: id }),
    ...calls.map((call) => functionCall(`${id}-${call}`, call, '{"target":"已观察位置"}', { responseId: id })),
    ...calls.map((call) => functionResult(`${id}-${call}`, call === 'break' ? '失败：受保护，未破坏。' : '已受理，尚未确认完成。'))];
}
function frame(source: string, type: string, text: string, cursor: number, snapshot = false): ContextRecord {
  return message('user', text, { frame: { events: [{ source, type, cursor,
    ts: '2026-01-01T10:00:00Z', start: 0, chars: text.length, ...(snapshot ? { tags: ['snapshot'] } : {}) }] } });
}
function source(): ContextRecord[] {
  return [message('system', '完整人格、行为契约与工具定义。'), message('user', '合成风格锚。', { head: true }),
    ...action('old'), message('assistant', '很久以前的探索记录。'.repeat(600), { responseId: 'large-old' }),
    frame('minecraft', 'minecraft.chat', '小禾：这件装备是我的，请不要捐赠。', 8), ...action('current', ['look', 'break'])];
}
function text(records: readonly ContextRecord[]): string { return records.map(({ item }) => itemText(item)).join('\n'); }

describe('前台上下文缓存epoch', () => {
  it('current pins replace obsolete state while the historical wire prefix stays stable', () => {
    const epoch = new ForegroundEpoch();
    const cfg = { ...options, pinMode: 'current' as const };
    const records = source();
    const first = epoch.prepare(records, cfg, [message('user', '魔力：20'), message('user', '当前目标：还工具')]);
    const added = action('progress');
    const next = epoch.prepare([...records,...added], cfg, [message('user', '魔力：25'), message('user', '当前目标：还工具')]);
    expect(wire(next.messages).slice(0, first.messages.length-2)).toEqual(wire(first.messages.slice(0,-2)));
    expect(text(next.messages)).not.toContain('魔力：20');
    expect(next.messages.slice(-2).map(record => itemText(record.item))).toEqual(['魔力：25','当前目标：还工具']);
    expect(next.rebuilt).toBe(false);
    expect(validatePairing(next.messages)).toEqual([]);
    const again = epoch.prepare([...records,...added], cfg, [message('user', '魔力：20')]);
    expect(again.messages.filter(record => itemText(record.item)==='魔力：20')).toHaveLength(1);
    expect(text(again.messages)).not.toContain('魔力：25');
    expect(text(again.messages)).not.toContain('当前目标：还工具');
  });

  it('current pins do not grow the request over repeated updates and source pins remain paired once', () => {
    const epoch = new ForegroundEpoch();
    const cfg = { ...options, pinMode: 'current' as const };
    const records = source();
    const receipt = records.at(-1)!;
    const initial = epoch.prepare(records, cfg, [receipt,message('user','当前状态0'.repeat(10))]);
    for (let index = 1; index < 50; index++) {
      const result = epoch.prepare(records, cfg, [receipt,message('user',`当前状态${index}`.repeat(10))]);
      expect(result.epoch).toBe(initial.epoch);
      expect(result.messages.length).toBe(initial.messages.length);
      expect(result.messages.filter(record => record.item.id===receipt.item.id)).toHaveLength(1);
      expect(validatePairing(result.messages)).toEqual([]);
    }
  });

  it('excerpts newly appended covered snapshots once while retaining wire prefix, fresh pins and adjacent chat', () => {
    const coverage = { ...options, coveredSnapshots: [{ source: 'game', type: 'game.state' }] };
    const epoch = new ForegroundEpoch(projectForeground, (records, cfg) => excerptHandoffRecords(records, text => text, {
      coveredSnapshots: cfg.coveredSnapshots, replaceCurrentState: true,
    }));
    const records = [message('system', '契约'), ...action('first')];
    const first = epoch.prepare(records, coverage, [message('user', '完整当前事实：原地点。')]);
    const snapshot = '本次现场快照。'.repeat(250);
    const chat = '同伴：请帮我开门。';
    const input = message('user', snapshot + '\n' + chat, { frame: { events: [
      { source: 'game', type: 'game.state', cursor: 10, ts: '2026-01-01T10:01:00Z', start: 0, chars: snapshot.length, tags: ['snapshot'] },
      { source: 'game', type: 'game.chat', cursor: 11, ts: '2026-01-01T10:01:00Z', start: snapshot.length + 1, chars: chat.length },
    ] } });
    const pin = message('user', '完整当前事实：已到门前。');
    const next = epoch.prepare([...records, input], coverage, [pin]);
    expect(next.rebuilt).toBe(false);
    expect(wire(next.messages).slice(0, first.messages.length)).toEqual(wire(first.messages));
    expect(text(next.messages)).toContain(chat);
    expect(text(next.messages)).toContain('本次 game/game.state 快照');
    expect(text(next.messages)).not.toContain(snapshot);
    expect(next.messages.at(-1)).toEqual(pin);
    expect(text([input])).toContain(snapshot);
    const stable = epoch.prepare([...records, input, ...action('reply')], coverage, [pin]);
    expect(wire(stable.messages).slice(0, next.messages.length)).toEqual(wire(next.messages));
    expect(validatePairing(stable.messages)).toEqual([]);
  });

  it('checkpoint coverage changes rebuild the request so replaced historical plans are no longer protected', () => {
    const epoch = new ForegroundEpoch();
    const planning = frame('persona', 'planning', '旧的计划说明。'.repeat(300), 1);
    const records = [message('system', '契约'), planning, frame('game', 'chat', '当前同伴发言。', 2), ...action('reply')];
    const pins = [message('user', '最新日程状态，旧阶段已完成。')];
    const first = epoch.prepare(records, options, pins);
    expect(first.messages).toContainEqual(planning);
    const next = epoch.prepare(records, { ...options, coveredCheckpoints: ['planning'] }, pins);
    expect(next.rebuildReason).toBe('options_changed');
    expect(next.messages).not.toContainEqual(planning);
    expect(next.messages).toContainEqual(pins[0]);
    expect(records[1]).toBe(planning);
  });
  it('完整实际投影视图作为下一次native wire输入前缀，包括事实、待办、notice、多调用及真实失败', () => {
    const epoch = new ForegroundEpoch();
    const initial = source();
    const before = structuredClone(initial);
    const pins = [message('user', '[minecraft] 最新位置与背包已核实。'), message('user', '[待办] 农田等待成熟。')];
    const notice = message('user', '[即时调用] 原账本保留，可用expand_context。');
    const first = epoch.prepare(initial, options, pins, notice);
    expect(first.rebuilt).toBe(true);
    expect(first.omittedRecords).toBeGreaterThan(0);
    expect(text(first.messages)).toContain('这件装备是我的');
    expect(text(first.messages)).toContain('失败：受保护，未破坏。');
    const added = [...action('next', ['move', 'eat']), frame('minecraft', 'task.done', '移动已完成；进食还在运行。', 9)];
    const second = epoch.prepare(structuredClone([...initial, ...added]), options,
      [message('user', '[minecraft] 最新位置与背包已核实。'), message('user', '[待办] 农田等待成熟。')], notice);
    const firstWire = wire(first.messages);
    const secondWire = wire(second.messages);
    expect(secondWire.slice(0, firstWire.length)).toEqual(firstWire);
    expect(JSON.stringify(secondWire.slice(0, firstWire.length))).toBe(JSON.stringify(firstWire));
    expect(second.messages.slice(first.messages.length)).toEqual(added);
    expect(second.epoch).toBe(first.epoch);
    expect(second.appendedPins).toBe(0);
    expect(second.appendedRecords).toBe(added.length);
    expect(validatePairing(second.messages)).toEqual([]);
    expect(initial).toEqual(before);
  });

  it('变化后的facts/pending在旧材料之后追加，同文的新id或metadata ts不造成重复', () => {
    const epoch = new ForegroundEpoch();
    const records = source();
    const first = epoch.prepare(records, options, [message('user', '当前魔力：20', { ts: 'old' })]);
    const same = epoch.prepare(structuredClone(records), options, [message('user', '当前魔力：20', { ts: 'new' })]);
    expect(wire(same.messages)).toEqual(wire(first.messages));
    expect(same.rebuildReason).toBe('unchanged');
    const changed = epoch.prepare(records, options, [message('user', '当前魔力：25')]);
    expect(wire(changed.messages).slice(0, first.messages.length)).toEqual(wire(first.messages));
    expect(itemText(changed.messages.at(-1)!.item)).toBe('当前魔力：25');
    expect(changed.appendedPins).toBe(1);
  });

  it('pin状态A→B→A必须再次追加A，不能用全局seen集合留下过期B', () => {
    const epoch = new ForegroundEpoch();
    const records = source();
    epoch.prepare(records, options, [message('user', '魔力：20')]);
    epoch.prepare(records, options, [message('user', '魔力：25')]);
    const result = epoch.prepare(records, options, [message('user', '魔力：20')]);
    expect(itemText(result.messages.at(-1)!.item)).toBe('魔力：20');
    expect(result.appendedPins).toBe(1);
    expect(result.messages.filter((entry) => itemText(entry.item) === '魔力：20')).toHaveLength(2);
  });

  it('输入与pin顺序重排均不改写旧epoch，重复pin和notice只插一次', () => {
    const epoch = new ForegroundEpoch();
    const records = source();
    const notice = message('user', '原文可展开。');
    const first = epoch.prepare(records, options, [message('user', 'A'), message('user', 'B'), message('user', 'A')], notice);
    const second = epoch.prepare(structuredClone(records), options, [message('user', 'B'), message('user', 'A')], message('user', '原文可展开。'));
    expect(wire(second.messages)).toEqual(wire(first.messages));
    expect(second.messages.filter((entry) => itemText(entry.item) === '原文可展开。')).toHaveLength(1);
    expect(second.messages[2].item.id).toBe(notice.item.id);
  });

  it('同id正文改变、前缀变化与原session删记录均触发重建，不能吞掉真实更新', () => {
    for (const edit of ['body', 'prefix', 'delete']) {
      const epoch = new ForegroundEpoch();
      const records = source();
      const first = epoch.prepare(records, options);
      const changed = structuredClone(records);
      if (edit === 'delete') changed.splice(2, 1);
      else {
        const record = edit === 'prefix' ? changed[0] : changed.at(-1)!;
        if (record.item.type === 'message') record.item.content = [{ type: 'input_text', text: '同id但内容已经改变。' }];
        else if (record.item.type === 'function_call_output') record.item.output = '真实失败更新：没有完成。';
      }
      const result = epoch.prepare(changed, options);
      expect(result.rebuilt).toBe(true);
      expect(result.rebuildReason).toBe('source_changed');
      expect(result.epoch).toBe(first.epoch + 1);
      if (edit === 'body') expect(text(result.messages)).toContain('真实失败更新');
      if (edit === 'prefix') expect(text(result.messages)).toContain('同id但内容已经改变');
    }
  });

  it('新交接记录触发epoch重建，仍完整保留新聊天和后续真实回执', () => {
    const epoch = new ForegroundEpoch();
    const records = source();
    epoch.prepare(records, options);
    const delta = [frame('persona', 'handoff-note', '当前目的与已证实的结果。', 10),
      frame('minecraft', 'minecraft.chat', '新朋友：请帮我。', 11), ...action('help')];
    const result = epoch.prepare([...records, ...delta], options);
    expect(result.rebuildReason).toBe('handoff');
    for (const record of delta) expect(result.messages).toContainEqual(record);
    expect(validatePairing(result.messages)).toEqual([]);
  });

  it('前缀改写同时引入多个新输入批时全部保留，旧id正文改写也作为真实更新保留', () => {
    const epoch = new ForegroundEpoch();
    const records = source();
    epoch.prepare(records, options);
    const changed = structuredClone(records);
    if (changed[0].item.type === 'message') changed[0].item.content = '更新后的完整契约。';
    const oldReceipt = changed[4];
    if (oldReceipt.item.type !== 'function_call_output') throw new Error('fixture');
    oldReceipt.item.output = '更正：旧任务实际失败。';
    const delta = [frame('minecraft', 'minecraft.chat', '第一批新消息。', 21), ...action('a'),
      frame('minecraft', 'minecraft.chat', '第二批新消息。', 22), ...action('b')];
    const result = epoch.prepare([...changed, ...delta], { maxHistoryTokens: 1, minRecentRounds: 0 });
    expect(result.rebuildReason).toBe('source_changed');
    expect(text(result.messages)).toContain('更正：旧任务实际失败。');
    for (const record of delta) expect(result.messages).toContainEqual(record);
    expect(validatePairing(result.messages)).toEqual([]);
  });

  it('coveredSnapshots从有效事实变为空时重建并恢复完整旧差分snapshot链', () => {
    const epoch = new ForegroundEpoch();
    const records = [message('system', '契约'), frame('minecraft', 'state', '基线：树在北侧。', 1, true),
      frame('minecraft', 'state', '差分：西侧新增河流。', 2, true),
      message('assistant', '旧历史'.repeat(500), { responseId: 'old' }),
      frame('minecraft', 'minecraft.chat', '现在请继续。', 3), ...action('new')];
    const covered = { ...options, coveredSnapshots: [{ source: 'minecraft', type: 'state' }] };
    const first = epoch.prepare(records, covered, [message('user', '完整当前事实：北树、西河。')]);
    expect(text(first.messages)).not.toContain('基线：');
    const result = epoch.prepare(structuredClone(records), options);
    expect(result.rebuildReason).toBe('options_changed');
    expect(text(result.messages)).toContain('基线：树在北侧。');
    expect(text(result.messages)).toContain('差分：西侧新增河流。');
  });

  it('预算/recent rounds配置改变重建，coverage集合仅重排则保持epoch', () => {
    const epoch = new ForegroundEpoch();
    const records = source();
    const a = [{ source: 'a', type: 'state' }, { source: 'b', type: 'state' }];
    const first = epoch.prepare(records, { ...options, coveredSnapshots: a });
    const same = epoch.prepare(records, { ...options, coveredSnapshots: [...a].reverse() });
    expect(same.rebuilt).toBe(false);
    expect(same.epoch).toBe(first.epoch);
    const changed = epoch.prepare(records, { ...options, maxHistoryTokens: 700, coveredSnapshots: a });
    expect(changed.rebuildReason).toBe('options_changed');
    const rounds = epoch.prepare(records, { ...options, maxHistoryTokens: 700, minRecentRounds: 2, coveredSnapshots: a });
    expect(rounds.rebuildReason).toBe('options_changed');
  });

  it('历史达到轮换阈值才重建，完整保留这次所有新输入批与多调用，不受软预算截断', () => {
    const epoch = new ForegroundEpoch();
    const records = source();
    const first = epoch.prepare(records, options);
    const delta = [frame('minecraft', 'minecraft.chat', '第一批新玩家消息：'.repeat(400), 20),
      ...action('reply-a', ['look', 'chat']), frame('minecraft', 'minecraft.chat', '第二批新玩家消息。', 21),
      ...action('reply-b', ['move', 'eat'])];
    const result = epoch.prepare([...records, ...delta], options);
    expect(result.rebuildReason).toBe('history_budget');
    expect(result.epoch).toBe(first.epoch + 1);
    for (const record of delta) expect(result.messages).toContainEqual(record);
    expect(result.protectedTokens).toBeGreaterThan(options.maxHistoryTokens);
    expect(validatePairing(result.messages)).toEqual([]);
    const stable = epoch.prepare(structuredClone([...records, ...delta]), options);
    expect(stable.rebuilt).toBe(false);
    expect(wire(stable.messages)).toEqual(wire(result.messages));
  });

  it('强制保留的巨大输入不会导致每轮重复冷重建', () => {
    const epoch = new ForegroundEpoch();
    const records = [message('system', '完整契约'), frame('terminal', 'message', '不能省略的新输入。'.repeat(1000), 1)];
    const first = epoch.prepare(records, { maxHistoryTokens: 10, minRecentRounds: 0 });
    expect(first.historyTokens).toBeGreaterThan(20);
    expect(first.rebuildAtHistoryTokens).toBeGreaterThan(first.historyTokens);
    expect(epoch.prepare(structuredClone(records), { maxHistoryTokens: 10, minRecentRounds: 0 }).rebuilt).toBe(false);
  });

  it('显式expand_context reset重新投影完整源账本，旧epoch事实不偷偷保留', () => {
    const epoch = new ForegroundEpoch();
    const records = source();
    const first = epoch.prepare(records, options, [message('user', '旧补充材料。')]);
    epoch.reset();
    const result = epoch.prepare(records, options);
    expect(result.rebuildReason).toBe('reset');
    expect(result.epoch).toBe(first.epoch + 1);
    expect(text(result.messages)).not.toContain('旧补充材料。');
  });

  it('可注入旧交接节选factory，实际节选版本在epoch内固定，原账本不变', () => {
    const epoch = new ForegroundEpoch((records, options, pins) =>
      projectForeground(excerptHandoffRecords(records, (value) => value.slice(0, 25) + '…' + value.slice(-25)), options, pins));
    const records = [message('system', '契约'), frame('persona', 'handoff-note', '很久以前的真实交接材料。'.repeat(600), 1),
      frame('minecraft', 'minecraft.chat', '最近收到的玩家消息。', 2), ...action('recent')];
    const before = structuredClone(records);
    const first = epoch.prepare(records, options);
    expect(text(first.messages)).toContain('expand_context');
    expect(first.projected).toBe(true);
    const next = epoch.prepare(structuredClone([...records, ...action('next')]), options);
    expect(wire(next.messages).slice(0, first.messages.length)).toEqual(wire(first.messages));
    expect(records).toEqual(before);
  });

  it('外部修改返回数组或嵌套item不污染下一次保留的完整wire前缀', () => {
    const epoch = new ForegroundEpoch();
    const records = source();
    const first = epoch.prepare(records, options, [message('user', '最新事实。')]);
    const before = wire(first.messages);
    const item = first.messages[0].item;
    if (item.type === 'message') item.content = '外部恶意改写。';
    first.messages.pop();
    expect(wire(epoch.prepare(structuredClone(records), options, [message('user', '最新事实。')]).messages)).toEqual(before);
  });

  it('input_image与blob引用原样保留，新媒体内容同id更新会重建', () => {
    const epoch = new ForegroundEpoch();
    const image = frame('minecraft', 'observation', '实际场景。', 1);
    if (image.item.type !== 'message') throw new Error('fixture');
    image.item.content = [{ type: 'input_text', text: '实际场景。' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' }];
    image.context.blobs = [{ handle: 'mem:scene.png', mime: 'image/png', fallbackText: '实际现场图片。' }];
    const records = [message('system', '契约'), image];
    const before = structuredClone(records);
    const first = epoch.prepare(records, options);
    expect(first.messages.at(-1)).toEqual(image);
    const changed = structuredClone(records);
    if (changed[1].item.type !== 'message' || !Array.isArray(changed[1].item.content)) throw new Error('fixture');
    changed[1].item.content[1] = { type: 'input_image', image_url: 'data:image/png;base64,BBBB', detail: 'auto' };
    const result = epoch.prepare(changed, options);
    expect(result.rebuildReason).toBe('source_changed');
    expect(records).toEqual(before);
  });

  it('晚到回执不沿用合成缺失回执；重建合法配对并保留真实失败', () => {
    const epoch = new ForegroundEpoch();
    const call = functionCall('late', 'move', '{}', { responseId: 'r1' });
    const records = [message('system', '契约'), call];
    const first = epoch.prepare(records, options);
    expect(validatePairing(first.messages)).toEqual([]);
    const result = epoch.prepare([...records, functionResult('late', '真实失败：目的地受阻。')], options);
    expect(result.rebuildReason).toBe('pairing');
    expect(validatePairing(result.messages)).toEqual([]);
    expect(text(result.messages)).toContain('真实失败：目的地受阻。');
    expect(result.messages.filter(({ item }) => item.type === 'function_call_output')).toHaveLength(1);
  });

  it('无有效预算时拒绝错误配置，不修改已有epoch', () => {
    const epoch = new ForegroundEpoch();
    const records = source();
    const initial = epoch.prepare(records, options);
    expect(() => epoch.prepare(records, { ...options, maxHistoryTokens: Number.NaN })).toThrow(RangeError);
    expect(epoch.prepare(records, options).epoch).toBe(initial.epoch);
  });
});
