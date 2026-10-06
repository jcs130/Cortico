import { afterEach, describe, expect, it, vi } from 'vitest';
import { MinecraftWorld } from '../../../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS, type MinecraftConfigSection } from '../../../src/worlds/minecraft/config.ts';
import { FakeHost } from '../../helpers/fake-host.ts';

function adviserResponse(): Response {
  return new Response(JSON.stringify({
    answers: {
      next: {
        choice: 'inspect', confidence: 0.7,
        probabilities: { inspect: 0.7, replan: 0.2, resupply: 0.08, pause: 0.02 },
      },
      risk: { score: 1.5 },
    },
    latency_ms: 43,
  }));
}

function rig() {
  const cfg = structuredClone(MINECRAFT_DEFAULTS) as MinecraftConfigSection;
  cfg.decision = { enabled: true, endpoint: 'http://example.test/decision', timeoutMs: 1000, minIntervalMs: 0 };
  const world = new MinecraftWorld({ cfg });
  const host = new FakeHost();
  const bot = {
    health: 13, food: 8,
    entity: { position: { x: 12.5, y: 64, z: -3.5 } },
    game: { dimension: 'overworld' },
  };
  Object.assign(world, {
    host,
    bridge: { bot, connected: true },
    executor: { status: () => ({
      running: { id: 8, label: '赶路', step: 'goto', stepIndex: 1, stepCount: 3 },
      waiting: Array.from({ length: 7 }, (_, n) => ({ id: n + 10, label: '后续任务'.repeat(40) })),
      hold: null,
    }) },
    publishGoalPlanEdges: () => {},
    reportWorldDelta: () => {},
  });
  const report = (kind: 'blocked' | 'done', taskId = 7, text = '任务受阻'): void => {
    (world as any).onTaskReport({ kind, taskId, text });
  };
  return { world, host, bot, cfg, report };
}

afterEach(() => vi.unstubAllGlobals());

describe('受阻任务辅助判断', () => {
  it('重复无进展证据随原任务终态投递，保留为 World 私有元数据', () => {
    const { world, host } = rig();
    (world as any).onTaskReport({
      kind: 'done', taskId: 16, text: '右键了小麦；包里一样没动',
      repeatFailure: { attempts: 2, previousReceipt: '上次右键后包里一样没动',
        scope: 'target', observation: 'unchanged' },
    });
    expect(host.events).toHaveLength(1);
    expect(host.events[0].type).toBe('minecraft.task');
    expect(host.pushOpts[0]?.trigger).toBe('flush');
    expect(host.events[0].text).toContain('同一坐标目标在 15 分钟内第 2 次');
    expect(host.events[0].text).toContain('上次回执：上次右键后包里一样没动');
    expect(host.events[0].meta).toEqual({
      repeatFailure: { taskId: 16, attempts: 2, scope: 'target', observation: 'unchanged' },
    });
  });

  it('先即时投递任务回执，再用有界状态取建议并搭车投递', async () => {
    let resolveFetch!: (response: Response) => void;
    const body: { state?: Record<string, any> } = {};
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      Object.assign(body, JSON.parse(String(init.body)));
      return new Promise<Response>((resolve) => { resolveFetch = resolve; });
    });
    const { world, host, report } = rig();
    const receipt = '受阻：' + '障'.repeat(2000);
    report('blocked', 7, receipt);
    expect(host.events).toHaveLength(1);
    expect(host.events[0].type).toBe('minecraft.task');
    expect(host.events[0].text).toContain(receipt);
    expect(host.pushOpts[0]?.trigger).toBe('flush');
    expect(body.state).toMatchObject({
      task: { id: 7, outcome: 'blocked' },
      player: { health: 13, food: 8, dimension: 'minecraft:overworld', position: { x: 12.5, y: 64, z: -3.5 } },
      queue: { waitingCount: 7, running: { id: 8, stepIndex: 1, stepCount: 3 } },
    });
    expect(body.state?.task.receipt.length).toBe(1200);
    expect(body.state?.queue.waiting).toHaveLength(4);
    expect(body.state?.queue.waiting[0].label.length).toBe(120);
    resolveFetch(adviserResponse());
    await vi.waitFor(() => expect(host.events).toHaveLength(2));
    expect(host.events[1].type).toBe('minecraft.event');
    expect(host.events[1].text).toContain('小模型辅助判断，未经核验');
    expect(host.events[1].text).toContain('建议先核对现场');
    expect(host.events[1].text).not.toContain(receipt);
    expect(host.pushOpts[1]?.trigger).toBe('piggyback');
    const log = world.logConsole().entries().find((entry) => entry.event === 'decision-advice');
    expect(log).toMatchObject({ taskId: 7, durMs: 43, data: { choice: 'inspect', confidence: 0.7, riskScore: 1.5, latencyMs: 43 } });
  });

  it('服务失败只写诊断，旧配置缺子段时仍保留原任务回执', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    const { world, host, cfg, report } = rig();
    report('blocked');
    await vi.waitFor(() => expect(world.logConsole().entries().some((entry) => entry.event === 'decision-error')).toBe(true));
    expect(host.events.map((event) => event.type)).toEqual(['minecraft.task']);
    expect(world.logConsole().entries().find((entry) => entry.event === 'decision-error')?.data)
      .toMatchObject({ reason: 'transport' });
    (cfg as any).decision = undefined;
    report('blocked', 8);
    expect(host.events.map((event) => event.type)).toEqual(['minecraft.task', 'minecraft.task']);
  });

  it('同一现场的重复受阻跨任务号只请求和投递一次建议', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchCall = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchCall);
    const { host, report } = rig();
    report('blocked', 7, '任务#7：这条路被墙挡住');
    report('blocked', 8, '任务#8：这条路被墙挡住');
    expect(fetchCall).toHaveBeenCalledTimes(1);
    resolveFetch(adviserResponse());
    await vi.waitFor(() => expect(host.events.filter((event) => event.type === 'minecraft.event')).toHaveLength(1));
    report('blocked', 9, '任务#9：这条路被墙挡住');
    await Promise.resolve();
    expect(fetchCall).toHaveBeenCalledTimes(1);
    expect(host.events.filter((event) => event.type === 'minecraft.task')).toHaveLength(3);
    expect(host.events.filter((event) => event.type === 'minecraft.event')).toHaveLength(1);
  });

  it.each([
    ['更新同一任务终态', (r: ReturnType<typeof rig>) => r.report('done', 7), 'task-updated'],
    ['换连接', (r: ReturnType<typeof rig>) => { (r.world as any).connectionGeneration++; }, 'connection-changed'],
    ['换维度', (r: ReturnType<typeof rig>) => { r.bot.game.dimension = 'the_nether'; }, 'dimension-changed'],
    ['World 停止', (r: ReturnType<typeof rig>) => { (r.world as any).shuttingDown = true; }, 'stopped'],
  ])('%s 后丢弃迟到建议', async (_title, change, reason) => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const r = rig();
    r.report('blocked');
    change(r);
    resolveFetch(adviserResponse());
    await vi.waitFor(() => expect(r.world.logConsole().entries().some((entry) =>
      entry.event === 'decision-stale' && entry.data?.reason === reason)).toBe(true));
    expect(r.host.events.every((event) => event.type === 'minecraft.task')).toBe(true);
  });
});
