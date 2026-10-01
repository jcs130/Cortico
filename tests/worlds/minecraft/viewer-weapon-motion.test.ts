import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface Pose { x: number; y: number; z: number; yaw: number; pitch: number; roll: number }
interface Swing { hand: string; kind: string; itemName: string; from: Pose; at: number;
  durationMs: number; variant: number; enchanted: boolean }

function weaponHarness(itemName = 'iron_sword', enchanted = true) {
  let now = 0;
  const changes: Array<[boolean, boolean]> = [];
  const queued: Array<() => void> = [];
  const item = { name: itemName, fullItem: { enchanted } };
  const viewer = { playerState: { reactive: { heldItemMain: item } },
    backend: { backendMethods: { changeHandSwingingState: (active: boolean, left: boolean) => {
      changes.push([active, left]);
    } } } };
  const source = readFileSync(path.resolve('scripts/minecraft-viewer-weapon-motion.js'), 'utf8');
  const api = runInNewContext(`${source}\n({ apply: cortiApplyFirstPersonSwing,
    poseAt: cortiWeaponPoseAt, swings: cortiWeaponSwings })`, {
    viewer, isFirstPersonView: true, performance: { now: () => now },
    queueMicrotask: (fn: () => void) => queued.push(fn), globalThis: {},
  }) as {
    apply(event: { hand: string }): void;
    poseAt(swing: Swing, at: number): Pose;
    swings: Record<string, Swing | null>;
  };
  return { ...api, item, changes, now: () => now, tick: (ms: number) => { now += ms; },
    flush: () => { for (const callback of queued.splice(0)) callback(); } };
}

describe('Minecraft first-person weapon motion', () => {
  it('alternates diagonal slashes and resumes from an interrupted sword pose', () => {
    const motion = weaponHarness();
    motion.apply({ hand: 'right' });
    expect(motion.changes).toHaveLength(0);
    const first = motion.swings.right!;
    expect(first.enchanted).toBe(true);
    expect(first.durationMs).toBeGreaterThan(350);
    motion.tick(first.durationMs * 0.43);
    const strike = motion.poseAt(first, motion.now());
    expect(strike.x).toBeLessThan(-0.25);
    expect(strike.roll).toBeGreaterThan(0.9);
    motion.apply({ hand: 'right' });
    const second = motion.swings.right!;
    expect(second.variant).toBe(-first.variant);
    expect(second.from.roll).toBeCloseTo(strike.roll);
    motion.tick(second.durationMs * 0.43);
    expect(motion.poseAt(second, motion.now()).roll).toBeLessThan(-0.7);
    motion.tick(second.durationMs);
    expect(motion.poseAt(second, motion.now())).toMatchObject({ x: 0, roll: 0 });
  });

  it('passes through the sword strike without stopping at a key pose', () => {
    const motion = weaponHarness();
    motion.apply({ hand: 'right' });
    const swing = motion.swings.right!;
    const before = motion.poseAt(swing, swing.durationMs * 0.399).roll;
    const strike = motion.poseAt(swing, swing.durationMs * 0.4).roll;
    const after = motion.poseAt(swing, swing.durationMs * 0.401).roll;
    expect(strike - before).toBeGreaterThan(0.001);
    expect(after - strike).toBeGreaterThan(0.001);
  });

  it('keeps a plain sword unenchanted', () => {
    const motion = weaponHarness('iron_sword', false);
    motion.apply({ hand: 'right' });
    expect(motion.swings.right?.enchanted).toBe(false);
  });

  it('stops a non-weapon swing before the renderer repeats it', () => {
    const motion = weaponHarness('oak_log');
    motion.apply({ hand: 'right' });
    expect(motion.changes).toEqual([[true, false]]);
    motion.flush();
    expect(motion.changes).toEqual([[true, false], [false, false]]);
  });

  it('uses a slower overhead motion for axes', () => {
    const motion = weaponHarness('minecraft:iron_axe');
    motion.apply({ hand: 'right' });
    const swing = motion.swings.right!;
    expect(swing.durationMs).toBeGreaterThan(410);
    expect(motion.poseAt(swing, swing.durationMs * 0.25).pitch).toBeGreaterThan(0);
    expect(motion.poseAt(swing, swing.durationMs * 0.55).pitch).toBeLessThan(0);
  });
});
