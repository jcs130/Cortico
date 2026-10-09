import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ViewerIdentityLinks, VIEWER_IDENTITY_LINKS_FILE } from '../../bots/cortiv/persona/viewer-identity-links.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const link = { accounts: [{ source: 'stream', id: '42' }, { source: 'game', id: 'Alex' }],
  confirmedAt: '2026-10-09T16:05:00+08:00', evidence: { kind: 'operator-confirmation', reference: 'terminal.message #50' } };
function fixture(links: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'identity-links-')); dirs.push(dir);
  mkdirSync(join(dir, 'social'));
  const path = join(dir, VIEWER_IDENTITY_LINKS_FILE);
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, links }));
  return { path, registry: new ViewerIdentityLinks(dir) };
}

describe('explicit social identity associations', () => {
  it('exposes the operator evidence for either exact account without guessing names or platforms', () => {
    const { registry } = fixture([link]);
    const note = registry.note('game', 'Alex');
    expect(note).toContain('stream/42 ↔ game/Alex');
    expect(note).toContain('terminal.message #50');
    expect(note).toContain('2026-10-09T16:05:00+08:00');
    expect(registry.note('stream', '42')).toBe(note);
    expect(registry.note('other', '42')).toBe('');
    expect(registry.note('game', 'alex')).toBe('');
  });

  it('rejects conflicting associations rather than merging people transitively', () => {
    const { registry } = fixture([link, { ...link, accounts: [{ source: 'stream', id: '99' }, { source: 'game', id: 'Alex' }] }]);
    for (const [source, id] of [['stream', '42'], ['stream', '99'], ['game', 'Alex']]) {
      expect(registry.note(source, id)).toContain('身份关联冲突');
      expect(registry.note(source, id)).not.toContain('已确认同一人');
    }
  });

  it.each([
    { ...link, evidence: undefined }, { ...link, confirmedAt: 'unknown' },
    { ...link, accounts: [link.accounts[0], link.accounts[0]] },
    { ...link, accounts: [{ source: '../escape', id: '42' }, link.accounts[1]] },
  ])('marks missing or invalid evidence as unverified', invalid => {
    const { registry } = fixture([invalid]);
    expect(registry.note('stream', '42')).toContain('未验证');
  });

  it('withdraws a removed registry and reads a later correction', () => {
    const { path, registry } = fixture([link]);
    expect(registry.note('stream', '42')).toContain('game/Alex');
    rmSync(path); expect(registry.note('stream', '42')).toBe('');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, links: [{ ...link,
      accounts: [link.accounts[0], { source: 'game', id: 'Blair' }] }] }));
    expect(registry.note('stream', '42')).toContain('game/Blair');
    expect(registry.note('game', 'Alex')).toBe('');
  });
});
