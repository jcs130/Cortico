import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingWork, PENDING_WORK_ID_MAX_CHARS, PENDING_WORK_OWNER, PENDING_WORK_SUMMARY_MAX_CHARS } from '../../bots/cortiv/persona/pending-work.ts';
import { TimerStore } from '../../src/core/timers.ts';
import { nullLogger } from '../../src/core/util.ts';
import type { CoreApi, EventEnvelope } from '../../src/core/types.ts';

const cleanup: Array<() => void> = [];

function rig(existing?: string) {
  const dir = existing ?? mkdtempSync(join(tmpdir(), 'cortico-pending-work-'));
  if (!existing) cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const timers = new TimerStore(join(dir, 'runtime'));
  cleanup.push(() => timers.stop());
  const injected: string[] = [];
  const gate = vi.fn(() => { throw new Error('待办不得阻断前台'); });
  const core = {
    timers, injectInternal: (text: string) => { injected.push(text); }, log: nullLogger(),
    deliveryGate: { set: gate, clear: gate, isBlocked: () => false },
  } as unknown as CoreApi;
  const manager = new PendingWork(core, dir, () => 'UTC');
  timers.onDue((entry) => manager.onDue(entry));
  manager.restore();
  timers.start();
  const saved = () => JSON.parse(readFileSync(join(dir, 'pending-work.json'), 'utf8')) as {
    entries: Array<{ id: string; status: string; timerId?: string; evidence?: { kind: string; cursor?: number; summary: string } }>;
  };
  return { dir, timers, injected, gate, core, manager, saved };
}

function event(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return { cursor: 1, source: 'chat', type: 'chat.message', senderKey: 'alice',
    origin: 'external', ts: new Date().toISOString(), text: '入口在东边', ...overrides };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
});

afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
  vi.useRealTimers();
});

describe('PendingWork', () => {
  it('所有展示标明可直接传回的原始 id，登记和只读展示不改变它', () => {
    const r = rig();
    const registered = r.manager.operate({ operation: 'defer', note: '稍后核对', after_seconds: 60 });
    const id = r.saved().entries[0].id;
    const label = `id=${JSON.stringify(id)}`;
    expect(registered).toContain(label);
    const stored = readFileSync(join(r.dir, 'pending-work.json'), 'utf8');
    expect(r.manager.operate({ operation: 'list' })).toContain(label);
    expect(r.manager.summary()).toContain(label);
    expect(readFileSync(join(r.dir, 'pending-work.json'), 'utf8')).toBe(stored);
    r.manager.onDue(r.timers.list()[0]);
    expect(r.injected[0]).toContain(label);
    expect(r.manager.operate({ operation: 'resolve', id })).toContain(label);
    expect(r.manager.operate({ operation: 'resolve', id })).toContain(`${label} 已结清`);
    expect(r.saved().entries).toMatchObject([{ id, status: 'resolved' }]);
  });

  it.each(['resolve', 'cancel'])('旧 # 展示输入可 %s 既有项，终态重复操作也命中同一项', (operation) => {
    const r = rig();
    r.manager.operate({ operation: 'defer', id: 'review', note: '核对结果', after_seconds: 60 });
    const out = r.manager.operate({ operation, id: '#review' });
    expect(out).toContain('id="review"');
    expect(r.saved().entries).toEqual([expect.objectContaining({ id: 'review', status: operation === 'resolve' ? 'resolved' : 'cancelled' })]);
    expect(r.timers.list()).toEqual([]);
    expect(r.manager.operate({ operation, id: '#review' })).toContain('没有再次改变');
  });

  it('旧 # 展示输入再次 defer 更新原始项与定时器，重启后不产生副本', async () => {
    const first = rig();
    first.manager.operate({ operation: 'defer', id: 'review', note: '旧计划', after_seconds: 60 });
    const oldTimer = first.timers.list()[0];
    const out = first.manager.operate({ operation: 'defer', id: '#review', note: '新计划', after_seconds: 120 });
    expect(out).toContain('id="review"');
    expect(first.saved().entries).toHaveLength(1);
    expect(first.saved().entries[0].id).toBe('review');
    expect(first.timers.list()).toHaveLength(1);
    expect(first.timers.list()[0].payload.workId).toBe('review');
    expect(first.timers.list()[0].id).not.toBe(oldTimer.id);
    first.manager.onDue(oldTimer);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.injected).toEqual([]);
    first.timers.stop();
    const second = rig(first.dir);
    expect(second.saved().entries).toMatchObject([{ id: 'review', status: 'waiting' }]);
    expect(second.timers.list()).toHaveLength(1);
    expect(second.timers.list()[0].payload.workId).toBe('review');
    expect(second.manager.operate({ operation: 'cancel', id: '#review' })).toContain('id="review"');
    expect(second.saved().entries).toHaveLength(1);
  });

  it('合法 # 自定义 id 原样保存并精确优先，包括已关闭项', () => {
    const r = rig();
    r.manager.operate({ operation: 'defer', id: '#review', note: '带 # 的事项', after_seconds: 60 });
    r.manager.operate({ operation: 'defer', id: 'review', note: '普通事项', after_seconds: 120 });
    const update = r.manager.operate({ operation: 'defer', id: '#review', note: '只更新带 # 的事项', after_seconds: 180 });
    expect(update).toContain('id="#review"');
    expect(r.saved().entries.map((entry) => entry.id)).toEqual(['#review', 'review']);
    r.manager.operate({ operation: 'cancel', id: '#review' });
    expect(r.manager.operate({ operation: 'resolve', id: '#review' })).toContain('已取消，没有再次改变');
    expect(r.saved().entries.map((entry) => [entry.id, entry.status])).toEqual([['#review', 'cancelled'], ['review', 'waiting']]);
    expect(r.timers.list().map((timer) => timer.payload.workId)).toEqual(['review']);
    expect(r.manager.operate({ operation: 'list', include_closed: true })).toContain('id="#review"');
  });

  it('旧展示别名仅剥一层 #，不会递归匹配或折叠其他原始 id', () => {
    const r = rig();
    r.manager.operate({ operation: 'defer', id: '#review', note: '带 # 的事项', after_seconds: 60 });
    expect(r.manager.operate({ operation: 'resolve', id: '##review' })).toContain('id="#review"');
    expect(r.manager.operate({ operation: 'resolve', id: '###review' })).toContain('找不到');
    r.manager.operate({ operation: 'defer', id: '###review', note: '独立原始 ID', after_seconds: 60 });
    expect(r.saved().entries.map((entry) => entry.id)).toEqual(['#review', '###review']);
    expect(r.manager.operate({ operation: 'cancel', id: 'Review' })).toContain('找不到');
  });

  it.each(['defer', 'resolve', 'cancel'])('最长原始 id 的旧展示输入可 %s，持久 id 仍为 80 字符', (operation) => {
    const r = rig();
    const id = 'x'.repeat(PENDING_WORK_ID_MAX_CHARS);
    r.manager.operate({ operation: 'defer', id, note: '原始事项', after_seconds: 60 });
    const out = r.manager.operate({ operation, id: `#${id}`, ...(operation === 'defer' ? { note: '更新事项', after_seconds: 120 } : {}) });
    expect(out).not.toContain('输入错误');
    expect(r.saved().entries).toHaveLength(1);
    expect(r.saved().entries[0].id).toBe(id);
    const stored = readFileSync(join(r.dir, 'pending-work.json'), 'utf8');
    for (const unknown of ['z'.repeat(PENDING_WORK_ID_MAX_CHARS + 1), `#${'z'.repeat(PENDING_WORK_ID_MAX_CHARS)}`, `##${id}`]) {
      expect(r.manager.operate({ operation: 'defer', id: unknown, note: '不应创建', after_seconds: 60 })).toContain('输入错误');
    }
    expect(readFileSync(join(r.dir, 'pending-work.json'), 'utf8')).toBe(stored);
  });

  it('带空格、引号、反斜线和换行的合法 id 用 JSON 展示并按原值查找', () => {
    const r = rig();
    const id = ' #choice "quoted"\\line\nend ';
    const label = `id=${JSON.stringify(id)}`;
    expect(r.manager.operate({ operation: 'defer', id, note: '保留原始值', after_seconds: 60 })).toContain(label);
    expect(r.manager.summary()).toContain(label);
    expect(r.manager.operate({ operation: 'list' })).toContain(label);
    expect(r.manager.operate({ operation: 'resolve', id: id.trim() })).toContain('找不到');
    expect(r.manager.operate({ operation: 'resolve', id })).toContain(label);
    expect(r.saved().entries[0].id).toBe(id);
  });

  it('等待只登记待办；不阻断其他事件，也不把发送成功当完成', () => {
    const r = rig();
    r.manager.operate({ operation: 'defer', id: 'ask', note: '稍后核对入口', after_seconds: 60,
      wait_for: { source: 'chat', sender_key: 'alice', contains: '入口' } });
    r.manager.onDelivery([event({ senderKey: 'bob' })]);
    expect(r.saved().entries[0].status).toBe('waiting');
    expect(r.injected).toEqual([]);
    expect(r.gate).not.toHaveBeenCalled();
    expect(r.timers.list()).toHaveLength(1);
    expect(r.manager.summary()).toContain('等待不占用前台');
  });

  it('事件条件按 AND 匹配，忽略旧事件、内部文本及 Persona 外部注入', () => {
    const r = rig();
    r.manager.operate({ operation: 'defer', id: 'ask', note: '核对回答',
      wait_for: { source: 'chat', type: 'chat.message', sender_key: 'alice', contains: '入口' } });
    for (const rejected of [
      event({ ts: '2026-01-01T09:59:59.999Z' }), event({ origin: 'internal' }),
      event({ source: 'persona' }), event({ type: 'chat.status' }),
      event({ senderKey: 'bob' }), event({ text: '天气晴朗' }), event({ ts: 'invalid' }),
    ]) r.manager.onDelivery([rejected]);
    expect(r.saved().entries[0].status).toBe('waiting');
    r.manager.onDelivery([event({ cursor: 42 })]);
    expect(r.saved().entries[0]).toMatchObject({ status: 'ready', evidence: { kind: 'event', cursor: 42 } });
    expect(r.injected).toHaveLength(1);
    expect(r.injected[0]).toContain('尚未完成');
  });

  it('contains 使用区分大小写的字面匹配，不按正则或目标完成推论', () => {
    const r = rig();
    r.manager.operate({ operation: 'defer', id: 'literal', note: '复核消息', wait_for: { contains: 'A.*B' } });
    r.manager.onDelivery([event({ text: 'AXXB' }), event({ text: 'a.*b' })]);
    expect(r.saved().entries[0].status).toBe('waiting');
    r.manager.onDelivery([event({ text: '收到 A.*B 字样' })]);
    expect(r.saved().entries[0].status).toBe('ready');
  });

  it('回复先到后取消定时索引；重复事件和迟到超时只提醒一次', async () => {
    const r = rig();
    r.manager.operate({ operation: 'defer', id: 'ask', note: '核对回答', after_seconds: 2, wait_for: { sender_key: 'alice' } });
    const timer = r.timers.list()[0];
    r.manager.onDelivery([event()]);
    r.manager.onDelivery([event({ cursor: 2 })]);
    r.manager.onDue(timer);
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.injected).toHaveLength(1);
    expect(r.timers.list()).toEqual([]);
    expect(r.saved().entries[0].status).toBe('ready');
  });

  it('超时只转待复核，不自动结清；随后回复不会重复提醒', async () => {
    const r = rig();
    r.manager.operate({ operation: 'defer', id: 'ask', note: '检查有没有回答', after_seconds: 0.1, wait_for: { sender_key: 'alice' } });
    await vi.advanceTimersByTimeAsync(100);
    r.manager.onDelivery([event()]);
    expect(r.injected).toHaveLength(1);
    expect(r.saved().entries[0]).toMatchObject({ status: 'ready', evidence: { kind: 'timer' } });
    expect(r.manager.operate({ operation: 'resolve', id: 'ask', result: '已核对，改日再问' })).toContain('由你结清');
    expect(r.saved().entries[0]).toMatchObject({ status: 'resolved', evidence: { kind: 'resolve', summary: '已核对，改日再问' } });
    expect(r.manager.summary()).toBe('');
  });

  it('同 id 替换条件和定时器，取消及结清为幂等终态', async () => {
    const r = rig();
    r.manager.operate({ operation: 'defer', id: 'ask', note: '旧事项', after_seconds: 1, wait_for: { sender_key: 'alice' } });
    const old = r.timers.list()[0];
    r.manager.operate({ operation: 'defer', id: 'ask', note: '新事项', after_seconds: 10, wait_for: { sender_key: 'bob' } });
    r.manager.onDue(old);
    r.manager.onDelivery([event()]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.saved().entries).toHaveLength(1);
    expect(r.saved().entries[0].status).toBe('waiting');
    expect(r.injected).toEqual([]);
    expect(r.timers.list()).toHaveLength(1);
    r.manager.operate({ operation: 'cancel', id: 'ask' });
    r.manager.operate({ operation: 'cancel', id: 'ask' });
    r.manager.operate({ operation: 'resolve', id: 'ask' });
    expect(r.saved().entries[0].status).toBe('cancelled');
    expect(r.timers.list()).toEqual([]);
  });

  it('恢复未来待办复用原定时器，缺失索引会重建，其他 owner 不受影响', () => {
    const first = rig();
    first.manager.operate({ operation: 'defer', id: 'first', note: '等第一件', after_seconds: 60 });
    first.manager.operate({ operation: 'defer', id: 'second', note: '等第二件', after_seconds: 120 });
    const owned = [...first.timers.list()];
    const foreign = first.timers.set(new Date(Date.now() + 60_000).toISOString(), { owner: 'another' });
    expect(foreign.ok).toBe(true);
    first.timers.cancel(owned[1].id);
    first.timers.stop();
    const second = rig(first.dir);
    expect(second.timers.list().filter((timer) => timer.payload.owner === PENDING_WORK_OWNER)).toHaveLength(2);
    expect(second.timers.list().find((timer) => timer.payload.workId === 'first')?.id).toBe(owned[0].id);
    expect(second.timers.list().find((timer) => timer.payload.owner === 'another')).toBeDefined();
    expect(second.injected).toEqual([]);
    second.manager.restore();
    expect(second.timers.list()).toHaveLength(3);
  });

  it('离线期间到期恢复只提醒一次，保留已就绪证据跨重启', () => {
    const first = rig();
    first.manager.operate({ operation: 'defer', id: 'later', note: '回来看进展', after_seconds: 2 });
    first.timers.stop();
    vi.setSystemTime(new Date(Date.now() + 3000));
    const second = rig(first.dir);
    expect(second.injected).toHaveLength(1);
    expect(second.saved().entries[0].status).toBe('ready');
    second.manager.restore();
    expect(second.injected).toHaveLength(1);
    second.timers.stop();
    const third = rig(first.dir);
    expect(third.injected).toEqual([]);
    expect(third.manager.summary()).toContain('待复核');
  });

  it('恢复移除本 owner 的孤儿和重复索引，保留其他 owner', () => {
    const r = rig();
    r.manager.operate({ operation: 'defer', id: 'ask', note: '等一下', after_seconds: 60 });
    const at = new Date(Date.now() + 60_000).toISOString();
    r.timers.set(at, { owner: PENDING_WORK_OWNER, workId: 'ask' });
    r.timers.set(at, { owner: PENDING_WORK_OWNER, workId: 'missing-a' });
    r.timers.set(at, { owner: PENDING_WORK_OWNER, workId: 'missing-b' });
    r.timers.set(at, { owner: 'other', workId: 'ask' });
    r.manager.restore();
    expect(r.timers.list().filter((timer) => timer.payload.owner === PENDING_WORK_OWNER)).toHaveLength(1);
    expect(r.timers.list().filter((timer) => timer.payload.owner === 'other')).toHaveLength(1);
  });

  it('输入边界拒绝无触发、空条件、非法时间及未知字段；未写入错误待办', () => {
    const r = rig();
    for (const args of [
      { operation: 'defer', note: '等着' }, { operation: 'defer', note: '等着', after_seconds: 0 },
      { operation: 'defer', note: '等着', after_seconds: '2' }, { operation: 'defer', note: '等着', after_seconds: Infinity },
      { operation: 'defer', note: '等着', after_seconds: 1e20 }, { operation: 'defer', note: '等着', wait_for: {} },
      { operation: 'defer', note: '等着', wait_for: { source: '' } }, { operation: 'defer', note: '等着', wait_for: { fuzzy: '词' } },
      { operation: 'defer', note: ' ', after_seconds: 2 }, { operation: 'defer', note: '等着', after_seconds: 2, hack: true },
      { operation: 'resolve', id: '' }, { operation: 'finish', id: 'x' },
    ]) expect(r.manager.operate(args)).toContain('输入错误');
    expect(r.timers.list()).toEqual([]);
    expect(r.manager.summary()).toBe('');
  });

  it('损坏或不合法的 Memory 文件报错并保留原文', () => {
    const r = rig();
    const path = join(r.dir, 'pending-work.json');
    for (const content of ['{broken', JSON.stringify({ version: 1, entries: [{ id: 'x', status: 'waiting' }] })]) {
      writeFileSync(path, content, 'utf8');
      expect(() => new PendingWork(r.core, r.dir, () => 'UTC')).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(content);
    }
  });

  it('活跃摘要遵守上下文预算且时间推进不改变摘要；list 仍保留全部条目', () => {
    const r = rig();
    for (let index = 0; index < 20; index++) r.manager.operate({ operation: 'defer', id: `work-${index}`,
      note: '一件需要以后根据真实事件复核的待办'.repeat(20), after_seconds: 60 });
    const text = r.manager.summary();
    expect(text.length).toBeLessThanOrEqual(PENDING_WORK_SUMMARY_MAX_CHARS);
    expect(text).toContain('还有');
    vi.setSystemTime(new Date(Date.now() + 1000));
    expect(r.manager.summary()).toBe(text);
    const first = r.manager.operate({ operation: 'list' });
    expect(first).toContain('next_offset=10');
    expect(first).not.toContain('id="work-19"');
    expect(r.manager.operate({ operation: 'list', offset: 10 })).toContain('id="work-19"');
  });

  it('list 默认只列活跃待办，已关闭归档分页读取，输出不回灌全部历史', () => {
    const r = rig();
    for (let index = 0; index < 25; index++) {
      r.manager.operate({ operation: 'defer', id: `old-${index}`, note: `历史事项 ${index}`, after_seconds: 60 });
      r.manager.operate({ operation: 'resolve', id: `old-${index}`, result: '已经核对' });
    }
    r.manager.operate({ operation: 'defer', id: 'new', note: '当前事项', after_seconds: 60 });
    const current = r.manager.operate({ operation: 'list' });
    expect(current).toContain('活跃 1 项，已结清 25 项');
    expect(current).toContain('id="new"');
    expect(current).not.toContain('id="old-');
    const first = r.manager.operate({ operation: 'list', include_closed: true, limit: 20 });
    expect(first).toContain('id="old-19"');
    expect(first).not.toContain('id="old-20"');
    expect(first).toContain('next_offset=20');
    const second = r.manager.operate({ operation: 'list', include_closed: true, offset: 20, limit: 20 });
    expect(second).toContain('id="old-24"');
    expect(second).toContain('id="new"');
    expect(second).toContain('next_offset=无');
    for (const args of [{ limit: 21 }, { limit: 0 }, { offset: -1 }, { offset: 0.5 }, { include_closed: 'yes' }]) {
      expect(r.manager.operate({ operation: 'list', ...args })).toContain('输入错误');
    }
  });

  it('待复核证据排在旧等待事项前，不被摘要预算挤掉', () => {
    const r = rig();
    for (let index = 0; index < 20; index++) r.manager.operate({ operation: 'defer', id: `wait-${index}`,
      note: '等待较长时间的事项'.repeat(30), after_seconds: 60 });
    r.manager.operate({ operation: 'defer', id: 'review-now', note: '核对刚到的回答', wait_for: { sender_key: 'alice' } });
    r.manager.onDelivery([event()]);
    const text = r.manager.summary();
    expect(text.indexOf('id="review-now"')).toBeLessThan(text.indexOf('id="wait-0"'));
    expect(text).toContain('cursor=1');
    expect(text.length).toBeLessThanOrEqual(PENDING_WORK_SUMMARY_MAX_CHARS);
  });
});
