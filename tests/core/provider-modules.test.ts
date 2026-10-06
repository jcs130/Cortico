import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BaseProvider, type ProviderHost, type ProviderModule } from '../../src/providers/base.ts';
import { discoverProviderModules, ProviderRegistry, providerModules } from '../../src/providers/registry.ts';
import { nullLogger } from '../../src/core/util.ts';

describe('Provider module discovery', () => {
  it('loads each native implementation through the common base and isolates deployment instances', () => {
    const root = join(import.meta.dirname, '../../src/providers');
    const nativeIds = readdirSync(root, { withFileTypes: true })
      .filter(dir => dir.isDirectory() && existsSync(join(root, dir.name, 'index.ts')))
      .map(dir => dir.name).sort();
    expect(nativeIds.length).toBeGreaterThan(0);
    expect(providerModules.map(module => module.id).sort()).toEqual(nativeIds);
    const entries = Object.fromEntries(providerModules.flatMap(module => [
      [`${module.id}-first`, { kind: module.id, baseUrl: 'https://one.test' }],
      [`${module.id}-second`, { kind: module.id, baseUrl: 'https://two.test' }],
    ]));
    const registry = new ProviderRegistry(() => entries, {
      stateRoot: join(tmpdir(), 'unused-provider-state'), readBlob: () => null,
      keepThinking: () => true, log: nullLogger(),
    });
    for (const module of providerModules) {
      const first = registry.resolve(`${module.id}-first`);
      const second = registry.resolve(`${module.id}-second`);
      expect(first.client).toBeInstanceOf(BaseProvider);
      expect(second.client).toBeInstanceOf(BaseProvider);
      expect(registry.resolve(`${module.id}-first`)).toBe(first);
      expect(first).not.toBe(second);
      expect(first.client).not.toBe(second.client);
    }
    expect(() => registry.resolve('missing')).toThrow('没有这个 LLM provider');
  });

  it('discovers an added module by directory and rejects a mismatched namespace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortico-provider-discovery-'));
    try {
      mkdirSync(join(root, 'fixture'));
      writeFileSync(join(root, 'fixture', 'index.ts'), 'export default { id: "fixture", title: "Fixture", reasoningTiers: [], serviceTiers: [] };');
      expect((await discoverProviderModules(root)).map(module => module.id)).toEqual(['fixture']);
      mkdirSync(join(root, 'invalid'));
      writeFileSync(join(root, 'invalid', 'index.ts'), 'export default { id: "different" };');
      await expect(discoverProviderModules(root)).rejects.toThrow('must match directory');
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('端点拿到自己的目录,密钥链是 进程环境 > 端点 .env', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'cortico-provider-state-'));
    try {
      mkdirSync(join(stateRoot, 'cloud'));
      writeFileSync(join(stateRoot, 'cloud', '.env'), 'SHARED=from-endpoint\nONLY_HERE=yes\n');
      let seen: ProviderHost | null = null;
      const module: ProviderModule = {
        id: 'probe', title: 'Probe', reasoningTiers: [], serviceTiers: [],
        create: (_name, _entry, host) => { seen = host; return { client: null as never }; },
      };
      new ProviderRegistry(
        () => ({ cloud: { kind: 'probe', baseUrl: 'https://probe.test' } }),
        { stateRoot, readBlob: () => null, keepThinking: () => true, log: nullLogger() },
        [module],
      ).resolve('cloud');

      const host = seen as unknown as ProviderHost;
      expect(host.stateDir).toBe(join(stateRoot, 'cloud'));
      expect(host.secret('ONLY_HERE')).toBe('yes');
      expect(host.secret('SHARED')).toBe('from-endpoint');
      expect(host.secret('MODULE_KEY')).toBe('');
      process.env.SHARED = 'from-process';
      try {
        expect(host.secret('SHARED')).toBe('from-process');
      } finally {
        delete process.env.SHARED;
      }
    } finally {
      rmSync(stateRoot, { recursive: true });
    }
  });
});
