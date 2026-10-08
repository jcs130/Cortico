import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { RejectedRouteLedger } from '../../../src/worlds/minecraft/rejected-route-ledger.ts';
import type { RejectedRouteScope } from '../../../src/worlds/minecraft/rejected-route-ledger.ts';
import type { SkillCall } from '../../../src/worlds/minecraft/executor.ts';

const file = join(tmpdir(), `cortico-rejected-route-${randomUUID()}.json`);
afterEach(() => { if (existsSync(file)) unlinkSync(file); });

const now = 1_000_000;
const scope: RejectedRouteScope = {
  realm: 'weak:server:25565|', dimension: 'minecraft:overworld', origin: [-577, 71, -627],
};
const route = [{ skill: 'goto', at: [-561, 74, -575] }] as SkillCall[];

it('从安全落点重试相同目的地是新路线，不沿用旧出发地的拒收', () => {
  new RejectedRouteLedger(file, now).record('stalled-route', route, scope, now);
  const reloaded = new RejectedRouteLedger(file, now + 1);
  expect(reloaded.match(route, scope, now + 1)).toBe('stalled-route');
  expect(reloaded.match(route, { ...scope, origin: [-576, 71, -625] }, now + 1)).toBe('stalled-route');
  expect(reloaded.match(route, { ...scope, origin: [-593, 91, -313] }, now + 1)).toBeNull();
  expect(reloaded.match(route, { ...scope, origin: [-577, 75, -627] }, now + 1)).toBeNull();
});

it('坐标和动作相同也不跨服务器或维度限制', () => {
  const ledger = new RejectedRouteLedger(file, now);
  ledger.record('stalled-route', route, scope, now);
  expect(ledger.match(route, { ...scope, realm: 'weak:another-server:25565|' }, now + 1)).toBeNull();
  expect(ledger.match(route, { ...scope, dimension: 'minecraft:the_nether' }, now + 1)).toBeNull();
});

it('不同出发地的失败分别保留，成功换地点不重置其他地点的限制', () => {
  const ledger = new RejectedRouteLedger(file, now);
  const other = { ...scope, origin: [-593, 91, -313] as [number, number, number] };
  ledger.record('stalled-route', route, scope, now);
  ledger.record('stalled-route', route, other, now + 1);
  const reloaded = new RejectedRouteLedger(file, now + 2);
  expect(reloaded.match(route, scope, now + 2)).toBe('stalled-route');
  expect(reloaded.match(route, other, now + 2)).toBe('stalled-route');
  expect(reloaded.match(route, { ...scope, origin: [0, 64, 0] }, now + 2)).toBeNull();
});

it('水层失败记录跨 World 重载，拦住原单和邻近同一竖井', () => {
  const old = [
    { skill: 'goto', at: [-534, 60, -418] },
    { skill: 'tunnel', at: ['~', '~-10', '~'] },
  ] as SkillCall[];
  new RejectedRouteLedger(file, now).record('shaft-liquid:-534:56:-419:水', old, scope, now);
  const reloaded = new RejectedRouteLedger(file, now + 1);
  expect(reloaded.match(old, scope, now + 1)).toContain('shaft-liquid');
  expect(reloaded.match([
    { skill: 'goto', at: [-535, 60, -420] },
    { skill: 'tunnel', at: ['~', '~-10', '~'] },
  ] as SkillCall[], { ...scope, origin: [0, 64, 0] }, now + 1)).toContain('shaft-liquid');
  expect(reloaded.match([
    { skill: 'goto', at: [-525, 60, -420] },
    { skill: 'tunnel', at: ['~', '~-10', '~'] },
  ] as SkillCall[], scope, now + 1)).toBeNull();
  expect(reloaded.match(old, { ...scope, dimension: 'minecraft:the_nether' }, now + 1)).toBeNull();
  expect(reloaded.match(old, scope, now + 16 * 60_000)).toBeNull();
});

it.each([1, undefined])('旧版 %s 无出发地记录自动退役，不猜测旧世界或把它变成全局限制', (version) => {
  writeFileSync(file, JSON.stringify({ version, records: [{ key: 'old-route', steps: route, atMs: now }] }));
  const ledger = new RejectedRouteLedger(file, now + 1);
  expect(ledger.match(route, scope, now + 1)).toBeNull();
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 2, records: [] });
  ledger.record('new-route', route, scope, now + 2);
  expect(new RejectedRouteLedger(file, now + 3).match(route, scope, now + 3)).toBe('new-route');
});

it('现场缺失时不添加或匹配路线限制', () => {
  const ledger = new RejectedRouteLedger(file, now);
  ledger.record('unknown-origin', route, null, now);
  expect(ledger.match(route, scope, now + 1)).toBeNull();
  ledger.record('known-origin', route, scope, now + 1);
  expect(ledger.match(route, null, now + 2)).toBeNull();
});

it('损坏或未来时间记录不生效，未知文件版本保留给对应版本处理', () => {
  const invalid = [
    { key: 'missing-origin', steps: route, atMs: now, scope: { realm: scope.realm, dimension: scope.dimension } },
    { key: 'invalid-origin', steps: route, atMs: now, scope: { ...scope, origin: [null, 64, 0] } },
    { key: 'future', steps: route, atMs: now + 60_000, scope },
  ];
  writeFileSync(file, JSON.stringify({ version: 2, records: invalid }));
  expect(new RejectedRouteLedger(file, now + 1).match(route, scope, now + 1)).toBeNull();
  const futureFile = JSON.stringify({ version: 3, records: [{ key: 'future-schema', steps: route, atMs: now, scope }] });
  writeFileSync(file, futureFile);
  expect(new RejectedRouteLedger(file, now + 1).match(route, scope, now + 1)).toBeNull();
  expect(readFileSync(file, 'utf8')).toBe(futureFile);
});
