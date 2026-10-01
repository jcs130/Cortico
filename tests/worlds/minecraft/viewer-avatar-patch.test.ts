import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { patchAvatarMotion, patchRendererAvatar } from '../../../scripts/minecraft-viewer-avatar-patch.mjs';

const sourceRoot = process.env.MINECRAFT_MODERN_VIEWER_ROOT || 'D:/workspace/mengyue-world-platform/packages/minecraft-modern-viewer';

describe('Minecraft third-person equipment and sword pose', () => {
  it.skipIf(!existsSync(path.join(sourceRoot, 'node_modules/minecraft-renderer/dist/minecraft-renderer.js')))
    ('moves the helmet pivot to the skin head and follows crouching', () => {
    const original = readFileSync(path.join(sourceRoot, 'node_modules/minecraft-renderer/dist/minecraft-renderer.js'), 'utf8');
    const patched = patchRendererAvatar(original);
    expect(patched).toContain('parent:"armor",pivot:[0,24,0],cubes:[{origin:[-4,24,-4]');
    expect(patched).toContain('h.position.set(r.head.position.x,12+r.head.position.y,r.head.position.z)');
    expect(patched).toContain('h.rotation.set(-r.head.rotation.x,r.head.rotation.y,r.head.rotation.z');
    expect(patched).toContain('leftarm",parent:"armor",pivot:[5,22,0]');
    expect(patched).toContain('rightarm",parent:"armor",pivot:[-5,22,0]');
    expect(patched).toContain('leftleg",parent:"armor",pivot:[1.9,12,-.1]');
    expect(patched).toContain('case"geometry_armor_chest_overlay"');
    expect(patched).toContain('bone.rotation.set(part.rotation.x,part.rotation.y,part.rotation.z');
    expect(patched).toContain('rotation.set(r.leftLeg.rotation.x,r.leftLeg.rotation.y,r.leftLeg.rotation.z');
    expect(patched).toContain('case"geometry_armor_head_overlay"');
  });

  it('has a windup, crossing strike and recover with alternating slashes', () => {
    const source = readFileSync(path.resolve('scripts/minecraft-viewer-third-person-swing.js'), 'utf8');
    const { sample } = runInNewContext(`${source}\n({ sample: cortiSlashPoseAt })`, {}) as {
      sample: (progress: number, variant: number) => number[];
    };
    const windup = sample(0.18, 1);
    const impact = sample(0.43, 1);
    const alternate = sample(0.43, -1);
    expect(windup[0]).toBeLessThan(-0.8);
    expect(impact[0]).toBeLessThan(-2);
    expect(impact[1]).toBeLessThan(-0.7);
    expect(alternate[1]).toBeGreaterThan(0.7);
    expect(impact[3] * alternate[3]).toBeLessThan(0);
    expect(sample(1, 1)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it.skipIf(!existsSync(path.join(sourceRoot, 'src/modern-viewer/avatar-motion.js')))
    ('routes swords through the new pose and leaves ordinary swings available', () => {
    const source = readFileSync(path.join(sourceRoot, 'src/modern-viewer/avatar-motion.js'), 'utf8');
    const overlay = readFileSync(path.resolve('scripts/minecraft-viewer-third-person-swing.js'), 'utf8');
    const patched = patchAvatarMotion(source, overlay);
    expect(patched).toContain('style: source.style === "sword" ? "sword" : null');
    expect(patched).toContain('applySwingOverlay(pose, progress, upper.hand, upper.style, upper.variant)');
    const calls: Array<[string, string, number, number, number]> = [];
    const { apply } = runInNewContext(`${overlay}\n({ apply: applySwingOverlay })`, {
      addRotation: (_pose: unknown, name: string, x: number, y: number, z: number) => calls.push(['rotation', name, x, y, z]),
      addPosition: (_pose: unknown, name: string, x: number, y: number, z: number) => calls.push(['position', name, x, y, z]),
    }) as { apply: (pose: object, progress: number, hand: string, style: string | null, variant: number) => void };
    apply({}, 0.43, 'right', 'sword', 1);
    expect(calls.some(([, name, x]) => name === 'rightArm' && x < -2)).toBe(true);
    expect(calls.some(([, name]) => name === 'leftArm')).toBe(true);
    calls.length = 0;
    apply({}, 0.43, 'right', null, 1);
    expect(calls.some(([, name]) => name === 'leftArm')).toBe(false);
  });
});
