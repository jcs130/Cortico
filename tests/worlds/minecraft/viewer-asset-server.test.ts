import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { serveViewerAsset, viewerByteRange } from '../../../src/worlds/minecraft/viewer-asset-server.ts';

describe('viewer audio byte ranges', () => {
  it('accepts bounded, open and suffix single ranges', () => {
    expect(viewerByteRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(viewerByteRange('bytes=2-', 10)).toEqual({ start: 2, end: 9 });
    expect(viewerByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(viewerByteRange('bytes=2-99', 10)).toEqual({ start: 2, end: 9 });
    for (const invalid of ['bytes=10-', 'bytes=8-2', 'bytes=-0', 'bytes=', 'bytes=0-2,4-6', 'items=1-2'])
      expect(viewerByteRange(invalid, 10)).toBeNull();
    expect(viewerByteRange('bytes=0-', 0)).toBeNull();
  });

  it('serves actual OGG bytes with 200, 206 and 416 and blocks paths outside the asset root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'viewer-audio-range-'));
    const bytes = Buffer.from('0123456789');
    await writeFile(path.join(root, 'sample.ogg'), bytes);
    await writeFile(path.join(root, 'sample.js'), bytes);
    const server = createServer((req, res) => {
      void serveViewerAsset(res, root, req.url!.slice(1), undefined, req.headers.range).then(served => {
        if (!served) { res.writeHead(404); res.end(); }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const full = await fetch(`${origin}/sample.ogg`);
      expect(full.status).toBe(200);
      expect(full.headers.get('accept-ranges')).toBe('bytes');
      expect(full.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
      const partial = await fetch(`${origin}/sample.ogg`, { headers: { Range: 'bytes=3-6' } });
      expect(partial.status).toBe(206);
      expect(partial.headers.get('content-range')).toBe('bytes 3-6/10');
      expect(partial.headers.get('content-length')).toBe('4');
      expect(await partial.text()).toBe('3456');
      const invalid = await fetch(`${origin}/sample.ogg`, { headers: { Range: 'bytes=20-' } });
      expect(invalid.status).toBe(416);
      expect(invalid.headers.get('content-range')).toBe('bytes */10');
      expect(await invalid.text()).toBe('');
      const nonAudio = await fetch(`${origin}/sample.js`, { headers: { Range: 'bytes=2-3' } });
      expect(nonAudio.status).toBe(200);
      expect(await nonAudio.text()).toBe(bytes.toString());
      expect(await serveViewerAsset({} as never, root, '../outside.ogg')).toBe(false);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
