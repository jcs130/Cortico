import type { WorldDefinition } from 'cortico/world.ts';
import { MYMC_DEFAULTS, type MymcConfigSection } from './config.ts';
import { assertMymcReady } from './guard.ts';
import { MymcWorld } from './world.ts';

export const MYMC: WorldDefinition<MymcConfigSection> = {
  id: 'mymc',
  label: '千灯纪',
  defaults: () => structuredClone(MYMC_DEFAULTS),
  preflight: (ctx) => assertMymcReady(ctx.cfg, ctx.botDir),
  create: (ctx) => new MymcWorld({
    cfg: ctx.cfg,
    botDir: ctx.botDir,
    timezone: ctx.timezone,
    botName: ctx.botName,
    dataDir: ctx.dataDir,
  }),
};
