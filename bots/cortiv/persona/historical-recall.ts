/** Explicit historical reads combine workspace excerpts with a configured game's public memory tool. */
import type { ToolCallContext, ToolDef, ToolOutcome, World } from 'cortico/core/types.ts';

export interface HistoricalRecallConfig {
  enabled: boolean;
  worldId: string;
  toolName: string;
  maxBytes: number;
  timeoutMs: number;
  /** Explicit World-to-workspace-directory entries, one `world=path` per line. */
  workspaceRoots?: string;
}
export const HISTORICAL_RECALL_DEFAULTS: HistoricalRecallConfig = {
  enabled: false, worldId: '', toolName: '', maxBytes: 4_000, timeoutMs: 8_000, workspaceRoots: '',
};
const receipt = (value: string | ToolOutcome) => typeof value === 'string' ? { text: value } : value;

export function historicalRecallTool(base: ToolDef, options: {
  config: () => HistoricalRecallConfig;
  worlds: () => readonly World[];
  search: ToolDef;
}): ToolDef {
  const properties = base.parameters.properties as Record<string, unknown>;
  return { ...base, interruptible: true,
    description: base.description + ' recall(query) searches persistent historical workspace excerpts and, when configured, the game memory service. Use recall when recent evidence misses or when resuming an old activity. History has original speakers and dates; it never proves current state or completion.',
    parameters: { ...base.parameters, properties: { ...properties,
      operation: { type: 'string', enum: ['read', 'history', 'evidence', 'recall', 'set', 'retire'] },
      world: { type: 'string', maxLength: 80, pattern: '^[a-zA-Z0-9_.:-]+$', description: 'recall: restrict workspace roots and external memory to this World. Missing configured roots stay unavailable; other Worlds are not searched as a fallback.' },
      query: { type: 'string', maxLength: 300,
        description: 'evidence: whitespace-separated literal terms must all occur in one of the latest 128 observations. recall: a nonblank topic/question; searches persistent workspace using any literal term and configured game memory using its scoped query. A miss never proves noncompletion.' },
    } },
    handler: async (args, ctx) => {
      if (args.operation !== 'recall') {
        const value = await base.handler(args, ctx);
        if (args.operation !== 'evidence' || args.evidence_id !== undefined || typeof value !== 'string') return value;
        const recent = JSON.parse(value) as { total: number; [key: string]: unknown };
        if (recent.total === 0) return JSON.stringify({ ...recent, recovery: {
          nextRead: typeof args.query === 'string' && args.query.trim() ? { operation: 'recall', query: args.query.trim() } : null,
          ...(typeof args.query === 'string' && args.query.trim() ? {} : { required: 'Choose a specific nonblank historical topic/query for memory_record recall.' }),
          reason: 'Only the bounded recent observation buffer was searched. Persistent history and the configured game memory have not been searched.',
        } });
        return value;
      }
      if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 300
        || args.world !== undefined && (typeof args.world !== 'string' || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(args.world))
        || Object.keys(args).some(key => !['operation', 'query', 'world'].includes(key)))
        return { failed: true, text: 'recall 只接受非空 query（最多300字符）和可选 World id；不传写入、版本或执行参数。' };
      ctx.signal?.throwIfAborted();
      const query = args.query.trim();
      const cfg = { ...HISTORICAL_RECALL_DEFAULTS, ...options.config() };
      const worldId = typeof args.world === 'string' ? args.world : null;
      const roots = (cfg.workspaceRoots ?? '').split('\n').flatMap(line => {
        const at = line.indexOf('=');
        return at > 0 && line.slice(0, at).trim() === worldId && line.slice(at + 1).trim()
          ? [line.slice(at + 1).trim()] : [];
      }).slice(0, 4);
      const signal = AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(cfg.timeoutMs)]);
      const readContext: ToolCallContext = { ...ctx, signal };
      const startedAt = Date.now();
      const sources = await Promise.all([
        read('workspace', async () => {
          if (worldId && !roots.length) return { status: 'unavailable', worldId, text: 'This World has no configured workspace roots. Other Worlds were not searched.' };
          const results = await Promise.all((worldId ? roots : [null]).map(path => options.search.handler({
            pattern: query.split(/\s+/u).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
            ...(path ? { path } : {}), ignore_case: true, head_limit: Math.max(1, Math.floor(6 / (roots.length || 1))), context: 1, history: true,
          }, readContext)));
          return { worldId, roots: worldId ? roots : null, text: results.map(result => receipt(result).text).join('\n') };
        }),
        read('game-memory', async () => {
          if (worldId && worldId !== cfg.worldId) return { status: 'unavailable', worldId, text: 'No external historical read source is configured for this World. Another World was not queried.' };
          if (!cfg.enabled) return { status: 'disabled', worldId: cfg.worldId, text: 'External historical recall is not enabled.' };
          const tool = options.worlds().find(world => world.id === cfg.worldId)?.tools()
            .find(tool => tool.name === cfg.toolName && tool.tags.includes('read'));
          if (!tool) return { status: 'unavailable', worldId: cfg.worldId, tool: cfg.toolName, text: 'Configured read tool is not currently mounted; no connection or fallback World was started.' };
          const result = receipt(await tool.handler({ action: 'service', operation: 'prepare',
            input: { query, max_bytes: cfg.maxBytes } }, readContext));
          return { status: result.failed ? 'failed' : 'read', worldId: cfg.worldId, tool: cfg.toolName, ...result };
        }),
      ]);
      ctx.signal?.throwIfAborted();
      ctx.log.emit('debug', '按需历史回查完成', { event: 'historical-recall', data: {
        elapsedMs: Date.now() - startedAt, queryChars: query.length,
        sources: sources.map(({ source, status, elapsedMs }) => ({ source, status, elapsedMs })),
      } });
      const recent = JSON.parse(await base.handler({ operation: 'evidence', query, ...(worldId ? { limit: 20 } : {}) }, ctx) as string);
      if (worldId) {
        const names = new Set(options.worlds().find(world => world.id === worldId)?.tools().map(tool => `tool/${tool.name}`) ?? []);
        recent.observations = (recent.observations ?? []).filter((row: { source: string }) => row.source.startsWith(worldId + '/') || names.has(row.source));
        recent.total = recent.observations.length; recent.nextOffset = null;
        recent.scope = { ...recent.scope, worldId, boundedPreview: true };
      }
      return JSON.stringify({ historical: true, currentWorldVerified: false, query, worldId,
        recent, sources,
        interpretation: 'Workspace uses literal keywords (any term), game memory uses its own scoped retrieval. Excerpts are historical previews; keep original speaker, time and provenance. Read exact files/artifacts before relying on a truncated excerpt. A miss or unavailable source never proves an activity unfinished. Use current World receipts and versioned work identity for completion.' });

      async function read(source: string, run: () => Promise<string | ToolOutcome | Record<string, unknown>>) {
        const at = Date.now();
        let cancel: (() => void) | undefined;
        try {
          signal.throwIfAborted();
          const cancelled = new Promise<never>((_resolve, reject) => {
            cancel = () => reject(signal.reason);
            signal.addEventListener('abort', cancel, { once: true });
          });
          const value = await Promise.race([run(), cancelled]);
          const result = typeof value === 'string' ? { text: value } : value;
          return { source, status: result.failed ? 'failed' : 'read', ...result, elapsedMs: Date.now() - at };
        } catch (error) {
          return { source, status: 'unavailable', elapsedMs: Date.now() - at,
            text: signal.aborted ? 'Historical read cancelled or timed out; no negative fact established.' : String(error) };
        } finally { if (cancel) signal.removeEventListener('abort', cancel); }
      }
    },
  };
}
