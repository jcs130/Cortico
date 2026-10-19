import { createHash } from 'node:crypto';
import { join } from 'node:path';
import DUNGEON, { DUNGEON_CREDENTIAL_SECRET } from 'cortico-world-dungeon';
import { withDungeonContext } from './context.ts';

/** Explicit private API 5 consumer. The original World still owns authentication, tools and events. */
export default { ...DUNGEON, create: (ctx: Parameters<typeof DUNGEON.create>[0]) => withDungeonContext(DUNGEON.create(ctx), {
  dataDir: ctx.dataDir ? join(ctx.dataDir, 'dungeon-observations') : '',
  scope: () => { const credential = ctx.secret(DUNGEON_CREDENTIAL_SECRET); return credential
    ? createHash('sha256').update(ctx.cfg.serverUrl).update('\0').update(credential).digest('hex') : null; },
}) };
export { withDungeonContext, DungeonObservations } from './context.ts';
