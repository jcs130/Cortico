import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogBlobStore } from '../../../src/core/blobs.ts';
import type { ToolOutcome } from '../../../src/core/types.ts';
import { MinecraftWorldProxy } from '../../../src/worlds/minecraft/proxy.ts';
import { MINECRAFT_DEFAULTS, type MinecraftConfigSection } from '../../../src/worlds/minecraft/config.ts';
import { FakeHost } from '../../helpers/fake-host.ts';

const fixture = vi.hoisted(() => ({ path: '' }));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, fork: (_entry: string, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    original.fork(fixture.path, args, options) };
});

let dir: string | undefined;
let proxy: MinecraftWorldProxy | undefined;
afterEach(async () => {
  await proxy?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  proxy = undefined;
  dir = undefined;
});

describe('MinecraftWorldProxy screenshot IPC', () => {
  it('retains binary image bytes across the real process boundary and Core blob storage', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mc-visual-ipc-'));
    fixture.path = join(dir, 'engine.mjs');
    // This engine fixture receives the production proxy fork options and responds over Node IPC.
    writeFileSync(fixture.path, `
      process.on('message', message => {
        if (message.t !== 'req') return;
        let value;
        if (message.req.kind === 'tool') {
          value = { text: 'scene observation', blobs: [{
            bytes: Buffer.from([137, 80, 78, 71, 0, 255, 13, 10]),
            mime: 'image/png', fallbackText: 'third-person scene'
          }] };
        }
        process.send({ t: 'rep', id: message.id, ok: true, value });
        if (message.req.kind === 'shutdown') setImmediate(() => process.exit(0));
      });
    `, 'utf8');
    const cfg = structuredClone(MINECRAFT_DEFAULTS) as MinecraftConfigSection;
    const host = new FakeHost();
    proxy = new MinecraftWorldProxy({ cfg });
    await proxy.start(host);
    const tool = proxy.tools().find(item => item.name === 'mc_visual')!;
    const result = await tool.handler({}, { role: 'main', log: host.log }) as ToolOutcome;
    const image = result.blobs?.[0];
    expect(image && 'bytes' in image && image.bytes).toBeInstanceOf(Uint8Array);
    if (!image || !('bytes' in image)) throw new Error('missing screenshot bytes');
    const expected = Buffer.from([137, 80, 78, 71, 0, 255, 13, 10]);
    expect(Buffer.from(image.bytes)).toEqual(expected);
    const store = new LogBlobStore(dir);
    const handle = store.put(image.bytes, image.mime);
    expect(store.read(handle)).toEqual({ bytes: expected, mime: 'image/png' });
  });
});
