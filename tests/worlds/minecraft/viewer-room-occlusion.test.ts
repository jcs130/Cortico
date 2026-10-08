import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { hasDeepRoof, hasRoomCeiling, patchRoomOcclusion, roomCutoffWorldY, roomOcclusionMode, shouldHideUpperEntity } from '../../../scripts/minecraft-viewer-room-occlusion.mjs';

const sourceRoot = process.env.MINECRAFT_MODERN_VIEWER_ROOT || path.resolve('../mc-visual-console/packages/modern-viewer/renderer-src');
const clientFile = path.join(sourceRoot, 'src/modern-viewer/client.js');

describe('Minecraft room occlusion', () => {
  it('detects a nearby roof only when it covers the avatar and neighboring blocks', () => {
    const solid = new Set(['0,66,0', '1,66,0', '0,66,1']);
    const cache = { isSolidBlock: (x: number, y: number, z: number) => solid.has(`${x},${y},${z}`) };
    expect(hasRoomCeiling({ x: 0.4, y: 64, z: 0.4 }, cache)).toBe(true);
    expect(hasRoomCeiling({ x: 5.4, y: 64, z: 0.4 }, cache)).toBe(false);
    solid.delete('0,66,1');
    expect(hasRoomCeiling({ x: 0.4, y: 64, z: 0.4 }, cache)).toBe(false);
  });

  it('keeps the dungeon cut above the avatar and the third-person cut above the floor', () => {
    expect(roomCutoffWorldY(64.3, true)).toBe(65.95);
    expect(roomCutoffWorldY(64.3, false)).toBe(64.35);
    expect(roomOcclusionMode(true, true)).toBe('cutaway');
    expect(roomOcclusionMode(false, true)).toBe('translucent');
    expect(roomOcclusionMode(true, false)).toBe('translucent');
  });

  it('treats thick overhead stone as a mine roof and a thin house roof as room cover', () => {
    const solid = new Set([66, 67, 68, 69].map((y) => `0,${y},0`));
    const cache = { isSolidBlock: (x: number, y: number, z: number) => solid.has(`${x},${y},${z}`) };
    expect(hasDeepRoof({ x: 0.4, y: 64, z: 0.4 }, cache)).toBe(false);
    solid.add('0,70,0');
    expect(hasDeepRoof({ x: 0.4, y: 64, z: 0.4 }, cache)).toBe(true);
  });

  it('hides only entities on a higher floor in dungeon view', () => {
    expect(shouldHideUpperEntity(66, 64.3)).toBe(true);
    expect(shouldHideUpperEntity(65.9, 64.3)).toBe(false);
    expect(shouldHideUpperEntity(66, 64.3, true)).toBe(false);
  });

  it.skipIf(!existsSync(clientFile))('cuts the dungeon roof and keeps third-person room dither', () => {
    const client = patchRoomOcclusion(readFileSync(clientFile, 'utf8'));
    expect(client).toContain('function installDungeonOcclusion() {\n  if (!usesWorldAvatar) return;');
    expect(client).toContain('deepRoof || trace.occluded || roomCeiling,');
    expect(client).not.toContain('isDungeonView || deepRoof');
    expect(client).toContain('typeof collisionCache?.isSolidBlock !== "function"');
    expect(client).toContain('cutoffWorldY: roomCutoffWorldY(avatar.y, hardCutaway),');
    expect(client).toContain('getUpperCutawayY: () => dungeonUpperCutawayY');
    expect(client).toContain('lanternAlongRaw <= 1.0');
    expect(client).toContain('lanternCutawayRegion = lanternBeyondFirstHit && lanternInSightCorridor');
    expect(client).not.toContain('    record.mode = "plane";');

    const start = client.indexOf('function patchDungeonCutawayShader(material) {');
    const end = client.indexOf('\nfunction applyDungeonCutaway(', start);
    const shaderPatch = client.slice(start, end);
    const patch = runInNewContext(`${shaderPatch}\npatchDungeonCutawayShader`, {
      Vector3: class {}, DUNGEON_OCCLUSION_CORRIDOR_RADIUS: 1.85,
    }) as (material: Record<string, unknown>) => boolean;
    const material = {
      vertexShader: 'void main() {\nvec3 relativePos = vec3(0.0);\n}',
      fragmentShader: 'void main() {\n}', uniforms: {} as Record<string, unknown>,
      userData: {} as Record<string, unknown>, needsUpdate: false,
    };
    expect(patch(material)).toBe(true);
    expect(material.fragmentShader).toContain('gl_FragCoord');
    expect(material.fragmentShader).toContain('4.0 * lanternLowRank + lanternHighRank >= lanternCoverage');
    const upperLayer = material.fragmentShader.match(/if \((u_lanternCutawayEnabled > 1\.5[^)]*)\) discard/)?.[1];
    expect(upperLayer).toBeDefined();
    for (const along of [-2, 0, 0.5, 1, 3]) {
      const clipped = (y: number) => runInNewContext(upperLayer!, {
        u_lanternCutawayEnabled: 2, u_lanternCutawayY: 65.95,
        v_lanternCutawayPosition: { y }, lanternHardCutawayRegion: true, lanternAlongRaw: along,
      });
      expect(clipped(66)).toBe(true);
      expect(clipped(65.9)).toBe(false);
    }
    expect(material.fragmentShader).not.toContain('u_lanternCutawayEnabled > 1.5 && lanternInSightCorridor && v_lanternCutawayPosition.y > u_lanternCutawayY) discard');
    expect(material.fragmentShader).toContain('lanternAlongRaw >= max(0.0, u_lanternCutawayHitAlong - u_lanternCutawayHalfSpan) && lanternAlongRaw <= 1.0 + u_lanternCutawayHalfSpan');
    const sightRange = material.fragmentShader.match(/bool lanternBeyondFirstHit = ([^;]+);/)?.[1];
    expect(sightRange).toBeDefined();
    const cutAt = (along: number) => runInNewContext(sightRange!, {
      lanternAlongRaw: along,
      u_lanternCutawayHitAlong: 0.35,
      u_lanternCutawayHalfSpan: 0.1,
      max: Math.max,
    }) as boolean;
    expect(cutAt(0.2)).toBe(false);
    expect(cutAt(0.35)).toBe(true);
    expect(cutAt(0.9)).toBe(true);
    expect(cutAt(1.05)).toBe(true);
    expect(cutAt(1.2)).toBe(false);
    expect(material.uniforms).toHaveProperty('u_lanternCutawayEnabled');
  });
});
