import { describe, expect, it, vi } from 'vitest';
import { untilHit } from '../../../src/worlds/minecraft/until.ts';

vi.mock('../../../src/worlds/minecraft/terrain.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/worlds/minecraft/terrain.ts')>(),
  canSeeBlockAt: (_bot: unknown, p: { x: number }) => p.x === 2,
}));

describe('early stop for travel and tunnel', () => {
  const hidden = { x: 1, y: 55, z: 1 };
  const exposed = { x: 2, y: 55, z: 1 };
  const bot = {
    findBlocks: () => [hidden, exposed],
    blockAt: () => ({ name: 'iron_ore' }),
  };

  it('ignores buried ore and stops at ore visible to collect', () => {
    expect(untilHit(bot as never, [1], 4)).toMatchObject(exposed);
  });

  it('does not stop when all nearby ore is buried', () => {
    const onlyHidden = { ...bot, findBlocks: () => [hidden] };
    expect(untilHit(onlyHidden as never, [1], 4)).toBeNull();
  });
});
