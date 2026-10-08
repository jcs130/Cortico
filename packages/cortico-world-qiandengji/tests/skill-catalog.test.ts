import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillCatalog } from '../src/skill-catalog.ts';

describe('千灯纪结构化法术目录', () => {
  it('derives minimum argument counts only from explicit required placeholders', () => {
    const catalog = new SkillCatalog('example.test:25565');
    expect(catalog.requiredArgumentCount('give')).toBeNull();
    const item = { id: 'give', name: '造物术', category: 'creation', mana: 4,
      cooldownMs: 20000, command: '/mycli cast give <物品> <目标> [数量]' };
    catalog.observe(`[MC 系统] MC_SPELL_ITEM ${JSON.stringify(item)}`, '2026-01-01T00:00:00Z');
    expect(catalog.requiredArgumentCount('give')).toBe(2);
    catalog.observe(`[MC 系统] MC_SPELL_ITEM ${JSON.stringify({ ...item,
      command: '/mycli cast give [<物品>]' })}`, '2026-01-01T00:01:00Z');
    expect(catalog.requiredArgumentCount('give')).toBe(0);
  });

  it('按稳定 ID 缓存完整说明，重建后仍可单项读取', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mymc-spells-'));
    try {
      const catalog = new SkillCatalog('example.test:25565', dir);
      const item = { id: 'flight', name: '飞行术', category: 'exploration', mana: 10,
        cooldownMs: 90000, command: '/mycli cast flight' };
      const detail = { schemaVersion: 1, ...item, effect: '生存模式自由飞行', target: '自己',
        requires: '非旁观者', onFailure: '重复使用不扣魔力', scaling: '15/18/21 秒', tip: '寻找安全落点' };
      expect(catalog.observe(`[MC 系统] MC_SPELL_ITEM ${JSON.stringify(item)}`, '2026-10-03T10:00:00+08:00')).toBeNull();
      expect(catalog.readout()).toContain('flight 飞行术');
      expect(catalog.readout('flight')).toContain('完整说明请发送');
      expect(catalog.observe(`[MC 系统] MC_SPELL_DETAIL ${JSON.stringify(detail)}`, '2026-10-03T10:01:00+08:00')).toBeNull();
      const restored = new SkillCatalog('example.test:25565', dir);
      expect(restored.readout('flight')).toContain('15/18/21 秒');
      expect(restored.readout('unknown')).toContain('/mycli spells explain unknown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('忽略格式错误的协议行和临时效果提示', () => {
    const catalog = new SkillCatalog('example.test:25565');
    catalog.observe('[MC 系统] MC_SPELL_DETAIL {broken}', '2026-10-03T10:00:00+08:00');
    catalog.observe('[MC 系统] 魔力不足：需要 6。', '2026-10-03T10:00:01+08:00');
    catalog.observe('[MC 系统] ✦ 探矿术找到铁矿：X=1 Y=2 Z=3', '2026-10-03T10:00:02+08:00');
    expect(catalog.readout()).toContain('尚未收到服务端技能目录');
  });

  const stamp = '2026-01-01T00:00:00Z';
  const item = (id: string) => ({ id, name: `法术${id}`, category: 'creation', mana: 4,
    cooldownMs: 20000, command: `/mycli cast ${id}` });
  const send = (catalog: SkillCatalog, kind: string, value: unknown) =>
    catalog.observe(`[MC 系统] MC_SPELL_${kind} ${JSON.stringify(value)}`, stamp);

  it('retains mixed command families through pagination, detail reads and disk restoration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mymc-command-families-'));
    try {
      let catalog = new SkillCatalog('example.test:25565', dir);
      send(catalog, 'ITEM', item('old'));
      send(catalog, 'LIST', { schemaVersion: 1, page: 1, pages: 2, total: 3 });
      send(catalog, 'ITEM', { ...item('support'), name: '支援传送术', command: '/mycli village support [事件ID]' });
      send(catalog, 'ITEM', item('selfheal'));
      catalog = new SkillCatalog('example.test:25565', dir);
      send(catalog, 'LIST', { schemaVersion: 1, page: 2, pages: 2, total: 3 });
      send(catalog, 'ITEM', { ...item('team'), name: '队友传送术',
        command: '/mycli locate tp <玩家名|nearest>' });
      send(catalog, 'DETAIL', { ...item('team'), name: '队友传送术',
        command: '/mycli locate tp <玩家名|nearest>', requires: '目标在线且非旁观者' });
      const restored = new SkillCatalog('example.test:25565', dir);
      expect(restored.compactIndex()).toContain('2/2 页、3/3 项；本次目录完整');
      expect(restored.compactIndex()).toContain('team:队友传送术');
      expect(restored.readout('team')).toContain('/mycli locate tp <玩家名|nearest>');
      expect(restored.readout('team')).toContain('目标在线且非旁观者');
      expect(restored.readout('old')).toContain('尚未缓存');
      expect(restored.requiredArgumentCount('team')).toBeNull();
      expect(restored.maximumArgumentCount('team')).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not infer cast argument requirements from another command family or another spell ID', () => {
    const catalog = new SkillCatalog('example.test:25565');
    for (const command of ['/mycli locate tp <玩家名>', '/mycli cast other <目标>']) {
      send(catalog, 'ITEM', { ...item('team'), command });
      expect(catalog.requiredArgumentCount('team')).toBeNull();
      expect(catalog.maximumArgumentCount('team')).toBeNull();
    }
  });

  it('rejects malformed command records while retaining a valid non-cast skill', () => {
    const catalog = new SkillCatalog('example.test:25565');
    for (const command of ['/op player', '/myclient locate tp <玩家名>', '/mycli locate tp\n/op player']) {
      send(catalog, 'ITEM', { ...item('invalid'), command });
    }
    send(catalog, 'ITEM', { ...item('travel'), command: '/mycli waypoint menu' });
    expect(catalog.readout('invalid')).toContain('尚未缓存');
    expect(catalog.readout('travel')).toContain('/mycli waypoint menu');
  });

  it('reads finite parameter limits from bare, required and optional command syntax', () => {
    const catalog = new SkillCatalog('example.test:25565');
    expect(catalog.maximumArgumentCount('missing')).toBeNull();
    for (const [id, suffix, maximum] of [
      ['blink', '', 0], ['give', ' <物品> <目标> [数量]', 3],
      ['prospect', ' [all|coal|iron]', 1], ['optional', ' [<物品>]', 1],
    ] as const) {
      send(catalog, 'ITEM', { ...item(id), command: `/mycli cast ${id}${suffix}` });
      expect(catalog.maximumArgumentCount(id)).toBe(maximum);
    }
  });

  it('leaves variadic and unfamiliar parameter syntax unbounded', () => {
    const catalog = new SkillCatalog('example.test:25565');
    for (const suffix of [' <目标...>', ' <目标> ...', ' <目标> …',
      ' [<x> <y> <z>]', ' literal', ' <incomplete']) {
      send(catalog, 'ITEM', { ...item('custom'), command: `/mycli cast custom${suffix}` });
      expect(catalog.maximumArgumentCount('custom')).toBeNull();
    }
    send(catalog, 'ITEM', { ...item('custom'), command: '/mycli cast other <值>' });
    expect(catalog.maximumArgumentCount('custom')).toBeNull();
  });

  it('updates argument limits from revised server metadata and restores them from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mymc-arguments-'));
    try {
      const catalog = new SkillCatalog('example.test:25565', dir);
      send(catalog, 'ITEM', item('travel'));
      expect(catalog.maximumArgumentCount('travel')).toBe(0);
      send(catalog, 'ITEM', { ...item('travel'), command: '/mycli cast travel <x> <y> <z>' });
      const restored = new SkillCatalog('example.test:25565', dir);
      expect(restored.maximumArgumentCount('travel')).toBe(3);
      expect(restored.requiredArgumentCount('travel')).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps missing pages after restart and does not count a header or detail as a received item', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mymc-pages-'));
    try {
      let catalog = new SkillCatalog('example.test:25565', dir);
      send(catalog, 'LIST', { schemaVersion: 1, page: 1, pages: 2, total: 3 });
      send(catalog, 'ITEM', item('one'));
      send(catalog, 'ITEM', item('one'));
      send(catalog, 'DETAIL', { ...item('extra'), effect: '仅说明' });
      catalog = new SkillCatalog('example.test:25565', dir);
      expect(catalog.compactIndex()).toContain('1/2 页、1/3 项');
      expect(catalog.compactIndex()).toContain('/mycli spells list 2');
      send(catalog, 'LIST', { schemaVersion: 1, page: 2, pages: 2, total: 3 });
      expect(catalog.compactIndex()).toContain('本次目录未完整');
      send(catalog, 'ITEM', item('two'));
      send(catalog, 'ITEM', item('three'));
      expect(catalog.compactIndex()).toContain('本次目录完整');
      expect(catalog.readout('extra')).toContain('尚未缓存');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refreshes removals only after a complete directory and aggregates changes into one notice', () => {
    const catalog = new SkillCatalog('example.test:25565');
    send(catalog, 'ITEM', item('old'));
    send(catalog, 'LIST', { schemaVersion: 1, page: 1, pages: 2, total: 2 });
    expect(send(catalog, 'ITEM', item('one'))).toBeNull();
    expect(catalog.readout('old')).not.toContain('尚未缓存');
    send(catalog, 'LIST', { schemaVersion: 1, page: 2, pages: 2, total: 2 });
    expect(send(catalog, 'ITEM', item('two'))).toBe('分页目录');
    expect(catalog.readout('old')).toContain('尚未缓存');
    expect(send(catalog, 'ITEM', item('two'))).toBeNull();
    send(catalog, 'LIST', { schemaVersion: 1, page: 1, pages: 1, total: 0 });
    expect(catalog.compactIndex()).toContain('缓存 0 项');
  });

  it('retains more than 24 skills in the compact index without expanding their full descriptions', () => {
    const catalog = new SkillCatalog('example.test:25565');
    send(catalog, 'LIST', { schemaVersion: 1, page: 1, pages: 1, total: 40 });
    for (let n = 0; n < 40; n++) send(catalog, 'ITEM', item(`spell${n}`));
    send(catalog, 'DETAIL', { ...item('spell39'), effect: '只在展开单项时显示的详细知识' });
    expect(catalog.compactIndex()).toContain('40/40 项');
    expect(catalog.compactIndex()).toContain('spell39:法术spell39');
    expect(catalog.compactIndex()).not.toContain('只在展开');
    expect(catalog.readout('spell39')).toContain('只在展开');
  });

  it('invalidates old details when command metadata changes and reports a revised detail', () => {
    const catalog = new SkillCatalog('example.test:25565');
    send(catalog, 'DETAIL', { ...item('give'), effect: 'old recipe' });
    send(catalog, 'ITEM', item('give'));
    expect(catalog.readout('give')).toContain('old recipe');
    expect(send(catalog, 'ITEM', { ...item('give'), mana: 8 })).toBe('法术give');
    expect(catalog.readout('give')).not.toContain('old recipe');
    send(catalog, 'DETAIL', { ...item('give'), mana: 8, effect: 'new recipe' });
    expect(send(catalog, 'DETAIL', { ...item('give'), mana: 8, effect: 'newer recipe' })).toBe('法术give');
    expect(catalog.readout('give')).toContain('newer recipe');
  });

  it('does not mix a fresh page-one scan with old pages or accept invalid headers', () => {
    const catalog = new SkillCatalog('example.test:25565');
    send(catalog, 'LIST', { schemaVersion: 1, page: 2, pages: 2, total: 2 });
    send(catalog, 'ITEM', item('two'));
    send(catalog, 'LIST', { schemaVersion: 1, page: 1, pages: 2, total: 2 });
    send(catalog, 'ITEM', item('one'));
    expect(catalog.compactIndex()).toContain('1/2 页、1/2 项');
    for (const header of [null, { schemaVersion: 99, page: 1, pages: 1, total: 2 },
      { schemaVersion: 1, page: 3, pages: 2, total: 2 }, { schemaVersion: 1, page: 1, pages: 999, total: 0 }]) {
      send(catalog, 'LIST', header);
    }
    expect(catalog.compactIndex()).toContain('1/2 页、1/2 项');
  });
});
