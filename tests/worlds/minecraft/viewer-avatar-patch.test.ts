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
    expect(patched).toContain('bone.rotation.copy(part.rotation)');
    expect(patched).toContain('case"geometry_armor_legs":case"geometry_armor_legs_overlay"');
    expect(patched).toContain('case"geometry_armor_feet":case"geometry_armor_feet_overlay"');
    expect(patched).toContain('[["leftleg",r.rightLeg],["rightleg",r.leftLeg]]');
    expect(patched).toContain('bone.position.set(-part.position.x,12+part.position.y,-part.position.z)');
    expect(patched).toContain('bone.rotation.set(-part.rotation.x,part.rotation.y,-part.rotation.z,part.rotation.order)');
    expect(patched).not.toContain('children[2].rotation.set(-r.leftLeg');
    expect(patched).toContain('case"geometry_armor_head_overlay"');
    expect(patched).toContain('let pitch=-e.playerObject.rotation.x;armor.rotation.x=pitch');
    expect(patched).toContain('armor.position.y=1-Math.cos(pitch);armor.position.z=-Math.sin(pitch)');
  });

  it.skipIf(!existsSync(path.join(sourceRoot, 'node_modules/minecraft-renderer/dist/minecraft-renderer.js')))
    ('maps each leg and boot to the skin limb under its 180-degree-facing armor root', () => {
    const original = readFileSync(path.join(sourceRoot, 'node_modules/minecraft-renderer/dist/minecraft-renderer.js'), 'utf8');
    const patched = patchRendererAvatar(original);
    const start = patched.indexOf('syncArmorPositions(e){');
    const end = patched.indexOf('getPlayerObject(e){', start);
    const syncSource = patched.slice(start, end);
    const createBone = () => ({ position: { x: 0, y: 0, z: 0,
      set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } },
      rotation: { x: 0, y: 0, z: 0, order: 'XYZ', set(x: number, y: number, z: number, order: string) {
        this.x = x; this.y = y; this.z = z; this.order = order;
      } } });
    const createArmor = (name: string) => {
      const left = createBone();
      const right = createBone();
      return { name, left, right, children: [{ getObjectByName(boneName: string) {
        return boneName === 'bone_leftleg' ? left : boneName === 'bone_rightleg' ? right : null;
      } }], rotation: { x: 0 }, position: { y: 0, z: 0 } };
    };
    const armor = createArmor('geometry_armor_legs');
    const feet = createArmor('geometry_armor_feet');
    const skin = { leftLeg: { position: { x: 1.9, y: -12, z: -.2 },
      rotation: { x: .7, y: .1, z: .2, order: 'XYZ' } }, rightLeg: {
      position: { x: -1.9, y: -12, z: .15 }, rotation: { x: -.4, y: -.1, z: -.2, order: 'XYZ' },
    } };
    const script = `const view = { ${syncSource} }; view.syncArmorPositions({ playerObject: { skin, rotation: { x: 1.1 } }, children: [armor, feet], traverse: (visit) => { visit(armor); visit(feet); } });`;
    runInNewContext(script, { armor, feet, skin });
    for (const piece of [armor, feet]) {
      expect(piece.left.rotation).toMatchObject({ x: .4, y: -.1, z: .2 });
      expect(piece.right.rotation).toMatchObject({ x: -.7, y: .1, z: -.2 });
      expect(piece.left.position).toMatchObject({ x: 1.9, y: 0, z: -.15 });
      expect(piece.right.position).toMatchObject({ x: -1.9, y: 0, z: .2 });
    }
    expect(armor.rotation.x).toBe(-1.1);
    expect(feet.rotation.x).toBe(-1.1);
    for (const piece of [armor, feet]) {
      expect(piece.position.y + Math.cos(piece.rotation.x)).toBeCloseTo(1);
      expect(piece.position.z + Math.sin(piece.rotation.x)).toBeCloseTo(0);
    }
  });

  it.skipIf(!existsSync(path.join(sourceRoot, 'src/modern-viewer/avatar-motion.js')))
    ('keeps a wading avatar upright and pitches a swimming avatar face forward', () => {
    const original = readFileSync(path.join(sourceRoot, 'src/modern-viewer/avatar-motion.js'), 'utf8');
    const sword = readFileSync(path.resolve('scripts/minecraft-viewer-third-person-swing.js'), 'utf8');
    const patched = patchAvatarMotion(original, sword).replace(/^export /gm, '');
    const { PoseDrivenPlayerAnimation } = runInNewContext(`${patched}\n({ PoseDrivenPlayerAnimation })`, {}) as {
      PoseDrivenPlayerAnimation: new (options: { now: () => number }) => {
        setMotion(frame: object, at: number): void;
        update(player: object, seconds: number): void;
        getDiagnostics(): { state: string };
      };
    };
    const part = () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } });
    const player = { ...part(), skin: { body: part(), head: part(), leftArm: part(),
      rightArm: part(), leftLeg: part(), rightLeg: part() }, cape: part() };
    let now = 0;
    const animation = new PoseDrivenPlayerAnimation({ now: () => now });
    const motion = (overrides: object) => ({ capturedAt: now, position: { x: 0, y: 64, z: 0 },
      velocity: { x: 0.2, y: 0, z: 0 }, inWater: true, onGround: true, sprinting: false, ...overrides });
    animation.setMotion(motion({}), now);
    animation.update(player, .1);
    expect(animation.getDiagnostics().state).not.toBe('swim');
    expect(player.rotation.x).toBe(0);
    now = 100;
    animation.setMotion(motion({ onGround: false, sprinting: true,
      position: { x: .3, y: 64, z: 0 } }), now);
    animation.update(player, .1);
    expect(animation.getDiagnostics().state).toBe('swim');
    expect(player.rotation.x).toBeGreaterThan(0);
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
