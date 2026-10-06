import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { executeIdleAction, IDLE_ACTIONS, sampleIdleActions } from '../../../src/worlds/minecraft/idle-actions.ts';

function scene() {
  const controls = new Map<string, boolean>();
  const changes: Array<{ key: string; value: boolean }> = [];
  const angles: Array<{ yaw: number; pitch: number; atMs: number }> = [];
  const previews: boolean[] = [];
  const overrides = new Map<string, string | null>();
  const blockPositions: Vec3[] = [];
  let blockedSight = false;
  let available = true;
  let swings = 0;
  const entity = { id: 1, position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0.12,
    height: 1.8, eyeHeight: 1.62, onGround: true, isValid: true };
  const bot = {
    entity, entities: {} as Record<number, typeof entity & { type: string; name?: string }>,
    heldItem: null as { name: string } | null,
    currentWindow: null as { id: number } | null,
    health: 20, food: 20,
    world: { raycast: () => blockedSight ? { position: new Vec3(1, 65, 0) } : null },
    blockAt: (p: Vec3) => {
      const position = p.floored();
      const key = `${position.x},${position.y},${position.z}`;
      const name = overrides.has(key) ? overrides.get(key) : position.y === 63 ? 'stone' : 'air';
      if (name === null) return null;
      return { position, name, boundingBox: name === 'stone' ? 'block' : 'empty',
        shapes: name === 'stone' ? [[0, 0, 0, 1, 1, 1]] : [], getProperties: () => ({}) };
    },
    canSeeBlock: () => !blockedSight,
    findBlocks: () => blockPositions,
    getControlState: (key: string) => controls.get(key) ?? false,
    setControlState: (key: string, value: boolean) => {
      controls.set(key, value); changes.push({ key, value });
    },
    look: async (yaw: number, pitch: number) => {
      entity.yaw = yaw; entity.pitch = pitch; angles.push({ yaw, pitch, atMs: Date.now() });
    },
    swingArm: () => { swings++; },
  };
  const cast = bot as unknown as Bot;
  const host = { available: () => available, inventoryPreview: (open: boolean) => { previews.push(open); } };
  return { bot, cast, host, controls, changes, angles, previews, overrides, blockPositions,
    sight: (blocked: boolean) => { blockedSight = blocked; },
    available: (value: boolean) => { available = value; }, swings: () => swings };
}

afterEach(() => vi.useRealTimers());

describe('Minecraft idle actions', () => {
  it('declares real protocol poses, optional short movement and a viewer inventory preview', () => {
    expect(IDLE_ACTIONS).toHaveLength(25);
    expect(new Set(IDLE_ACTIONS.map(a => a.id)).size).toBe(IDLE_ACTIONS.length);
    const s = scene();
    const ids = sampleIdleActions(s.cast, { allowMovement: false }).candidates.map(a => a.id);
    expect(ids).toContain('inventory_preview');
    expect(ids).toContain('wave');
    expect(ids).not.toContain('short_walk');
    expect(ids).not.toContain('look_hand');
    s.bot.heldItem = { name: 'iron_sword' };
    const armed = sampleIdleActions(s.cast, { allowMovement: false }).candidates.map(a => a.id);
    expect(armed).toContain('look_hand');
    expect(armed).not.toContain('wave');
    expect(armed).not.toContain('wave_twice');
  });

  it('samples only visible nearby targets and copies their positions', () => {
    const s = scene();
    s.bot.entities[2] = { ...s.bot.entity, id: 2, type: 'player', position: new Vec3(2, 64, 0) };
    s.blockPositions.push(new Vec3(2, 64, 1));
    s.overrides.set('2,64,1', 'poppy');
    const sample = sampleIdleActions(s.cast, { allowMovement: false });
    expect(sample.candidates.map(a => a.id)).toEqual(expect.arrayContaining(['look_player', 'look_flower']));
    expect(sample.state.targets).toMatchObject({ look_player: { entityId: 2, point: { x: 2, y: 64.9, z: 0 } } });
    s.bot.entities[2].position.x = 3;
    expect(sample.state.targets).toMatchObject({ look_player: { point: { x: 2 } } });
    s.sight(true);
    expect(sampleIdleActions(s.cast, { allowMovement: false }).candidates.map(a => a.id))
      .not.toEqual(expect.arrayContaining(['look_player', 'look_flower']));
    s.sight(false);
    s.overrides.set('1,65,0', null);
    expect(sampleIdleActions(s.cast, { allowMovement: false }).candidates.map(a => a.id)).not.toContain('look_player');
  });

  it('does not preview inventory over a real server window', async () => {
    const s = scene();
    s.bot.currentWindow = { id: 3 };
    expect(sampleIdleActions(s.cast, { allowMovement: false }).candidates.map(a => a.id)).not.toContain('inventory_preview');
    await executeIdleAction(s.cast, 'inventory_preview', {}, new AbortController().signal, s.host);
    expect(s.previews).toEqual([]);
    expect(s.bot.currentWindow).toEqual({ id: 3 });
  });

  it.each([['look_tree', 'oak_leaves'], ['look_flower', 'poppy']])
    ('executes %s from a serialized observation using Mineflayer Vec3 lookups', async (id, name) => {
      vi.useFakeTimers();
      const s = scene();
      s.blockPositions.push(new Vec3(2, 65, 1));
      s.overrides.set('2,65,1', name);
      const sample = sampleIdleActions(s.cast, { allowMovement: false });
      expect(sample.candidates.map(action => action.id)).toContain(id);
      const state = JSON.parse(JSON.stringify(sample.state));
      expect(state.targets[id].block.position).toEqual({ x: 2, y: 65, z: 1 });
      const done = executeIdleAction(s.cast, id, state, new AbortController().signal, s.host);
      await vi.advanceTimersByTimeAsync(6000);
      await done;
      expect(s.angles.some(angle => Math.abs(angle.yaw) > 0.15)).toBe(true);
      expect(s.bot.entity.yaw).toBeCloseTo(0);
      expect(s.changes).toEqual([]);
      s.overrides.set('2,65,1', 'stone');
      const writes = s.angles.length;
      await executeIdleAction(s.cast, id, state, new AbortController().signal, s.host);
      expect(s.angles).toHaveLength(writes);
    });

  it('closes only the viewer preview synchronously on abort', async () => {
    vi.useFakeTimers();
    const s = scene();
    const abort = new AbortController();
    const done = executeIdleAction(s.cast, 'inventory_preview', {}, abort.signal, s.host);
    const rejected = expect(done).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.previews).toEqual([true]);
    abort.abort();
    expect(s.previews).toEqual([true, false]);
    s.bot.currentWindow = { id: 8 };
    await rejected;
    expect(s.previews).toEqual([true, false]);
    expect(s.bot.currentWindow).toEqual({ id: 8 });
  });

  it('closes the local preview as soon as a real window opens', async () => {
    vi.useFakeTimers();
    const s = scene();
    const done = executeIdleAction(s.cast, 'inventory_preview', {}, new AbortController().signal, s.host);
    await vi.advanceTimersByTimeAsync(150);
    s.bot.currentWindow = { id: 4 };
    await vi.advanceTimersByTimeAsync(50);
    await done;
    expect(s.previews).toEqual([true, false]);
    expect(s.bot.currentWindow).toEqual({ id: 4 });
  });

  it('turns without jumps and restores the direction after finishing', async () => {
    vi.useFakeTimers();
    const s = scene();
    const original = { yaw: s.bot.entity.yaw, pitch: s.bot.entity.pitch };
    const done = executeIdleAction(s.cast, 'look_sky', {}, new AbortController().signal, s.host);
    await vi.advanceTimersByTimeAsync(6000);
    await done;
    let previous = original;
    for (const angle of s.angles) {
      expect(Math.abs(angle.yaw - previous.yaw)).toBeLessThanOrEqual(0.2);
      expect(Math.abs(angle.pitch - previous.pitch)).toBeLessThanOrEqual(0.2);
      previous = angle;
    }
    expect(Math.max(...s.angles.map(a => a.pitch))).toBeCloseTo(0.95);
    expect(s.bot.entity.yaw).toBeCloseTo(original.yaw);
    expect(s.bot.entity.pitch).toBeCloseTo(original.pitch);
  });

  it('finishes a side glance promptly and eases into and out of the turn', async () => {
    vi.useFakeTimers();
    const s = scene();
    const startedAtMs = Date.now();
    let finishedAtMs: number | undefined;
    const done = executeIdleAction(s.cast, 'look_left', {}, new AbortController().signal, s.host)
      .then(() => { finishedAtMs = Date.now(); });
    await vi.advanceTimersByTimeAsync(1200);
    await done;
    expect(finishedAtMs! - startedAtMs).toBeGreaterThan(600);
    expect(finishedAtMs! - startedAtMs).toBeLessThan(1100);
    const maximumYaw = Math.max(...s.angles.map(angle => angle.yaw));
    const peakIndex = s.angles.findIndex(angle => angle.yaw === maximumYaw);
    const outward = s.angles.slice(0, peakIndex + 1);
    const steps = outward.map((angle, i) => angle.yaw - (i === 0 ? 0 : outward[i - 1].yaw));
    expect(maximumYaw).toBeGreaterThan(0.5);
    expect(steps[0]).toBeLessThan(Math.max(...steps) * 0.6);
    expect(steps.at(-1)!).toBeLessThan(Math.max(...steps) * 0.6);
    expect(steps.every(step => step > 0 && step < 0.2)).toBe(true);
    expect(s.bot.entity.yaw).toBeCloseTo(0);
  });

  it('looks to both sides and returns to center without a prolonged sweep', async () => {
    vi.useFakeTimers();
    const s = scene();
    const startedAtMs = Date.now();
    let finishedAtMs: number | undefined;
    const done = executeIdleAction(s.cast, 'scan', {}, new AbortController().signal, s.host)
      .then(() => { finishedAtMs = Date.now(); });
    await vi.advanceTimersByTimeAsync(2500);
    await done;
    expect(finishedAtMs! - startedAtMs).toBeLessThan(2300);
    const left = s.angles.findIndex(angle => angle.yaw > 0.6);
    const right = s.angles.findIndex(angle => angle.yaw < -0.6);
    expect(left).toBeGreaterThan(0);
    expect(right).toBeGreaterThan(left);
    expect(s.bot.entity.yaw).toBeCloseTo(0);
    expect(s.changes).toEqual([]);
  });

  it('uses elapsed time so delayed look acknowledgements do not stretch every frame', async () => {
    vi.useFakeTimers();
    const s = scene();
    const look = s.bot.look;
    s.bot.look = async (yaw, pitch) => {
      await look(yaw, pitch);
      await new Promise(resolve => setTimeout(resolve, 100));
    };
    const startedAtMs = Date.now();
    let finishedAtMs: number | undefined;
    const done = executeIdleAction(s.cast, 'look_left', {}, new AbortController().signal, s.host)
      .then(() => { finishedAtMs = Date.now(); });
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(finishedAtMs! - startedAtMs).toBeLessThan(1500);
    expect(s.bot.entity.yaw).toBeCloseTo(0);
  });

  it('accelerates and slows the upward and downward pitch arcs without yaw drift', async () => {
    vi.useFakeTimers();
    const s = scene();
    const originalPitch = s.bot.entity.pitch;
    const done = executeIdleAction(s.cast, 'look_sky', {}, new AbortController().signal, s.host);
    await vi.advanceTimersByTimeAsync(1500);
    await done;
    const maximumPitch = Math.max(...s.angles.map(angle => angle.pitch));
    const peakIndex = s.angles.findIndex(angle => angle.pitch === maximumPitch);
    const upward = s.angles.slice(0, peakIndex + 1);
    const downward = s.angles.slice(peakIndex + 1);
    const rise = upward.map((angle, i) => angle.pitch - (i === 0 ? originalPitch : upward[i - 1].pitch));
    const fall = downward.map((angle, i) => (i === 0 ? maximumPitch : downward[i - 1].pitch) - angle.pitch);
    for (const steps of [rise, fall]) {
      expect(steps.every(step => step > 0 && step < 0.2)).toBe(true);
      expect(steps[0]).toBeLessThan(Math.max(...steps) * 0.6);
      expect(steps.at(-1)!).toBeLessThan(Math.max(...steps) * 0.6);
    }
    expect(s.angles.every(angle => angle.yaw === 0)).toBe(true);
    expect(s.bot.entity.pitch).toBeCloseTo(originalPitch);
  });

  it('allows a new gaze after cancellation without late writes from the old action', async () => {
    vi.useFakeTimers();
    const s = scene();
    const abort = new AbortController();
    const first = executeIdleAction(s.cast, 'scan', {}, abort.signal, s.host);
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100);
    abort.abort();
    const handoffYaw = s.bot.entity.yaw;
    const handoffPitch = s.bot.entity.pitch;
    const writes = s.angles.length;
    const next = executeIdleAction(s.cast, 'look_sky', {}, new AbortController().signal, s.host);
    await vi.advanceTimersByTimeAsync(1600);
    await next;
    await rejected;
    expect(s.angles.slice(writes).every(angle => angle.yaw === handoffYaw)).toBe(true);
    expect(s.bot.entity.yaw).toBeCloseTo(handoffYaw);
    expect(s.bot.entity.pitch).toBeCloseTo(handoffPitch);
  });

  it('takes the short yaw arc across pi when looking at a target', async () => {
    vi.useFakeTimers();
    const s = scene();
    s.bot.entity.yaw = Math.PI - 0.04;
    s.bot.entities[2] = { ...s.bot.entity, id: 2, type: 'player', position: new Vec3(0.56, 64, 2.5) };
    const { state } = sampleIdleActions(s.cast, { allowMovement: false });
    const done = executeIdleAction(s.cast, 'look_player', state, new AbortController().signal, s.host);
    await vi.advanceTimersByTimeAsync(4000);
    await done;
    expect(s.angles.every(a => Math.abs(a.yaw - Math.PI) < 0.12)).toBe(true);
    expect(s.bot.entity.yaw).toBeCloseTo(Math.PI - 0.04);
  });

  it('never restores an old view after another owner takes over', async () => {
    vi.useFakeTimers();
    const s = scene();
    const abort = new AbortController();
    const done = executeIdleAction(s.cast, 'scan', {}, abort.signal, s.host);
    const rejected = expect(done).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(150);
    abort.abort();
    s.available(false);
    s.bot.entity.yaw = 2.4;
    s.bot.entity.pitch = -0.5;
    const writes = s.angles.length;
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(s.angles).toHaveLength(writes);
    expect(s.bot.entity).toMatchObject({ yaw: 2.4, pitch: -0.5 });
  });

  it('releases owned sneak before abort returns and does not clear the next owner sneak', async () => {
    vi.useFakeTimers();
    const s = scene();
    const abort = new AbortController();
    const done = executeIdleAction(s.cast, 'crouch', {}, abort.signal, s.host);
    const rejected = expect(done).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.controls.get('sneak')).toBe(true);
    abort.abort();
    expect(s.controls.get('sneak')).toBe(false);
    s.bot.setControlState('sneak', true);
    await rejected;
    expect(s.controls.get('sneak')).toBe(true);
    expect(s.changes).toEqual([{ key: 'sneak', value: true }, { key: 'sneak', value: false }, { key: 'sneak', value: true }]);
  });

  it('does not take ownership of sneak already set by someone else', async () => {
    const s = scene();
    s.controls.set('sneak', true);
    await executeIdleAction(s.cast, 'crouch', {}, new AbortController().signal, s.host);
    expect(s.controls.get('sneak')).toBe(true);
    expect(s.changes).toEqual([]);
  });

  it.each(['water', 'lava', 'powder_snow', 'cobweb', null, 'air'])('does not step into unsafe or unloaded terrain: %s', (name) => {
    const s = scene();
    s.overrides.set('0,63,-1', name);
    expect(sampleIdleActions(s.cast, { allowMovement: true }).candidates.map(a => a.id)).not.toContain('short_walk');
  });

  it('rejects head obstructions, nonlevel footing and an edge within the stopping margin', () => {
    const s = scene();
    expect(sampleIdleActions(s.cast, { allowMovement: true }).candidates.map(a => a.id)).toContain('short_walk');
    s.overrides.set('0,65,-1', 'stone');
    expect(sampleIdleActions(s.cast, { allowMovement: true }).candidates.map(a => a.id)).not.toContain('short_walk');
    s.overrides.clear();
    s.bot.entity.position.y = 64.5;
    expect(sampleIdleActions(s.cast, { allowMovement: true }).candidates.map(a => a.id)).not.toContain('short_walk');
    s.bot.entity.position.y = 64;
    s.overrides.set('0,63,-2', 'air');
    expect(sampleIdleActions(s.cast, { allowMovement: true }).candidates.map(a => a.id)).not.toContain('short_walk');
  });

  it('rechecks corridor safety before moving and only owns forward until synchronous cancellation', async () => {
    vi.useFakeTimers();
    const s = scene();
    const { state } = sampleIdleActions(s.cast, { allowMovement: true });
    s.overrides.set('0,64,-1', 'water');
    await executeIdleAction(s.cast, 'short_walk', state, new AbortController().signal, s.host);
    expect(s.changes).toEqual([]);
    s.overrides.clear();
    const abort = new AbortController();
    const done = executeIdleAction(s.cast, 'short_walk', state, abort.signal, s.host);
    const rejected = expect(done).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.controls.get('forward')).toBe(true);
    abort.abort();
    expect(s.controls.get('forward')).toBe(false);
    s.bot.setControlState('forward', true);
    await rejected;
    expect(s.controls.get('forward')).toBe(true);
    expect(s.changes.every(change => change.key === 'forward')).toBe(true);
  });

  it('finishes a short step from actual position without changing other controls', async () => {
    vi.useFakeTimers();
    const s = scene();
    const { state } = sampleIdleActions(s.cast, { allowMovement: true });
    const physics = setInterval(() => {
      if (s.controls.get('forward')) s.bot.entity.position.z -= 0.2;
    }, 50);
    const done = executeIdleAction(s.cast, 'short_walk', state, new AbortController().signal, s.host);
    await vi.advanceTimersByTimeAsync(800);
    await done;
    clearInterval(physics);
    expect(s.bot.entity.position.z).toBeLessThanOrEqual(-0.5);
    expect(s.bot.entity.position.z).toBeGreaterThan(-0.9);
    expect(s.controls.get('forward')).toBe(false);
    expect(s.changes.every(change => change.key === 'forward')).toBe(true);
    expect(s.angles).toEqual([]);
  });

  it.each(['short_walk', 'crouch'])('releases its own controls when %s becomes unavailable without an abort', async (id) => {
    vi.useFakeTimers();
    const s = scene();
    const { state } = sampleIdleActions(s.cast, { allowMovement: true });
    const abort = new AbortController();
    const done = executeIdleAction(s.cast, id, state, abort.signal, s.host);
    const rejected = expect(done).rejects.toMatchObject({ name: 'AbortError' });
    const key = id === 'short_walk' ? 'forward' : 'sneak';
    expect(s.controls.get(key)).toBe(true);
    // No other owner has claimed the body: a fall or fresh hazard invalidates
    // availability before the World event that would deliver an abort.
    s.available(false);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(abort.signal.aborted).toBe(false);
    expect(s.controls.get(key)).toBe(false);
    expect(s.changes).toEqual([{ key, value: true }, { key, value: false }]);
  });

  it('stops the next camera frame when availability is lost without restoring the view', async () => {
    vi.useFakeTimers();
    const s = scene();
    const done = executeIdleAction(s.cast, 'look_left', {}, new AbortController().signal, s.host);
    const rejected = expect(done).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100);
    s.available(false);
    const last = s.angles.at(-1);
    const count = s.angles.length;
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(s.angles).toHaveLength(count);
    expect(s.bot.entity.yaw).toBe(last?.yaw);
  });

  it('rejects a target that has gone behind a wall and waving with a newly equipped weapon', async () => {
    const s = scene();
    s.bot.entities[2] = { ...s.bot.entity, id: 2, type: 'player', position: new Vec3(2, 64, 0) };
    const { state } = sampleIdleActions(s.cast, { allowMovement: false });
    s.sight(true);
    await executeIdleAction(s.cast, 'look_player', state, new AbortController().signal, s.host);
    expect(s.angles).toEqual([]);
    s.bot.heldItem = { name: 'diamond_sword' };
    await executeIdleAction(s.cast, 'wave', state, new AbortController().signal, s.host);
    expect(s.swings()).toBe(0);
  });
});
