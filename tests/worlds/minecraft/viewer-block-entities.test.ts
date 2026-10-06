import { describe, expect, it } from 'vitest';
import { viewerBlockEntities, viewerChunkBlockEntities } from '../../../src/worlds/minecraft/viewer-block-entities.ts';

describe('viewer block entities', () => {
  it('maps local sign positions across positive and negative chunk origins', () => {
    const sign = { type: 'compound', value: { id: { type: 'string', value: 'minecraft:sign' } } };
    expect(viewerChunkBlockEntities({ x: -32, z: 48 }, {
      '0,64,15': sign,
      '15,70,0': sign,
      '16,64,0': sign,
      'bad': sign,
    })).toEqual({ '-32,64,63': sign, '-17,70,48': sign });
  });

  it('drops unloaded chunks from the published snapshot', () => {
    const chunks = new Map([
      ['0,0', viewerChunkBlockEntities({ x: 0, z: 0 }, { '1,65,2': { id: 'sign' } })],
      ['16,0', viewerChunkBlockEntities({ x: 16, z: 0 }, { '1,65,2': { id: 'hanging_sign' } })],
    ]);
    expect(Object.keys(viewerBlockEntities(chunks.values()))).toEqual(['1,65,2', '17,65,2']);
    chunks.delete('0,0');
    expect(Object.keys(viewerBlockEntities(chunks.values()))).toEqual(['17,65,2']);
  });
});
