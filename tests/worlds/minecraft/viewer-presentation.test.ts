import { describe, expect, it } from 'vitest';
import { parseViewerCustomEvent, viewerExplosion, viewerPacketLane, viewerParticle, viewerWorldEvent } from '../../../src/worlds/minecraft/viewer-presentation.ts';

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

  it('accepts semantic custom events without HTML or arbitrary payload fields', () => {
    const event = { schemaVersion: 1, kind: 'skill', id: 'goddess:flame_wave',
      title: '焰浪', body: '命中 3 名敌人', tone: 'arcane', position: { x: 1, y: 2, z: 3 }, html: '<script>' };
    expect(parseViewerCustomEvent('mcviewer:event', Buffer.from(JSON.stringify(event))))
      .toEqual({ kind: 'skill', id: 'goddess:flame_wave', title: '焰浪', body: '命中 3 名敌人',
        tone: 'arcane', position: { x: 1, y: 2, z: 3 } });
    expect(parseViewerCustomEvent('mcagent:event', Buffer.from(JSON.stringify(event))))
      .toMatchObject({ kind: 'skill', id: 'goddess:flame_wave' });
  });

  it('keeps unknown packet names visible in the coverage audit', () => {
    expect(viewerPacketLane('world_particles')).toBe('presentation');
    expect(viewerPacketLane('collect')).toBe('presentation');
    expect(viewerPacketLane('map_chunk')).toBe('world');
    expect(viewerPacketLane('action_bar')).toBe('hud');
    expect(viewerPacketLane('experience')).toBe('hud');
    expect(viewerPacketLane('sound_effect')).toBe('presentation');
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
