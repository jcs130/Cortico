import { describe, expect, it } from 'vitest';
import { parseViewerCombatHit, VIEWER_COMBAT_CHANNEL } from '../../../src/worlds/minecraft/viewer-combat.ts';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

describe('viewer combat payload', () => {
  it('accepts final damage dealt by this bot', () => {
    expect(parseViewerCombatHit(VIEWER_COMBAT_CHANNEL, encode({
      schemaVersion: 1, attackerEntityId: 7, targetEntityId: 42, damage: 5.5, critical: true,
    }), 7)).toEqual({ id: 42, amount: 5.5, critical: true });
  });

  it('does not invent or show another player’s damage', () => {
    const event = { schemaVersion: 1, attackerEntityId: 8, targetEntityId: 42, damage: 5, critical: false };
    expect(parseViewerCombatHit(VIEWER_COMBAT_CHANNEL, encode(event), 7)).toBeNull();
    expect(parseViewerCombatHit(VIEWER_COMBAT_CHANNEL, encode({ ...event, attackerEntityId: 7, damage: null }), 7)).toBeNull();
  });
});
