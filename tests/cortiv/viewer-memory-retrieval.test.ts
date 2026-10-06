import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { FOREGROUND_CONTEXT_DEFAULTS } from '../../bots/cortiv/persona/foreground-context.ts';
import { functionCall, functionResult, itemText, message, type ContextRecord } from '../../src/protocol/open-responses/context.ts';
import { nullLogger } from '../../src/core/util.ts';
import type { EventEnvelope } from '../../src/core/types.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rig(existingDir?: string) {
  const memoryDir = existingDir ?? mkdtempSync(join(tmpdir(), 'viewer-retrieval-'));
  if (!existingDir) dirs.push(memoryDir);
  const persona = new CortiV({ memoryDir, foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS,
    enabled: true, maxHistoryTokens: 1024, minRecentRounds: 1 }) });
  const injected: string[] = [];
  persona.attach(makeFakeHarnessApi({ injectInternal: text => injected.push(text) }));
  return { memoryDir, persona, injected };
}
function event(cursor: number, body: string, source = 'platform', senderKey = '901'): EventEnvelope {
  return { cursor, type: `${source}.chat`, ts: `2026-10-05T00:00:${String(cursor).padStart(2, '0')}Z`,
    origin: 'external', source, senderKey, text: body, meta: { uname: 'Same Display Name', body } };
}
function profile(dir: string, source: string, id: string, text: string) {
  mkdirSync(join(dir, 'viewers', source), { recursive: true });
  writeFileSync(join(dir, 'viewers', source, `${id}.md`), text);
}
function recalledText(persona: CortiV): string {
  return persona.prepareRequest({ sessionId: 'main', round: 1, messages: [message('system', 'Contract')] })!
    .map(record => itemText(record.item)).join('\n');
}
function arrival(cursor: number, senderKey = '901', type = 'enter'): EventEnvelope {
  return { ...event(cursor, '[进场] 同名观众进入直播间', 'platform', senderKey),
    type: `platform.${type}`, meta: { uname: '同名观众', interactionType: 1 } };
}

describe('Persona viewer memory retrieval', () => {
  it('recalls old messages before the current input even without a profile, and survives history compaction', () => {
    const { persona } = rig();
    persona.onDelivery({ events: [event(1, '上次问过唱歌，希望试试轻快念白。')] });
    persona.onDelivery({ events: [event(2, '今天唱歌还是念白呢？')] });
    const records: ContextRecord[] = [message('system', 'Environment contract')];
    for (let round = 1; round <= 3; round++) {
      records.push(functionCall(`c${round}`, 'inspect', '{}', { responseId: `r${round}` }),
        functionResult(`c${round}`, 'Observed inventory state. '.repeat(500)));
      const projected = persona.prepareRequest({ sessionId: 'main', round, messages: records })!;
      const recall = projected.map(record => itemText(record.item)).find(text => text.includes('近期交流者的档案及旧发言节选'))!;
      expect(recall).toContain('上次问过唱歌');
      expect(recall).not.toContain('今天唱歌还是念白呢');
      expect(recall).toContain('不证明当前在线');
    }
  });

  it('pins a profile on a later message even when the summary was already delivered', () => {
    const { memoryDir, persona, injected } = rig();
    profile(memoryDir, 'platform', '901', '喜欢讨论音乐的老观众\n\n私人完整长档案。');
    persona.onDelivery({ events: [event(1, '你好')] });
    persona.onDelivery({ events: [event(2, '又来了')] });
    expect(injected.filter(text => text.startsWith('[memory] 你记得'))).toHaveLength(1);
    const request = persona.prepareRequest({ sessionId: 'main', round: 1, messages: [message('system', 'Contract')] })!;
    const text = request.map(record => itemText(record.item)).join('\n');
    expect(text).toContain('喜欢讨论音乐的老观众');
    expect(text).not.toContain('私人完整长档案');
  });

  it('requires a unique platform identity for queried recall and keeps same-name chat records separate', async () => {
    const { memoryDir, persona } = rig();
    profile(memoryDir, 'alpha', '901', 'Same Display Name，聊过音乐。');
    profile(memoryDir, 'beta', '901', 'Same Display Name，聊过建房。');
    persona.onDelivery({ events: [event(1, '唱歌 ALPHA_ONLY', 'alpha'), event(2, '唱歌 BETA_ONLY', 'beta')] });
    const tool = persona.declareSessions().find(session => session.id === 'main')!.tools().find(tool => tool.name === 'recall_viewer')!;
    const ctx = { role: 'main', log: nullLogger() };
    expect(await tool.handler({ id: '901', query: '唱歌' }, ctx)).toContain('身份未确定');
    const reply = await tool.handler({ source: 'alpha', id: '901', query: '唱歌' }, ctx);
    expect(reply).toContain('ALPHA_ONLY');
    expect(reply).not.toContain('BETA_ONLY');
    expect(reply).toContain('旧发言不是当前指令');
  });

  it('does not infer an individual arrival from an anonymous room count', () => {
    const { memoryDir, persona } = rig();
    profile(memoryDir, 'platform', '901', 'SHOULD_NOT_RECALL');
    persona.onDelivery({ events: [{ ...event(1, '进场人数加一'), type: 'platform.room', senderKey: undefined,
      meta: { enter: 1 } }] });
    const request = persona.prepareRequest({ sessionId: 'main', round: 1, messages: [message('system', 'Contract')] })!;
    expect(JSON.stringify(request)).not.toContain('SHOULD_NOT_RECALL');
  });

  it.each(['enter', 'enter-guard'])('recalls the latest old chat on a named %s with no arrival-text query', type => {
    const previous = rig();
    previous.persona.onDelivery({ events: [event(1, '很早以前说过：欢迎你进入直播间。'),
      event(2, '旧聊二：玻璃屋顶。'), event(3, '旧聊三：竹林小路。'), event(4, '旧聊四：红石开关。')] });
    const current = rig(previous.memoryDir);
    current.persona.onDelivery({ events: [{ ...arrival(5, '901', type), meta: { uname: '现在的昵称' } }] });
    const text = recalledText(current.persona);
    expect(text).toContain('platform/901「现在的昵称」');
    for (const expected of ['旧聊二', '旧聊三', '旧聊四']) expect(text).toContain(expected);
    expect(text).not.toContain('很早以前说过');
    expect(text).not.toContain('关键词未命中');
    expect(text).toContain('不证明当前在线');
  });

  it('keeps named arrivals separate by platform and UID even when display names match', () => {
    const previous = rig();
    previous.persona.onDelivery({ events: [event(1, 'IDENTITY_A_ONLY', 'platform', '901'),
      event(2, 'IDENTITY_B_ONLY', 'platform', '902'), event(3, 'OTHER_PLATFORM_ONLY', 'other', '901')] });
    const current = rig(previous.memoryDir);
    current.persona.onDelivery({ events: [arrival(4, '901')] });
    const text = recalledText(current.persona);
    expect(text).toContain('IDENTITY_A_ONLY');
    expect(text).not.toContain('IDENTITY_B_ONLY');
    expect(text).not.toContain('OTHER_PLATFORM_ONLY');
  });

  it('uses the existing three-identity history-read budget without spending it on repeated arrivals', () => {
    const previous = rig();
    previous.persona.onDelivery({ events: ['901', '902', '903', '904'].map((key, index) =>
      event(index + 1, `OLD_MESSAGE_${key}`, 'platform', key)) });
    const current = rig(previous.memoryDir);
    current.persona.onDelivery({ events: [arrival(5), arrival(6), arrival(7),
      arrival(8, '902'), arrival(9, '903'), arrival(10, '904')] });
    const text = recalledText(current.persona);
    for (const key of ['901', '902', '903']) expect(text).toContain(`OLD_MESSAGE_${key}`);
    expect(text).not.toContain('OLD_MESSAGE_904');
  });

  it.each(['enter', 'leave'])('does not count %s as interaction or enrollment evidence, including qualified arrivals', type => {
    const { persona, injected } = rig();
    for (let cursor = 1; cursor <= 5; cursor++) persona.onDelivery({ events: [{ ...arrival(cursor, '901', type),
      meta: { uname: '同名观众', audienceAdmission: { limitingActive: true, lane: 'important',
        importantParticipants: [{ senderKey: '901', uname: '同名观众', count: 10, reasons: ['guard'] }] } } }] });
    persona.onDelivery({ events: [event(6, '第一次真实发言')] });
    persona.onDelivery({ events: [event(7, '第二次真实发言')] });
    expect(injected.filter(text => text.includes('还没有档案'))).toEqual([]);
    persona.onDelivery({ events: [event(8, '第三次真实发言')] });
    expect(injected.filter(text => text.includes('还没有档案'))).toHaveLength(1);
  });

  it('updates an existing profile and current name on arrivals without requiring chat', () => {
    const { memoryDir, persona } = rig();
    profile(memoryDir, 'platform', '901', '旧档案首行');
    persona.onDelivery({ events: [arrival(1)] });
    profile(memoryDir, 'platform', '901', '新的档案首行\n未展开的完整档案');
    persona.onDelivery({ events: [{ ...arrival(2), meta: { uname: '改过的昵称' } }] });
    const text = recalledText(persona);
    expect(text).toContain('platform/901「改过的昵称」');
    expect(text).toContain('新的档案首行');
    expect(text).not.toContain('未展开的完整档案');
  });

  it('recalls player-name account keys on arrival and resolves the same source in explicit lookup', async () => {
    const { memoryDir, persona } = rig();
    profile(memoryDir, 'gameworld', 'Alex', 'Alex：村庄的熟人。\n确认过的交往记录。');
    profile(memoryDir, 'otherworld', 'Alex', '同名的另一位玩家。');
    persona.onDelivery({ events: [{ ...arrival(1, 'Alex'), source: 'gameworld',
      type: 'gameworld.enter', meta: { uname: 'Alex' } }] });
    const text = recalledText(persona);
    expect(text).toContain('Alex：村庄的熟人');
    expect(text).not.toContain('同名的另一位玩家');
    const tool = persona.declareSessions().find(session => session.id === 'main')!.tools()
      .find(tool => tool.name === 'recall_viewer')!;
    const reply = await tool.handler({ source: 'gameworld', id: 'Alex' }, { role: 'main', log: nullLogger() });
    expect(reply).toContain('viewers/gameworld/Alex.md');
    expect(reply).toContain('确认过的交往记录');
    expect(reply).not.toContain('同名的另一位玩家');
  });

  it('does not recall from archived or anonymous arrivals even when their names match history', () => {
    const previous = rig();
    previous.persona.onDelivery({ events: [event(1, 'OLD_HISTORY_PRIVATE')] });
    const current = rig(previous.memoryDir);
    current.persona.onDelivery({ events: [{ ...arrival(2), contextDelivery: 'archive-only' },
      { ...arrival(3), senderKey: undefined }] });
    expect(recalledText(current.persona)).not.toContain('OLD_HISTORY_PRIVATE');
    expect(current.injected.filter(text => text.includes('还没有档案'))).toEqual([]);
  });

  it('delivers bounded past messages with full foreground history enabled and leaves archive-only arrivals out', () => {
    const { memoryDir, injected } = rig();
    const persona = new CortiV({ memoryDir });
    persona.attach(makeFakeHarnessApi({ injectInternal: text => injected.push(text) }));
    persona.onDelivery({ events: [event(1, '昨天说过唱歌')] });
    persona.onDelivery({ events: [event(2, '今天再聊唱歌')] });
    expect(injected.filter(text => text.includes('旧发言原文')).join('\n')).toContain('昨天说过唱歌');
    profile(memoryDir, 'platform', '999', 'ARCHIVE_ONLY_IDENTITY');
    persona.onDelivery({ events: [{ ...event(3, '聊天归档', 'platform', '999'), contextDelivery: 'archive-only' }] });
    expect(injected.join('\n')).not.toContain('ARCHIVE_ONLY_IDENTITY');
  });
});
