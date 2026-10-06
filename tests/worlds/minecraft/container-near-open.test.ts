import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { openNearbyContainer } from '../../../src/worlds/minecraft/containers.ts';

describe('近距离打开仓库', () => {
  it('站在箱边时直接开窗，不启动寻路', async () => {
    const win = { id: 1, inventoryStart: 27 };
    const block = { name: 'chest' };
    const openContainer = vi.fn(async () => win);
    const bot = {
      entity: { position: new Vec3(-499, 69, -474) },
      currentWindow: null,
      blockAt: vi.fn(() => block),
      openContainer,
    };
    const result = await openNearbyContainer(bot as never,
      { x: -498, y: 69, z: -476, name: 'chest' }, { aborted: () => false } as never);
    expect(result).toBe(win);
    expect(openContainer).toHaveBeenCalledWith(block);
  });
});
