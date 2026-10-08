import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CombatTacticBook, type CombatResult } from '../../../src/worlds/minecraft/combat-tactics.ts';
import { CombatSpells } from '../../../src/worlds/minecraft/combat-spells.ts';

const dirs: string[] = [];
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'combat-tactics-'));
  dirs.push(dir);
  return join(dir, 'tactics.json');
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const result = (at: number): CombatResult => ({ startedAt: new Date(at).toISOString(),
  endedAt: new Date(at + 5000).toISOString(), reason: 'death', healthBefore: 20,
  healthAfter: 0, kills: { zombie: 1 }, swings: 3, meleeLanded: 2, arrows: 0, rangedLanded: 0 });

describe('World-scoped combat tactic persistence', () => {
  it('restores the selected tactic after process replacement and isolates another world', () => {
    const path = file();
    const first = new CombatSpells(new CombatTacticBook(path));
    first.useRealm('world-a');
    first.setTactic({ spells: ['golem', 'frostnova'], healAtOrBelow: 12 });
    first.noteServerMessage('探索咏唱：守护傀儡(golem，12 魔力/75 秒)', 100_000);
    first.noteManualCast('golem', 100_000);
    const receipt = first.recordCombat(result(99_000));
    const replacement = new CombatSpells(new CombatTacticBook(path));
    replacement.useRealm('world-a');
    expect(replacement.getTactic()).toEqual(first.getTactic());
    expect(replacement.readout(receipt.id)).toContain('"healthAfter":0');
    expect(replacement.readout()).toContain('本连接尚未确认该能力');
    replacement.useRealm('world-b');
    expect(replacement.getTactic()).toBeNull();
    expect(replacement.readout(receipt.id)).toContain('未找到');
    replacement.setTactic({ spells: ['starbolt'], healAtOrBelow: 10 });
    replacement.useRealm('world-a');
    expect(replacement.getTactic()?.spells).toEqual(['golem', 'frostnova']);
    replacement.setTactic(null);
    const cleared = new CombatSpells(new CombatTacticBook(path));
    cleared.useRealm('world-a');
    expect(cleared.getTactic()).toBeNull();
    cleared.useRealm('world-b');
    expect(cleared.getTactic()?.spells).toEqual(['starbolt']);
  });

  it('keeps bounded observed encounters and versions without generating a lesson', () => {
    const book = new CombatTacticBook(file());
    book.useRealm('world-a');
    book.set({ spells: ['golem'], healAtOrBelow: 12 }, 100_000);
    for (let i = 0; i < 7; i++) book.record(result(101_000 + i * 10_000), []);
    const saved = book.current();
    expect(saved.reports.map((r) => r.id)).toEqual([3, 4, 5, 6, 7]);
    expect(saved.revision).toBe(1);
    expect(saved.reports.at(-1)).toMatchObject({ reason: 'death', healthAfter: 0,
      tacticRevision: 1, tacticAtEnd: { spells: ['golem'], healAtOrBelow: 12 }, casts: [] });
    saved.tactic!.spells!.push('starbolt');
    expect(book.current().tactic?.spells).toEqual(['golem']);
  });

  it('does not report a changed tactic when its file cannot be saved', () => {
    const path = file();
    const spells = new CombatSpells(new CombatTacticBook(path));
    spells.useRealm('world-a');
    spells.setTactic({ spells: ['golem'], healAtOrBelow: 12 });
    rmSync(path);
    mkdirSync(path);
    expect(() => spells.setTactic({ spells: ['starbolt'], healAtOrBelow: 8 })).toThrow();
    expect(spells.getTactic()).toEqual({ spells: ['golem'], healAtOrBelow: 12 });
  });

  it('rejects malformed saved settings before applying them', () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ version: 1, realms: { a: { revision: 1,
      updatedAt: null, tactic: { spells: ['selfheal'], healAtOrBelow: 80 }, reports: [] } } }));
    expect(() => new CombatTacticBook(path)).toThrow('Invalid combat tactic state');
  });
});
