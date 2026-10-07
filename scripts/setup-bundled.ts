/** Register and build the World packages shipped in this checkout. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BUNDLED_WORLD_PACKAGES = ['cortico-world-qiandengji', 'cortico-world-vtuber'] as const;

/** Existing extensions and local configuration remain in the extension registry. */
export function registerBundledExtensions(root: string): { changed: boolean; backup: string | null } {
  const registryDir = join(root, 'extensions');
  const registryFile = join(registryDir, 'package.json');
  const before = existsSync(registryFile) ? readFileSync(registryFile, 'utf8') : null;
  const registry = before ? JSON.parse(before) : { name: 'cortico-extensions', private: true, type: 'module' };
  const targets = BUNDLED_WORLD_PACKAGES.map((name) => {
    const target = join(root, 'packages', name);
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    if (pkg.name !== name || pkg.cortico?.kind !== 'world') throw new Error(`Invalid bundled World: ${name}`);
    return { name, target, link: join(registryDir, 'node_modules', name) };
  });
  registry.dependencies = { ...registry.dependencies };
  let changed = false;
  for (const { name, target, link } of targets) {
    const spec = `link:../packages/${name}`;
    if (registry.dependencies[name] !== spec) changed = true;
    registry.dependencies[name] = spec;
    try { if (realpathSync(link) !== realpathSync(target)) changed = true; }
    catch { changed = true; }
  }
  if (!changed) return { changed: false, backup: null };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = before === null ? null : `${registryFile}.before-bundled-${stamp}`;
  mkdirSync(join(registryDir, 'node_modules'), { recursive: true });
  if (backup) writeFileSync(backup, before!, 'utf8');
  const touched: Array<{ link: string; previous: string | null }> = [];
  try {
    for (const { target, link } of targets) {
      try { if (realpathSync(link) === realpathSync(target)) continue; } catch { /* missing or broken link */ }
      const previous = (() => { try { lstatSync(link); return `${link}.before-bundled-${stamp}`; } catch { return null; } })();
      if (previous) renameSync(link, previous);
      touched.push({ link, previous });
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    }
    const temporary = `${registryFile}.bundled-next`;
    writeFileSync(temporary, JSON.stringify(registry, null, 2) + '\n', 'utf8');
    renameSync(temporary, registryFile);
  } catch (error) {
    for (const { link, previous } of touched.reverse()) {
      // These paths are the two links created above, never their target directories.
      try { if (lstatSync(link).isSymbolicLink()) rmSync(link); } catch { /* no link created */ }
      if (previous) renameSync(previous, link);
    }
    throw error;
  }
  return { changed: true, backup };
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw new Error('Run this command with pnpm setup:bundled.');
  // The renderer pins a newer Three.js than the legacy host package.
  const renderer = join(root, 'packages', 'mc-visual-console', 'packages', 'modern-viewer', 'renderer-src');
  const lockHash = createHash('sha256').update(readFileSync(join(renderer, 'package-lock.json'))).digest('hex');
  const marker = join(renderer, 'node_modules', '.cortico-lock.sha256');
  if (!existsSync(marker) || readFileSync(marker, 'utf8') !== lockHash) {
    const result = spawnSync(process.execPath,
      [pnpm, 'exec', 'npm', 'ci', '--prefix', renderer, '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Renderer dependency installation failed.');
    writeFileSync(marker, lockHash, 'utf8');
  }
  for (const name of BUNDLED_WORLD_PACKAGES) {
    const result = spawnSync(process.execPath, [pnpm, '--dir', join(root, 'packages', name), 'run', 'build'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Build failed: ${name}`);
  }
  const result = registerBundledExtensions(root);
  console.log(result.changed ? 'Bundled Worlds registered.' : 'Bundled Worlds already registered.');
  if (result.backup) console.log(`Previous extension registry: ${result.backup}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
