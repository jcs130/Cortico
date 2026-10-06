import { describe, expect, it } from 'vitest';
import { ServerActionWait } from '../../../src/worlds/minecraft/server-action-wait.ts';

describe('server interaction wait receipt', () => {
  it('holds only the same target until a server countdown expires', () => {
    const guard = new ServerActionWait();
    guard.noteUse([-596, 92, -313], 1_000);
    guard.noteFeedback('试炼场休息中，还需 58 秒。', 1_200);
    expect(guard.blockReason([-596, 92, -313], 11_000)).toContain('还需等 49 秒');
    expect(guard.blockReason([-594, 91, -313], 11_000)).toBeNull();
    expect(guard.blockReason([-596, 92, -313], 59_200)).toBeNull();
  });

  it('does not attach unrelated or late server text to an interaction', () => {
    const guard = new ServerActionWait();
    guard.noteUse([1, 2, 3], 1_000);
    guard.noteFeedback('10 秒后全队自动进入下一层。', 1_200);
    expect(guard.blockReason([1, 2, 3], 2_000)).toBeNull();
    guard.noteFeedback('还需 30 秒。', 5_000);
    expect(guard.blockReason([1, 2, 3], 5_100)).toBeNull();
  });

  it('把服务端倒计时绑定到同一条游戏命令，避免反复查询', () => {
    const guard = new ServerActionWait();
    guard.noteChat('/mycli arena status', 1_000);
    guard.noteFeedback('试炼场休息中，还需 173 秒。', 1_200);
    expect(guard.blockChat('/mycli arena status', 2_000)).toContain('还需等 173 秒');
    expect(guard.blockChat('/mycli guild status', 2_000)).toBeNull();
    expect(guard.blockChat('大家好', 2_000)).toBeNull();
    expect(guard.blockChat('/mycli arena status', 174_200)).toBeNull();
  });

  it('节流重复的只读状态查询，不影响施法和其他命令', () => {
    const guard = new ServerActionWait();
    guard.noteChat('/mycli arena status', 1_000);
    guard.noteFeedback('MC_DUNGEON status participant=false globalActive=false', 1_200);
    expect(guard.blockChat('/mycli arena status', 2_000)).toContain('还需等 59 秒');
    expect(guard.blockChat('/mycli arena status', 2_000)).toContain('participant=false');
    guard.noteChat('/mycli skill cast frostnova', 3_000);
    expect(guard.blockChat('/mycli arena status', 4_000)).toBeNull();
    expect(guard.blockChat('/mycli guild status', 4_000)).toBeNull();
    expect(guard.blockChat('/mycli skill cast frostnova', 4_000)).toContain('相同游戏命令刚发送过');
    expect(guard.blockChat('/mycli skill cast frostnova', 5_000)).toBeNull();
    expect(guard.blockChat('/mycli arena status', 61_000)).toBeNull();
  });

  it('节流没有聊天回执的奖励查询，避免高频重复发送', () => {
    const guard = new ServerActionWait();
    guard.noteChat('/mycli arena rewards', 1_000);
    expect(guard.blockChat('/mycli arena rewards', 1_500)).toContain('还需等 60 秒');
    expect(guard.blockChat('/mycli arena rewards', 30_000)).toContain('尚无服务端回执');
    expect(guard.blockChat('/mycli arena rewards', 61_000)).toBeNull();
  });

  it('节流多行看板查询，仍允许公会接单和领取', () => {
    const guard = new ServerActionWait();
    guard.noteChat('/mycli guild board', 1_000);
    expect(guard.blockChat('/mycli guild board', 1_800)).toContain('还需等 60 秒');
    expect(guard.blockChat('/mycli guild accept lost_town', 1_800)).toBeNull();
    expect(guard.blockChat('/mycli guild claim', 1_800)).toBeNull();
    expect(guard.blockChat('/mycli guild board', 61_000)).toBeNull();
  });

  it('修改命令允许立即核对状态，单纯 use 不洗掉查询冷却', () => {
    const guard = new ServerActionWait();
    guard.noteChat('/mycli guild status', 1_000);
    guard.noteFeedback('正在进行：深层远征 [1/1]；可交付领取', 1_200);
    guard.noteChat('/mycli guild claim', 2_000);
    expect(guard.blockChat('/mycli guild status', 2_100)).toBeNull();
    guard.noteChat('/mycli arena status', 3_000);
    guard.noteFeedback('MC_DUNGEON status participant=false globalActive=false', 3_100);
    guard.noteUse([-596, 92, -313], 4_000, 'button=off;bag=unchanged');
    expect(guard.blockChat('/mycli arena status', 4_100)).toContain('同一只读查询刚发送过');
    expect(guard.blockChat('/mycli guild status', 4_100)).toBeNull();
  });

  it('交替右键同一格与 status 时，未观察到变化就暂缓两种重复', () => {
    const guard = new ServerActionWait();
    const at = [-596, 92, -313];
    const command = '/mycli arena status';
    const unchanged = 'button=off;bag=unchanged';
    guard.noteUse(at, 1_000, unchanged);
    guard.noteChat(command, 2_000);
    guard.noteFeedback('MC_DUNGEON status participant=false globalActive=false', 2_100);
    expect(guard.blockReason(at, 4_000, unchanged)).toContain('还需等 12 秒');
    expect(guard.blockChat(command, 4_000)).toContain('还需等 58 秒');
    expect(guard.blockReason([1, 2, 3], 4_000, unchanged)).toBeNull();
    expect(guard.blockChat('/mycli guild status', 4_000)).toBeNull();
    expect(guard.blockReason(at, 16_000, unchanged)).toBeNull();
    expect(guard.blockChat(command, 16_000)).toContain('同一只读查询刚发送过');
  });

  it('同格右键后方块或容器可见状态变化时允许再操作', () => {
    const guard = new ServerActionWait();
    const at = [-596, 92, -313];
    guard.noteUse(at, 1_000, 'button=off;window=none');
    expect(guard.blockReason(at, 1_500, 'button=on;window=none')).toBeNull();
    guard.noteUse(at, 2_000, 'button=on;window=none');
    expect(guard.blockReason(at, 2_500, 'button=on;window=none')).toContain('现场可见状态没有变化');
    expect(guard.blockReason(at, 2_500, 'button=on;window=1')).toBeNull();
  });

  it('相同只读回执不反复唤醒，重复查询逐步退避，改变状态后立即解锁', () => {
    const guard = new ServerActionWait();
    const command = '/mycli arena status';
    guard.noteChat(command, 1_000);
    expect(guard.noteFeedback('未参赛', 1_100)).toBe(false);
    expect(guard.noteFeedback('globalActive=false', 1_200)).toBe(false);
    expect(guard.blockChat(command, 61_000)).toBeNull();
    guard.noteChat(command, 61_000);
    expect(guard.noteFeedback('未参赛', 61_100)).toBe(true);
    expect(guard.noteFeedback('globalActive=false', 61_200)).toBe(true);
    expect(guard.blockChat(command, 121_000)).toContain('还需等 240 秒');
    expect(guard.blockChat(command, 361_000)).toBeNull();
    guard.noteChat(command, 361_000);
    guard.noteFeedback('未参赛', 361_100);
    guard.noteFeedback('globalActive=false', 361_200);
    expect(guard.blockChat(command, 661_000)).toContain('还需等 600 秒');
    guard.noteChat('/mycli skill cast home', 662_000);
    expect(guard.blockChat(command, 662_100)).toBeNull();
  });
});
