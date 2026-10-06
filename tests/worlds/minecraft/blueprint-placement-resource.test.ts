/** 真实 1.20.6 方块回读 + World 材料账：工程许可与迟到扣料的因果边界。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { MinecraftWorld, BLUEPRINT_PLACEMENT_SETTLE_MS } from '../../../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS } from '../../../src/worlds/minecraft/config.ts';
import { diffBlueprint, billForSteps, remainingPlacementBillSteps } from '../../../src/worlds/minecraft/blueprint-plan.ts';
import { worldStateAt } from '../../../src/worlds/minecraft/skills-build.ts';
import { Aborted, SkillBlocked, type BlueprintPlacementIntent, type ResourcePlacementPermit } from '../../../src/worlds/minecraft/skill-context.ts';
import { FakeHost } from '../../helpers/fake-host.ts';

const dependency = createRequire(createRequire(import.meta.url).resolve('mineflayer'));
const registry = dependency('prismarine-registry')('1.20.6');
const Blocks = dependency('prismarine-block')(registry);
const dirs: string[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function floor(key = 'home', state = 'minecraft:glass') {
  return { key, site_mode: 'new', size_xyz: [2, 1, 2], axis_order: 'YZX',
    palette: [state], layers: [[[0, 0], [0, 0]]] };
}

async function rig(stock: Record<string, number> = { glass: 1 }, submission = floor()) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-owned-bp-'));
  dirs.push(dir);
  const world = new MinecraftWorld({ cfg: structuredClone({ ...MINECRAFT_DEFAULTS, enabled: true, port: 1 }), dataDir: dir });
  Object.assign(world, { host: new FakeHost() });
  const m = world as any; // Inspect the World-owned cache/ledger, not a duplicate test ledger.
  const cells = new Map<string, string>();
  const unknown = new Set<string>();
  const client = Object.assign(new EventEmitter(), { write: vi.fn() });
  const bot = Object.assign(new EventEmitter(), { registry, _client: client, game: { dimension: 'overworld', gameMode: 'survival' },
    inventory: { items: () => Object.entries(stock).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })) },
    blockAt: (at: Vec3) => {
      const key = `${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)}`;
      if (unknown.has(key)) return null;
      const name = cells.get(key) ?? 'air';
      const block = Blocks.fromStateId(registry.blocksByName[name].defaultState, 0);
      block.position = new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z));
      return block;
    } });
  m.bridge = { bot, retune: vi.fn() };
  const tool = world.tools().find((entry) => entry.name === 'mc_blueprint')!;
  const save = async (value: Record<string, unknown>) => tool.handler({ save: value }, {} as never);
  await save(submission);
  const key = submission.key;
  m.blueprints.bind(key, [0, 64, 0]);
  m.syncBlueprintResources();
  const refresh = () => {
    const site = m.blueprintDesk().get(key);
    const diff = diffBlueprint(site.blueprint, site.plan, site.anchor,
      (x, y, z) => worldStateAt(bot as never, { x, y, z }));
    m.observeBlueprintRemaining(key, site.versionId, site.anchor,
      diff.remaining.map((step) => step.index), diff.placements);
    return diff;
  };
  refresh();
  const intent = (at: [number, number, number] = [0, 64, 0]): BlueprintPlacementIntent => {
    const site = m.blueprintDesk().get(key);
    return { key, versionId: site.versionId, anchor: [0, 64, 0], at, aborted: () => false };
  };
  const permit = (item = 'glass', at?: [number, number, number]): ResourcePlacementPermit =>
    m.permitBlueprintResourcePlacement(item, intent(at));
  const put = (at: [number, number, number] = [0, 64, 0], name = 'glass') => cells.set(at.join(','), name);
  return { world, m, bot, stock, cells, unknown, client, key, save, refresh, intent, permit, put };
}

function allowed(value: ResourcePlacementPermit): Extract<ResourcePlacementPermit, { ok: true }> {
  expect(value.ok).toBe(true);
  if (!value.ok) throw new Error(value.reason);
  return value;
}

function outcome(promise: void | Promise<void>) {
  return Promise.resolve(promise).then(() => ({ ok: true, error: null }), (error: unknown) => ({ ok: false, error }));
}

describe('正式蓝图格使用本工程预留', () => {
  it('同物品普通放置被保护，正式格无需 override；确证扣料不记临时借料', async () => {
    const r = await rig();
    r.m.blueprintResources.openOverride({ reason: '临时借料', ttlMs: 30_000, maxBlocks: 4 });
    // Inspect the no-override verdict separately: an override must not be spent by formal construction.
    const lease = r.m.blueprintResources.activeOverride();
    expect(r.m.blueprintResources.placementDecision('glass', r.stock, Date.now())).toMatchObject({ source: 'override' });
    const gate = allowed(r.permit());
    r.put(); r.stock.glass--;
    await gate.finish(true);
    expect(r.m.blueprintResources.reserve()).toEqual({ glass: 3 });
    expect(r.m.blueprintResources.activeOverride().id).toBe(lease.id);
    expect(r.m.blueprintResources.activeOverride().spent).toBe(0);
    expect(r.m.blueprintResources.restockMarkers()).toEqual([]);
    expect(r.m.blueprintOwnedConsumptions).toHaveLength(0);
  });

  it('没有临时覆盖时，只允许确证正式目标，不放空整个施工 context 的 gate', async () => {
    const r = await rig();
    expect(r.m.permitBlueprintResourcePlacement('glass')).toMatchObject({ ok: false });
    const gate = allowed(r.permit());
    await gate.finish(false);
    expect(r.m.permitBlueprintResourcePlacement('glass')).toMatchObject({ ok: false });
    expect(r.m.blueprintResources.reserve()).toEqual({ glass: 4 });
  });

  it('同材质其他工程的预留继续保留，只能花其他工程之外的随身数量', async () => {
    const r = await rig({ glass: 4 });
    await r.save(floor('other'));
    r.m.blueprints.bind('other', [10, 64, 0]);
    r.m.syncBlueprintResources();
    expect(r.permit()).toMatchObject({ ok: false, reason: expect.stringContaining('其他蓝图保留 4') });
    r.stock.glass = 5;
    const gate = allowed(r.permit());
    r.put(); r.stock.glass--;
    await gate.finish(true);
    expect(r.m.blueprintResources.reserve()).toEqual({ glass: 7 });
    expect(r.m.blueprintResources.placementDecision('glass', r.stock, Date.now(),
      { key: 'other', versionId: r.m.blueprints.get('other').versionId })).toMatchObject({ ok: true });
  });

  it.each(['version', 'anchor', 'outside', 'item', 'unknown', 'already'] as const)
  ('%s 不能凭同物品绕过 reserve', async (change) => {
    const r = await rig();
    const proof = r.intent();
    let item = 'glass';
    if (change === 'version') proof.versionId = 'bpv_stale';
    if (change === 'anchor') proof.anchor = [1, 64, 0];
    if (change === 'outside') proof.at = [2, 64, 0];
    if (change === 'item') item = 'stone';
    if (change === 'unknown') r.unknown.add('0,64,0');
    if (change === 'already') r.put();
    expect(r.m.permitBlueprintResourcePlacement(item, proof)).toMatchObject({ ok: false });
    expect(r.m.blueprintPlacementHolds).toBe(0);
  });

  it('finish(false) 和未回读到真实目标的 finish(true) 不减需求、不花预算', async () => {
    const r = await rig();
    r.m.blueprintResources.openOverride({ reason: '借料', ttlMs: 30_000, maxBlocks: 4 });
    await allowed(r.permit()).finish(false);
    const finish = await outcome(allowed(r.permit()).finish(true));
    expect(finish.error).toBeInstanceOf(SkillBlocked);
    expect(r.m.blueprintResources.reserve()).toEqual({ glass: 4 });
    expect(r.m.blueprintResources.activeOverride().spent).toBe(0);
    expect(r.m.blueprintPlacementHolds).toBe(0);
  });

  it('异名 torch→wall_torch 以编译目标块确认，而非把库存物品名当方块名', async () => {
    const r = await rig({ torch: 1 }, { ...floor('home', 'minecraft:wall_torch[facing=east]'),
      size_xyz: [1, 1, 1], layers: [[[0]]] });
    expect(r.m.blueprints.get('home').plan.steps[0]).toMatchObject({ item: 'torch', state: expect.stringContaining('wall_torch') });
    const gate = allowed(r.permit('torch'));
    r.put(undefined, 'wall_torch'); r.stock.torch--;
    await gate.finish(true);
    expect(billForSteps(r.m.blueprintRemainingBill('home')).lines).toMatchObject([{ item: 'torch', need: 0 }]);
  });
});

describe('已确认施工与迟到库存', () => {
  it('等待真实扣料，有上界；数量尚未变化时不虚扣 override，单格回读已更新需求', async () => {
    const r = await rig();
    r.m.blueprintResources.openOverride({ reason: '借料', ttlMs: 30_000, maxBlocks: 4 });
    const gate = allowed(r.permit());
    r.put();
    const finished = outcome(gate.finish(true));
    expect(r.m.blueprintResources.reserve()).toEqual({ glass: 3 });
    expect(r.m.blueprintPlacementHolds).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(r.m.blueprintResources.activeOverride().spent).toBe(0);
    r.stock.glass--;
    await vi.advanceTimersByTimeAsync(50);
    expect((await finished).ok).toBe(true);
    expect(r.m.blueprintResources.activeOverride().spent).toBe(0);
    expect(r.m.blueprintPlacementHolds).toBe(0);
  });

  it('超时释放串行闸，同 item 未决不发第二张；一份迟到扣料只结清一格', async () => {
    const r = await rig({ glass: 10, stone: 2 });
    const gate = allowed(r.permit());
    r.put();
    const finished = outcome(gate.finish(true));
    await vi.advanceTimersByTimeAsync(BLUEPRINT_PLACEMENT_SETTLE_MS);
    expect((await finished).error).toBeInstanceOf(SkillBlocked);
    expect(r.m.blueprintPlacementHolds).toBe(0);
    expect(r.permit('glass', [1, 64, 0])).toMatchObject({ ok: false, reason: expect.stringContaining('扣减仍待同步') });
    await allowed(r.m.permitBlueprintResourcePlacement('stone')).finish(false);
    r.stock.glass = 9;
    r.m.observeBlueprintResources();
    expect(r.m.blueprintOwnedConsumptions).toHaveLength(0);
    expect(r.m.blueprintResources.reserve()).toEqual({ glass: 3 });
    await allowed(r.permit('glass', [1, 64, 0])).finish(false);
    expect(r.m.blueprintResources.reserve()).toEqual({ glass: 3 });
  });

  it('后续库存点击让旧 pending 失去归属，不拿普通消费冒充施工扣料', async () => {
    const r = await rig();
    r.m.blueprintResources.openOverride({ reason: '后续普通借料', ttlMs: 30_000, maxBlocks: 4 });
    const gate = allowed(r.permit()); r.put();
    const finished = outcome(gate.finish(true));
    await vi.advanceTimersByTimeAsync(BLUEPRINT_PLACEMENT_SETTLE_MS);
    expect((await finished).ok).toBe(false);
    r.client.write('window_click', { windowId: 0, slot: 36, mouseButton: 0, mode: 0, stateId: -1, changedSlots: [], cursorItem: null });
    r.stock.glass = 0;
    r.m.observeBlueprintResources();
    expect(r.m.blueprintOwnedConsumptions).toHaveLength(0);
    expect(r.m.blueprintResources.activeOverride().spent).toBe(1);
    expect(r.m.diag.after(0).some((entry: { event: string }) => entry.event === 'blueprint-material-unconfirmed')).toBe(true);
  });

  it('等待期内发生另一笔 use_item，回执仍未决，不能因 pending 消失翻成成功', async () => {
    const r = await rig();
    const gate = allowed(r.permit()); r.put();
    const finished = outcome(gate.finish(true));
    r.client.write('use_item', { hand: 0, sequence: 1 });
    await vi.advanceTimersByTimeAsync(50);
    expect((await finished).error).toBeInstanceOf(SkillBlocked);
    expect(r.m.blueprintPlacementHolds).toBe(0);
  });

  it('任务取消结束有界等待；同连接且没有后续改写的迟到扣料仍可证实', async () => {
    const r = await rig();
    let aborted = false;
    const proof = { ...r.intent(), aborted: () => aborted };
    const gate = allowed(r.m.permitBlueprintResourcePlacement('glass', proof)); r.put();
    const finished = outcome(gate.finish(true)); aborted = true;
    await vi.advanceTimersByTimeAsync(50);
    expect((await finished).error).toBeInstanceOf(Aborted);
    expect(r.m.blueprintPlacementHolds).toBe(0);
    r.stock.glass--;
    r.m.observeBlueprintResources();
    expect(r.m.blueprintOwnedConsumptions).toHaveLength(0);
    expect(r.m.blueprintResources.restockMarkers()).toEqual([]);
  });

  it.each(['bot', 'dimension', 'realm', 'version', 'anchor'] as const)
  ('%s 变化不继承旧材料事实和需求缓存', async (change) => {
    const r = await rig();
    r.m.blueprintResources.openOverride({ reason: '普通消耗', ttlMs: 30_000, maxBlocks: 4 });
    const gate = allowed(r.permit()); r.put();
    const finished = outcome(gate.finish(true));
    if (change === 'bot') r.m.bridge.bot = { ...r.bot };
    if (change === 'dimension') r.bot.game.dimension = 'the_nether';
    if (change === 'realm') r.m.cfg.host = 'other-server';
    if (change === 'version') await r.save(floor());
    if (change === 'anchor') r.m.blueprints.bind('home', [1, 64, 0]);
    await vi.advanceTimersByTimeAsync(50);
    expect((await finished).error).toBeInstanceOf(Aborted);
    r.stock.glass--;
    r.m.syncBlueprintResources();
    expect(r.m.blueprintOwnedConsumptions).toHaveLength(0);
    // The old 3-cell readback must not become the current scope's material requirement.
    expect(billForSteps(r.m.blueprintRemainingBill('home')).lines.find((line) => line.item === 'glass')?.need).toBe(4);
  });

  it('断线清理 pending；换 bot 后旧 finish 不释放新 bot 的材料 hold', async () => {
    const r = await rig();
    const gate = allowed(r.permit()); r.put();
    const finished = outcome(gate.finish(true));
    r.client.emit('end');
    r.m.bridge.bot = { ...r.bot, _client: Object.assign(new EventEmitter(), { write: vi.fn() }) };
    const newer = allowed(r.permit('glass', [1, 64, 0]));
    expect(r.m.blueprintPlacementHolds).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect((await finished).error).toBeInstanceOf(Aborted);
    expect(r.m.blueprintPlacementHolds).toBe(1);
    await newer.finish(false);
    expect(r.m.blueprintPlacementHolds).toBe(0);
  });

  it('creative 的确证不耗料，立即完成材料收尾、不造借料', async () => {
    const r = await rig(); r.bot.game.gameMode = 'creative';
    const gate = allowed(r.permit()); r.put();
    await gate.finish(true);
    expect(r.stock.glass).toBe(1);
    expect(r.m.blueprintPlacementHolds).toBe(0);
    expect(r.m.blueprintOwnedConsumptions).toHaveLength(0);
    expect(r.m.blueprintResources.reserve()).toEqual({ glass: 3 });
    expect(r.m.blueprintResources.restockMarkers()).toEqual([]);
  });

  it.each(['death', 'respawn'])('同 bot 的 %s 确定失效旧施工 fact，不把新生命库存当迟到扣料', async (event) => {
    const r = await rig();
    const gate = allowed(r.permit()); r.put();
    const finished = outcome(gate.finish(true));
    r.bot.emit(event);
    r.stock.glass--;
    await vi.advanceTimersByTimeAsync(50);
    expect((await finished).error).toBeInstanceOf(Aborted);
    expect(r.m.blueprintOwnedConsumptions).toHaveLength(0);
    expect(r.m.blueprintResourceReadings.has('home')).toBe(false);
    expect(billForSteps(r.m.blueprintRemainingBill('home')).lines).toMatchObject([{ item: 'glass', need: 4 }]);
  });

  it('已有施工回读先更新同格，迟到库存不重复减格，未知格仍计所需材料', async () => {
    const r = await rig();
    const gate = allowed(r.permit()); r.put();
    const finished = outcome(gate.finish(true));
    r.unknown.add('1,64,1');
    expect(r.refresh().unknown).toBe(1);
    expect(r.m.blueprintResources.reserve()).toEqual({ glass: 3 });
    r.stock.glass--;
    await vi.advanceTimersByTimeAsync(50);
    expect((await finished).ok).toBe(true);
    expect(r.m.blueprintResources.reserve()).toEqual({ glass: 3 });
  });
});

describe('局部已完成材料账', () => {
  it('49 格已有18格只计31料，unknown保留需要，原施工 IR 仍是49格', async () => {
    const r = await rig({ cherry_log: 18 }, { key: 'home', site_mode: 'new', size_xyz: [7, 1, 7],
      axis_order: 'YZX', palette: ['minecraft:cherry_log'], layers: [Array.from({ length: 7 }, () => Array(7).fill(0))] });
    for (let index = 0; index < 18; index++) r.put([index % 7, 64, Math.floor(index / 7)], 'cherry_log');
    r.unknown.add('6,64,6');
    const diff = r.refresh();
    expect(diff.matched).toBe(18);
    expect(diff.unknown).toBe(1);
    expect(billForSteps(remainingPlacementBillSteps(diff.remaining, diff.placements)).lines)
      .toMatchObject([{ item: 'cherry_log', need: 31 }]);
    expect(r.m.blueprintResources.reserve()).toEqual({ cherry_log: 31 });
    expect(r.m.blueprints.get('home').plan.steps[0].cells).toBe(49);
  });

  it('已放主块但 postUse 未到终态，不重复要一份方块物品', async () => {
    const r = await rig({ lever: 4 }, floor('home', 'minecraft:lever[face=floor,facing=north,powered=true]'));
    r.put(undefined, 'lever');
    const diff = r.refresh();
    expect(diff.remaining).toHaveLength(1);
    expect(billForSteps(r.m.blueprintRemainingBill('home')).lines).toMatchObject([{ item: 'lever', need: 3 }]);
  });
});
