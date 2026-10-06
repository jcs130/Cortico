import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Heartbeat } from '../../bots/cormini/persona/heartbeat.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T06:00:00Z'));
});

afterEach(() => vi.useRealTimers());

describe('Persona idle heartbeat', () => {
  it('counts the interval from the last external activity, then backs off during silence', async () => {
    const fired: number[] = [];
    const heartbeat = new Heartbeat(() => 30, () => fired.push(Date.now()));
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(20);
    heartbeat.noteActivity();
    await vi.advanceTimersByTimeAsync(29);
    expect(fired).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(fired).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(59);
    expect(fired).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toHaveLength(3);
    heartbeat.stop();
  });

  it('does not emit a tick while external events keep arriving', async () => {
    let fires = 0;
    const heartbeat = new Heartbeat(() => 30, () => { fires++; });
    heartbeat.start();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(20);
      heartbeat.noteActivity();
    }
    await vi.advanceTimersByTimeAsync(29);
    expect(fires).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fires).toBe(1);
    heartbeat.stop();
  });
});
