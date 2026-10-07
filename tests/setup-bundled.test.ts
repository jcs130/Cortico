import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_WORLD_PACKAGES, registerBundledExtensions } from '../scripts/setup-bundled.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'cortico-bundled-'));
  roots.push(root);
  for (const name of BUNDLED_WORLD_PACKAGES) {
    const dir = join(root, 'packages', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, cortico: { kind: 'world' } }));
  }
  return root;
}
describe('bundled extension registration', () => {
  it('creates working extension links on a fresh checkout and is idempotent', () => {
    const root = fixture();
    expect(registerBundledExtensions(root)).toEqual({ changed: true, backup: null });
    for (const name of BUNDLED_WORLD_PACKAGES) {
      expect(realpathSync(join(root, 'extensions', 'node_modules', name))).toBe(realpathSync(join(root, 'packages', name)));
    }
    expect(registerBundledExtensions(root)).toEqual({ changed: false, backup: null });
  });
  it('preserves unrelated extensions and backs up an existing installation before replacing it', () => {
    const root = fixture();
    const ext = join(root, 'extensions');
    mkdirSync(join(ext, 'node_modules', BUNDLED_WORLD_PACKAGES[0]), { recursive: true });
    writeFileSync(join(ext, 'node_modules', BUNDLED_WORLD_PACKAGES[0], 'old.txt'), 'old package');
    const before = JSON.stringify({ name: 'custom', dependencies: { other: '^2', [BUNDLED_WORLD_PACKAGES[0]]: '^1' } });
    writeFileSync(join(ext, 'package.json'), before);
    const result = registerBundledExtensions(root);
    expect(readFileSync(result.backup!, 'utf8')).toBe(before);
    const registry = JSON.parse(readFileSync(join(ext, 'package.json'), 'utf8'));
    expect(registry.name).toBe('custom');
    expect(registry.dependencies.other).toBe('^2');
    expect(registry.dependencies[BUNDLED_WORLD_PACKAGES[0]]).toMatch(/^link:/);
    expect(realpathSync(join(ext, 'node_modules', BUNDLED_WORLD_PACKAGES[0]))).toBe(realpathSync(join(root, 'packages', BUNDLED_WORLD_PACKAGES[0])));
  });
  it('rejects an incomplete checkout before changing the extension registry', () => {
    const root = fixture();
    rmSync(join(root, 'packages', BUNDLED_WORLD_PACKAGES[1], 'package.json'));
    expect(() => registerBundledExtensions(root)).toThrow();
    expect(existsSync(join(root, 'extensions'))).toBe(false);
  });
});
