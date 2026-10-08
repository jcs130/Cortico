import { describe, expect, it } from 'vitest';
import { viewerPlayerSkin } from '../../../src/worlds/minecraft/viewer-player-skin.ts';
import { ownEntity, viewerEntity } from '../../../src/worlds/minecraft/modern-viewer.ts';

describe('server player appearance', () => {
  const hash = 'a'.repeat(64);
  const entity = { id: 8, name: 'player', position: { x: 0, y: 64, z: 0 }, username: 'Visitor', uuid: 'profile-id' };
  const fixture = (url = `http://textures.minecraft.net/texture/${hash}`, model = 'slim') => ({
    username: 'Visitor', entity, inventory: { slots: [] },
    players: { Visitor: { uuid: entity.uuid, skinData: { url, model } } },
  });

  it('forwards the server texture and arm shape for both self and nearby players', () => {
    const bot = fixture() as never;
    const expected = { uuid: entity.uuid, skinUrl: `/head-texture/${hash}.png`, skinModel: 'slim' };
    expect(ownEntity(bot)).toMatchObject(expected);
    expect(viewerEntity(bot, entity as never)).toMatchObject(expected);
    expect(viewerPlayerSkin(bot, undefined, entity.uuid)).toMatchObject({ skinModel: 'slim' });
    expect(viewerPlayerSkin(fixture(undefined, 'default') as never, 'Visitor')).toMatchObject({ skinModel: 'classic' });
  });

  it('does not accept arbitrary remote URLs or invented skins when no server texture exists', () => {
    for (const url of [`https://example.invalid/texture/${hash}`, `file:///texture/${hash}`,
      `https://textures.minecraft.net/texture/${hash}?other=1`, `https://textures.minecraft.net:8443/texture/${hash}`]) {
      expect(viewerPlayerSkin(fixture(url) as never, 'Visitor')).toEqual({});
    }
    expect(viewerPlayerSkin({ players: {} } as never, 'Visitor')).toEqual({});
    const noProfile = { ...fixture(), players: {} } as never;
    expect(ownEntity(noProfile)).toMatchObject({ skinUrl: null, skinModel: null });
    expect(viewerEntity(noProfile, entity as never)).toMatchObject({ skinUrl: null, skinModel: null });
  });
});
