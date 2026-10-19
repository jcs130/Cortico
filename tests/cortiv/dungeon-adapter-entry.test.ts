import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ADAPTER from '../../packages/cortico-world-dungeon-context/src/index.ts';
import type { WorldContext } from '../../src/world.ts';
import { nullLogger } from '../../src/core/util.ts';
const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it('loads the pinned upstream World offline with its existing tools and registration console intact', async () => {
  vi.stubGlobal('fetch', () => { throw new Error('No network allowed'); });
  vi.stubGlobal('WebSocket', class { constructor() { throw new Error('No connection allowed'); } });
  const dir = mkdtempSync(join(tmpdir(), 'dungeon-entry-')); dirs.push(dir);
  const ctx = { id: 'dungeon', cfg: ADAPTER.defaults(), timezone: 'UTC', botName: 'fixture', botDir: dir,
    packageDir: dir, dataDir: dir, repoRoot: dir, secret: () => 'test-credential-not-persisted', storeSecret: () => {},
    persist: () => {}, restart: async () => {} } as WorldContext<ReturnType<typeof ADAPTER.defaults>>;
  const world = ADAPTER.create(ctx);
  expect(world.id).toBe('dungeon');
  expect(world.tools().map(tool => tool.name)).toContain('dungeon_photo');
  expect(world.tools()).toHaveLength(11);
  expect(world.console!().panels!.map(panel => panel.id)).toContain('register');
  expect(world.requestFacts!()).toBeNull();
  const read = world.tools().find(tool => tool.name === 'dungeon_evidence')!;
  expect(await read.handler({ action: 'read', reference: 'unknown' }, { role: 'main', log: nullLogger() })).toContain('"found":false');
  const root = fileURLToPath(new URL('../../packages/cortico-world-dungeon-context/', import.meta.url));
  execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { windowsHide: true, stdio: 'pipe' });
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  expect(manifest.private).toBe(true); expect(manifest.cortico.api).toBe(5);
  expect(existsSync(join(root, manifest.cortico.consoleClient))).toBe(true);
});
