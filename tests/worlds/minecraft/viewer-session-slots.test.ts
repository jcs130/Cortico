import { describe, expect, it } from 'vitest';
import { ViewerSessionSlots } from '../../../src/worlds/minecraft/viewer-session-slots.ts';

describe('viewer and capture admission', () => {
  it('admits one capture while audience connections remain full and preserves their reservations', () => {
    const slots = new ViewerSessionSlots(2, 1);
    const audience = [slots.reserve(false)!, slots.reserve(false)!];
    expect(slots.reserve(false)).toBeNull();
    const capture = slots.reserve(true)!;
    expect(slots.status()).toMatchObject({ viewers: 2, captureSessions: 1 });
    expect(slots.reserve(true)).toBeNull();
    capture();
    expect(slots.status()).toMatchObject({ viewers: 2, captureSessions: 0 });
    expect(slots.reserve(false)).toBeNull();
    audience[0]!();
    expect(slots.reserve(false)).toBeTypeOf('function');
    audience[1]!();
  });

  it('releases each connection only once across disconnect and expiry cleanup', () => {
    const slots = new ViewerSessionSlots(1, 1);
    const release = slots.reserve(true)!;
    release(); release();
    expect(slots.status().captureSessions).toBe(0);
    const next = slots.reserve(true)!;
    expect(slots.reserve(true)).toBeNull();
    next();
    expect(slots.status().captureSessions).toBe(0);
  });
});
