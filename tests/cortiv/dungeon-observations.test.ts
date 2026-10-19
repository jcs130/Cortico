import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext, ToolDef, ToolOutcome, World, WorldHost } from '../../src/core/types.ts';
import { nullLogger } from '../../src/core/util.ts';
import { DungeonObservations, withDungeonContext } from '../../packages/cortico-world-dungeon-context/src/context.ts';
const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'dungeon-observations-')); dirs.push(dir);
  let now = Date.parse('2026-01-01T06:01:00Z'), scope = 'account-a';
  const opts = { dataDir: dir, scope: () => scope, now: () => now };
  const cache = new DungeonObservations(opts); cache.start();
  const call = (id: string): ToolCallContext => ({ role: 'main', log: nullLogger(), callId: id });
  const record = (tool: string, args: Record<string, unknown>, text: string, id: string, failed = false) => {
    const ticket = cache.begin(tool, args);
    cache.record(ticket, tool, args, { text, ...(failed ? { failed: true as const } : {}) }, call(id));
  };
  return { cache, opts, call, record, advance: () => { now += 61_000; }, switchScope: () => { scope = 'account-b'; } };
}
it('retains paid purchase evidence without inferring a commission, and invalidates old balances on an action', () => {
  const { cache, record } = rig();
  record('dungeon_look', { action: 'status' }, '金币 33，职业工匠', 'status-before');
  record('dungeon_trade', { action: 'accept', offer: '#offer-a' }, '实际交割：付出16金币，得到紫杉木4根。', 'wood-paid');
  expect(cache.facts()!.parts!.find(x => x.key === 'state/status')!.text).toBe('');
  expect(cache.facts()!.text).toContain('付出16金币');
  expect(cache.facts()!.text).not.toContain('金币 33');
  const raw = JSON.parse(cache.evidence({ action: 'read', reference: 'wood-paid', limit: 8000 }));
  expect(JSON.parse(raw.text)).toMatchObject({ args: { action: 'accept', offer: '#offer-a' }, outcome: { text: '实际交割：付出16金币，得到紫杉木4根。' } });
  record('dungeon_life', { action: 'craft', recipe: 'bow' }, '余额不足，未制作。', 'craft-denied', true);
  expect(cache.facts()!.text).toContain('余额不足，未制作');
  record('dungeon_look', { action: 'inventory' }, '金币17，紫杉木4根。', 'inventory-now');
  expect(cache.facts()!.text).toContain('金币17');
});
it('archives a delayed read but cannot use it to resurrect state across a mutation or stop', () => {
  const { cache, call } = rig();
  const read = cache.begin('dungeon_look', { action: 'status' });
  const write = cache.begin('dungeon_trade', { action: 'give', confirm: true });
  cache.record(write, 'dungeon_trade', { action: 'give', confirm: true }, '已交割。', call('transfer'));
  cache.record(read, 'dungeon_look', { action: 'status' }, '旧余额90', call('late-status'));
  expect(cache.facts()!.text).not.toContain('旧余额90');
  expect(cache.evidence({ action: 'read', reference: 'late-status' })).toContain('旧余额90');
  const next = cache.begin('dungeon_look', { action: 'inventory' });
  cache.stop(); cache.record(next, 'dungeon_look', { action: 'inventory' }, '已停止后的晚到读数', call('stopped-read'));
  expect(cache.facts()).toBeNull();
  cache.start(); expect(cache.facts()!.text).not.toContain('已停止后的晚到读数');
});
it('expires observations, invalidates on resource events and preserves original archives across restart within the same scope', () => {
  const { cache, record, advance, opts, switchScope } = rig();
  record('dungeon_look', { action: 'status' }, '金币17', 'snapshot');
  advance(); expect(cache.facts()!.text).not.toContain('金币17');
  record('dungeon_look', { action: 'status' }, '金币18', 'fresh');
  cache.event('dungeon.trade'); expect(cache.facts()!.text).not.toContain('金币18');
  const restored = new DungeonObservations(opts); restored.start();
  expect(restored.facts()!.text).not.toContain('金币17');
  expect(restored.evidence({ action: 'read', reference: 'snapshot' })).toContain('金币17');
  switchScope(); expect(restored.evidence({ action: 'read', reference: 'snapshot' })).toContain('"found":false');
});
it('does not copy binary attachments into the receipt archive or truncate the original text', () => {
  const { cache, call } = rig();
  const text = '原始观察。'.repeat(3000);
  const args = { action: 'capture' }, ticket = cache.begin('dungeon_photo', args);
  cache.record(ticket, 'dungeon_photo', args, { text, blobs: [{ bytes: new Uint8Array([1, 2]), mime: 'image/png' }] } as ToolOutcome, call('photo'));
  let offset = 0, original = '';
  for (;;) {
    const result = JSON.parse(cache.evidence({ action: 'read', reference: 'photo', offset, limit: 8000 }));
    original += result.text; if (result.nextOffset === null) break; offset = result.nextOffset;
  }
  expect(JSON.parse(original).outcome.text).toBe(text);
  expect(JSON.parse(original).outcome.blobs).toBeUndefined();
});
it('cannot attribute a late receipt from a previous account to a new account', () => {
  const { cache, call, switchScope } = rig();
  const ticket = cache.begin('dungeon_look', { action: 'status' });
  switchScope();
  cache.record(ticket, 'dungeon_look', { action: 'status' }, '前一个账号的资产', call('account-a-read'));
  expect(cache.facts()!.text).not.toContain('前一个账号的资产');
  expect(cache.evidence({ action: 'list' })).not.toContain('account-a-read');
  expect(cache.evidence({ action: 'read', reference: 'account-a-read' })).toContain('"found":false');
});
it('delegates execution and events while cached facts and local archive reads make no network calls', async () => {
  const { opts } = rig();
  vi.stubGlobal('fetch', () => { throw new Error('Unexpected network call'); });
  let host: WorldHost | undefined, stopped = false;
  const tool: ToolDef = { name: 'dungeon_look', description: 'fixture', tags: ['read'], parameters: {}, handler: async () => '角色已读' };
  const original: World = { id: 'dungeon', envPromptVars: () => ({}), tools: () => [tool],
    start: async value => { host = value; }, stop: async () => { stopped = true; } };
  const wrapped = withDungeonContext(original, opts);
  const events: string[] = [];
  await wrapped.start({ pushEvent: async event => { events.push(event.text); return event; } } as WorldHost);
  const call = { role: 'main', log: nullLogger(), callId: 'observed' };
  await wrapped.tools()[0].handler({ action: 'status' }, call);
  for (let i = 0; i < 3; i++) expect(wrapped.requestFacts!()!.text).toContain('角色已读');
  const archive = wrapped.tools().find(x => x.name === 'dungeon_evidence')!;
  expect(await archive.handler({ action: 'read', reference: 'observed' }, call)).toContain('角色已读');
  await host!.pushEvent({ source: 'dungeon', type: 'dungeon.trade', text: '外部资源变动', ts: '2026-01-01', senderKey: 'dungeon' });
  expect(events).toEqual(['外部资源变动']);
  expect(wrapped.requestFacts!()!.text).not.toContain('角色已读');
  await wrapped.stop(); expect(stopped).toBe(true); expect(wrapped.requestFacts!()).toBeNull();
});
