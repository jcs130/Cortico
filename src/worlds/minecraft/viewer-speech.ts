/** Same-origin captions relayed from the matching bot's local performance service. */
import { request, type IncomingMessage, type ServerResponse } from 'node:http';

const ROUTES = new Set(['/speech-source', '/overlay', '/overlay/app.js', '/overlay/styles.css', '/stream']);
const PORTS = [7792, 7793, 7794, 7795, 7796];

export class ViewerSpeechRelay {
  private port: number | null = null;
  private checkedAt = 0;
  private lookup: Promise<number | null> | null = null;
  private closed = false;
  private readonly requests = new Set<AbortController>();

  constructor(private readonly sourceId: string, private readonly ports: readonly number[] = PORTS) {}

  private async resolve(): Promise<number | null> {
    if (this.closed) return null;
    if (Date.now() - this.checkedAt < 1000) return this.port;
    if (this.lookup) return this.lookup;
    this.lookup = (async () => {
      for (const port of this.ports) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/identity`, {
            signal: AbortSignal.timeout(1000), redirect: 'error',
          });
          if (response.ok && (await response.json() as { sourceId?: unknown }).sourceId === this.sourceId) return port;
        } catch { /* Unavailable or another local service. */ }
      }
      return null;
    })();
    try {
      this.port = await this.lookup;
      this.checkedAt = Date.now();
      return this.closed ? null : this.port;
    } finally { this.lookup = null; }
  }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (!ROUTES.has(pathname)) return false;
    const port = await this.resolve();
    if (pathname === '/speech-source') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ available: port !== null, sourceId: this.sourceId }));
      return true;
    }
    if (port === null) { res.writeHead(503, { 'cache-control': 'no-store' }).end(); return true; }
    const target = new URL(req.url ?? pathname, `http://127.0.0.1:${port}`);
    target.searchParams.set('source', this.sourceId);
    const controller = new AbortController();
    this.requests.add(controller);
    res.once('close', () => { controller.abort(); this.requests.delete(controller); });
    const upstream = request({ hostname: '127.0.0.1', port,
      path: target.pathname + target.search, signal: controller.signal,
      headers: req.headers['last-event-id'] ? { 'last-event-id': req.headers['last-event-id'] } : {},
    }, response => {
      res.writeHead(response.statusCode ?? 502, {
        'content-type': response.headers['content-type'] ?? 'text/plain',
        'cache-control': 'no-cache, no-store, no-transform',
        ...(pathname === '/stream' ? { 'x-accel-buffering': 'no' } : {}),
      });
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.on('error', () => {
      this.port = null; this.checkedAt = 0;
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.end();
    return true;
  }

  close(): void {
    this.closed = true;
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
  }
}
