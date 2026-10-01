import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function motionHarness() {
  let now = 0;
  class Vec3 {
    constructor(public x: number, public y: number, public z: number) {}
  }
  const source = readFileSync(path.resolve('scripts/minecraft-viewer-motion.js'), 'utf8');
  const script = `${source}\n({ sample: cortiCameraPose })`;
  const context = { isFirstPersonView: true, performance: { now: () => now }, Vec3,
    requestAnimationFrame: () => 1, rendererReady: false, latestPosition: null };
  const { sample } = runInNewContext(script, context) as {
    sample: (packet: { pos: Vec3; yaw: number; pitch: number; teleport?: boolean }, instant: boolean) =>
      { pos: Vec3; yaw: number; pitch: number; settled: boolean };
  };
  return { sample, tick: (ms: number) => { now += ms; }, Vec3 };
}

describe('Minecraft viewer camera motion', () => {
  it('smooths normal turning and walking, then snaps on teleports', () => {
    const { sample, tick, Vec3 } = motionHarness();
    sample({ pos: new Vec3(0, 64, 0), yaw: 0, pitch: 0 }, true);
    tick(16);
    const turning = sample({ pos: new Vec3(1, 64, 0), yaw: Math.PI, pitch: 0 }, false);
    expect(turning.pos.x).toBeGreaterThan(0);
    expect(turning.pos.x).toBeLessThan(1);
    expect(turning.yaw).toBeGreaterThan(0);
    expect(turning.yaw).toBeLessThan(0.2);
    tick(16);
    const moved = sample({ pos: new Vec3(1, 64, 0), yaw: Math.PI, pitch: 0 }, false);
    expect(moved.pos.x).toBeGreaterThan(turning.pos.x);
    expect(moved.yaw).toBeGreaterThan(turning.yaw);
    const teleport = sample({ pos: new Vec3(30, 80, -20), yaw: -1, pitch: 0.5, teleport: true }, false);
    expect(teleport.pos.x).toBe(30);
    expect(teleport.yaw).toBe(-1);
    expect(teleport.settled).toBe(true);
  });

  it('turns across the shortest path at the -π/π boundary', () => {
    const { sample, tick, Vec3 } = motionHarness();
    sample({ pos: new Vec3(0, 64, 0), yaw: Math.PI - 0.02, pitch: 0 }, true);
    tick(16);
    const next = sample({ pos: new Vec3(0, 64, 0), yaw: -Math.PI + 0.02, pitch: 0 }, false);
    expect(next.yaw).toBeGreaterThan(Math.PI - 0.02);
    expect(next.yaw).toBeLessThan(Math.PI + 0.02);
  });
});
