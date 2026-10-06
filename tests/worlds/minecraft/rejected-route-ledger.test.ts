import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { RejectedRouteLedger } from '../../../src/worlds/minecraft/rejected-route-ledger.ts';
import type { SkillCall } from '../../../src/worlds/minecraft/executor.ts';

const file = join(tmpdir(), `cortico-rejected-route-${randomUUID()}.json`);
afterEach(() => { if (existsSync(file)) unlinkSync(file); });

it('水层失败记录跨 World 重载，拦住原单和邻近同一竖井', () => {
  const now = 1_000_000;
  const old = [
    { skill: 'goto', at: [-534, 60, -418] },
    { skill: 'tunnel', at: ['~', '~-10', '~'] },
  ] as SkillCall[];
  new RejectedRouteLedger(file, now).record('shaft-liquid:-534:56:-419:水', old, now);
  const reloaded = new RejectedRouteLedger(file, now + 1);
  expect(reloaded.match(old, now + 1)).toContain('shaft-liquid');
  expect(reloaded.match([
    { skill: 'goto', at: [-535, 60, -420] },
    { skill: 'tunnel', at: ['~', '~-10', '~'] },
  ] as SkillCall[], now + 1)).toContain('shaft-liquid');
  expect(reloaded.match([
    { skill: 'goto', at: [-525, 60, -420] },
    { skill: 'tunnel', at: ['~', '~-10', '~'] },
  ] as SkillCall[], now + 1)).toBeNull();
  expect(reloaded.match(old, now + 16 * 60_000)).toBeNull();
});
