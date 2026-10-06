import { describe, expect, it } from 'vitest';
import { observeViewerRangedUse, observeViewerShieldUse } from '../../../src/worlds/minecraft/viewer-entity-state.ts';

describe('read-only ranged-use observation', () => {
  it('mirrors bow draw and release without changing outgoing packets', () => {
    const writes: string[] = [];
    const events: unknown[] = [];
    const protocol = { write(name: string, _params?: Record<string, unknown>) { writes.push(name); } };
    const original = protocol.write;
    const stop = observeViewerRangedUse(protocol, () => 'bow', event => events.push(event));
    protocol.write('use_item', { hand: 0 });
    protocol.write('block_dig', { status: 5 });
    expect(writes).toEqual(['use_item', 'block_dig']);
    expect(events).toEqual([
      { kind: 'bow', hand: 'right', phase: 'draw' },
      { kind: 'bow', hand: 'right', phase: 'release' },
    ]);
    stop();
    expect(protocol.write).toBe(original);
  });

  it('clears the viewer draw when changing slots aborts a shot', () => {
    const writes: string[] = [];
    const events: unknown[] = [];
    const protocol = { write(name: string, _params?: Record<string, unknown>) { writes.push(name); } };
    const stop = observeViewerRangedUse(protocol, () => 'bow', event => events.push(event));
    protocol.write('use_item', { hand: 0 });
    protocol.write('held_item_slot', { slotId: 2 });
    protocol.write('block_dig', { status: 5 });
    expect(writes).toEqual(['use_item', 'held_item_slot', 'block_dig']);
    expect(events).toEqual([
      { kind: 'bow', hand: 'right', phase: 'draw' },
      { kind: 'bow', hand: 'right', phase: 'cancel' },
    ]);
    stop();
  });
});

describe('read-only shield-use observation', () => {
  it('raises only for an offhand shield and lowers on release', () => {
    const writes: string[] = [];
    const events: boolean[] = [];
    let item = 'shield';
    const protocol = { write(name: string, _params?: Record<string, unknown>) { writes.push(name); } };
    const original = protocol.write;
    const stop = observeViewerShieldUse(protocol, () => item, raised => events.push(raised));
    protocol.write('use_item', { hand: 0 });
    protocol.write('use_item', { hand: 1 });
    protocol.write('use_item', { hand: 1 });
    protocol.write('block_dig', { status: 5 });
    item = 'totem_of_undying';
    protocol.write('use_item', { hand: 1 });
    expect(writes).toHaveLength(5);
    expect(events).toEqual([true, false]);
    stop();
    expect(protocol.write).toBe(original);
  });
});
