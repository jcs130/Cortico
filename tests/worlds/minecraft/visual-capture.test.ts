import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright-core';
import { captureMinecraftView, MinecraftViewCaptureManager, viewerCaptureState, VisualCaptureError } from '../../../src/worlds/minecraft/visual-capture.ts';

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalInnerWidth = Object.getOwnPropertyDescriptor(globalThis, 'innerWidth');
const originalInnerHeight = Object.getOwnPropertyDescriptor(globalThis, 'innerHeight');
const originalWorld = Object.getOwnPropertyDescriptor(globalThis, 'world');
const originalCapture = Object.getOwnPropertyDescriptor(globalThis, '__corticoCapture');

afterEach(() => {
  vi.useRealTimers();
  for (const [key, original] of [
    ['document', originalDocument], ['innerWidth', originalInnerWidth],
    ['innerHeight', originalInnerHeight], ['world', originalWorld],
    ['__corticoCapture', originalCapture],
  ] as const) {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function fakeHealth(viewers: number, ok = true, capture?: { captureSessions: number; maxCaptureSessions: number }): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ ok, viewers, maxSessions: 2, version: '1.20.6', ...capture }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
}

function fakeBrowser(screenshot: () => Promise<Buffer>) {
  const close = vi.fn(async () => undefined);
  const goto = vi.fn(async (_url: string, _options?: unknown) => undefined);
  const page = {
    goto,
    close: vi.fn(async () => undefined),
    isClosed: vi.fn(() => false),
    evaluate: vi.fn(async (_fn: unknown, _value?: unknown) => undefined),
    addStyleTag: vi.fn(async () => undefined),
    screenshot: vi.fn(screenshot),
    waitForFunction: vi.fn(async () => ({ jsonValue: async () => 'ready', dispose: async () => undefined })),
    locator: vi.fn(() => ({ screenshot })),
  };
  const browser = { newPage: vi.fn(async () => page), close, isConnected: vi.fn(() => true) } as unknown as Browser;
  return { browser, page, close, goto };
}

describe('Minecraft visual capture', () => {
  it('rejects remote addresses before any request', async () => {
    const fetcher = fakeHealth(0);
    await expect(captureMinecraftView({ viewerUrl: 'http://example.com:7793' }, { fetcher }))
      .rejects.toMatchObject({ code: 'invalid_url' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('leaves the livestream viewer alone when both sockets are occupied', async () => {
    const launchBrowser = vi.fn(async () => { throw Error('should not launch'); });
    await expect(captureMinecraftView({ viewerUrl: 'http://127.0.0.1:7793' }, {
      fetcher: fakeHealth(2), launchBrowser,
    })).rejects.toMatchObject({ code: 'busy' });
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it('captures only the scene canvas and releases its temporary socket', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const fake = fakeBrowser(async () => png);
    const result = await captureMinecraftView({
      viewerUrl: 'http://127.0.0.1:7793', mode: 'third', width: 960, height: 540,
    }, { fetcher: fakeHealth(1), launchBrowser: async () => fake.browser });
    expect(result).toMatchObject({ mode: 'third', width: 960, height: 540, viewerVersion: '1.20.6' });
    expect(result.png).toEqual(png);
    expect(fake.goto).toHaveBeenCalledWith('http://127.0.0.1:7793/third/', expect.any(Object));
    expect(fake.page.locator).toHaveBeenCalledWith('canvas[data-cortico-capture-scene="true"]');
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('captures through the independent lane while both audience connections are occupied', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const fake = fakeBrowser(async () => png);
    const result = await captureMinecraftView({ viewerUrl: 'http://127.0.0.1:7793', includeHud: true }, {
      fetcher: fakeHealth(2, true, { captureSessions: 0, maxCaptureSessions: 1 }),
      launchBrowser: async () => fake.browser,
    });
    expect(result).toMatchObject({ png, includesHud: true });
    expect(fake.page.screenshot).toHaveBeenCalledOnce();
    expect(fake.page.locator).not.toHaveBeenCalled();
    expect(fake.browser.newPage).toHaveBeenCalledWith(expect.objectContaining({
      extraHTTPHeaders: expect.objectContaining({ 'x-mc-viewer-capture': '1' }),
    }));
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('does not fall back into the audience lane when the independent capture slot is occupied', async () => {
    const launchBrowser = vi.fn(async () => { throw Error('should not launch'); });
    await expect(captureMinecraftView({ viewerUrl: 'http://127.0.0.1:7793' }, {
      fetcher: fakeHealth(0, true, { captureSessions: 1, maxCaptureSessions: 1 }), launchBrowser,
    })).rejects.toMatchObject({ code: 'busy' });
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it('releases the browser when the renderer fails', async () => {
    const fake = fakeBrowser(async () => { throw Error('WebGL context lost'); });
    await expect(captureMinecraftView({ viewerUrl: 'http://127.0.0.1:7793' }, {
      fetcher: fakeHealth(0), launchBrowser: async () => fake.browser,
    })).rejects.toBeInstanceOf(VisualCaptureError);
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('reserves a temporary viewer socket before concurrent health checks', async () => {
    let releaseHealth!: (response: Response) => void;
    const fetcher = (() => new Promise<Response>(resolve => { releaseHealth = resolve; })) as typeof fetch;
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const fake = fakeBrowser(async () => png);
    const pending = captureMinecraftView({ viewerUrl: 'http://127.0.0.1:7793' }, {
      fetcher, launchBrowser: async () => fake.browser,
    });
    await expect(captureMinecraftView({ viewerUrl: 'http://127.0.0.1:7793/third/' }, {
      fetcher: fakeHealth(0), launchBrowser: async () => fake.browser,
    })).rejects.toMatchObject({ code: 'busy' });
    releaseHealth(new Response(JSON.stringify({ ok: true, viewers: 1 })));
    expect((await pending).png).toEqual(png);
    const next = fakeBrowser(async () => png);
    expect((await captureMinecraftView({ viewerUrl: 'http://127.0.0.1:7793' }, {
      fetcher: fakeHealth(1), launchBrowser: async () => next.browser,
    })).png).toEqual(png);
  });

  it('releases the reservation when health is unavailable', async () => {
    await expect(captureMinecraftView({ viewerUrl: 'http://127.0.0.1:7793' }, {
      fetcher: fakeHealth(0, false),
    })).rejects.toMatchObject({ code: 'unavailable' });
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const fake = fakeBrowser(async () => png);
    expect((await captureMinecraftView({ viewerUrl: 'http://127.0.0.1:7793' }, {
      fetcher: fakeHealth(0), launchBrowser: async () => fake.browser,
    })).png).toEqual(png);
  });

  it('cancels a screenshot and closes its browser once', async () => {
    let rejectScreenshot!: (error: Error) => void;
    let screenshotStarted!: () => void;
    const started = new Promise<void>(resolve => { screenshotStarted = resolve; });
    const fake = fakeBrowser(() => {
      screenshotStarted();
      return new Promise<Buffer>((_resolve, reject) => { rejectScreenshot = reject; });
    });
    fake.close.mockImplementation(async () => { rejectScreenshot(new Error('browser closed')); });
    const controller = new AbortController();
    const pending = captureMinecraftView({ viewerUrl: 'http://127.0.0.1:7793', signal: controller.signal }, {
      fetcher: fakeHealth(0), launchBrowser: async () => fake.browser,
    });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('reuses its own independent scene while the viewer reports the occupied capture slot', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const fake = fakeBrowser(async () => png);
    let occupied = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) => url.toString().endsWith('/capture-lease')
      ? new Response('{"ok":true}')
      : new Response(JSON.stringify({ ok: true, viewers: 2, maxSessions: 2, captureSessions: occupied, maxCaptureSessions: 1 }))) as unknown as typeof fetch;
    const manager = new MinecraftViewCaptureManager({ fetcher, launchBrowser: async () => fake.browser });
    try {
      const first = await manager.capture({ viewerUrl: 'http://127.0.0.1:7793' });
      occupied = 1;
      const second = await manager.capture({ viewerUrl: 'http://127.0.0.1:7793', includeHud: true });
      expect(first.timings?.reusedPage).toBe(false);
      expect(second.timings?.reusedPage).toBe(true);
      expect(second.png).toEqual(png);
      expect(fake.goto).toHaveBeenCalledOnce();
      expect(fake.page.waitForFunction).toHaveBeenCalledTimes(2);
      expect(fake.page.evaluate.mock.calls.map(call => call[1])).toEqual([true, false]);
      expect(fake.close).not.toHaveBeenCalled();
    } finally { await manager.stop(); }
    expect(fake.page.close).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('reconnects a changed viewpoint and releases every page on shutdown', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const fake = fakeBrowser(async () => png);
    const manager = new MinecraftViewCaptureManager({ fetcher: fakeHealth(0, true, { captureSessions: 0, maxCaptureSessions: 1 }),
      launchBrowser: async () => fake.browser });
    try {
      await manager.capture({ viewerUrl: 'http://127.0.0.1:7793', mode: 'first' });
      await manager.capture({ viewerUrl: 'http://127.0.0.1:7793', mode: 'dungeon' });
      expect(fake.goto.mock.calls.map(call => call[0])).toEqual(['http://127.0.0.1:7793/', 'http://127.0.0.1:7793/dungeon/']);
      expect(fake.page.close).toHaveBeenCalledOnce();
    } finally { await manager.stop(); }
    expect(fake.page.close).toHaveBeenCalledTimes(2);
  });

  it('releases its keyed slot before switching views while socket disconnection is delayed', async () => {
    const fake = fakeBrowser(async () => Buffer.from('png'));
    let occupied = false;
    let owner: string | undefined;
    const order: string[] = [];
    fake.goto.mockImplementation(async () => { occupied = true; order.push('connect'); });
    const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url).endsWith('/capture-lease')) {
        const key = new Headers(options?.headers).get('x-mc-viewer-capture-key');
        if (options?.method === 'DELETE') {
          expect(key).toBe(owner);
          occupied = false;
          order.push('release');
        } else owner = key ?? undefined;
        return new Response('{"ok":true}');
      }
      return new Response(JSON.stringify({ ok: true, viewers: 2, maxSessions: 2,
        captureSessions: Number(occupied), maxCaptureSessions: 1 }));
    }) as unknown as typeof fetch;
    const manager = new MinecraftViewCaptureManager({ fetcher, launchBrowser: async () => fake.browser });
    try {
      await manager.capture({ viewerUrl: 'http://127.0.0.1:7793', mode: 'third' });
      await manager.capture({ viewerUrl: 'http://127.0.0.1:7793', mode: 'first' });
      await manager.capture({ viewerUrl: 'http://127.0.0.1:7793', mode: 'dungeon' });
      expect(order).toEqual(['connect', 'release', 'connect', 'release', 'connect']);
      expect(fake.goto.mock.calls.map(call => call[0])).toEqual([
        'http://127.0.0.1:7793/third/', 'http://127.0.0.1:7793/', 'http://127.0.0.1:7793/dungeon/']);
    } finally { await manager.stop(); }
    expect(occupied).toBe(false);
  });

  it('closes a failed retained scene so the next capture starts with a new browser', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const failed = fakeBrowser(async () => { throw new Error('WebGL context lost'); });
    const next = fakeBrowser(async () => png);
    const launchBrowser = vi.fn().mockResolvedValueOnce(failed.browser).mockResolvedValueOnce(next.browser);
    const manager = new MinecraftViewCaptureManager({ fetcher: fakeHealth(0, true, { captureSessions: 0, maxCaptureSessions: 1 }), launchBrowser });
    try {
      await expect(manager.capture({ viewerUrl: 'http://127.0.0.1:7793' })).rejects.toMatchObject({ code: 'renderer' });
      expect(failed.close).toHaveBeenCalledOnce();
      expect((await manager.capture({ viewerUrl: 'http://127.0.0.1:7793' })).png).toEqual(png);
    } finally { await manager.stop(); }
    expect(next.close).toHaveBeenCalledOnce();
  });

  it('renews a retained scene beyond one minute and keeps it until shutdown', async () => {
    vi.useFakeTimers();
    const fake = fakeBrowser(async () => Buffer.from('png'));
    const fetcher = fakeHealth(0, true, { captureSessions: 0, maxCaptureSessions: 1 });
    const manager = new MinecraftViewCaptureManager({ fetcher, launchBrowser: async () => fake.browser });
    await manager.capture({ viewerUrl: 'http://127.0.0.1:7793' });
    await vi.advanceTimersByTimeAsync(75_000);
    expect(fake.page.close).not.toHaveBeenCalled();
    expect(vi.mocked(fetcher).mock.calls.filter(call => String(call[0]).endsWith('/capture-lease'))).toHaveLength(6);
    const next = await manager.capture({ viewerUrl: 'http://127.0.0.1:7793' });
    expect(next.timings?.reusedPage).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.close).not.toHaveBeenCalled();
    await manager.stop();
    expect(fake.page.close).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rebuilds a legacy capture page before its fixed server lease expires', async () => {
    vi.useFakeTimers();
    const fake = fakeBrowser(async () => Buffer.from('png'));
    const health = fakeHealth(0, true, { captureSessions: 0, maxCaptureSessions: 1 });
    const fetcher = ((url: string | URL | Request, options?: RequestInit) => String(url).endsWith('/capture-lease')
      ? Promise.resolve(new Response('', { status: 404 })) : health(url, options)) as typeof fetch;
    const manager = new MinecraftViewCaptureManager({ fetcher, launchBrowser: async () => fake.browser });
    try {
      await manager.capture({ viewerUrl: 'http://127.0.0.1:7793' });
      await vi.advanceTimersByTimeAsync(51_000);
      const next = await manager.capture({ viewerUrl: 'http://127.0.0.1:7793' });
      expect(next.timings?.reusedPage).toBe(false);
      expect(fake.page.close).toHaveBeenCalledOnce();
      expect(fake.goto).toHaveBeenCalledTimes(2);
    } finally { await manager.stop(); }
  });

  it('closes a browser that finishes launching after manager shutdown', async () => {
    let releaseBrowser!: (browser: Browser) => void;
    let started!: () => void;
    const launching = new Promise<void>(resolve => { started = resolve; });
    const fake = fakeBrowser(async () => Buffer.from('png'));
    const manager = new MinecraftViewCaptureManager({ fetcher: fakeHealth(0), launchBrowser: () => {
      started();
      return new Promise<Browser>(resolve => { releaseBrowser = resolve; });
    } });
    const pending = manager.capture({ viewerUrl: 'http://127.0.0.1:7793' });
    await launching;
    await manager.stop();
    releaseBrowser(fake.browser);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(fake.close).toHaveBeenCalledOnce();
    expect(fake.browser.newPage).not.toHaveBeenCalled();
  });

  it('shares a background warmup with the first visual request instead of returning busy', async () => {
    let releaseScene!: () => void;
    let started!: () => void;
    const starting = new Promise<void>(resolve => { started = resolve; });
    const scene = new Promise<void>(resolve => { releaseScene = resolve; });
    const fake = fakeBrowser(async () => Buffer.from('png'));
    fake.page.waitForFunction.mockImplementationOnce(async () => {
      started();
      await scene;
      return { jsonValue: async () => 'ready', dispose: async () => undefined };
    });
    const manager = new MinecraftViewCaptureManager({ fetcher: fakeHealth(0, true, { captureSessions: 0, maxCaptureSessions: 1 }),
      launchBrowser: async () => fake.browser });
    try {
      const warming = manager.warm('http://127.0.0.1:7793');
      await starting;
      const capture = manager.capture({ viewerUrl: 'http://127.0.0.1:7793' });
      releaseScene();
      await warming;
      expect((await capture).timings?.reusedPage).toBe(true);
      expect(fake.goto).toHaveBeenCalledOnce();
      expect(fake.page.waitForFunction).toHaveBeenCalledTimes(2);
    } finally { await manager.stop(); }
  });

  it('cancels a visual request waiting for shared warmup without interrupting the warmup', async () => {
    let releaseScene!: () => void;
    let started!: () => void;
    const starting = new Promise<void>(resolve => { started = resolve; });
    const scene = new Promise<void>(resolve => { releaseScene = resolve; });
    const fake = fakeBrowser(async () => Buffer.from('png'));
    fake.page.waitForFunction.mockImplementationOnce(async () => {
      started();
      await scene;
      return { jsonValue: async () => 'ready', dispose: async () => undefined };
    });
    const manager = new MinecraftViewCaptureManager({ fetcher: fakeHealth(0, true, { captureSessions: 0, maxCaptureSessions: 1 }),
      launchBrowser: async () => fake.browser });
    try {
      const warming = manager.warm('http://127.0.0.1:7793');
      await starting;
      const controller = new AbortController();
      const capture = manager.capture({ viewerUrl: 'http://127.0.0.1:7793', signal: controller.signal });
      controller.abort();
      await expect(capture).rejects.toMatchObject({ code: 'cancelled' });
      expect(fake.close).not.toHaveBeenCalled();
      releaseScene();
      await warming;
    } finally { await manager.stop(); }
  });
});

describe('viewer canvas readiness', () => {
  it('waits for meshed chunks and excludes the tactical overlay', () => {
    const attributes = new Map<string, string>();
    const canvas = {
      id: 'scene', width: 1280, height: 720, closest: () => null,
      getBoundingClientRect: () => ({ width: 1280, height: 720 }),
      setAttribute: (key: string, value: string) => attributes.set(key, value),
    };
    const tactical = { ...canvas, id: 'corti-tactical-canvas' };
    const document = {
      querySelector: () => ({ classList: { contains: (name: string) => name === 'is-compact' }, textContent: '' }),
      querySelectorAll: () => [tactical, canvas],
    };
    Object.assign(globalThis, { document, innerWidth: 1280, innerHeight: 720, world: { finishedChunks: {} } });
    expect(viewerCaptureState()).toBe(false);
    Object.assign(globalThis, { world: { finishedChunks: { '0,0': true } } });
    expect(viewerCaptureState()).toBe(false);
    Object.assign(globalThis, { __corticoCapture: { chunks: '0,0', since: performance.now() - 400 } });
    expect(viewerCaptureState()).toBe('ready');
    expect(attributes.get('data-cortico-capture-scene')).toBe('true');
  });

  it('waits for every received chunk and pending mesh section before starting the stable interval', () => {
    const canvas = {
      id: 'scene', width: 1280, height: 720, closest: () => null,
      getBoundingClientRect: () => ({ width: 1280, height: 720 }), setAttribute: () => undefined,
    };
    const document = {
      querySelector: () => ({ classList: { contains: (name: string) => name === 'is-compact' }, textContent: '' }),
      querySelectorAll: () => [canvas],
    };
    const world = {
      loadedChunks: { '0,0': true, '16,0': true },
      finishedChunks: { '0,0': true } as Record<string, boolean>,
      sectionsWaiting: new Map<string, number>(), messageQueue: [] as unknown[],
    };
    Object.assign(globalThis, { document, innerWidth: 1280, innerHeight: 720, world,
      __corticoCapture: { chunks: '0,0', since: performance.now() - 400 } });
    expect(viewerCaptureState()).toBe(false);
    world.finishedChunks['16,0'] = true;
    world.sectionsWaiting.set('16,64,0', 1);
    expect(viewerCaptureState()).toBe(false);
    world.sectionsWaiting.clear();
    world.messageQueue.push({ type: 'load' });
    expect(viewerCaptureState()).toBe(false);
    world.messageQueue.length = 0;
    expect(viewerCaptureState()).toBe(false);
    Object.assign(globalThis, { __corticoCapture: { chunks: '0,0;16,0', since: performance.now() - 400 } });
    expect(viewerCaptureState()).toBe('ready');
    delete world.finishedChunks['0,0'];
    Reflect.deleteProperty(world.loadedChunks, '0,0');
    world.finishedChunks['32,0'] = true;
    Object.assign(world.loadedChunks, { '32,0': true });
    expect(viewerCaptureState()).toBe(false);
  });
});
