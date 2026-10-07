import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreConfig } from 'cortico/core/types.ts';
import { CORE_DEFAULTS } from 'cortico/core/config.ts';
import { loadDeployment } from 'cortico/deploy.ts';
import { MYMC } from '../src/definition.ts';
import { MYMC_RHYTHM_CONFIG_GROUP, type MymcConfigSection } from '../src/config.ts';

describe('Qiandengji repeat-success configuration', () => {
  it('merges deployed settings into the World config and exposes all four controls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mymc-repeat-config-'));
    try {
      const deployed = { enabled: true, skillsCsv: 'fish', maxSuccesses: 4, windowMinutes: 7 };
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ worlds: { mymc: { repeatSuccessFallback: deployed } } }));
      const loaded = loadDeployment<CoreConfig & { worlds: { mymc: MymcConfigSection } }>({
        defaults: () => ({ ...CORE_DEFAULTS, worlds: { mymc: MYMC.defaults() } }) as CoreConfig & {
          worlds: { mymc: MymcConfigSection };
        },
      }, dir, dir, dir, dir);
      expect(MYMC.defaults().repeatSuccessFallback).toEqual({
        enabled: false, skillsCsv: '', maxSuccesses: 3, windowMinutes: 15,
      });
      expect(loaded.config.worlds.mymc.repeatSuccessFallback).toEqual(deployed);
      expect(Object.keys(MYMC_RHYTHM_CONFIG_GROUP.schema.properties).filter((path) =>
        path.startsWith('worlds.mymc.repeatSuccessFallback.'))).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
