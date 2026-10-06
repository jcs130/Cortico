import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { Movements } from 'mineflayer-pathfinder';
import { BREAK_ACL_CHANNEL, BreakPermissions } from '../../../src/worlds/minecraft/break-permissions.ts';
import { installPathfinderPerf, setProtectedCells } from '../../../src/worlds/minecraft/pathfinder-perf.ts';

const packet = (over: Record<string, unknown> = {}): Buffer => Buffer.from(JSON.stringify({
  v: 1, complete: true, dimension: 'minecraft:overworld', chunkX: -31, chunkZ: -28,
  revision: 2, ttlSec: 300,
  denyCells: [[-490, 69, -434]],
  denyBoxes: [[-489, 68, -435, -488, 70, -433]],
  ...over,
}));

describe('服务端逐格挖掘权限', () => {
  it('负坐标区块只拒绝清单所列方块；未覆盖和过期区块不能冒险挖掘', () => {
    const acl = new BreakPermissions(null, '192.168.3.163:25565');
    expect(acl.applyPacket(BREAK_ACL_CHANNEL, packet(), 1000)).toBe('changed');
    expect(acl.denied('overworld', -490, 69, -434, 123, 1001)).toBe(true);
    expect(acl.denied('overworld', -489, 69, -434, 123, 1001)).toBe(true);
    expect(acl.denied('overworld', -487, 69, -434, 123, 1001)).toBe(false);
    expect(acl.denied('overworld', 0, 69, 0, 123, 1001)).toBe(true);
    expect(acl.denied('nether', -490, 69, -434, 123, 1001)).toBe(false);
    expect(acl.applyPacket(BREAK_ACL_CHANNEL, packet({ revision: 1, denyCells: [], denyBoxes: [] }), 1002)).toBe(false);
    expect(acl.applyPacket(BREAK_ACL_CHANNEL, packet({ revision: 2, denyCells: [], denyBoxes: [] }), 2000)).toBe('refreshed');
    expect(acl.denied('overworld', -490, 69, -434, 123, 2001)).toBe(true);
    expect(acl.denied('overworld', -487, 69, -434, 123, 302_001)).toBe(true);
    acl.beginConnection();
    expect(acl.denied('overworld', 0, 69, 0, 123, 302_002)).toBe(false);
    expect(acl.applyPacket(BREAK_ACL_CHANNEL, packet({ revision: 0, denyCells: [], denyBoxes: [] }), 302_003)).toBe('changed');
    expect(acl.denied('overworld', -490, 69, -434, 123, 302_004)).toBe(false);
  });

  it('拒绝跨区块、非完整与超大清单；明确拒绝的格子按服务端保存且换方块后释放', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortico-break-acl-'));
    try {
      const file = join(dir, 'denied.json');
      const acl = new BreakPermissions(file, 'server-a');
      expect(acl.applyPacket(BREAK_ACL_CHANNEL, packet({ complete: false }))).toBe(false);
      expect(acl.applyPacket(BREAK_ACL_CHANNEL, packet({ denyCells: [[0, 69, 0]] }))).toBe(false);
      expect(acl.applyPacket(BREAK_ACL_CHANNEL, packet({ denyCells: Array.from({ length: 4097 }, () => [-490, 69, -434]) }))).toBe(false);
      acl.noteDenied('overworld', -490, 69, -434, 12);
      const loaded = new BreakPermissions(file, 'server-a');
      expect(loaded.denied('overworld', -490, 69, -434, 12)).toBe(true);
      expect(loaded.denied('overworld', -490, 69, -434, 13)).toBe(false);
      expect(new BreakPermissions(file, 'server-b').denied('overworld', -490, 69, -434, 12)).toBe(false);
      expect(acl.applyPacket(BREAK_ACL_CHANNEL, packet({ denyCells: [], denyBoxes: [] }))).toBe('changed');
      expect(acl.denied('overworld', -490, 69, -434, 12)).toBe(false); // 新鲜完整快照覆盖旧拒绝
      acl.noteDenied('overworld', -490, 69, -434, 12);
      expect(acl.denied('overworld', -490, 69, -434, 12)).toBe(true); // 快照滞后时实际拒绝优先
      expect(acl.applyPacket(BREAK_ACL_CHANNEL, packet({ revision: 3, denyCells: [], denyBoxes: [] }))).toBe('changed');
      expect(acl.denied('overworld', -490, 69, -434, 12)).toBe(false); // 新版本重新授权
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('1.20.6 全高度位图在 Paper 单包限制内精确表达碎片保护格', () => {
    const bytes = Buffer.alloc(384 * 256 / 8);
    const index = (69 + 64) * 256 + 14 * 16 + 6; // (-490,69,-434) 在 (-31,-28) 区块内
    bytes[index >>> 3] |= 1 << (index & 7);
    const data = packet({ denyCells: [], denyBoxes: [], minY: -64, height: 384,
      denyBits: bytes.toString('base64') });
    expect(data.length).toBeLessThan(32766);
    const acl = new BreakPermissions(null, 'server-a');
    expect(acl.applyPacket(BREAK_ACL_CHANNEL, data, 1000)).toBe('changed');
    expect(acl.denied('overworld', -490, 69, -434, 1, 1001)).toBe(true);
    expect(acl.denied('overworld', -489, 69, -434, 1, 1001)).toBe(false);
    expect(acl.denied('overworld', -490, 320, -434, 1, 1001)).toBe(true); // 位图未覆盖的高度权限未知
    expect(acl.applyPacket(BREAK_ACL_CHANNEL, packet({ denyCells: [], denyBoxes: [],
      minY: -64, height: 384, denyBits: 'AA' }))).toBe(false);
  });

  it('A* 的 safeToBreak 实际读取保护缓存，不影响邻格', () => {
    installPathfinderPerf();
    const req = createRequire(createRequire(import.meta.url).resolve('mineflayer/package.json'));
    const registry = req('prismarine-registry')('1.20.6');
    const bot = { registry, inventory: { items: () => [] }, entity: { effects: {} } };
    const movements = new Movements(bot as never);
    const acl = new BreakPermissions(null, 'server-a');
    acl.applyPacket(BREAK_ACL_CHANNEL, packet(), 1000);
    setProtectedCells(movements, (x, y, z, type) => acl.denied('overworld', x, y, z, type, 1001));
    const block = (x: number) => ({ type: 1, position: { x, y: 69, z: -434 }, name: 'stone', diggable: true });
    expect((movements as any).safeToBreak(block(-490))).toBe(false);
    // 邻格是否可挖继续交给上游的方块/液体判据；权限层不封整片村庄。
    expect(acl.denied('overworld', -487, 69, -434, 1, 1001)).toBe(false);
  });
});
