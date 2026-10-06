import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadViewerSoundRegistry, validateViewerSoundRegistry } from '../../../src/worlds/minecraft/viewer-sound-registry.ts';
import { viewerSoundPacket } from '../../../src/worlds/minecraft/viewer-sound-packets.ts';

const catalogue = () => ({ schemaVersion: 1, minecraftVersion: '1.20.6',
  clientJarSha256: '02dfd345ac1ad55692d5dbc8486ac7e4fea72cd54ac494a79cd48963048e56b2',
  events: Object.fromEntries(Array.from({ length: 1607 }, (_, id) => [String(id), { name:
    ({ 325: 'minecraft:entity.cod.ambient', 515: 'minecraft:entity.fish.swim',
      1450: 'minecraft:entity.villager.ambient' } as Record<number, string>)[id] ?? `minecraft:fixture.sound_${id}` }])) });

describe('exact viewer sound registry', () => {
  it('decodes actual 1.20.6 IDs as fish and villagers instead of the inherited 1.20.4 names', () => {
    const registry = validateViewerSoundRegistry(catalogue(), '1.20.6')!;
    for (const [id, name] of [[325, 'entity.cod.ambient'], [515, 'entity.fish.swim'], [1450, 'entity.villager.ambient']] as const) {
      expect(viewerSoundPacket('sound_effect', { sound: { soundId: id }, soundCategory: 6,
        x: 8, y: 512, z: 16, volume: 1, pitch: 1 }, registry, () => null)?.name).toBe(name);
    }
    expect(Object.keys(registry.sounds!)).toHaveLength(1607);
  });

  it('rejects mismatched versions, hashes, partial IDs and invalid or repeated names', () => {
    expect(validateViewerSoundRegistry(catalogue(), '1.20.4')).toBeNull();
    for (const mutate of [
      (value: ReturnType<typeof catalogue>) => { value.minecraftVersion = '1.20.4'; },
      (value: ReturnType<typeof catalogue>) => { value.clientJarSha256 = 'a'.repeat(64); },
      (value: ReturnType<typeof catalogue>) => { delete value.events['515']; },
      (value: ReturnType<typeof catalogue>) => { value.events['515'] = { name: '../invalid' }; },
      (value: ReturnType<typeof catalogue>) => { value.events['515'] = value.events['325']!; },
    ]) { const value = catalogue(); mutate(value); expect(validateViewerSoundRegistry(value, '1.20.6')).toBeNull(); }
  });

  it('loads exact assets and never falls back to the known wrong 1.20.4 table for 1.20.6', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'viewer-sound-registry-'));
    const inherited = { sounds: { 325: { name: 'block.copper_grate.step' } } };
    try {
      const missing = await loadViewerSoundRegistry(root, '1.20.6', inherited);
      expect(missing.source).toBe('unavailable'); expect(missing.registry.sounds).toEqual({});
      expect(missing.diagnostic).toMatch(/编号表/);
      expect(viewerSoundPacket('sound_effect', { sound: { data: { soundName: 'minecraft:ui.button.click' } },
        x: 0, y: 0, z: 0, volume: 1, pitch: 1 }, missing.registry, () => null)?.name).toBe('ui.button.click');
      const directory = path.join(root, 'public', 'sounds'); await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'registry.json'), JSON.stringify(catalogue()));
      expect((await loadViewerSoundRegistry(root, '1.20.6', inherited)).source).toBe('exact-assets');
      await writeFile(path.join(directory, 'registry.json'), 'invalid');
      expect((await loadViewerSoundRegistry(root, '1.20.6', inherited)).source).toBe('unavailable');
      expect((await loadViewerSoundRegistry(root, '1.20.4', inherited)).registry).toBe(inherited);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
