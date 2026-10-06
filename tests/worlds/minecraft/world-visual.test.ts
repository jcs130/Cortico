import { Vec3 } from 'vec3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CognitionRequest, ToolOutcome } from '../../../src/core/types.ts';
import { LogBlobStore, withBlobLines } from '../../../src/core/blobs.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MinecraftWorld } from '../../../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS, type MinecraftConfigSection } from '../../../src/worlds/minecraft/config.ts';
import { captureMinecraftView } from '../../../src/worlds/minecraft/visual-capture.ts';
import { FakeHost } from '../../helpers/fake-host.ts';

vi.mock('../../../src/worlds/minecraft/visual-capture.ts', () => ({
  captureMinecraftView: vi.fn(), closeMinecraftViewCapture: vi.fn(async () => {}),
}));

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cBqUAAAAASUVORK5CYII=', 'base64');
const capturedAt = '2026-01-01T08:00:00.000Z';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function image() { return { png, mode: 'first' as const, width: 1280, height: 720, capturedAt }; }

function rig(connected = true) {
  const cfg = structuredClone(MINECRAFT_DEFAULTS) as MinecraftConfigSection;
  const world = new MinecraftWorld({ cfg });
  const host = new FakeHost();
  const bot = { entity: { position: new Vec3(1.5, 64, -3.5), onGround: true }, game: { dimension: 'overworld' },
    blockAt: vi.fn((_position: Vec3): { name: string } | null => null), oxygenLevel: 20 };
  const bridge = { bot: connected ? bot : null, viewerUrl: connected ? 'http://127.0.0.1:12345' : null };
  Object.assign(world, { host, bridge });
  const tool = world.tools().find(item => item.name === 'mc_visual')!;
  return { world, host, bot, bridge, tool, ctx: { role: 'main', log: host.log } };
}

beforeEach(() => {
  vi.mocked(captureMinecraftView).mockReset();
  vi.mocked(captureMinecraftView).mockImplementation(async options => ({
    png, mode: options.mode ?? 'third', width: 1280, height: 720, capturedAt,
    includesHud: options.includeHud === true,
  }));
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('mc_visual scene observation', () => {
  it('reports missing connection without claiming a screenshot', async () => {
    const { tool, ctx } = rig(false);
    const result = await tool.handler({}, ctx) as ToolOutcome;
    expect(result).toMatchObject({ failed: true, endsTurn: true });
    expect(result).not.toHaveProperty('retryAfterMs');
    expect(result.text).toContain('未连接');
    expect(result.blobs).toBeUndefined();
  });

  it('returns image bytes that Core can persist, with time, viewpoint and location provenance', async () => {
    const { tool, ctx } = rig();
    const result = await tool.handler({ focus: '入口  和\n房间布局' }, ctx) as ToolOutcome;
    expect(result.failed).toBeUndefined();
    expect(result.text).toContain(capturedAt);
    expect(result.text).toContain('third');
    expect(result.text).toContain('overworld');
    expect(result.text).toContain('(1.5, 64.0, -3.5)');
    expect(result.text).toContain('入口 和 房间布局');
    const image = result.blobs?.[0];
    expect(image).toMatchObject({ mime: 'image/png', fallbackText: expect.stringContaining(capturedAt) });
    expect(image && 'bytes' in image && image.bytes).toBeInstanceOf(Uint8Array);
    const dir = mkdtempSync(join(tmpdir(), 'mc-visual-blob-'));
    try {
      if (!image || !('bytes' in image)) throw new Error('missing screenshot bytes');
      const store = new LogBlobStore(dir);
      const handle = store.put(image.bytes, image.mime);
      expect(store.read(handle)?.bytes).toEqual(png);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('labels a moving viewpoint instead of presenting it as a stationary inspection', async () => {
    const { tool, ctx, bot } = rig();
    vi.mocked(captureMinecraftView).mockImplementationOnce(async () => {
      bot.entity.position = new Vec3(6.5, 64, -3.5);
      return { png, mode: 'first', width: 1280, height: 720, capturedAt };
    });
    const result = await tool.handler({ mode: 'first' }, ctx) as ToolOutcome;
    expect(result.text).toContain('移动了约 5.0 格');
    expect(result.text).toContain('(6.5, 64.0, -3.5)');
    expect(result.blobs).toHaveLength(1);
  });

  it('sends only this captured image and question to task-focused cognition and returns text to the main loop', async () => {
    const { host, tool, ctx } = rig();
    const request = vi.fn(async (_req: CognitionRequest) => ({ text: '门口可见台阶，箱子没有打开，无法判断箱内物品。' }));
    Object.assign(host, { cognition: { request } });
    const result = await tool.handler({ mode: 'first', focus: '入口和箱子' }, ctx) as ToolOutcome;
    expect(result.text).toContain('箱子没有打开');
    expect(result.text).toContain(capturedAt);
    expect(result.blobs).toBeUndefined();
    expect(request.mock.calls[0][0]).toMatchObject({ hint: { context: 'task', rounds: 1 },
      brief: expect.stringContaining('入口和箱子'), blobs: [{ bytes: png, mime: 'image/png' }] });
  });

  it('gives focused observation the water readings taken after capture and preserves them while analysis runs', async () => {
    const { host, tool, ctx, bot } = rig();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(capturedAt));
    bot.blockAt.mockReturnValue({ name: 'air' });
    vi.mocked(captureMinecraftView).mockImplementationOnce(async () => {
      bot.entity.position = new Vec3(8.5, 60, -3.5);
      bot.blockAt.mockReturnValue({ name: 'water' });
      bot.oxygenLevel = 9;
      vi.advanceTimersByTime(200);
      return image();
    });
    let material = '';
    Object.assign(host, { cognition: { request: async (request: CognitionRequest) => {
      material = request.brief;
      bot.blockAt.mockReturnValue({ name: 'air' });
      bot.entity.position = new Vec3(9.5, 64, -3.5);
      bot.oxygenLevel = 20;
      return { text: '可见河床；现场读数表明截图完成时头部在水中。' };
    } } });
    const result = await tool.handler({ focus: '哪里可以上岸' }, ctx) as ToolOutcome;
    for (const text of ['2026-01-01T08:00:00.200Z', '(8.5, 60.0, -3.5)',
      '脚部格 water；头部格 water', '头部在水中', '氧气 9/20']) {
      expect(material).toContain(text);
      expect(result.text).toContain(text);
    }
    expect(result.text).not.toContain('氧气 20/20');
    expect(result.blobs).toBeUndefined();
  });

  it('distinguishes shallow water, unread cells and dry cells without certifying a landing', async () => {
    const { tool, ctx, bot } = rig();
    bot.blockAt.mockImplementation(position => ({ name: position.y < 65 ? 'water' : 'air' }));
    const shallow = await tool.handler({ raw: true }, ctx) as ToolOutcome;
    expect(shallow.text).toContain('脚部在水中，尚未确认登岸');
    expect(shallow.text).not.toContain('头部在水中');
    expect(shallow.text).not.toContain('氧气');
    bot.blockAt.mockReturnValue(null);
    const unread = await tool.handler({ raw: true }, ctx) as ToolOutcome;
    expect(unread.text).toContain('水中状态未核实');
    expect(unread.text).not.toContain('未读到水');
    bot.blockAt.mockReturnValue({ name: 'air' });
    const dry = await tool.handler({ raw: true }, ctx) as ToolOutcome;
    expect(dry.text).toContain('头脚所在格未读到水');
  });

  it('reports ground below the feet separately from the air occupied by the body', async () => {
    const { host, tool, ctx, bot } = rig();
    bot.blockAt.mockImplementation(position => ({ name: position.y < 64 ? 'stone_slab' : 'air' }));
    let material = '';
    Object.assign(host, { cognition: { request: async (request: CognitionRequest) => {
      material = request.brief;
      return { text: '角色站在石台阶上，身体所在格为空气。' };
    } } });
    const result = await tool.handler({ focus: '我是否站在岸上' }, ctx) as ToolOutcome;
    for (const text of ['脚部格 air；头部格 air', '脚底下方格 stone_slab；物理接地：是',
      '空气不表示脚下悬空']) {
      expect(material).toContain(text);
      expect(result.text).toContain(text);
    }
  });

  it('returns the real image and failure reason when focused observation is unavailable', async () => {
    const { host, tool, ctx } = rig();
    Object.assign(host, { cognition: { request: async () => ({ error: '图片判断通道忙' }) } });
    const result = await tool.handler({}, ctx) as ToolOutcome;
    expect(result.text).toContain('图片判断通道忙');
    expect(result.blobs).toHaveLength(1);
    expect(result.failed).toBeUndefined();
  });

  it('lets the agent request the original image without running focused observation', async () => {
    const { host, tool, ctx } = rig();
    const request = vi.fn(async () => ({ text: 'unused' }));
    Object.assign(host, { cognition: { request } });
    const result = await tool.handler({ raw: true }, ctx) as ToolOutcome;
    expect(result.blobs).toHaveLength(1);
    expect(request).not.toHaveBeenCalled();
  });

  it('does not read the synchronous model facts API which is unavailable in an engine child', async () => {
    const { host, tool, ctx } = rig();
    host.modelFacts.accepts = () => { throw new Error('modelFacts.accepts unavailable in engine child'); };
    const request = vi.fn(async () => ({ text: '图片看见一扇打开的门。' }));
    Object.assign(host, { cognition: { request } });
    const result = await tool.handler({}, ctx) as ToolOutcome;
    expect(result.text).toContain('打开的门');
    expect(result.blobs).toBeUndefined();
    const raw = await tool.handler({ raw: true }, ctx) as ToolOutcome;
    expect(raw.blobs).toHaveLength(1);
  });

  it('returns the original image if the parent reports unsupported image input', async () => {
    const { host, tool, ctx } = rig();
    const request = vi.fn(async () => ({ error: '当前模型通道不支持本次附件格式：image/png' }));
    Object.assign(host, { cognition: { request } });
    const result = await tool.handler({}, ctx) as ToolOutcome;
    expect(result.text).toContain('不支持本次附件格式');
    expect(result.blobs).toHaveLength(1);
  });

  it('discards a successful observation if the game connection changes during analysis', async () => {
    const { host, tool, ctx, bridge, bot } = rig();
    Object.assign(host, { cognition: { request: async () => { bridge.bot = { ...bot }; return { text: '旧画面结论' }; } } });
    const result = await tool.handler({}, ctx) as ToolOutcome;
    expect(result.failed).toBe(true);
    expect(result.text).toContain('分析期间');
    expect(result.text).not.toContain('旧画面结论');
    expect(result.blobs).toBeUndefined();
  });

  it('does not return a stale fallback image when the dimension changes during an analysis failure', async () => {
    const { host, tool, ctx, bot } = rig();
    Object.assign(host, { cognition: { request: async () => { bot.game.dimension = 'the_nether'; throw new Error('analysis disconnected'); } } });
    const result = await tool.handler({}, ctx) as ToolOutcome;
    expect(result.failed).toBe(true);
    expect(result.text).toContain('旧画面已丢弃');
    expect(result.blobs).toBeUndefined();
  });

  it('observes the current menu without enqueuing body actions and retains evidence boundaries', async () => {
    const { tool, ctx } = rig();
    const result = await tool.handler({ mode: 'first', include_hud: true, focus: '物品名称和菜单入口' }, ctx) as ToolOutcome;
    expect(result.failed).toBeUndefined();
    expect(result.blobs).toHaveLength(1);
    expect(result.text).toContain('包含游戏界面和当前可见菜单');
    expect(result.text).toContain('物品名称和菜单入口');
    expect(result.text).toContain('一帧不能证明动作过程、玩家意图或隐藏区域');
  });

  it('rejects an invalid interface flag before capturing', async () => {
    const { tool, ctx } = rig();
    const result = await tool.handler({ include_hud: 'yes' }, ctx) as ToolOutcome;
    expect(result.failed).toBe(true);
    expect(result.blobs).toBeUndefined();
    expect(captureMinecraftView).not.toHaveBeenCalled();
  });

  it.each(['connection', 'viewer', 'dimension'] as const)('discards a screenshot after %s changes during capture', async change => {
    const { tool, ctx, bot, bridge } = rig();
    vi.mocked(captureMinecraftView).mockImplementationOnce(async () => {
      if (change === 'connection') bridge.bot = { ...bot };
      if (change === 'viewer') bridge.viewerUrl = 'http://127.0.0.1:12346';
      if (change === 'dimension') bot.game.dimension = 'the_nether';
      return { png, mode: 'third', width: 1280, height: 720, capturedAt };
    });
    const result = await tool.handler({}, ctx) as ToolOutcome;
    expect(result.failed).toBe(true);
    expect(result.blobs).toBeUndefined();
  });

  it('preserves a capture failure reason and ends this wake without hiding the tool', async () => {
    const { tool, ctx } = rig();
    vi.mocked(captureMinecraftView).mockRejectedValueOnce(new Error('viewer session is full'));
    const result = await tool.handler({}, ctx) as ToolOutcome;
    expect(result).toMatchObject({ failed: true, endsTurn: true });
    expect(result).not.toHaveProperty('retryAfterMs');
    expect(result.text).toContain('viewer session is full');
    expect(result.blobs).toBeUndefined();
  });
});

describe('mc_visual background observation', () => {
  it('accepts before capture settles and later delivers actual bytes as an external observation event', async () => {
    const { host, tool, ctx } = rig();
    const capture = deferred<ReturnType<typeof image>>();
    vi.mocked(captureMinecraftView).mockImplementationOnce(() => capture.promise);
    const accepted = await tool.handler({ background: true, raw: true, focus: '门口' }, { ...ctx, callId: 'look-1' }) as ToolOutcome;
    expect(accepted.failed).toBeUndefined();
    expect(accepted.text).toContain('已受理');
    expect(accepted.text).toContain('尚未完成');
    expect(accepted.blobs).toBeUndefined();
    expect(host.events).toHaveLength(0);
    capture.resolve(image());
    await vi.waitFor(() => expect(host.events).toHaveLength(1));
    const event = host.events[0];
    expect(event).toMatchObject({ origin: 'external', source: 'minecraft', type: 'minecraft.visual',
      senderKey: 'minecraft.visual',
      meta: { status: 'completed', callId: 'look-1', dimension: 'overworld', connectionGeneration: 0 } });
    expect(accepted.text).toContain(String(event.meta?.jobId));
    expect(event.text).toContain(capturedAt);
    expect(event.text).toContain('门口');
    expect((event.blobs?.[0] as unknown as { bytes: Uint8Array }).bytes).toEqual(png);
    expect(host.pushOpts[0]).toEqual({ trigger: 'debounce' });
  });

  it('keeps one in-flight job without duplicating capture and permits another after settlement', async () => {
    const { host, tool, ctx } = rig();
    const capture = deferred<ReturnType<typeof image>>();
    vi.mocked(captureMinecraftView).mockImplementationOnce(() => capture.promise);
    const first = await tool.handler({ background: true, raw: true }, ctx) as ToolOutcome;
    const second = await tool.handler({ background: true, raw: true }, ctx) as ToolOutcome;
    expect(second.failed).toBe(true);
    const id = first.text.match(/job_id:(vis_[\w-]+)/)?.[1];
    expect(id).toBeTruthy();
    expect(second.text).toContain(id!);
    expect(captureMinecraftView).toHaveBeenCalledTimes(1);
    capture.resolve(image());
    await vi.waitFor(() => expect(host.events).toHaveLength(1));
    const next = await tool.handler({ background: true, raw: true }, ctx) as ToolOutcome;
    expect(next.failed).toBeUndefined();
    expect(next.text).not.toContain(id!);
    await vi.waitFor(() => expect(host.events).toHaveLength(2));
  });

  it('delivers focused analysis and durable image references without replaying the image into the main context', async () => {
    const { host, tool, ctx } = rig();
    const analysis = deferred<{ text: string }>();
    Object.assign(host, { cognition: { request: async () => analysis.promise } });
    const accepted = await tool.handler({ background: true, focus: '墙面' }, ctx) as ToolOutcome;
    expect(accepted.text).not.toContain('墙面有窗');
    expect(host.events).toHaveLength(0);
    const dir = mkdtempSync(join(tmpdir(), 'mc-visual-background-blob-'));
    try {
      const store = new LogBlobStore(dir);
      const handle = store.put(png, 'image/png');
      analysis.resolve({ text: withBlobLines('墙面有窗，图片未显示房间内部。',
        [{ handle, mime: 'image/png', fallbackText: '本帧现场截图' }]) });
      await vi.waitFor(() => expect(host.events).toHaveLength(1));
      expect(host.events[0].text).toContain('墙面有窗');
      expect(host.events[0].text).toContain(capturedAt);
      expect(host.events[0].text).toContain(handle);
      expect(store.read(handle)?.bytes).toEqual(png);
      expect(host.events[0].blobs).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([false, true])('prevents repeat capture across call modes while background=%s is pending', async background => {
    const { host, tool, ctx } = rig();
    const analysis = deferred<{ text: string }>();
    let analyses = 0;
    Object.assign(host, { cognition: { request: async () => { analyses++; return analysis.promise; } } });
    const pending = tool.handler({ background, focus: '入口' }, ctx);
    await vi.waitFor(() => expect(analyses).toBe(1));
    const first = background ? await pending as ToolOutcome : undefined;
    for (const next of [{ background: true }, { background: false }, { raw: true }]) {
      const refused = await tool.handler(next, ctx) as ToolOutcome;
      expect(refused.failed).toBe(true);
      expect(refused.text).toContain('没有拍摄或新建分析');
      if (first) expect(refused.text).toContain(first.text.match(/job_id:(vis_[\w-]+)/)![1]);
      expect(refused.blobs).toBeUndefined();
    }
    expect(captureMinecraftView).toHaveBeenCalledTimes(1);
    expect(analyses).toBe(1);
    analysis.resolve({ text: '入口有台阶' });
    if (background) await vi.waitFor(() => expect(host.events).toHaveLength(1));
    else expect((await pending as ToolOutcome).text).toContain('入口有台阶');
    const next = await tool.handler({ raw: true }, ctx) as ToolOutcome;
    expect(next.failed).toBeUndefined();
    expect(next.blobs).toHaveLength(1);
    expect(captureMinecraftView).toHaveBeenCalledTimes(2);
    expect(analyses).toBe(1);
    expect(host.events).toHaveLength(background ? 1 : 0);
  });

  it('releases a synchronous observation after caller cancellation and permits a fresh capture', async () => {
    const { tool, ctx } = rig();
    const controller = new AbortController();
    vi.mocked(captureMinecraftView).mockImplementationOnce(options => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    }));
    const pending = tool.handler({}, { ...ctx, signal: controller.signal });
    await vi.waitFor(() => expect(captureMinecraftView).toHaveBeenCalledTimes(1));
    controller.abort(new Error('caller cancelled'));
    expect(await pending).toMatchObject({ failed: true });
    const next = await tool.handler({ raw: true }, ctx) as ToolOutcome;
    expect(next.failed).toBeUndefined();
    expect(next.blobs).toHaveLength(1);
  });

  it('leaves explicit background=false synchronous until focused analysis is ready', async () => {
    const { host, tool, ctx } = rig();
    const analysis = deferred<{ text: string }>();
    Object.assign(host, { cognition: { request: async () => analysis.promise } });
    let settled = false;
    const pending = tool.handler({ background: false }, ctx).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(captureMinecraftView).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    analysis.resolve({ text: '观察完成' });
    const result = await pending as ToolOutcome;
    expect(result.text).toContain('观察完成');
    expect(result.text).not.toContain('已受理');
    expect(result.blobs).toBeUndefined();
    expect(host.events).toHaveLength(0);
  });

  it.each([{ background: 'yes' }, { background: true, mode: 'side' },
    { background: true, include_hud: 'yes' }, { background: true, raw: 'yes' }])(
    'rejects invalid arguments before accepting a job: %j', async args => {
      const { host, tool, ctx } = rig();
      const result = await tool.handler(args, ctx) as ToolOutcome;
      expect(result.failed).toBe(true);
      expect(result.text).not.toContain('已受理');
      expect(captureMinecraftView).not.toHaveBeenCalled();
      expect(host.events).toHaveLength(0);
    });

  it('does not accept a disconnected or already-cancelled call', async () => {
    const disconnected = rig(false);
    const missing = await disconnected.tool.handler({ background: true }, disconnected.ctx) as ToolOutcome;
    expect(missing).toMatchObject({ failed: true, endsTurn: true });
    const { tool, ctx } = rig();
    const controller = new AbortController();
    controller.abort();
    const cancelled = await tool.handler({ background: true }, { ...ctx, signal: controller.signal }) as ToolOutcome;
    expect(cancelled.failed).toBe(true);
    expect(captureMinecraftView).not.toHaveBeenCalled();
  });

  it('reports real capture failure without a fabricated image or successful analysis', async () => {
    const { host, tool, ctx } = rig();
    vi.mocked(captureMinecraftView).mockRejectedValueOnce(new Error('renderer is unavailable'));
    await tool.handler({ background: true }, ctx);
    await vi.waitFor(() => expect(host.events).toHaveLength(1));
    expect(host.events[0]).toMatchObject({ meta: { status: 'failed' } });
    expect(host.events[0].text).toContain('renderer is unavailable');
    expect(host.events[0].blobs).toBeUndefined();
  });

  it('returns the actual image when analysis fails and labels the fallback in the event', async () => {
    const { host, tool, ctx } = rig();
    Object.assign(host, { cognition: { request: async () => ({ error: 'analysis unavailable' }) } });
    await tool.handler({ background: true }, ctx);
    await vi.waitFor(() => expect(host.events).toHaveLength(1));
    expect(host.events[0]).toMatchObject({ meta: { status: 'completed' } });
    expect(host.events[0].text).toContain('独立观察未完成（analysis unavailable）');
    expect(host.events[0].blobs).toHaveLength(1);
  });

  it('caps local waiting, suppresses late analysis, and holds the slot until the model request settles', async () => {
    vi.useFakeTimers();
    const { host, tool, ctx } = rig();
    const analysis = deferred<{ text: string }>();
    Object.assign(host, { cognition: { request: async () => analysis.promise } });
    await tool.handler({ background: true }, ctx);
    await vi.advanceTimersByTimeAsync(75_000);
    expect(host.events).toHaveLength(1);
    expect(host.events[0]).toMatchObject({ meta: { status: 'failed' } });
    expect(host.events[0].text).toContain('模型请求可能仍在运行');
    expect(host.events[0].blobs).toBeUndefined();
    const busy = await tool.handler({ background: true }, ctx) as ToolOutcome;
    expect(busy.failed).toBe(true);
    expect(captureMinecraftView).toHaveBeenCalledTimes(1);
    analysis.resolve({ text: '迟到分析不能交付' });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.events).toHaveLength(1);
    const next = await tool.handler({ background: true, raw: true }, ctx) as ToolOutcome;
    expect(next.failed).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.events).toHaveLength(2);
    expect(host.events.some(event => event.text.includes('迟到分析'))).toBe(false);
  });

  it.each(['host', 'connection', 'viewer', 'dimension', 'generation'] as const)(
    'suppresses a background result after %s changes', async change => {
      vi.useFakeTimers();
      const { world, host, tool, ctx, bridge, bot } = rig();
      const analysis = deferred<{ text: string }>();
      Object.assign(host, { cognition: { request: async () => analysis.promise } });
      await tool.handler({ background: true }, ctx);
      await vi.advanceTimersByTimeAsync(0);
      const newHost = new FakeHost();
      if (change === 'host') Object.assign(world, { host: newHost });
      if (change === 'connection') bridge.bot = { ...bot };
      if (change === 'viewer') bridge.viewerUrl = 'http://127.0.0.1:12346';
      if (change === 'dimension') bot.game.dimension = 'the_nether';
      if (change === 'generation') Object.assign(world, { connectionGeneration: 1 });
      analysis.resolve({ text: '旧画面分析' });
      await vi.advanceTimersByTimeAsync(0);
      expect(host.events).toHaveLength(0);
      expect(newHost.events).toHaveLength(0);
    });

  it('aborts pending capture on stop without waiting for an uncooperative source or delivering a late result', async () => {
    vi.useFakeTimers();
    const { world, host, bridge, tool, ctx } = rig();
    const capture = deferred<ReturnType<typeof image>>();
    vi.mocked(captureMinecraftView).mockImplementationOnce(() => capture.promise);
    Object.assign(bridge, { stop: async () => {} });
    const privateWorld = world as unknown as { client: { stop(): Promise<void> };
      playerClient: { stop(): Promise<void> }; mcServer: { stop(): Promise<void> } };
    vi.spyOn(privateWorld.client, 'stop').mockResolvedValue();
    vi.spyOn(privateWorld.playerClient, 'stop').mockResolvedValue();
    vi.spyOn(privateWorld.mcServer, 'stop').mockResolvedValue();
    await tool.handler({ background: true }, ctx);
    const signal = vi.mocked(captureMinecraftView).mock.calls[0][0].signal!;
    expect(signal.aborted).toBe(false);
    await world.stop();
    expect(signal.aborted).toBe(true);
    capture.resolve(image());
    await vi.advanceTimersByTimeAsync(0);
    expect(host.events).toHaveLength(0);
    expect(await tool.handler({ background: true }, ctx)).toMatchObject({ failed: true });
  });
});
