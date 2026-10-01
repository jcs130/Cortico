import { describe, expect, it } from 'vitest';
import { viewerRenderableMetadata } from '../../../src/worlds/minecraft/viewer-render-metadata.ts';

describe('entity item metadata for the 1.20.6 renderer', () => {
  it('maps Mineflayer item type to the renderer itemId', () => {
    expect(viewerRenderableMetadata({ 0: 0, 1: { type: 267, itemCount: 1 } }))
      .toEqual({ 0: 0, 1: { type: 267, itemId: 267, itemCount: 1 } });
  });

  it('drops malformed slots without changing other metadata', () => {
    const source = { 0: 0, 1: { itemCount: 1 }, color: 'blue' };
    expect(viewerRenderableMetadata(source)).toEqual({ 0: 0, 1: null, color: 'blue' });
    expect(source[1]).toEqual({ itemCount: 1 });
  });
});
