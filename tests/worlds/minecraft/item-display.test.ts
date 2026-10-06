import { describe, expect, it } from 'vitest';
import { itemCustomName, itemProfileSkinHash } from '../../../src/worlds/minecraft/item-display.ts';

describe('item display names', () => {
  it('reads the server name from 1.20.6 components', () => {
    const item = { name: 'player_head', components: [
      { type: 'custom_name', data: '{"text":"大","extra":[{"text":"背包"}]}' },
    ] };
    expect(itemCustomName(item)).toBe('大背包');
  });

  it('does not infer a name from player_head alone', () => {
    expect(itemCustomName({})).toBeNull();
  });

  it('reads item_name when custom_name is absent', () => {
    expect(itemCustomName({ componentMap: new Map([['minecraft:item_name', { data: { text: '大背包' } }]]) }))
      .toBe('大背包');
  });

  it('reads the 1.20.6 NBT chat component carried by a player head', () => {
    const component = { type: 'compound', value: {
      text: { type: 'string', value: '' },
      extra: { type: 'list', value: { type: 'compound', value: [
        { text: { type: 'string', value: '大背包' }, color: { type: 'string', value: 'gold' } },
      ] } },
    } };
    expect(itemCustomName({ customName: component })).toBe('大背包');
  });

  it('accepts only a Mojang texture hash from the profile component', () => {
    const hash = 'a'.repeat(64);
    const profile = (host: string) => ({ components: [{ type: 'profile', data: { properties: [{
      name: 'textures', value: Buffer.from(JSON.stringify({ textures: { SKIN: {
        url: `http://${host}/texture/${hash}`,
      } } })).toString('base64'),
    }] } }] });
    expect(itemProfileSkinHash(profile('textures.minecraft.net'))).toBe(hash);
    expect(itemProfileSkinHash(profile('other.example'))).toBeNull();
  });
});
