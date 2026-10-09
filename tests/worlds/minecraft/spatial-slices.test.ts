import { describe, expect, it } from 'vitest';
import { PROBE_SLICE_TEXT_CAP, renderSpatialSlices, type SpatialSliceAxis,
  type SpatialSliceCell } from '../../../src/worlds/minecraft/spatial-slices.ts';

function section(cells: SpatialSliceCell[], axis: SpatialSliceAxis = 'y'): string {
  const text = renderSpatialSlices({ axis, cells, observedAt: '2026-10-09T08:00:00.000Z',
    dimension: 'minecraft:the_nether', feet: { x: -2, y: 64, z: 3 } });
  if (typeof text !== 'string') throw new Error(text.error);
  return text;
}

function cube(): SpatialSliceCell[] {
  return [64, 65].flatMap(y => [3, 4].flatMap(z => [-2, -1].map(x => {
    const name = y === 64 && z === 3 && x === -2 ? 'stone'
      : y === 64 && z === 4 && x === -1 ? 'stone_slab'
      : y === 65 && z === 4 && x === -1 ? 'ladder' : 'air';
    return { c: { x, y, z }, name, air: name === 'air', state: '',
      collision: name === 'stone_slab' ? [[0, 0, 0, 1, 0.5, 1]] : undefined };
  })));
}

describe('coordinate-preserving spatial sections', () => {
  it.each([
    ['y', '[y=64]\nz=3: 00 ..\nz=4: .. 01\n[y=65]\nz=3: .. ..\nz=4: .. 02'],
    ['z', '[z=3]\ny=65: .. ..\ny=64: 00 ..\n[z=4]\ny=65: .. 02\ny=64: .. 01'],
    ['x', '[x=-2]\ny=65: .. ..\ny=64: 00 ..\n[x=-1]\ny=65: .. 02\ny=64: .. 01'],
  ] as const)('keeps exact cell positions with world-axis orientation along %s', (axis, map) => {
    const text = section(cube(), axis);
    expect(text).toContain(map);
    expect(text).toContain('x=-2..-1,y=64..65,z=3..4');
    expect(text).toContain('dimension=minecraft:the_nether');
    expect(text).toContain('01=stone_slab;collision=[[0,0,0,1,0.5,1]]');
    expect(text).toContain('02=ladder;collision=未读');
  });

  it('distinguishes layouts with identical material totals', () => {
    const cells = cube(), moved = structuredClone(cells);
    const stone = moved.find(c => c.name === 'stone')!;
    const air = moved.find(c => c.c.x === -1 && c.c.y === 64 && c.c.z === 3)!;
    [stone.c, air.c] = [air.c, stone.c];
    expect(section(cells)).toContain('[y=64]\nz=3: 00 ..');
    expect(section(moved)).toContain('[y=64]\nz=3: .. 00');
  });

  it('keeps unread and omitted samples distinct from observed air or empty collision', () => {
    const text = section([
      { c: { x: 0, y: 64, z: 0 }, name: 'air', air: true, state: '', collision: [] },
      { c: { x: 1, y: 64, z: 0 }, name: null, air: false, state: '' },
      { c: { x: 3, y: 64, z: 0 }, name: 'torch', air: false, state: '', collision: [] },
    ]);
    expect(text).toContain('z=0: .. ?? ?? 00');
    expect(text).toContain('00=torch;collision=[]');
  });

  it('refuses wide sparse bounds and oversized text without returning a cropped map', () => {
    const base = { axis: 'y' as const, observedAt: '2026-10-09T08:00:00Z', dimension: null,
      feet: { x: 0, y: 0, z: 0 } };
    expect(renderSpatialSlices({ ...base, cells: [
      { c: { x: 0, y: 0, z: 0 }, name: null, air: false, state: '' },
      { c: { x: 1_000_000_000, y: 0, z: 0 }, name: null, air: false, state: '' },
    ] })).toMatchObject({ error: expect.stringContaining('请缩小探查范围') });
    expect(renderSpatialSlices({ ...base, cells: [
      { c: { x: 0, y: 0, z: 0 }, name: 'stone', air: false, state: 'x'.repeat(PROBE_SLICE_TEXT_CAP) },
    ] })).toMatchObject({ error: expect.stringContaining('未返回截断地图') });
  });
});
