import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { World, WorldHost } from '../../src/core/types.ts';
import { nullLogger } from '../../src/core/util.ts';
import { message, functionCall, functionResult, itemText, type ContextRecord } from '../../src/protocol/open-responses/context.ts';
import { validatePairing } from '../../src/core/truncate.ts';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { FOREGROUND_CONTEXT_DEFAULTS } from '../../bots/cortiv/persona/foreground-context.ts';
import { withDungeonContext } from '../../packages/cortico-world-dungeon-context/src/context.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';
const clean: Array<() => void> = [];
afterEach(() => { for (const fn of clean.splice(0)) fn(); });
it('replays paid materials, sales and crafting while a small foreground window retains the declared purpose and original evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'world-continuity-'));
  const original: World = { id: 'dungeon', envPromptVars: () => ({}), start: async () => {}, stop: async () => {},
    tools: () => ['dungeon_trade', 'dungeon_life'].map(name => ({ name, description: 'fixture', tags: ['act'], parameters: {},
      handler: async args => ({ text: String(args.fixtureReceipt) }) })) };
  const world = withDungeonContext(original, { dataDir: join(dir, 'world-data'), scope: () => 'test-character' });
  await world.start({} as WorldHost);
  const config = { ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true, maxHistoryTokens: 1024, minRecentRounds: 1 };
  const persona = new CortiV({ memoryDir: dir, worlds: [world], foreground: () => config });
  const core = makeFakeHarnessApi(); persona.attach(core);
  clean.push(() => { persona.stopRhythm(); rmSync(dir, { recursive: true, force: true }); });
  const plan = persona.declareSessions().find(x => x.id === 'main')!.tools().find(x => x.name === 'activity_plan')!;
  const ctx = { role: 'main', log: nullLogger() };
  const read = JSON.parse(await plan.handler({ operation: 'read' }, ctx) as string);
  await plan.handler({ operation: 'start', expected_revision: read.revision, id: 'own-bow', title: '制作并装备自己的二阶弓',
    why: '提高自己的战斗能力；未确认代工或赠送约定。', worlds: ['dungeon'],
    doneWhen: '自己的角色装备新弓后核对数值。', references: ['receipt:paid-wood'] }, ctx);
  const paid = '交易已成交：向卖家支付16金币，得到紫杉木4根。';
  await world.tools()[0].handler({ action: 'accept', fixtureReceipt: paid }, { ...ctx, callId: 'paid-wood' });
  for (const [id, text] of [['sell-shell', '出售甲壳，金币29。'], ['sell-skin', '出售兽皮，金币41。'],
    ['sell-potion', '出售药剂，金币47。'], ['make-bow', '制作费36，得到新长弓。建议：交给委托人，或自行装备。']])
    await world.tools()[1].handler({ action: id === 'make-bow' ? 'craft' : 'sell', fixtureReceipt: text }, { ...ctx, callId: id });
  const records: ContextRecord[] = [message('system', 'Stable personality and tools contract.'),
    functionCall('paid-wood', 'dungeon_trade', '{"action":"accept"}', { responseId: 'old-response' }),
    functionResult('paid-wood', paid),
    message('user', '另一个 World 出现新交流。', { frame: { events: [{ source: 'garden', type: 'garden.chat', cursor: 9,
      ts: '2026-01-01T00:00:00Z', start: 0, chars: '另一个 World 出现新交流。'.length }] } })];
  for (let i = 0; i < 12; i++) records.push(message('assistant', '无关旧记录。'.repeat(600), { responseId: 'noise-' + i }));
  records.push(message('user', '继续。', { frame: { events: [{ source: 'garden', type: 'garden.chat', cursor: 10,
    ts: '2026-01-01T00:01:00Z', start: 0, chars: '继续。'.length }] } }));
  const before = structuredClone(records);
  const view = persona.prepareRequest({ sessionId: 'main', round: 1, messages: records })!;
  const text = view.map(row => itemText(row.item)).join('\n');
  expect(text).toContain('制作并装备自己的二阶弓');
  expect(text).toContain('未确认代工或赠送约定');
  expect(text).toContain('向卖家支付16金币');
  expect(text).toContain('dungeon_evidence');
  expect(view.some(row => row.item.type === 'function_call' && row.item.call_id === 'paid-wood')).toBe(false);
  expect(validatePairing(view)).toEqual([]);
  expect(records).toEqual(before);
  config.enabled = false;
  const full = persona.prepareRequest({ sessionId: 'main', round: 2, messages: records })!;
  expect(full.map(row => itemText(row.item)).join('\n')).toContain('自己的角色装备新弓');
  expect(view[0]).toEqual(records[0]);
});
