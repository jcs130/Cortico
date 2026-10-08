import { createServer, get, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewerSpeechRelay } from '../../../src/worlds/minecraft/viewer-speech.ts';

const JSDOM_MODULE = 'jsdom';
const { JSDOM } = await import(JSDOM_MODULE) as any;
const script = readFileSync(new URL('../../../src/worlds/minecraft/speech-bubble-client.js', import.meta.url), 'utf8');
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('viewer speech source isolation', () => {
  it('relays only the matching bot, preserves SSE replay, and closes subscriptions', async () => {
    const requests: Array<{ sourceId: string; path: string }> = [];
    const origins = [];
    for (const sourceId of ['other-bot', 'own-bot']) {
      origins.push(await listen(createServer((req, res) => {
        const url = new URL(req.url!, 'http://localhost');
        requests.push({ sourceId, path: url.pathname });
        if (url.pathname === '/identity') { res.end(JSON.stringify({ sourceId })); return; }
        if (url.searchParams.get('source') !== sourceId) { res.writeHead(403).end(); return; }
        if (url.pathname === '/stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ sourceId, lastId: req.headers['last-event-id'] })}\n\n`);
          return;
        }
        res.setHeader('content-type', 'text/html');
        res.end(`<div id="bubbles">${sourceId}</div>`);
      })));
    }
    const relay = new ViewerSpeechRelay('own-bot', origins.map(origin => Number(new URL(origin).port)));
    const viewer = await listen(createServer((req, res) => {
      void relay.handle(req, res, new URL(req.url!, 'http://localhost').pathname).then(handled => {
        if (!handled) res.writeHead(404).end();
      });
    }));
    cleanup.push(() => relay.close());
    expect(await (await fetch(viewer + '/speech-source')).json()).toEqual({ available: true, sourceId: 'own-bot' });
    expect(await (await fetch(viewer + '/overlay?source=other-bot')).text()).toContain('own-bot');
    expect(requests.filter(req => req.sourceId === 'other-bot').every(req => req.path === '/identity')).toBe(true);
    await new Promise<void>((resolve, reject) => {
      const req = get(viewer + '/stream', { headers: { 'last-event-id': '17' } }, res => {
        res.once('data', data => {
          expect(String(data)).toContain('"sourceId":"own-bot","lastId":"17"');
          relay.close();
        });
        res.once('close', resolve);
      });
      req.once('error', reject);
    });
    expect(await (await fetch(viewer + '/speech-source')).json()).toMatchObject({ available: false });
  });

  it('keeps captions unavailable when only an unrelated or legacy service exists', async () => {
    const origin = await listen(createServer((req, res) => {
      if (req.url === '/identity') res.end(JSON.stringify({ sourceId: 'other-bot' }));
      else res.end('<div id="bubbles"></div><script src="/overlay/app.js"></script>');
    }));
    const relay = new ViewerSpeechRelay('own-bot', [Number(new URL(origin).port)]);
    cleanup.push(() => relay.close());
    const viewer = await listen(createServer((req, res) => { void relay.handle(req, res, req.url!); }));
    expect(await (await fetch(viewer + '/speech-source')).json()).toMatchObject({ available: false });
    expect((await fetch(viewer + '/overlay')).status).toBe(503);
  });

  it.each(['http://localhost:7793/', 'http://192.0.2.7:7793/dungeon/'])('browser at %s uses only its own origin', async url => {
    vi.useFakeTimers();
    const dom = new JSDOM('<iframe id="corti-speech-bubble" hidden></iframe>', { url, runScripts: 'outside-only' });
    cleanup.push(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); });
    dom.window.AbortSignal.timeout = AbortSignal.timeout;
    dom.window.setInterval = setInterval; dom.window.clearInterval = clearInterval;
    let available = true;
    const calls: string[] = [];
    dom.window.fetch = (async (target: string) => {
      calls.push(target);
      return { ok: true, json: async () => ({ sourceId: 'own-bot', available }) };
    }) as any;
    dom.window.eval(script.replace("'__VIEWER_SPEAKER_NAME__'", JSON.stringify('Display label')));
    await vi.advanceTimersByTimeAsync(0);
    const frame = dom.window.document.querySelector('iframe')!;
    expect(frame.hidden).toBe(false);
    expect(new URL(frame.src).origin).toBe(new URL(url).origin);
    expect(new URL(frame.src).searchParams.get('source')).toBe('own-bot');
    available = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(frame.hidden).toBe(true);
    expect(frame.hasAttribute('src')).toBe(false);
    available = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(frame.hidden).toBe(false);
    expect(calls.every(target => target === '/speech-source')).toBe(true);
  });
});
