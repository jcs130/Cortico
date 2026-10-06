/** 实际引擎入口与生产 proxy 的回执往返；仅将游戏 World 启动和工具替换为离线夹具。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolOutcome } from '../../../src/core/types.ts';
import { MinecraftWorldProxy } from '../../../src/worlds/minecraft/proxy.ts';
import { MINECRAFT_DEFAULTS } from '../../../src/worlds/minecraft/config.ts';
import { FakeHost } from '../../helpers/fake-host.ts';

const fixture = vi.hoisted(() => ({ path: '' }));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    fork: (_entry: string, args: readonly string[], options: import('node:child_process').ForkOptions) =>
      original.fork(fixture.path, args, options),
  };
});
let dir: string | undefined;
let proxy: MinecraftWorldProxy | undefined;
afterEach(async () => {
  await proxy?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  proxy = undefined;
  dir = undefined;
});

describe('Minecraft engine tool outcome IPC', () => {
  it.each([false, true])('retains failed and endsTurn through the actual engine entry (image=%s)', async (withImage) => {
    dir = mkdtempSync(join(tmpdir(), 'mc-outcome-ipc-'));
    fixture.path = join(dir, 'engine-fixture.mjs');
    const worldUrl = new URL('../../../src/worlds/minecraft/world.ts', import.meta.url).href;
    const engineUrl = new URL('../../../src/worlds/minecraft/engine-child.ts', import.meta.url).href;
    writeFileSync(fixture.path, `
      import { MinecraftWorld } from ${JSON.stringify(worldUrl)};
      MinecraftWorld.prototype.start = async function () {};
      MinecraftWorld.prototype.stop = async function () {};
      MinecraftWorld.prototype.console = function () { return { panels: [], storage: [] }; };
      MinecraftWorld.prototype.envPromptRuntimeVars = function () { return {}; };
      MinecraftWorld.prototype.tools = function () {
        return [{ name: 'mc_do', handler: async function (args) {
          return { text: '目标拒收，当前唤醒结束', failed: true, endsTurn: true,
            ...(args.withImage ? { blobs: [{
              bytes: Buffer.from([137, 80, 78, 71, 0, 255]), mime: 'image/png', fallbackText: '现场'
            }] } : {})
          };
        } }];
      };
      await import(${JSON.stringify(engineUrl)});
    `, 'utf8');
    const host = new FakeHost();
    proxy = new MinecraftWorldProxy({ cfg: structuredClone(MINECRAFT_DEFAULTS) });
    await proxy.start(host);
    const tool = proxy.tools().find((candidate) => candidate.name === 'mc_do')!;
    const result = await tool.handler({ withImage }, { role: 'main', log: host.log }) as ToolOutcome;
    expect(result).toMatchObject({ text: '目标拒收，当前唤醒结束', failed: true, endsTurn: true });
    if (!withImage) {
      expect(result.blobs).toBeUndefined();
    } else {
      const image = result.blobs?.[0];
      expect(image && 'bytes' in image && image.bytes).toBeInstanceOf(Uint8Array);
      if (!image || !('bytes' in image)) throw new Error('missing image bytes');
      expect(Buffer.from(image.bytes)).toEqual(Buffer.from([137, 80, 78, 71, 0, 255]));
    }
  }, 20_000);
});
