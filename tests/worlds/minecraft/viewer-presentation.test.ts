import { describe, expect, it } from 'vitest';
import { parseViewerCustomEvent, viewerBiomeClimate, viewerExplosion, viewerPacketLane, viewerParticle, viewerWorldEvent } from '../../../src/worlds/minecraft/viewer-presentation.ts';

describe('viewer presentation event boundaries', () => {
  it('preserves the named 1.20.6 particle and bounds its fan-out', () => {
    expect(viewerParticle({ x: 1, y: 2, z: 3, offsetX: 1, offsetY: 0, offsetZ: 1,
      velocityOffset: .2, amount: 2000, particle: { type: 'dust', data: { red: .2, green: .4, blue: .8 } } }))
      .toMatchObject({ kind: 'particle', name: 'dust', count: 48, color: [.2, .4, .8] });
  });

  it('keeps explosion and world-event positions without raw packet contents', () => {
    expect(viewerExplosion({ x: 1, y: 2, z: 3, radius: 99, affectedBlockOffsets: Array(1000) }))
      .toEqual({ kind: 'explosion', position: { x: 1, y: 2, z: 3 }, radius: 12 });
    expect(viewerWorldEvent({ effectId: 2001, location: { x: 1, y: 2, z: 3 }, data: 4 }))
      .toEqual({ kind: 'world_event', position: { x: 1, y: 2, z: 3 }, effectId: 2001, data: 4 });
  });

  it('resolves block break states and jukebox item IDs through the actual registry', () => {
    const registry = { blocksByStateId: { 4: { name: 'grass_block' } },
      items: { 20: { name: 'music_disc_cat' } } };
    const base = { location: { x: 1, y: 2, z: 3 } };
    expect(viewerWorldEvent({ ...base, effectId: 2001, data: 4 }, registry)?.blockName).toBe('grass_block');
    expect(viewerWorldEvent({ ...base, effectId: 1010, data: 20 }, registry)?.itemName).toBe('music_disc_cat');
    expect(viewerWorldEvent({ ...base, effectId: 1011, data: 20 }, registry)).not.toHaveProperty('itemName');
    expect(viewerWorldEvent({ ...base, effectId: 2001, data: 999 }, registry)).not.toHaveProperty('blockName');
    expect(viewerWorldEvent({ ...base, effectId: 1010, data: 0 }, registry)).not.toHaveProperty('itemName');
  });

  it('forwards only known biome climate fields without guessing precipitation', () => {
    expect(viewerBiomeClimate({ name: 'desert', temperature: 2, has_precipitation: false }))
      .toEqual({ temperature: 2, hasPrecipitation: false });
    expect(viewerBiomeClimate({ name: 'snowy_plains', temperature: 0, has_precipitation: true }))
      .toEqual({ temperature: 0, hasPrecipitation: true });
    expect(viewerBiomeClimate({ precipitation: 'snow' })).toEqual({ precipitation: 'snow' });
    expect(viewerBiomeClimate({ name: 'unknown', precipitation: 'future', temperature: Number.NaN }))
      .toEqual({});
    expect(viewerBiomeClimate(null)).toEqual({});
  });

  it('accepts semantic custom events without HTML or arbitrary payload fields', () => {
    const event = { schemaVersion: 1, kind: 'skill', id: 'goddess:flame_wave',
      title: '焰浪', body: '命中 3 名敌人', tone: 'arcane', position: { x: 1, y: 2, z: 3 }, html: '<script>' };
    expect(parseViewerCustomEvent('mcviewer:event', Buffer.from(JSON.stringify(event))))
      .toEqual({ kind: 'skill', id: 'goddess:flame_wave', title: '焰浪', body: '命中 3 名敌人',
        tone: 'arcane', position: { x: 1, y: 2, z: 3 } });
    expect(parseViewerCustomEvent('mcagent:event', Buffer.from(JSON.stringify(event))))
      .toMatchObject({ kind: 'skill', id: 'goddess:flame_wave' });
  });

  it('accepts AgentFriend skill tones and bounded raw UTF-8 payloads', () => {
    const sample = { schemaVersion: 1, kind: 'skill', id: 'starbolt', title: '星芒箭',
      body: '命中 僵尸', tone: 'arcane', position: { x: -589.5, y: 92.62, z: -326.15 } };
    for (const tone of ['arcane', 'healing', 'frost', 'fire', 'movement']) {
      const payload = Buffer.from(JSON.stringify({ ...sample, tone, extra: 'a'.repeat(5_000) }), 'utf8');
      expect(parseViewerCustomEvent('mcagent:event', payload)).toMatchObject({
        id: 'starbolt', tone, position: sample.position,
      });
    }
    expect(parseViewerCustomEvent('mcagent:event', Buffer.from(JSON.stringify({ ...sample, tone: 'future' }))))
      .toMatchObject({ tone: 'arcane' });
    expect(parseViewerCustomEvent('mcagent:event', Buffer.from(JSON.stringify({ ...sample, extra: 'x'.repeat(16_384) }))))
      .toBeNull();
    expect(parseViewerCustomEvent('mcagent:event', Buffer.from([0, 3, 123]))).toBeNull();
  });

  it('keeps the home skill landing point for the on-screen cast cue', () => {
    const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'skill',
      id: 'home', title: '归乡', body: '传送完成', tone: 'movement',
      position: { x: -543.5, y: 67, z: -439.5 } }), 'utf8');
    expect(parseViewerCustomEvent('mcagent:event', payload)).toEqual({ kind: 'skill',
      id: 'home', title: '归乡', body: '传送完成', tone: 'movement',
      position: { x: -543.5, y: 67, z: -439.5 } });
  });

  it('keeps unknown packet names visible in the coverage audit', () => {
    expect(viewerPacketLane('world_particles')).toBe('presentation');
    expect(viewerPacketLane('collect')).toBe('presentation');
    expect(viewerPacketLane('map_chunk')).toBe('world');
    expect(viewerPacketLane('action_bar')).toBe('hud');
    expect(viewerPacketLane('experience')).toBe('hud');
    expect(viewerPacketLane('sound_effect')).toBe('presentation');
    expect(viewerPacketLane('entity_sound_effect')).toBe('presentation');
    expect(viewerPacketLane('stop_sound')).toBe('presentation');
    expect(viewerPacketLane('custom_payload')).toBe('plugin');
    expect(viewerPacketLane('update_view_position')).toBe('control');
    expect(viewerPacketLane('position')).toBe('control');
    expect(viewerPacketLane('simulation_distance')).toBe('control');
    expect(viewerPacketLane('initialize_world_border')).toBe('control');
    expect(viewerPacketLane('set_ticking_state')).toBe('control');
    expect(viewerPacketLane('step_tick')).toBe('control');
    expect(viewerPacketLane('keep_alive')).toBe('control');
    expect(viewerPacketLane('new_server_feature')).toBe('unmapped');
  });
});
