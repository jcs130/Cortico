import { describe, expect, it } from 'vitest';
import { observeViewerAttack } from '../../../src/worlds/minecraft/viewer-entity-state.ts';
import { viewerRoute } from '../../../src/worlds/minecraft/viewer-tactics.ts';

describe('read-only tactical viewer cues', () => {
  it('sends a bounded local route and the actual destination', () => {
    const path = Array.from({ length: 200 }, (_, x) => ({ x, y: 64, z: 0 }));
    const route = viewerRoute({ status: 'partial', path }, { x: -1, y: 64, z: 0 },
      { x: 2_000, y: 70, z: -400 });
    expect(route.status).toBe('partial');
    expect(route.points.length).toBe(64);
    expect(route.points[0]).toEqual({ x: -1, y: 64, z: 0 });
    expect(route.goal).toEqual({ x: 2_000, y: 70, z: -400 });
  });

  it('rejects invalid path coordinates', () => {
    const route = viewerRoute({ path: [{ x: Infinity, y: 64, z: 0 },
      { x: 1, y: 64, z: 1 }] }, { x: 0, y: 64, z: 0 }, null);
    expect(route.points).toHaveLength(2);
  });

  it('marks only actual outgoing attack packets and restores the writer', () => {
    const sent: string[] = [];
    const targets: number[] = [];
    const protocol = { write(name: string, _params?: Record<string, unknown>) { sent.push(name); } };
    const original = protocol.write;
    const stop = observeViewerAttack(protocol, id => targets.push(id));
    protocol.write('use_entity', { target: 42, mouse: false });
    protocol.write('use_entity', { target: 42, mouse: true });
    protocol.write('use_entity', { target: -1, mouse: true });
    expect(sent).toEqual(['use_entity', 'use_entity', 'use_entity']);
    expect(targets).toEqual([42]);
    stop();
    expect(protocol.write).toBe(original);
  });
});
