import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentFriendProtection, NearbyProtectionBackoff, holdUnverifiedPathAction, parseProtectReply,
  selectHeldPathAction,
} from '../../../src/worlds/minecraft/agentfriend-protection.ts';

describe('寻路动作保护闸', () => {
  const player = { x: 0.5, y: 64, z: 0.5 };
  const move = (x: number, toBreak: Array<{ x: number; y: number; z: number }> = [],
    toPlace: Array<{ x: number; y: number; z: number; dx?: number; dy?: number; dz?: number; useOne?: boolean }> = []) =>
    ({ x, y: 64, z: 0, toBreak, toPlace });

  it('只放行无需挖掘的路径前缀，第一处未知权限先截住', () => {
    const path = { path: [move(1), move(2, [{ x: 2, y: 64, z: 0 }]), move(3)] };
    const held = holdUnverifiedPathAction(path, player, () => null);
    expect(held).toEqual({ action: 'break', cell: { x: 2, y: 64, z: 0 }, status: null, safePrefix: 1 });
    expect(path.path).toEqual([move(1)]);
  });

  it('首步就要挖时留下无动作占位，避免上游把空路径误报为完成', () => {
    const path = { path: [move(1, [{ x: 1, y: 64, z: 0 }])] };
    expect(holdUnverifiedPathAction(path, player, () => null)?.safePrefix).toBe(0);
    expect(path.path).toHaveLength(1);
    expect(path.path[0]).toMatchObject({ ...player, toBreak: [], toPlace: [] });
  });

  it('放置校验实际落点；开门交互不用当作放方块', () => {
    const path = { path: [move(1, [], [
      { x: 1, y: 64, z: 0, useOne: true },
      { x: 2, y: 63, z: 0, dx: 0, dy: 1, dz: 0 },
    ])] };
    const checked: string[] = [];
    const held = holdUnverifiedPathAction(path, player, (action, cell) => {
      checked.push(`${action}:${cell.x},${cell.y},${cell.z}`);
      return null;
    });
    expect(checked).toEqual(['place:2,64,0']);
    expect(held?.cell).toEqual({ x: 2, y: 64, z: 0 });
  });

  it('已获 allow_likely 的改方块节点保持原路径', () => {
    const path = { path: [move(1, [{ x: 1, y: 64, z: 0 }])] };
    expect(holdUnverifiedPathAction(path, player, () => 'allow_likely')).toBeNull();
    expect(path.path[0].toBreak).toHaveLength(1);
  });

  it('路径重算提出其他格时，先完成正在查询的权限并截住新路径', () => {
    const first = { key: 'break|overworld|1,64,0', querying: true };
    const next = { key: 'break|overworld|2,64,0', querying: false };
    const path = { path: [move(2, [{ x: 2, y: 64, z: 0 }])] };
    expect(holdUnverifiedPathAction(path, player, () => null)?.safePrefix).toBe(0);
    expect(selectHeldPathAction(first, next)).toBe(first);
    expect(selectHeldPathAction(first, { ...first, querying: false })).toBe(first);
    expect(path.path[0]).toMatchObject({ ...player, toBreak: [] });
    expect(selectHeldPathAction(null, next)).toBe(next);
    expect(selectHeldPathAction({ ...first, querying: false }, next)).toBe(next);
  });
});

it('相邻三处保护拒绝后暂时只走现有道路；离开区域或到期自动恢复', () => {
  const backoff = new NearbyProtectionBackoff();
  const at = { x: 0, y: 64, z: 0 };
  const reply = (x: number) => ({ action: 'break' as const, dimension: 'overworld',
    x, y: 64, z: 1, status: 'deny' as const, reason: 'protected' });
  expect(backoff.note(reply(1), at, 1000)).toBe(false);
  expect(backoff.note(reply(1), at, 1001)).toBe(false);
  expect(backoff.note(reply(2), at, 1002)).toBe(false);
  expect(backoff.note(reply(3), at, 1003)).toBe(true);
  expect(backoff.active(at, 'overworld', 1004)).toBe(true);
  expect(backoff.active({ x: 17, y: 64, z: 0 }, 'overworld', 1004)).toBe(false);
  expect(backoff.active(at, 'overworld', 61_004)).toBe(false);
});

it('连续三个 unknown 同样触发纯行走，不能把未确认方块当可挖', () => {
  const backoff = new NearbyProtectionBackoff();
  const player = { x: 0, y: 64, z: 0 };
  for (let x = 1; x <= 2; x++) {
    expect(backoff.note({ action: 'break', dimension: 'overworld', x, y: 64, z: 0,
      status: 'unknown', reason: 'rate_limited' }, player, 1000 + x)).toBe(false);
  }
  expect(backoff.note({ action: 'break', dimension: 'overworld', x: 3, y: 64, z: 0,
    status: 'unknown', reason: 'rate_limited' }, player, 1003)).toBe(true);
});

afterEach(() => vi.useRealTimers());

function rig() {
  const events = new EventEmitter();
  const packets = new EventEmitter();
  const sent: string[] = [];
  const bot = {
    on: events.on.bind(events),
    _client: { on: packets.on.bind(packets) },
    chat: (text: string) => { sent.push(text); },
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: () => ({ name: 'stone_bricks' }),
  };
  const changed: string[] = [];
  const client = new AgentFriendProtection(bot, (reply) => changed.push(reply.status));
  return { bot, client, events, packets, sent, changed };
}

describe('AgentFriend 保护预检', () => {
  it('只解析指定系统回执和插件消息', () => {
    const json = JSON.stringify({ action: 'break', dimension: 'minecraft:overworld',
      x: 1, y: 64, z: 2, status: 'deny', reason: '公会建筑' });
    expect(parseProtectReply(`MC_PROTECT ${json}`)?.status).toBe('deny');
    expect(parseProtectReply(json)).toBeNull();
    expect(parseProtectReply(Buffer.from(json), 'mcagent:protection')?.dimension).toBe('overworld');
  });

  it('对挖掘格询问，拒绝被缓存，普通位置不查询', async () => {
    const { client, events, sent, changed } = rig();
    const at = { x: 1, y: 64, z: 2 };
    const pending = client.check('break', 'overworld', at, true);
    await Promise.resolve();
    expect(sent).toEqual(['/mycli protect break 1 64 2']);
    events.emit('message', { toString: () => 'MC_PROTECT '
      + JSON.stringify({ action: 'break', dimension: 'overworld', ...at,
        status: 'deny', reason: '公会建筑' }) }, 'system');
    expect((await pending).status).toBe('deny');
    expect(client.verdict('break', 'overworld', at)).toBe('deny');
    expect((await client.check('break', 'overworld', at, true)).status).toBe('deny');
    expect(sent).toHaveLength(1);
    expect(changed).toEqual(['deny']);
  });

  it('超出 16 格时缓存 unknown，寻路不会对同一远处方块空转询问', async () => {
    const { client, sent } = rig();
    const far = { x: 30, y: 64, z: 0 };
    expect((await client.check('break', 'overworld', far)).status).toBe('unknown');
    expect(client.verdict('break', 'overworld', far)).toBe('unknown');
    expect((await client.check('break', 'overworld', far)).status).toBe('unknown');
    expect(sent).toHaveLength(0);
  });

  it('接受服务端 world 字段的拒绝回执，并停止对同一格重复询问', async () => {
    const { bot, client, events, sent, changed } = rig();
    const at = { x: -598, y: 89, z: -317 };
    bot.entity.position = { x: -599, y: 89, z: -318 };
    const pending = client.check('break', 'minecraft:overworld', at, true);
    await Promise.resolve();
    events.emit('message', { toString: () => 'MC_PROTECT '
      + JSON.stringify({ schemaVersion: 1, action: 'break', world: 'minecraft:overworld',
        ...at, status: 'deny', allowed: false, reason: 'arena' }) }, 'system');
    expect(await pending).toMatchObject({ ...at, dimension: 'overworld', status: 'deny', reason: 'arena' });
    expect(client.verdict('break', 'overworld', at)).toBe('deny');
    expect(await client.check('break', 'overworld', at, true)).toMatchObject({ status: 'deny' });
    expect(sent).toEqual(['/mycli protect break -598 89 -317']);
    expect(changed).toEqual(['deny']);
  });

  it('只通过插件消息也能收到回执，机器 JSON 不需要进入聊天框', async () => {
    const { client, packets, sent, changed } = rig();
    const at = { x: 2, y: 64, z: 3 };
    const pending = client.check('place', 'overworld', at, true);
    await Promise.resolve();
    packets.emit('custom_payload', {
      channel: 'mcagent:protection',
      data: Uint8Array.from(Buffer.from(JSON.stringify({ schemaVersion: 1,
        action: 'place', world: 'minecraft:overworld', ...at,
        status: 'deny', allowed: false, reason: 'village' }))),
    });
    expect(await pending).toMatchObject({ ...at, dimension: 'overworld', status: 'deny' });
    expect(client.verdict('place', 'overworld', at)).toBe('deny');
    expect(sent).toEqual(['/mycli protect place 2 64 3']);
    expect(changed).toEqual(['deny']);
  });

  it('执行前刷新 allow_likely；超时保持 unknown', async () => {
    vi.useFakeTimers();
    const { client, events, sent } = rig();
    const at = { x: 2, y: 64, z: 2 };
    const first = client.check('place', 'overworld', at);
    await Promise.resolve();
    events.emit('message', { toString: () => 'MC_PROTECT '
      + JSON.stringify({ action: 'place', dimension: 'overworld', ...at,
        status: 'allow_likely', reason: '可尝试' }) }, 'system');
    expect((await first).status).toBe('allow_likely');
    const fresh = client.check('place', 'overworld', at, true);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4001);
    expect((await fresh).status).toBe('unknown');
  });

  it('服务端限流时放慢后续预检，路径预取至多挂起一格', async () => {
    vi.useFakeTimers();
    const { client, events, sent } = rig();
    const firstCell = { x: 1, y: 64, z: 1 };
    const nextCell = { x: 2, y: 64, z: 1 };
    client.prefetch('break', 'overworld', firstCell);
    client.prefetch('break', 'overworld', nextCell);
    await Promise.resolve();
    expect(sent).toEqual(['/mycli protect break 1 64 1']);
    expect(client.verdict('break', 'overworld', nextCell)).toBeNull();
    events.emit('message', { toString: () => 'MC_PROTECT '
      + JSON.stringify({ action: 'break', world: 'minecraft:overworld', ...firstCell,
        status: 'unknown', reason: 'unknown_rate_limited' }) }, 'system');
    await Promise.resolve();
    const next = client.check('break', 'overworld', nextCell, true);
    await vi.advanceTimersByTimeAsync(4999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['/mycli protect break 1 64 1', '/mycli protect break 2 64 1']);
    events.emit('message', { toString: () => 'MC_PROTECT '
      + JSON.stringify({ action: 'break', world: 'minecraft:overworld', ...nextCell,
        status: 'deny', reason: 'arena' }) }, 'system');
    expect((await next).status).toBe('deny');
  });
});
