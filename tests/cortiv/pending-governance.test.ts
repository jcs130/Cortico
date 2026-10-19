import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PendingWork, type PendingIntent } from '../../bots/cortiv/persona/pending-work.ts';
import { ActivityAgenda } from '../../bots/cortiv/persona/activity-agenda.ts';
import { TimerStore } from '../../src/core/timers.ts';
import { nullLogger } from '../../src/core/util.ts';
import type { CoreApi } from '../../src/core/types.ts';

const cleanups: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T10:00:00Z')); });
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.useRealTimers(); });
function rig(legacy?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'pending-governance-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'pending-work.json');
  if (legacy) writeFileSync(file, JSON.stringify(legacy));
  const timers = new TimerStore(join(dir, 'runtime')); cleanups.push(() => timers.stop());
  const core = { timers, injectInternal() {}, log: nullLogger() } as unknown as CoreApi;
  const intents: PendingIntent[] = [{ id: 'own-notebook', status: 'active', worlds: ['mail'] }];
  const options = { worlds: () => ['mail', 'garden'], intents: () => intents };
  const manager = new PendingWork(core, dir, () => 'UTC', options);
  const restart = () => new PendingWork(core, dir, () => 'UTC', options);
  const read = (id: string) => JSON.parse(manager.operate({ operation: 'read', id }));
  return { dir, file, timers, manager, intents, restart, read };
}
const deferred = { operation: 'defer', id: 'paper-reply', note: 'Check the paper delivery for my own notebook.',
  intent_id: 'own-notebook', after_seconds: 60, wait_for: { source: 'mail', type: 'mail.message' } };

it('rejects anonymous reminders and unconfigured or internal event sources without writing a ledger', () => {
  const r = rig();
  for (const source of ['mail/mail.message', 'mail.message', 'persona', 'missing'])
    expect(r.manager.operate({ ...deferred, wait_for: { source } })).toContain('World id');
  const { id, ...anonymous } = deferred;
  expect(r.manager.operate(anonymous)).toContain('稳定 id');
  expect(existsSync(r.file)).toBe(false); expect(r.timers.list()).toEqual([]);
});

it('links only an adopted open goal and filters exact reminders without completing the goal', () => {
  const r = rig();
  const agenda = new ActivityAgenda(r.dir);
  agenda.operate({ operation: 'start', id: 'own-notebook', expected_revision: agenda.revision(),
    title: 'Use my notebook', worlds: ['mail'], why: 'For my own travel diary', doneWhen: 'The diary is used.' });
  expect(r.manager.operate({ ...deferred, intent_id: 'unknown' })).toContain('开放的已采用目标');
  r.manager.operate(deferred);
  r.manager.operate({ operation: 'defer', id: 'weather', note: 'Check the weather.', wait_for: { source: 'garden' } });
  const filtered = r.manager.operate({ operation: 'list', intent_id: 'own-notebook', world: 'mail' });
  expect(filtered).toContain('paper-reply'); expect(filtered).not.toContain('id="weather"');
  expect(r.manager.operate({ operation: 'list', query: 'paper notebook' })).toContain('paper-reply');
  r.manager.onDelivery([{ cursor: 7, ts: new Date().toISOString(), origin: 'external', source: 'mail',
    type: 'mail.message', text: 'Paper delivery accepted.' }]);
  expect(r.read('paper-reply').status).toBe('ready');
  expect(agenda.state().items[0].status).toBe('active');
  r.manager.operate({ operation: 'resolve', id: 'paper-reply', expected_revision: r.read('paper-reply').revision,
    result: 'The paper was delivered, which closes this reminder only.' });
  expect(agenda.state().items[0].status).toBe('active');
  r.intents[0].status = 'done';
  expect(r.manager.operate({ ...deferred, id: 'new-reminder' })).toContain('开放的已采用目标');
});

it('deduplicates stable requests across restart without moving the review time or creating another id', () => {
  const r = rig(); const request = { ...deferred, request_id: 'delivery-check-1' };
  r.manager.operate(request);
  const before = readFileSync(r.file, 'utf8'), timer = r.timers.list()[0];
  vi.advanceTimersByTime(5000);
  expect(r.restart().operate({ ...request, wait_for: { type: 'mail.message', source: 'mail' } })).toContain('未重设');
  expect(readFileSync(r.file, 'utf8')).toBe(before); expect(r.timers.list()[0]).toEqual(timer);
  expect(r.manager.operate({ ...request, id: 'another-id' })).toContain('相同 request_id');
  expect(r.manager.operate({ ...request, after_seconds: 120 })).toContain('相同 request_id');
  expect(r.manager.operate({ ...deferred, after_seconds: 120 })).toContain('版本冲突');
  expect(readFileSync(r.file, 'utf8')).toBe(before);
});

it('preserves legacy bytes on load, discloses bad selectors and archives each explicit repair', () => {
  const old = { version: 1, entries: [{ id: 'legacy', note: 'Ask for the paper for my own diary.', status: 'waiting',
    registeredAt: '2025-12-30T10:00:00Z', waitFor: { source: 'mail/mail.message' } }] };
  const r = rig(old), original = readFileSync(r.file, 'utf8');
  expect(r.read('legacy').issues).toEqual(['legacy_unreviewed', 'unknown_event_source']);
  expect(r.manager.operate({ operation: 'list', needs_review: true })).toContain('id="legacy"');
  expect(readFileSync(r.file, 'utf8')).toBe(original);
  r.manager.operate({ operation: 'review', id: 'legacy', expected_revision: r.read('legacy').revision,
    result: 'The request remains unfinished, but the event source needs correction.' });
  expect(r.read('legacy').status).toBe('waiting'); expect(r.read('legacy').issues).toEqual(['unknown_event_source']);
  const registeredAt = r.read('legacy').registeredAt;
  r.manager.operate({ operation: 'review', id: 'legacy', expected_revision: r.read('legacy').revision,
    wait_for: { source: 'mail', type: 'mail.message' }, result: 'The declared event uses source mail and a separate type.' });
  expect(r.read('legacy')).toMatchObject({ registeredAt, status: 'waiting', waitFor: { source: 'mail', type: 'mail.message' } });
  r.manager.operate({ ...deferred, id: 'legacy', expected_revision: r.read('legacy').revision });
  expect(r.read('legacy').issues).toEqual([]); expect(r.read('legacy').intentId).toBe('own-notebook');
  const history = JSON.parse(r.manager.operate({ operation: 'history', id: 'legacy' }));
  expect(history.versions[0]).toEqual(old.entries[0]);
  expect(history.versions[0].waitFor.source).toBe('mail/mail.message');
  expect(r.restart().operate({ operation: 'read', id: 'legacy' })).toBe(r.manager.operate({ operation: 'read', id: 'legacy' }));
});

it('rejects stale closure after a new observation and never reopens a closed id', () => {
  const r = rig(); r.manager.operate(deferred); const revision = r.read('paper-reply').revision;
  r.manager.onDue(r.timers.list()[0]);
  expect(r.manager.operate({ operation: 'resolve', id: 'paper-reply', expected_revision: revision,
    result: 'An old snapshot claimed this was complete.' })).toContain('版本冲突');
  expect(r.read('paper-reply').status).toBe('ready');
  r.manager.operate({ operation: 'cancel', id: 'paper-reply', expected_revision: r.read('paper-reply').revision,
    result: 'I explicitly abandon this reminder; the parent goal is separate.' });
  const closed = readFileSync(r.file, 'utf8');
  expect(r.manager.operate(deferred)).toContain('已关闭');
  expect(r.restart().operate(deferred)).toContain('已关闭');
  expect(readFileSync(r.file, 'utf8')).toBe(closed); expect(r.timers.list()).toEqual([]);
});

it('keeps reminders whose parent closes visible as review candidates without automatic cancellation', () => {
  const r = rig(); r.manager.operate(deferred); r.intents[0].status = 'cancelled';
  expect(r.read('paper-reply')).toMatchObject({ status: 'waiting', issues: ['closed_intent'] });
  expect(r.manager.operate({ operation: 'list', needs_review: true, intent_id: 'own-notebook' })).toContain('paper-reply');
  expect(r.timers.list()).toHaveLength(1);
});

it('prioritizes the active parent and links an existing reminder without changing its time or status', () => {
  const r = rig();
  r.manager.operate({ operation: 'defer', id: 'paper-reply', note: deferred.note, after_seconds: 60 });
  const original = r.read('paper-reply');
  for (let index = 0; index < 15; index++) r.manager.operate({ operation: 'defer', id: 'unrelated-' + index,
    note: 'An unrelated reminder. '.repeat(20), after_seconds: 120 });
  expect(r.manager.summary()).not.toContain('id="paper-reply"');
  r.manager.operate({ operation: 'link', id: 'paper-reply', expected_revision: original.revision,
    intent_id: 'own-notebook', result: 'The paper reply is a prerequisite of this adopted personal goal.' });
  expect(r.read('paper-reply')).toMatchObject({ intentId: 'own-notebook', status: original.status,
    dueAt: original.dueAt, registeredAt: original.registeredAt });
  expect(r.manager.summary()).toContain('id="paper-reply"');
  expect(JSON.parse(r.manager.operate({ operation: 'history', id: 'paper-reply' })).versions[0].intentId).toBeUndefined();
});
