import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { observeViewerSounds, viewerSoundPacket, viewerSoundStopPacket, type ViewerSound,
  type ViewerSoundStop } from '../../../src/worlds/minecraft/viewer-sound-packets.ts';

const registry = { sounds: { 0: { name: 'entity.allay.ambient_with_item' },
  12: { name: 'entity.skeleton.shoot' } } };
const at = { x: 4, y: 64, z: -8 };
const packet = { sound: { soundId: 12 }, soundCategory: 'hostile', x: 32, y: 512, z: -64,
  volume: 1, pitch: 1.4, seed: [0, 17] };

describe('viewer sound packet bridge', () => {
  it('preserves Java 1.20.6 registry IDs, fixed point coordinates and categories', () => {
    expect(viewerSoundPacket('sound_effect', packet, registry, () => null)).toEqual({
      name: 'entity.skeleton.shoot', category: 'hostile', position: at, volume: 1, pitch: 1.4, seed: '17',
    });
    expect(viewerSoundPacket('sound_effect', { ...packet, sound: { soundId: 0 }, soundCategory: 'player' },
      registry, () => null)).toMatchObject({ name: 'entity.allay.ambient_with_item', category: 'players' });
  });

  it('reads direct sounds and custom namespaces without changing pitch into a narrow range', () => {
    expect(viewerSoundPacket('sound_effect', { ...packet, sound: { data: {
      soundName: 'example:spell.wind', fixedRange: 40 } }, pitch: 2.6, soundCategory: 'block' },
    registry, () => null)).toMatchObject({ name: 'example:spell.wind', fixedRange: 40, pitch: 2.6, category: 'blocks' });
    expect(viewerSoundPacket('named_sound_effect', { ...packet, sound: undefined,
      soundName: 'minecraft:block.note_block.harp' }, registry, () => null)?.name).toBe('block.note_block.harp');
  });

  it('resolves entity sounds at the entity position and declines unknown spatial origins', () => {
    expect(viewerSoundPacket('entity_sound_effect', { ...packet, entityId: 21 }, registry,
      id => id === 21 ? at : null)).toMatchObject({ entityId: 21, position: at });
    expect(viewerSoundPacket('entity_sound_effect', { ...packet, entityId: 22 }, registry,
      () => null)).toBeNull();
    expect(viewerSoundPacket('entity_sound_effect', { ...packet, entityId: '21' }, registry,
      () => at)).toBeNull();
  });

  it('handles all stop flags and category aliases', () => {
    expect(viewerSoundStopPacket({ flags: 0 })).toEqual({});
    expect(viewerSoundStopPacket({ flags: 1, source: 1 })).toEqual({ category: 'music' });
    expect(viewerSoundStopPacket({ flags: 2, sound: 'minecraft:music.game' })).toEqual({ name: 'music.game' });
    expect(viewerSoundStopPacket({ flags: 3, source: 2, sound: 'example:music.grove' }))
      .toEqual({ category: 'records', name: 'example:music.grove' });
    for (const bad of [{ flags: 4 }, { flags: 1, source: 11 }, { flags: 2, sound: '../bad' },
      { flags: 3, source: 4 }, { flags: '0' }]) expect(viewerSoundStopPacket(bad)).toBeNull();
  });

  it('rejects invalid packets before producing browser events', () => {
    for (const bad of [{ ...packet, volume: Number.NaN }, { ...packet, x: Number.POSITIVE_INFINITY },
      { ...packet, sound: { soundId: 9999 } }, { ...packet, sound: { data: { soundName: 'javascript:alert(1)' } } }])
      expect(viewerSoundPacket('sound_effect', bad, registry, () => at)).toBeNull();
  });

  it('forwards raw packets once, bounds a burst and detaches all listeners', () => {
    const protocol = new EventEmitter();
    const sounds: ViewerSound[] = [], stops: ViewerSoundStop[] = [];
    let time = 1000;
    const dispose = observeViewerSounds(protocol, registry, () => at, event => sounds.push(event),
      event => stops.push(event), () => time);
    protocol.emit('sound_effect', packet);
    // Mineflayer emits this derivative too. It is not a source for this bridge.
    protocol.emit('soundEffectHeard', 'entity.skeleton.shoot', at, 1, 1.4);
    expect(sounds).toHaveLength(1);
    protocol.emit('entity_sound_effect', { ...packet, entityId: 2 });
    protocol.emit('stop_sound', { flags: 1, source: 1 });
    expect(sounds).toHaveLength(2);
    expect(stops).toEqual([{ category: 'music' }]);
    for (let index = 0; index < 140; index++) protocol.emit('sound_effect', packet);
    expect(sounds).toHaveLength(128);
    time += 1000;
    protocol.emit('sound_effect', packet);
    expect(sounds).toHaveLength(129);
    dispose();
    protocol.emit('sound_effect', packet);
    protocol.emit('stop_sound', { flags: 0 });
    expect(sounds).toHaveLength(129);
    expect(stops).toHaveLength(1);
    expect(protocol.eventNames()).toEqual([]);
  });
});
