import { describe, expect, it } from 'vitest';
import { excerptHandoffRecords } from '../../bots/cortiv/persona/context-excerpts.ts';
import { HANDOFF_NOTE_TYPE } from '../../bots/cormini/persona/handoffNote.ts';
import { functionCall, functionResult, itemText, message, type ContextRecord } from '../../src/protocol/open-responses/context.ts';
import type { FrameEventRef } from '../../src/core/types.ts';

const longNote = '# 交接笔记 · 旧材料（09:00–09:30）\n' + '调用只是意图，真实回执才证明结果。'.repeat(150);
const selected = (text: string): string => text.slice(0, 65) + '\n[中间原文未展开]\n' + text.slice(-35);
function mixed(): ContextRecord {
  const lead = '内部提示：新回执优先，仍需继续行动。\n';
  const bodies = [longNote, '小禾：请把装备还给我。', longNote + '\n最后一次操作被拒绝，未生效。', '系统：距离过远，没有使用床。'];
  const refs: FrameEventRef[] = [];
  let start = lead.length;
  for (const [index, body] of bodies.entries()) {
    refs.push({ cursor: 10 + index, source: index % 2 === 0 ? 'persona' : 'minecraft',
      type: index % 2 === 0 ? HANDOFF_NOTE_TYPE : 'minecraft.chat',
      ts: '2026-01-01T09:31:00+08:00', start, chars: body.length });
    start += body.length + 1;
  }
  return message('user', lead + bodies.join('\n'), { ts: '2026-01-01T09:31:00+08:00', frame: { events: refs } });
}
function later(): ContextRecord {
  return message('user', '刚确认的玩家问候。', { frame: { events: [{ cursor: 20,
    source: 'minecraft', type: 'minecraft.chat', ts: '2026-01-01T09:35:00+08:00', start: 0, chars: 10 }] } });
}
const refText = (record: ContextRecord, index: number): string => {
  const ref = record.context.frame!.events[index];
  return itemText(record.item).slice(ref.start, ref.start + ref.chars);
};

describe('请求副本的旧交接笔记节选', () => {
  it('excerpts only historical snapshots covered by complete current World facts and preserves adjacent chat and media', () => {
    const original = mixed();
    const refs = original.context.frame!.events;
    refs[0].source = 'game'; refs[0].type = 'game.state'; refs[0].tags = ['snapshot'];
    refs[2].source = 'other'; refs[2].type = 'game.state'; refs[2].tags = ['snapshot'];
    original.context.blobs = [{ handle: 'mem:scene.png', mime: 'image/png', fallbackText: '历史画面' }];
    const before = structuredClone(original);
    const options = { coveredSnapshots: [{ source: 'game', type: 'game.state' }] };
    const result = excerptHandoffRecords([original, later()], selected, options)[0];
    expect(refText(result, 0)).toContain('历史 game/game.state 快照');
    expect(refText(result, 0)).toContain('事件#10');
    expect(refText(result, 0)).toContain('2026-01-01T09:31:00+08:00');
    expect(refText(result, 0)).toContain('expand_context');
    expect(refText(result, 2)).toBe(refText(original, 2));
    expect(refText(result, 1)).toBe(refText(original, 1));
    expect(refText(result, 3)).toBe(refText(original, 3));
    expect(result.context.blobs).toBe(original.context.blobs);
    expect(itemText(result.item).length).toBeLessThan(itemText(original.item).length / 2 + 200);
    expect(original).toEqual(before);
    expect(excerptHandoffRecords([original], selected, options)[0]).toBe(original);
    expect(excerptHandoffRecords([original, later()], selected, { ...options, protectedRecords: [original] })[0]).toBe(original);
    refs[0].tags = undefined;
    expect(excerptHandoffRecords([original, later()], selected, options)[0]).toBe(original);
  });
  it('replaces a historical Persona checkpoint inside a mixed frame while keeping outside speech, media and source ranges', () => {
    const original = mixed();
    original.context.frame!.events[0].type = 'activity_plan';
    original.context.blobs = [{ handle: 'mem:scene.png', mime: 'image/png', fallbackText: '现场图片' }];
    const before = structuredClone(original);
    const result = excerptHandoffRecords([original, later()], selected, { coveredCheckpoints: ['activity_plan'] })[0];
    expect(refText(result, 0)).toContain('已由本轮最新状态替代');
    expect(refText(result, 0)).not.toContain(longNote);
    expect(refText(result, 1)).toBe(refText(original, 1));
    expect(refText(result, 3)).toBe(refText(original, 3));
    expect(result.context.blobs).toBe(original.context.blobs);
    expect(original).toEqual(before);
    const refs = result.context.frame!.events;
    for (const ref of refs) expect(itemText(result.item).slice(ref.start, ref.start + ref.chars).length).toBe(ref.chars);
    expect(excerptHandoffRecords([original], selected, { coveredCheckpoints: ['activity_plan'] })[0]).toBe(original);
    expect(excerptHandoffRecords([original, later()], selected, {
      coveredCheckpoints: ['activity_plan'], protectedRecords: [original],
    })[0]).toBe(original);
  });
  it('同一混合frame的两段旧笔记分别节选，内部行、聊天和拒绝原文不变', () => {
    const original = mixed();
    const result = excerptHandoffRecords([original, later()], selected);
    expect(itemText(result[0].item)).toMatch(/^内部提示：新回执优先，仍需继续行动。\n/);
    expect(refText(result[0], 1)).toBe(refText(original, 1));
    expect(refText(result[0], 3)).toBe(refText(original, 3));
    expect(refText(result[0], 0)).toContain('事件#10');
    expect(refText(result[0], 0)).toContain('2026-01-01T09:31:00+08:00');
    expect(refText(result[0], 2)).toContain('事件#12');
    expect(refText(result[0], 2)).toContain('expand_context');
    expect(itemText(result[0].item).length).toBeLessThan(itemText(original.item).length / 3);
    expect(result[0].item.id).toBe(original.item.id);
  });

  it('多个text part跨越节选区间时保留image part、其他part属性与blob引用', () => {
    const original = mixed();
    const text = itemText(original.item);
    const image = { type: 'input_image' as const, image_url: 'data:image/png;base64,test', detail: 'auto' as const };
    const content = [{ type: 'input_text' as const, text: text.slice(0, 60) }, image,
      { type: 'input_text' as const, text: text.slice(60, text.length - 40) },
      { type: 'input_text' as const, text: text.slice(text.length - 40) }];
    if (original.item.type !== 'message') throw new Error('fixture');
    original.item.content = content;
    original.context.blobs = [{ handle: 'mem:scene.png', mime: 'image/png', fallbackText: '已观察的现场图片。' }];
    const result = excerptHandoffRecords([original, later()], selected)[0];
    if (result.item.type !== 'message' || !Array.isArray(result.item.content)) throw new Error('result');
    expect(result.item.content[1]).toBe(image);
    expect(result.item.content).toHaveLength(content.length);
    expect(result.context.blobs).toBe(original.context.blobs);
    expect(refText(result, 1)).toBe(refText(original, 1));
    expect(refText(result, 3)).toBe(refText(original, 3));
    expect(refText(result, 0)).toContain(selected(refText(original, 0)));
  });

  it('start和chars精确重算，cursor、来源、时间与未折叠记录的长度保留', () => {
    const original = mixed();
    const result = excerptHandoffRecords([original, later()], selected)[0];
    const before = original.context.frame!.events;
    const after = result.context.frame!.events;
    for (const [index, ref] of after.entries()) {
      expect(refText(result, index).length).toBe(ref.chars);
      expect({ ...ref, start: 0, chars: 0 }).toEqual({ ...before[index], start: 0, chars: 0 });
      if (index > 0) expect(ref.start).toBe(after[index - 1].start + after[index - 1].chars + 1);
    }
    expect(after[1].chars).toBe(before[1].chars);
    expect(after[3].chars).toBe(before[3].chars);
  });

  it('最新user输入批和之后记录完整，不因为标题或大体积就折叠新材料', () => {
    const old = mixed();
    const current = mixed();
    const result = excerptHandoffRecords([old, message('assistant', '已看过上一批。'), current], selected);
    expect(result[0]).not.toBe(old);
    expect(result[2]).toBe(current);
    const only = excerptHandoffRecords([current], selected);
    expect(only[0]).toBe(current);
  });

  it('显式指定的新自动交接范围可立即节选，同帧其他输入和短交接段完整保留', () => {
    const current = mixed();
    const result = excerptHandoffRecords([current], selected, {
      protectedRecords: [current], currentHandoffs: [current.context.frame!.events[0]],
    })[0];
    expect(refText(result, 0)).toContain('交接笔记原文节选');
    for (const index of [1, 2, 3]) expect(refText(result, index)).toBe(refText(current, index));
    expect(itemText(result.item)).toMatch(/^内部提示：新回执优先，仍需继续行动。\n/);
    expect(current.item.id).toBe(result.item.id);
  });

  it('protected records保持原文，未精确指定的同type或伪造来源范围不折叠', () => {
    const protectedRecord = mixed();
    const result = excerptHandoffRecords([protectedRecord, later()], selected, { protectedRecords: [protectedRecord] });
    expect(result[0]).toBe(protectedRecord);
    const impersonated = mixed();
    impersonated.context.frame!.events[0].source = 'minecraft';
    const selectedRef = structuredClone(impersonated.context.frame!.events[2]);
    expect(excerptHandoffRecords([impersonated], selected, {
      currentHandoffs: [impersonated.context.frame!.events[0], selectedRef],
    })[0]).toBe(impersonated);
  });

  it('最新外部frame早于最新user时，从更早的外部批开始完整保留', () => {
    const old = mixed();
    const external = functionResult('events', longNote, { frame: { events: [{ cursor: 30,
      source: 'minecraft', type: 'minecraft.event', ts: '2026-01-01T10:00:00Z', start: 0, chars: longNote.length }] } });
    const stillCurrent = mixed();
    const records = [old, later(), functionCall('events', 'external_event_frame', '{}'), external,
      stillCurrent, message('user', '新内部提醒。')];
    const result = excerptHandoffRecords(records, selected);
    expect(result[0]).not.toBe(old);
    expect(result[4]).toBe(stillCurrent);
    expect(result[3]).toBe(external);
  });

  it('合成head、system和developer以及其他来源冒用相同type都不节选', () => {
    const head = mixed(); head.context.head = true;
    const system = mixed(); if (system.item.type === 'message') system.item.role = 'system';
    const developer = mixed(); if (developer.item.type === 'message') developer.item.role = 'developer';
    const impersonated = mixed(); impersonated.context.frame!.events.forEach((ref) => { ref.source = 'minecraft'; });
    const records = [head, system, developer, impersonated, later()];
    const result = excerptHandoffRecords(records, selected);
    for (const index of [0, 1, 2, 3]) expect(result[index]).toBe(records[index]);
  });

  it('无sidecar、越界或重叠范围时保留原记录，不解析自然语言找旧笔记', () => {
    const missing = message('user', longNote);
    const invalid = mixed(); invalid.context.frame!.events[0].start = -1;
    const overlapping = mixed(); overlapping.context.frame!.events[1].start = 1;
    const overrun = mixed(); overrun.context.frame!.events[0].chars = itemText(overrun.item).length + 1;
    const fractional = mixed(); fractional.context.frame!.events[0].chars = 1.5;
    const records = [missing, invalid, overlapping, overrun, fractional, later()];
    const result = excerptHandoffRecords(records, selected);
    for (const index of [0, 1, 2, 3, 4]) expect(result[index]).toBe(records[index]);
  });

  it('节选失败、空文本或并未变短时不额外改写记录', () => {
    const original = mixed();
    for (const excerpt of [() => { throw new Error('failed'); }, () => '', (text: string) => text]) {
      expect(excerptHandoffRecords([original, later()], excerpt)[0]).toBe(original);
    }
  });

  it('原始账本、媒体和sidecar不可变，按需展开仍能取出完整原文', () => {
    const original = mixed();
    const records = [original, later()];
    const before = structuredClone(records);
    const first = excerptHandoffRecords(records, selected);
    const again = excerptHandoffRecords(records, selected);
    expect(records).toEqual(before);
    expect(first).toEqual(again);
    expect(refText(original, 0)).toBe(longNote);
    expect(refText(original, 2)).toBe(longNote + '\n最后一次操作被拒绝，未生效。');
    expect(itemText(first[0].item)).not.toBe(itemText(original.item));
  });

  it('旧合成工具帧的string输出保留call_id和非笔记内容', () => {
    const original = mixed();
    const output = functionResult('old-batch', itemText(original.item), original.context);
    const records = [functionCall('old-batch', 'external_event_frame', '{}'), output, later()];
    const result = excerptHandoffRecords(records, selected);
    if (result[1].item.type !== 'function_call_output') throw new Error('result');
    expect(result[1].item.call_id).toBe('old-batch');
    expect(refText(result[1], 1)).toBe(refText(output, 1));
    expect(refText(result[1], 3)).toBe(refText(output, 3));
    expect(result[0]).toBe(records[0]);
    expect(itemText(output.item)).toContain(longNote);
  });
});
