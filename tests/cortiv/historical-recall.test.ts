import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { HISTORICAL_RECALL_DEFAULTS } from '../../bots/cortiv/persona/historical-recall.ts';
import { makeFakeHarnessApi, makeFakeIO } from '../core/helpers.ts';
import { nullLogger } from '../../src/core/util.ts';
import type { ToolCallContext } from '../../src/core/types.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'historical-recall-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const world = makeFakeIO('game');
  const calls: { args: Record<string, unknown>; ctx: ToolCallContext }[] = [];
  let remote = async () => ({ text: JSON.stringify({ historical: true, currentWorldVerified: false,
    result: { source: 'memory-source-7', observedAt: '2026-10-01T10:00:00Z', text: 'A companion reported the orchard work complete.' } }) });
  world.tools = () => [{ name: 'game_memory', tags: ['read', 'write'], description: 'Public game memory', parameters: {},
    handler: async (args, ctx) => { calls.push({ args, ctx }); return remote(); } }];
  const cfg = { ...HISTORICAL_RECALL_DEFAULTS, enabled: true, worldId: 'game', toolName: 'game_memory' };
  const persona = new CortiV({ memoryDir: dir, worlds: [world], historicalRecall: () => cfg });
  persona.attach(makeFakeHarnessApi()); cleanup.push(() => persona.stopRhythm());
  persona.memory.writeFileAtomic('sessions/old-orchard.md', '[2026-10-01] Player Jojo: I finished the orchard.\nThis is their account, not my action.');
  const tool = persona.declareSessions().find(s => s.id === 'main')!.tools().find(t => t.name === 'memory_record')!;
  const invoke = (args: Record<string, unknown>, signal?: AbortSignal) => tool.handler(args, { role: 'main', log: nullLogger(), signal });
  return { persona, invoke, calls, cfg, remote: (value: typeof remote) => { remote = value; } };
}
describe('historical recall through the public game memory read contract', () => {
  it('recent misses point to recall; explicit recall retrieves durable lines and original game provenance without writing', async () => {
    const r = rig();
    const missed = JSON.parse(await r.invoke({ operation: 'evidence', query: 'orchard' }) as string);
    expect(missed.scope.retained).toBe(0);
    expect(missed.recovery.nextRead).toEqual({ operation: 'recall', query: 'orchard' });
    expect(r.calls).toEqual([]);
    const result = JSON.parse(await r.invoke({ operation: 'recall', query: 'orchard' }) as string);
    expect(result).toMatchObject({ historical: true, currentWorldVerified: false });
    expect(result.sources[0].text).toContain('sessions/old-orchard.md:1:');
    expect(result.sources[0].text).toContain('Player Jojo: I finished');
    expect(result.sources[1].text).toContain('memory-source-7');
    expect(result.sources[1].text).toContain('2026-10-01');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].args).toEqual({ action: 'service', operation: 'prepare', input: { query: 'orchard', max_bytes: 4000 } });
    expect(r.calls[0].ctx.role).toBe('main');
    expect(existsSync(r.persona.memory.resolveSafe('.state-memory.json'))).toBe(false);
  });
  it('missing or disabled configured worlds do not silently choose a different source', async () => {
    const r = rig(); r.cfg.worldId = 'other';
    let result = JSON.parse(await r.invoke({ operation: 'recall', query: 'orchard' }) as string);
    expect(result.sources[1].status).toBe('unavailable');
    r.cfg.enabled = false;
    result = JSON.parse(await r.invoke({ operation: 'recall', query: 'orchard' }) as string);
    expect(result.sources[1].status).toBe('disabled');
    expect(result.sources[0].text).toContain('Player Jojo');
    expect(r.calls).toEqual([]);
  });
  it('a slow remote read returns available local history at the deadline and aborts its request', async () => {
    const r = rig(); r.cfg.timeoutMs = 20;
    r.remote(() => new Promise(() => {}));
    const result = JSON.parse(await r.invoke({ operation: 'recall', query: 'orchard' }) as string);
    expect(result.sources[0].text).toContain('Player Jojo');
    expect(result.sources[1].status).toBe('unavailable');
    expect(r.calls[0].ctx.signal!.aborted).toBe(true);
  });
  it('rejects write arguments and respects caller cancellation without treating it as an empty search', async () => {
    const r = rig();
    const empty = JSON.parse(await r.invoke({ operation: 'evidence' }) as string);
    expect(empty.recovery.nextRead).toBeNull();
    expect(empty.recovery.required).toContain('nonblank');
    expect(await r.invoke({ operation: 'recall', query: 'orchard', requestId: 'write' })).toHaveProperty('failed');
    const controller = new AbortController(); controller.abort(new Error('caller cancelled'));
    await expect(r.invoke({ operation: 'recall', query: 'orchard' }, controller.signal)).rejects.toThrow('caller cancelled');
    expect(r.calls).toEqual([]);
  });
});
