import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityAgenda, AGENDA_FILE, AGENDA_MAX_ITEMS, AGENDA_INTENT_CONTEXT_MAX_CHARS } from '../../bots/cortiv/persona/activity-agenda.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'declared-intent-')); dirs.push(dir);
  const agenda = new ActivityAgenda(dir, () => Date.parse('2026-01-01T00:00:00Z'));
  const start = (id: string, world: string, title: string) => agenda.operate({ operation: 'start', id, title,
    worlds: [world], why: '为自己升级装备，材料是已付款买入的。', doneWhen: '同一角色实际装备后核对数值。',
    references: ['receipt:paid-materials'], expected_revision: agenda.revision() });
  return { dir, agenda, start };
}
it('retains declared purposes and evidence references across World switches and restart without accepting a background proposal', () => {
  const { dir, start } = rig();
  start('own-equipment', 'bazaar', '制作自用长弓');
  start('garden', 'garden', '种花');
  const restored = new ActivityAgenda(dir);
  expect(restored.intentContext()).toContain('制作自用长弓');
  expect(restored.intentContext()).toContain('World=bazaar');
  expect(restored.intentContext()).toContain('已付款买入');
  expect(restored.intentContext()).toContain('receipt:paid-materials');
  expect(restored.state().items.map(x => x.status)).toEqual(['queued', 'active']);
  expect(restored.state().proposal).toBeNull();
});
it('rejects a stale or duplicate declaration and preserves the original purpose', () => {
  const { dir, agenda, start } = rig(); start('own-equipment', 'bazaar', '制作自用长弓');
  const before = readFileSync(join(dir, AGENDA_FILE), 'utf8');
  expect(start('own-equipment', 'bazaar', '赠给卖家')).toContain('已有记录');
  expect(agenda.operate({ operation: 'start', expected_revision: 0, id: 'other', title: '别的用途',
    worlds: ['bazaar'], why: '临时想法', doneWhen: '实际核验' })).toContain('输入错误');
  expect(readFileSync(join(dir, AGENDA_FILE), 'utf8')).toBe(before);
});
it('keeps completion distinct from intent and permits an explicit new gift purpose without banning gifts', () => {
  const { agenda, start } = rig(); start('own-equipment', 'bazaar', '制作自用长弓');
  expect(agenda.state().items[0].status).toBe('active');
  agenda.operate({ operation: 'update', id: 'own-equipment', status: 'cancelled', note: '明确改变用途，保留原采购记录。' });
  start('chosen-gift', 'bazaar', '决定赠送纪念品');
  expect(agenda.intentContext()).not.toContain('制作自用长弓');
  expect(agenda.intentContext()).toContain('决定赠送纪念品');
  expect(agenda.state().items[0].status).toBe('cancelled');
  expect(agenda.state().items[1].status).toBe('active');
});
it('updates evidence references with a revision while retaining the original purpose and dated reference history', () => {
  const { agenda, dir, start } = rig(); start('own-equipment', 'bazaar', '制作自用长弓');
  const stale = agenda.revision() - 1;
  expect(agenda.operate({ operation: 'update', id: 'own-equipment', expected_revision: stale,
    references: ['receipt:new'], note: '刚收到付款回执。' })).toContain('输入错误');
  agenda.operate({ operation: 'update', id: 'own-equipment', expected_revision: agenda.revision(),
    references: ['receipt:new'], note: '新增真实付款回执；自用目标不变。' });
  const restored = new ActivityAgenda(dir);
  expect(restored.intentContext()).toContain('receipt:new');
  expect(restored.intentContext()).toContain('为自己升级装备');
  const read = JSON.parse(restored.operate({ operation: 'read', id: 'own-equipment' }));
  expect(read.items[0].referenceHistory[0].references).toEqual(['receipt:paid-materials']);
});
it('retains goals beyond the reading window without forcing cancellation and keeps the active purpose visible', () => {
  const { agenda, dir, start } = rig();
  for (let index = 0; index < AGENDA_MAX_ITEMS * 3; index++) start('purpose-' + index, 'correspondence', 'Prepare notebook ' + index);
  const restored = new ActivityAgenda(dir);
  expect(restored.state().items).toHaveLength(AGENDA_MAX_ITEMS * 3);
  expect(restored.state().items.filter(item => ['done', 'cancelled'].includes(item.status))).toHaveLength(0);
  expect(restored.intentContext()).toContain('purpose-' + (AGENDA_MAX_ITEMS * 3 - 1));
  expect(restored.intentContext().length).toBeLessThanOrEqual(AGENDA_INTENT_CONTEXT_MAX_CHARS);
  const page = JSON.parse(restored.operate({ operation: 'read' }));
  expect(page.items).toHaveLength(AGENDA_MAX_ITEMS);
  expect(page.page.total).toBe(AGENDA_MAX_ITEMS * 3);
  expect(page.page.nextOffset).toBe(AGENDA_MAX_ITEMS);
  expect(restored.state()).toEqual(agenda.state());
});
