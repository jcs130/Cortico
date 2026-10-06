import { describe, expect, it } from 'vitest';
import { projectForeground } from '../../bots/cortiv/persona/foreground-context.ts';
import { message, type ContextRecord } from '../../src/protocol/open-responses/context.ts';

function snapshotFrame(cursor: number, status: string): ContextRecord {
  const world = `位置与背包的历史读数。${'已观察物品。'.repeat(300)}`;
  const text = `${world}\n${status}`;
  return message('user', text, { frame: { events: [
    { source: 'mymc', type: 'mymc.world.snapshot', cursor, ts: '2026-10-04T09:00:00+08:00', start: 0, chars: world.length, tags: ['snapshot'] },
    { source: 'vtuber', type: 'vtuber.status', cursor: cursor + 1, ts: '2026-10-04T09:00:00+08:00', start: world.length + 1, chars: status.length, tags: ['snapshot'] },
  ] } });
}

describe('完整缓存替代混合帧中的历史状态', () => {
  it('小型演出状态不再固定保留整批旧世界读数，新玩家内容仍完整保留', () => {
    const oldFrames = Array.from({ length: 8 }, (_, i) => snapshotFrame(2 * i, '[演出状态] 安静'));
    const latest = message('user', '玩家刚提出的请求和全部证据。'.repeat(120), {
      frame: { events: [{ source: 'minecraft', type: 'minecraft.chat', cursor: 30,
        ts: '2026-10-04T09:02:00+08:00', start: 0, chars: '玩家刚提出的请求和全部证据。'.repeat(120).length }] },
      blobs: [{ handle: 'log:current-image', mime: 'image/png', fallbackText: '本次观察' }],
    });
    const records = [message('system', '人格与工具契约。'), ...oldFrames, latest];
    const originals = structuredClone(records);
    const options = { maxHistoryTokens: 1, minRecentRounds: 0,
      coveredSnapshots: [{ source: 'mymc', type: 'mymc.world.snapshot' }] };
    const worldPin = message('user', '[当前世界完整读数；有实际观察时刻]');
    const old = projectForeground(records, options, [worldPin]);
    const statusPin = message('user', '[演出当前读数；有实际观察时刻]\n[演出状态] 正在说话');
    const updated = projectForeground(records, { ...options, coveredSnapshots: [...options.coveredSnapshots,
      { source: 'vtuber', type: 'vtuber.status' }] }, [worldPin, statusPin]);
    expect(old.messages).toEqual([...records, worldPin]);
    expect(updated.messages).toEqual([records[0], latest, worldPin, statusPin]);
    expect(updated.protectedTokens).toBeLessThan(old.protectedTokens / 2);
    expect(updated.messages).toContain(latest);
    expect(latest.context.blobs).toEqual(originals.at(-1)!.context.blobs);
    expect(records).toEqual(originals);
  });

  it('只有当前已验证缓存声明覆盖的source/type可省略，其他增量快照仍保留', () => {
    const other = snapshotFrame(1, '[演出状态] 安静');
    other.context.frame!.events[1].source = 'other-world';
    const latest = message('user', '最新输入。');
    const result = projectForeground([other, latest], { maxHistoryTokens: 1, minRecentRounds: 0,
      coveredSnapshots: [{ source: 'mymc', type: 'mymc.world.snapshot' }, { source: 'vtuber', type: 'vtuber.status' }] });
    expect(result.messages).toEqual([other, latest]);
  });
});
