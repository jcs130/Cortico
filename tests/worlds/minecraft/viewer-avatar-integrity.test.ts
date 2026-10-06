import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve('scripts/minecraft-viewer-avatar-integrity.js'), 'utf8');

describe('viewer local avatar integrity', () => {
  it('keeps armor facing forward when the skin wrapper is flipped', () => {
    const helmet = { name: 'geometry_armor_head', rotation: { y: 0 }, frustumCulled: true };
    const chest = { name: 'geometry_armor_chest', rotation: { y: 0 }, frustumCulled: true };
    const bodyMesh = { isMesh: true, frustumCulled: true };
    const skin = { name: 'mesh', rotation: { y: Math.PI }, userData: {},
      traverse: (visit: (part: typeof bodyMesh) => void) => visit(bodyMesh) };
    const scene = { children: [skin, helmet, chest] };
    const { align } = runInNewContext(`${source}\n({ align: cortiAlignAvatarArmor })`, {
      usesWorldAvatar: true,
      globalThis: { world: { entities: { entities: { '7': scene }, playerEntity: null } } },
    }) as { align: (entity: { id: number }) => void };
    align({ id: 7 });
    expect(helmet.rotation.y % (2 * Math.PI)).toBe(0);
    expect(chest.rotation.y % (2 * Math.PI)).toBe(0);
    expect(bodyMesh.frustumCulled).toBe(false);
    expect(helmet.frustumCulled).toBe(false);
  });

  it('removes an old self avatar only after the new one is authoritative', () => {
    const cache = new Map([['7', { id: 7, name: 'player', isSelf: true }], ['8', { id: 8, name: 'player', isSelf: true }],
      ['9', { id: 9, name: 'player', isSelf: false }]]);
    const removed: number[] = [];
    const context = {
      pendingAvatarState: { entity: { id: null as number | null } }, entityCache: cache,
      canonicalEntityName: (name: string) => name,
      handleEntity: (event: { id: number; delete: boolean }) => {
        if (event.delete) { cache.delete(String(event.id)); removed.push(event.id); }
      },
    };
    const { prune } = runInNewContext(`${source}\n({ prune: cortiPruneSelfEntities })`, context) as {
      prune: (entity: { id: number; name: string; isSelf: boolean }) => boolean;
    };
    prune({ id: 7, name: 'player', isSelf: true });
    expect(removed).toEqual([]);
    context.pendingAvatarState.entity.id = 8;
    expect(prune({ id: 7, name: 'player', isSelf: true })).toBe(true);
    expect(removed).toEqual([7]);
    expect(prune({ id: 8, name: 'player', isSelf: true })).toBe(false);
    expect([...cache.keys()]).toEqual(['8', '9']);
  });
});
