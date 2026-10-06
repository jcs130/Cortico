import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { Executor, type SkillCall, type TaskReport } from '../../../src/worlds/minecraft/executor.ts';
import { pocketScan, probeBlockInfo, standCellsAround, type BlockReader } from '../../../src/worlds/minecraft/terrain.ts';
import { renderRouteMenu, routeNote, travelGoalReached, withRouteScene } from '../../../src/worlds/minecraft/travel.ts';
import { SkillBlocked, type RouteProbe, type SkillContext, type TargetDiag } from '../../../src/worlds/minecraft/skill-context.ts';
import { combatBot, log, nextTaskId, waitUntil } from './executor-harness.ts';

const require = createRequire(createRequire(import.meta.url).resolve('mineflayer/package.json'));
const registry = require('prismarine-registry')('1.20.6');
const Block = require('prismarine-block')(registry);
const { goals } = pathfinderPkg;
const partialBlockNames = ['spruce_stairs', 'spruce_slab', 'spruce_fence_gate', 'oak_door'];

function block(name: string) {
  return Block.fromStateId(registry.blocksByName[name].defaultState, 0);
}

const complete: RouteProbe[] = [
  { profile: 'style', status: 'complete', steps: 7, place: 0, breaks: 2, endDist: 0 },
  { profile: 'walk', status: 'noPath', steps: 0, place: 0, breaks: 0, endDist: 3 },
];

describe('目标格诊断的碰撞与到达范围', () => {
  it.each(partialBlockNames)('%s 的部分碰撞不能证明整格不可站', (name) => {
    const info = probeBlockInfo(block(name));
    expect(info).toMatchObject({ solid: true, uncertain: true });
    const read: BlockReader = () => info;
    const candidates = standCellsAround(read, { x: 0, y: 64, z: 0 });
    expect(candidates.length).toBeGreaterThan(0);
    expect(pocketScan(read, candidates)).toBeNull();
  });

  it('整块石头仍能证明所有候选被占据', () => {
    const stone = probeBlockInfo(block('stone'));
    expect(stone.uncertain).toBeUndefined();
    expect(standCellsAround(() => stone, { x: 0, y: 64, z: 0 })).toEqual([]);
  });

  it('缺失碰撞形状不能被当作已验证的整块墙', () => {
    const info = probeBlockInfo({ name: 'custom_block', boundingBox: 'block' });
    expect(standCellsAround(() => info, { x: 0, y: 64, z: 0 }).length).toBeGreaterThan(0);
  });

  it('脚下加一格已满足 GoalNear 时，分诊保留同一可站位置', () => {
    const goal = new goals.GoalNear(0, 64, 0, 1);
    const bot = { entity: { position: new Vec3(0.5, 62, 0.5) } };
    const read: BlockReader = (_x, y, _z) => ({ name: y <= 61 ? 'stone' : 'air', solid: y <= 61 });
    expect(travelGoalReached(bot as never, goal)).toBe(true);
    expect(standCellsAround(read, { x: 0, y: 64, z: 0 })).toContainEqual({ x: 0, y: 62, z: 0 });
    expect(travelGoalReached({ entity: { position: new Vec3(0.5, 61, 0.5) } } as never, goal)).toBe(false);
  });

  it('完整路径不会同时被描述成无处站立，实际移动失败仍保留', () => {
    const bot = combatBot({});
    const target = { x: 10, y: 64, z: 0 };
    const ctx = { probeRoutes: () => complete, probeTarget: () => ({ kind: 'noStand' }) } as unknown as SkillContext;
    expect(() => routeNote(bot as never, ctx, target)).not.toThrow();
    const err = withRouteScene(bot as never, ctx, new SkillBlocked('走不过去:实际路线受阻'), target);
    expect(err).toBeInstanceOf(SkillBlocked);
    expect((err as SkillBlocked).message).toContain('实际路线受阻');
    expect((err as SkillBlocked).message).not.toContain('站不进人');
    expect((err as SkillBlocked).scene.join('\n')).toContain('走 7 步,挖 2 块');
    expect(renderRouteMenu(complete, target, { diag: { kind: 'noStand' } })).not.toContain('站不进人');
  });
});

describe('旧不可站记录重新核验', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function rig(diag: TargetDiag | null, probes?: RouteProbe[]) {
    const bot = combatBot({});
    const reports: TaskReport[] = [];
    const exec = new Executor({ getBot: () => bot as never, report: (r) => reports.push(r),
      log, nextId: nextTaskId(), probeTarget: () => diag, probeRoutes: () => probes ?? null });
    const target: SkillCall = { skill: 'goto', at: [10, 64, 0] };
    (exec as unknown as { recordSpatialOutcome(s: SkillCall[], failed: boolean, why: string): void })
      .recordSpatialOutcome([target], true, '目标那一格站不进人:它和四周都被方块占着');
    return { bot, exec, target, reports };
  }

  it.each([null, { kind: 'open' } as TargetDiag])('新读数 %j 不沿用旧不可站结论', async (diag) => {
    const { bot, exec, target, reports } = rig(diag);
    expect(exec.submitDetailed([target]).accepted).toBe(true);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(bot.entity.position.x).toBe(10);
  });

  it('当前仍由整格诊断确认无落脚点时拒绝原样重试', () => {
    const { bot, exec, target, reports } = rig({ kind: 'noStand' });
    const receipt = exec.submitDetailed([target]);
    expect(receipt.accepted).toBe(false);
    expect(receipt.receipt).toContain('已确认不可站');
    expect(reports).toHaveLength(0);
    expect(bot.entity.position.x).toBe(0.5);
  });

  it('有完整路径时不把旧不可站记作当前不可改变的事实', async () => {
    const { bot, exec, target, reports } = rig({ kind: 'noStand' }, complete);
    expect(exec.submitDetailed([target]).accepted).toBe(true);
    await waitUntil(() => reports.length === 1);
    expect(reports[0].kind).toBe('done');
    expect(bot.entity.position.x).toBe(10);
  });
});
