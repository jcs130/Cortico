import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GuildProgress } from '../src/guild-progress.ts';

describe('GuildProgress', () => {
  it('updates claim progress in either direction, retaining acceptance and refusing older observations', () => {
    const progress = new GuildProgress('example.test:25565:visitor');
    progress.observe('[MC 系统] 已接公会委托：补充建材。交付24份材料。', '2026-01-01T12:00:00Z');
    progress.observe('[MC 系统] 正在进行：补充建材 [0/24]', '2026-01-01T12:01:00Z');
    progress.observe('[MC 系统] materials 补充建材 · 交付建材。 [in_progress]', '2026-01-01T12:01:01Z');
    expect(progress.observe('[MC 系统] 还需完成「补充建材」：20/24', '2026-01-01T12:02:00Z')).toBe(true);
    expect(progress.facts()).toContain('在办：补充建材 [20/24]');
    expect(progress.facts()).toContain('2026-01-01T12:02:00Z');
    expect(progress.facts()).toContain('交付24份材料。');
    expect(progress.facts()).toContain('精确ID：materials');
    progress.observe('[MC 系统] 还需完成「补充建材」：0/24', '2026-01-01T12:03:00Z');
    progress.observe('[MC 系统] 还需完成「补充建材」：20/24', '2026-01-01T12:02:30Z');
    expect(progress.facts()).toContain('在办：补充建材 [0/24]');
    expect(progress.facts()).toContain('2026-01-01T12:03:00Z');
    expect(progress.facts()).not.toContain('确认交付');
  });

  it('restores a claim observation without inventing acceptance or completion evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guild-claim-'));
    try {
      const progress = new GuildProgress('example.test:25565:visitor', dir);
      expect(progress.observe('[MC 玩家] visitor: 还需完成「补充建材」：20/24', '2026-01-01T12:00:00Z')).toBe(false);
      progress.observe('[MC 系统] 还需完成「补充建材」：20/24', '2026-01-01T12:01:00Z');
      const restored = new GuildProgress('example.test:25565:visitor', dir);
      expect(restored.facts()).toBe(progress.facts());
      expect(restored.facts()).toContain('在办：补充建材 [20/24]');
      expect(restored.facts()).not.toContain('验收要求原文');
      expect(restored.facts()).not.toContain('交付成功');
      restored.observe('[MC 系统] 委托交付成功！', '2026-01-01T12:02:00Z');
      expect(restored.facts()).toContain('当前没有在办的委托');
      expect(restored.facts()).toContain('服务端确认交付：补充建材');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves the server acceptance conditions through progress updates and obtains the exact ID from an in-progress board entry', () => {
    const progress = new GuildProgress('example.test:25565:visitor');
    const accepted = '[MC 系统] 已接公会委托：登高看远方 · 1/1 登高。到达高度至少 120 的地方；服务器记录实际到达。；完成后领取奖励。';
    progress.observe(accepted, '2026-01-01T12:00:00Z');
    progress.observe('[MC 系统] 正在进行：登高看远方 · 1/1 登高 [0/1]', '2026-01-01T12:01:00Z');
    progress.observe('[MC 系统] tm_hill_walk 登高看远方 · 选一个喜欢的山顶。 [in_progress] · 声望+6', '2026-01-01T12:02:00Z');
    const facts = progress.facts();
    expect(facts).toContain('在办：登高看远方 [0/1]');
    expect(facts).toContain('精确ID：tm_hill_walk');
    expect(facts).toContain('2026-01-01T12:00:00Z');
    expect(facts).toContain('到达高度至少 120 的地方；服务器记录实际到达。');
    expect(facts).toContain('验收要求原文');
    expect(facts).not.toContain('在办：登高看远方 · 1/1 登高');
  });

  it('clears old acceptance evidence on a different commission and refuses unmatched or non-active ID listings', () => {
    const progress = new GuildProgress('example.test:25565:visitor');
    progress.observe('[MC 系统] 已接公会委托：旧采集。需要16份材料。', '2026-01-01T12:00:00Z');
    progress.observe('[MC 系统] 正在进行：新建造 [0/4]', '2026-01-01T12:01:00Z');
    progress.observe('[MC 系统] old_collect 旧采集 · 交付材料。 [in_progress] · 声望+6', '2026-01-01T12:02:00Z');
    progress.observe('[MC 系统] new_build 新建造 · 搭建。 [available] · 声望+6', '2026-01-01T12:02:01Z');
    expect(progress.facts()).toContain('在办：新建造 [0/4]');
    expect(progress.facts()).not.toContain('需要16份材料');
    expect(progress.facts()).not.toContain('精确ID');
  });

  it('retains acceptance evidence and ID after reload but removes them after delivery, including a repeated quest name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guild-acceptance-'));
    try {
      const progress = new GuildProgress('example.test:25565:visitor', dir);
      progress.observe('[MC 系统] 已接公会委托：修路。先完成一条可通行的道路。', '2026-01-01T12:00:00Z');
      progress.observe('[MC 系统] road_build 修路 · 建造道路。 [in_progress] · 声望+6', '2026-01-01T12:00:01Z');
      const restored = new GuildProgress('example.test:25565:visitor', dir);
      expect(restored.facts()).toContain('可通行的道路');
      expect(restored.facts()).toContain('精确ID：road_build');
      restored.observe('[MC 系统] 委托交付成功！', '2026-01-01T12:02:00Z');
      restored.observe('[MC 系统] 正在进行：修路 [0/2]', '2026-01-02T12:00:00Z');
      expect(restored.facts()).not.toContain('可通行的道路');
      expect(restored.facts()).not.toContain('精确ID');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains delivery evidence after current state is cleared and another commission is accepted', () => {
    const progress = new GuildProgress('example.test:25565:visitor');
    expect(progress.facts()).toBe('');
    progress.observe('[MC 系统] 已接公会委托：采集委托。交付材料。', '2026-01-01T12:00:00Z');
    progress.observe('[MC 系统] 正在进行：采集委托 [16/16]；可交付领取', '2026-01-01T12:01:00Z');
    progress.observe('[MC 系统] 委托交付成功！声望 +6。', '2026-01-01T12:02:00Z');
    progress.observe('[MC 系统] 当前没有在办的委托。', '2026-01-01T12:03:00Z');
    expect(progress.facts()).toContain('当前没有在办的委托');
    expect(progress.facts()).toContain('2026-01-01T12:02:00Z 服务端确认交付：采集委托');
    progress.observe('[MC 系统] 已接公会委托：补给委托。', '2026-01-01T12:04:00Z');
    expect(progress.facts()).toContain('在办：补给委托；进度尚未回读');
    expect(progress.facts()).not.toContain('在办：采集委托');
    expect(progress.facts()).toContain('服务端确认交付：采集委托');
  });

  it('does not turn a rejected accept, available listing or player statement into an active commission', () => {
    const progress = new GuildProgress('example.test:25565:visitor');
    progress.observe('[MC 系统] 当前没有在办的委托。', '2026-01-01T12:00:00Z');
    progress.observe('[MC 系统] q_collect 采集委托 · 交付材料 · 声望+6 [规划|今日已完成]', '2026-01-01T12:01:00Z');
    for (const text of ['[MC 系统] 先完成并交付当前任务。',
      '[MC 系统] q_collect 采集委托 · 交付材料 · 声望+6 [规划|可接]',
      '[MC 玩家] visitor: 已接公会委托：采集委托。']) {
      expect(progress.observe(text, '2026-01-01T12:02:00Z')).toBe(false);
    }
    expect(progress.facts()).toContain('当前没有在办的委托');
    expect(progress.facts()).toContain('看板列为今日已完成：采集委托');
    expect(progress.facts()).not.toContain('在办：采集委托');
  });

  it('keeps a newer state when an old status arrives and does not name an unknown delivery', () => {
    const progress = new GuildProgress('example.test:25565:visitor');
    progress.observe('[MC 系统] 委托交付成功！声望 +6。', '2026-01-01T12:02:00Z');
    progress.observe('[MC 系统] 正在进行：旧委托 [5/16]', '2026-01-01T12:01:00Z');
    expect(progress.facts()).toContain('当前没有在办的委托');
    expect(progress.facts()).toContain('最近交付成功回执：2026-01-01T12:02:00Z');
    expect(progress.facts()).not.toContain('旧委托');
    expect(progress.facts()).not.toContain('确认交付：');
  });

  it('persists evidence across reloads and isolates the server and account', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guild-progress-'));
    try {
      const progress = new GuildProgress('example.test:25565:visitor', dir);
      progress.observe('[MC 系统] 已接公会委托：采集委托。', '2026-01-01T12:00:00Z');
      progress.observe('[MC 系统] 委托交付成功！', '2026-01-01T12:02:00Z');
      expect(new GuildProgress('example.test:25565:visitor', dir).facts()).toBe(progress.facts());
      expect(new GuildProgress('other.test:25565:visitor', dir).facts()).toBe('');
      expect(new GuildProgress('example.test:25565:other', dir).facts()).toBe('');
      writeFileSync(join(dir, 'mymc-guild-progress.json'), '{"version":1,"server":"example.test:25565:visitor","state":{}}');
      expect(new GuildProgress('example.test:25565:visitor', dir).facts()).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
