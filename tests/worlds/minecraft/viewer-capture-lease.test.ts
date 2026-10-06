import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewerCaptureLease } from '../../../src/worlds/minecraft/viewer-capture-lease.ts';

afterEach(() => vi.useRealTimers());

describe('viewer capture lease', () => {
  it('retains a renewing capture beyond the original deadline and expires after renewals stop', () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const lease = new ViewerCaptureLease(expired);
    for (let round = 0; round < 6; round++) {
      vi.advanceTimersByTime(15_000);
      lease.renew();
    }
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(expired).toHaveBeenCalledOnce();
  });

  it('expires a legacy capture without renewal', () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    new ViewerCaptureLease(expired);
    vi.advanceTimersByTime(60_000);
    expect(expired).toHaveBeenCalledOnce();
  });

  it('releases the expiration timer on viewer shutdown', () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const lease = new ViewerCaptureLease(expired);
    lease.stop();
    vi.advanceTimersByTime(120_000);
    expect(expired).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
