import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorkspaceMemory } from '../../bots/cormini/persona/memory.ts';
import { StateMemory, STATE_MEMORY_FILE } from '../../bots/cortiv/persona/state-memory.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const observedAt = '2026-01-01T10:00:00Z';
function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'claim-kinds-')); dirs.push(dir);
  const memory = new GitWorkspaceMemory({ memoryDir: dir });
  let now = Date.parse('2026-01-01T10:00:10Z');
  const state = new StateMemory(memory, () => now);
  const evidence_id = state.observe({ source: 'mail/result', observedAt, text: 'Paper delivered. Balance 5.' });
  const record = { operation: 'set', key: 'paper/balance', value: 'Paper balance: 5', expected_revision: 0, evidence_id };
  const read = (key = record.key) => JSON.parse(state.operate({ operation: 'read', key }) as string).claims[0];
  return { memory, state, record, read, clock: (at: string) => { now = Date.parse(at); } };
}

it('requires a meaning and an explicit lifetime for temporary observations', () => {
  const r = rig();
  expect(r.state.operate(r.record)).toMatchObject({ failed: true });
  expect(r.state.operate({ ...r.record, kind: 'observation' })).toMatchObject({ failed: true });
  expect(r.state.operate({ ...r.record, kind: 'observation', valid_for_seconds: 60 })).not.toHaveProperty('failed');
  expect(r.read()).toMatchObject({ kind: 'observation', expiresAt: '2026-01-01T10:01:00.000Z', active: true });
  r.clock('2026-01-01T10:01:01Z');
  expect(r.read().active).toBe(false); expect(r.state.summary()).not.toContain(r.record.value);
  expect(JSON.parse(r.state.operate({ operation: 'read', include_inactive: true }) as string).claims).toHaveLength(1);
  expect(JSON.parse(r.state.operate({ operation: 'read' }) as string).claims).toEqual([]);
});

it('rejects a topic query on a key read instead of returning unrelated records as search results', () => {
  const r = rig(); r.state.operate({ ...r.record, kind: 'event' });
  const before = r.memory.readFile(STATE_MEMORY_FILE);
  for (const operation of ['read', 'history']) expect(r.state.operate({ operation, key: r.record.key, query: 'unrelated' }))
    .toMatchObject({ failed: true, text: expect.stringContaining('recall') });
  expect(r.memory.readFile(STATE_MEMORY_FILE)).toBe(before);
});

it('keeps an old observation expired when it is written later and rejects renewal from the same evidence', () => {
  const r = rig(); r.clock('2026-01-01T12:00:00Z');
  r.state.operate({ ...r.record, kind: 'observation', valid_for_seconds: 60 });
  expect(r.read()).toMatchObject({ active: false, expiresAt: '2026-01-01T10:01:00.000Z' });
  expect(r.state.operate({ ...r.record, kind: 'observation', expected_revision: r.read().revision,
    valid_for_seconds: 36000 })).toMatchObject({ failed: true });
  expect(r.read().expiresAt).toBe('2026-01-01T10:01:00.000Z');
});

it('retains events and beliefs independently of the expiration of sampled resource state', () => {
  const r = rig();
  r.state.operate({ ...r.record, kind: 'observation', valid_for_seconds: 60 });
  r.state.operate({ ...r.record, kind: 'event', key: 'paper/delivery', value: 'The paper was delivered.' });
  r.state.operate({ ...r.record, kind: 'belief', key: 'paper/usage', value: 'Thin paper suits my travel diary.' });
  r.clock('2026-03-01T12:00:00Z');
  expect(r.read().active).toBe(false);
  expect(r.read('paper/delivery')).toMatchObject({ kind: 'event', active: true, expiresAt: null });
  expect(r.read('paper/usage')).toMatchObject({ kind: 'belief', active: true, expiresAt: null });
  expect(r.state.summary()).toContain('[历史事件]'); expect(r.state.summary()).toContain('[认识经验]');
});

it('loads legacy claims without rewriting them and classifies by revision without changing original evidence', () => {
  const r = rig();
  const old = { key: 'paper/balance', revision: 1, value: 'Paper balance: 5', recordedAt: observedAt,
    observation: { id: 'legacy-observation', source: 'mail/read', observedAt, text: 'Paper balance 5.' },
    retired: false, expiresAt: null };
  const original = JSON.stringify({ version: 1, legacy: {}, claims: [old] });
  r.memory.writeFileAtomic(STATE_MEMORY_FILE, original);
  expect(r.read()).toMatchObject({ kind: 'legacy', observation: old.observation });
  expect(r.state.summary()).toContain('[未分类旧记录]'); expect(r.memory.readFile(STATE_MEMORY_FILE)).toBe(original);
  r.clock('2026-01-01T12:00:00Z');
  expect(r.state.operate({ operation: 'classify', key: old.key, expected_revision: 0, kind: 'observation',
    valid_for_seconds: 60, reason: 'This was a sampled balance.' })).toMatchObject({ failed: true });
  r.state.operate({ operation: 'classify', key: old.key, expected_revision: 1, kind: 'observation',
    valid_for_seconds: 60, reason: 'The original receipt is a sampled balance, not a permanent fact.' });
  expect(r.read()).toMatchObject({ kind: 'observation', revision: 2, value: old.value, observation: old.observation, active: false });
  const history = JSON.parse(r.state.operate({ operation: 'history', key: old.key }) as string);
  expect(history.claims[0]).toMatchObject({ revision: old.revision, value: old.value, kind: 'legacy', observation: old.observation });
  expect(JSON.parse(r.memory.readFile(STATE_MEMORY_FILE)).claims[0]).toEqual(old);
  expect(r.state.operate({ operation: 'classify', key: old.key, expected_revision: 2, kind: 'belief',
    reason: 'Try to remove its lifetime.' })).toMatchObject({ failed: true });
});

it('cannot extend a legacy expiry through classification or lose the expiry when retiring an observation', () => {
  const r = rig();
  const observation = { id: 'legacy', source: 'mail/read', observedAt, text: 'Balance 5.' };
  r.memory.writeFileAtomic(STATE_MEMORY_FILE, JSON.stringify({ version: 1, legacy: {}, claims: [{ key: r.record.key,
    revision: 1, value: r.record.value, recordedAt: observedAt, observation, expiresAt: '2026-01-01T10:01:00Z', retired: false }] }));
  expect(r.state.operate({ operation: 'classify', key: r.record.key, expected_revision: 1, kind: 'belief',
    valid_for_seconds: 3600, reason: 'Retain a lesson.' })).toMatchObject({ failed: true });
  r.state.operate({ operation: 'classify', key: r.record.key, expected_revision: 1, kind: 'observation', reason: 'Sampled balance.' });
  const evidence_id = r.state.observe({ source: 'mail/read', observedAt: '2026-01-01T10:00:20Z', text: 'Balance reading is invalid.' });
  expect(r.state.operate({ operation: 'retire', key: r.record.key, expected_revision: 2,
    value: 'Invalidated by a later receipt.', evidence_id })).not.toHaveProperty('failed');
  expect(new StateMemory(r.memory).operate({ operation: 'read', key: r.record.key })).not.toHaveProperty('failed');
  expect(r.read().retired).toBe(true);
});
