import { describe, expect, it } from 'vitest';
import { ViewerEncounters, VIEWER_ENCOUNTER_LIMITS } from '../../bots/cortiv/persona/viewer-encounters.ts';
import { estimateTokens } from '../../src/core/util.ts';
import type { EventEnvelope } from '../../src/core/types.ts';

function event(cursor: number, type = 'enter', source = 'stream', id = '42'): EventEnvelope {
  return { cursor, source, senderKey: id, type: `${source}.${type}`, origin: 'external',
    ts: `2026-10-09T07:${String(cursor).padStart(2, '0')}:00Z`, text: '同名账号',
    meta: { uname: 'Same Name', socialScope: source === 'stream' ? 'live-room' : 'minecraft-server' } };
}

describe('social encounter evidence across context replacement', () => {
  it('keeps prior arrival and chat times instead of treating each entry signal as a new person', () => {
    const context = new ViewerEncounters();
    context.observe(event(1)); context.observe(event(2, 'danmaku')); context.observe(event(3));
    const text = context.text();
    expect(text).toContain('本进程首次观察=2026-10-09T07:01:00Z');
    expect(text).toContain('前次=2026-10-09T07:01:00Z');
    expect(text).toContain('最近发言=2026-10-09T07:02:00Z');
    expect(text).toContain('进场信号=2 次');
    expect(context.observe(event(1))).toBe('');
    expect(context.text()).toBe(text);
  });

  it('separates server arrivals, nearby observations and room arrivals for same-name accounts', () => {
    const context = new ViewerEncounters();
    context.observe(event(1)); context.observe(event(2, 'enter', 'game'));
    context.observe({ ...event(3, 'event', 'game'), meta: { minecraftPlayerObservation: { kind: 'appearance' } } });
    context.observe(event(4, 'leave', 'game'));
    const text = context.text();
    expect(text).toContain('stream/42「Same Name」；范围=直播间');
    expect(text).toContain('game/42「Same Name」；范围=Minecraft 服务器');
    expect(text).toContain('最新事件=game.leave #4');
    expect(text.match(/进场信号=1 次/g)).toHaveLength(2);
    expect(text).toContain('不证明此刻在线');
  });

  it('does not turn anonymous counts, archived deliveries, or ordinary game events into encounters', () => {
    const context = new ViewerEncounters();
    context.observe({ ...event(1), senderKey: undefined });
    context.observe({ ...event(2), contextDelivery: 'archive-only' });
    context.observe(event(3, 'task', 'game'));
    expect(context.text()).toBe('');
  });

  it('keeps identity and context budgets bounded and clears on a new session', () => {
    const context = new ViewerEncounters();
    for (let index = 1; index <= 30; index++) context.observe(event(index, 'chat', 'stream', String(index)));
    expect(context.text()).not.toContain('stream/1「');
    expect(context.text()).toContain('stream/30「');
    expect(estimateTokens(context.text())).toBeLessThanOrEqual(VIEWER_ENCOUNTER_LIMITS.tokens);
    context.clear(); expect(context.text()).toBe('');
  });
});
