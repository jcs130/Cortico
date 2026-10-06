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
  const world = { holdingBlock: { cortiNockedArrow: { visible: false },
    cortiBowDrawArm: { visible: false } },
    holdingBlockLeft: { cortiNockedArrow: { visible: false } } };
  const viewer = { playerState: { reactive: { heldItemMain: item, itemUsageTicks: 0 } },
    backend: { backendMethods: { changeHandSwingingState: (active: boolean, left: boolean) => {
      changes.push([active, left]);
    } } } };
  const source = readFileSync(path.resolve('scripts/minecraft-viewer-weapon-motion.js'), 'utf8');
  const api = runInNewContext(`${source}\n({ apply: cortiApplyFirstPersonSwing,
    poseAt: cortiWeaponPoseAt, rangedPoseAt: cortiRangedPoseAt,
    setRangedUse: cortiSetRangedUse, syncRangedState: cortiSyncRangedState,
    rangedUse: () => cortiRangedUse,
    swings: cortiWeaponSwings })`, {
    viewer, isFirstPersonView: true, performance: { now: () => now },
    queueMicrotask: (fn: () => void) => queued.push(fn), globalThis: { world },
  }) as {
    apply(event: { hand: string }): void;
    poseAt(swing: Swing, at: number): Pose;
    rangedPoseAt(use: { kind: string; hand: string; phase: string; at: number }, at: number,
      hand: string): Pose | null;
    setRangedUse(event: { kind: string; hand: string; phase: string }, at: number): void;
    syncRangedState(state: { hotbar?: Array<{ selected: boolean; item: { name: string } | null }>;
      usingHeldItem?: boolean }): void;
    rangedUse(): { kind: string; hand: string; phase: string; at: number } | null;
    swings: Record<string, Swing | null>;
  };
  return { ...api, item, changes, world, viewer, now: () => now, tick: (ms: number) => { now += ms; },
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

  it('pulls the opposite hand back during bow charge and releases both hands', () => {
    const motion = weaponHarness('bow', false);
    motion.setRangedUse({ kind: 'bow', hand: 'right', phase: 'draw' }, 0);
    const use = motion.rangedUse()!;
    const bow = motion.rangedPoseAt(use, 700, 'right')!;
    const pullingHand = motion.rangedPoseAt(use, 700, 'left')!;
    expect(bow.x).toBeLessThan(-0.8);
    expect(pullingHand.z).toBeGreaterThan(0.1);
    expect(pullingHand).not.toEqual(bow);
    motion.world.holdingBlock.cortiNockedArrow.visible = true;
    motion.world.holdingBlock.cortiBowDrawArm.visible = true;
    motion.viewer.playerState.reactive.itemUsageTicks = 15;
    motion.setRangedUse({ kind: 'bow', hand: 'right', phase: 'release' }, 700);
    expect(motion.world.holdingBlock.cortiNockedArrow.visible).toBe(false);
    expect(motion.world.holdingBlock.cortiBowDrawArm.visible).toBe(false);
    expect(motion.viewer.playerState.reactive.itemUsageTicks).toBe(0);
    expect(motion.rangedPoseAt(motion.rangedUse()!, 800, 'left')).not.toBeNull();
  });

  it('removes a nocked arrow immediately when a draw is canceled', () => {
    const motion = weaponHarness('bow', false);
    motion.setRangedUse({ kind: 'bow', hand: 'right', phase: 'draw' }, 0);
    motion.world.holdingBlock.cortiNockedArrow.visible = true;
    motion.setRangedUse({ kind: 'bow', hand: 'right', phase: 'cancel' }, 100);
    expect(motion.world.holdingBlock.cortiNockedArrow.visible).toBe(false);
    expect(motion.rangedUse()).toBeNull();
  });

  it('ends a stale draw when the selected item changes in the avatar snapshot', () => {
    const motion = weaponHarness('bow', false);
    motion.setRangedUse({ kind: 'bow', hand: 'right', phase: 'draw' }, 0);
    motion.world.holdingBlock.cortiNockedArrow.visible = true;
    motion.syncRangedState({ hotbar: [{ selected: true, item: { name: 'iron_sword' } }] });
    expect(motion.rangedUse()).toBeNull();
    expect(motion.world.holdingBlock.cortiNockedArrow.visible).toBe(false);
  });
});
