import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { biomeIdMap, remapViewerChunkBiomes } from '../../../src/worlds/minecraft/viewer-biome.ts';

const require = createRequire(import.meta.url);
const vanilla = (require('minecraft-data')('1.20.6') as {
  biomesArray: Array<{ id: number; name: string }>;
}).biomesArray;
const idOf = (name: string) => vanilla.find(biome => biome.name === name)!.id;

describe('viewer biome ID translation', () => {
  it('maps Paper runtime IDs to 1.20.6 names inside chunk palettes', () => {
    const ids = biomeIdMap({ biomes: {
      27: { id: 27, name: 'minecraft:plains' },
      99: { id: 99, name: 'river' },
      113: { id: 113, name: 'terralith:shrubland' },
      127: { id: 127, name: 'terralith:cave/fungal_caves' },
    } }, vanilla);
    const sections = ['block-state-bytes-must-stay-identical'];
    const packed = '{"data":[805335808,0],"capacity":64,"bitsPerValue":1}';
    const chunk = JSON.stringify({ worldHeight: 384, minY: -64, sections,
      biomes: [JSON.stringify({ type: 'single', value: 99 }),
        JSON.stringify({ type: 'indirect', palette: [27, 99, 113], data: packed })] });
    const decoded = JSON.parse(remapViewerChunkBiomes(chunk, ids, idOf('plains')));
    expect(decoded.sections).toEqual(sections);
    expect(JSON.parse(decoded.biomes[0]).value).toBe(idOf('river'));
    expect(JSON.parse(decoded.biomes[1]).palette).toEqual([
      idOf('plains'), idOf('river'), idOf('savanna'),
    ]);
    expect(JSON.parse(decoded.biomes[1]).data).toBe(packed);
    expect(ids.get(127)).toBe(idOf('mushroom_fields'));
  });

  it('keeps an unrecognized future serializer unchanged', () => {
    expect(remapViewerChunkBiomes('invalid', new Map([[99, 1]]), idOf('plains'))).toBe('invalid');
  });
});
