import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { MinecraftWorld } from '../../../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS } from '../../../src/worlds/minecraft/config.ts';
import { ServerActionWait } from '../../../src/worlds/minecraft/server-action-wait.ts';
import { parseSteps, type SkillCall } from '../../../src/worlds/minecraft/executor.ts';
import { useOnce } from '../../../src/worlds/minecraft/skills-interact.ts';
import type { SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';
import { FakeHost } from '../../helpers/fake-host.ts';

const { navigation } = vi.hoisted(() => ({ navigation: vi.fn() }));
vi.mock('../../../src/worlds/minecraft/travel.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/worlds/minecraft/travel.ts')>(),
  reachCell: navigation,
}));

const AT: [number, number, number] = [1, 64, 0];
const packet = { location: new Vec3(...AT), direction: 1, hand: 0 };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000); navigation.mockReset(); navigation.mockResolvedValue(undefined); });
afterEach(() => vi.useRealTimers());

function rig(target = 'white_bed') {
  const packets: string[] = [];
  const protocol = Object.assign(new EventEmitter(), { write: (name: string, _params?: Record<string, unknown>): unknown => { packets.push(name); return undefined; } });
  const inventory = Object.assign(new EventEmitter(), { slots: Array(46).fill(null), items: () => [] });
  let stateId = 10;
  const bot = Object.assign(new EventEmitter(), {
    _client: protocol, inventory, heldItem: null, currentWindow: null,
    entity: { position: new Vec3(0.5, 64, 0.5) }, game: { dimension: 'overworld' },
    registry: { foodsByName: {} }, time: { timeOfDay: 1_000 },
    blockAt: (position: Vec3) => ({ name: target, type: 1, stateId, position,
      getProperties: () => ({ open: false }) }),
    activateBlock: async (block: { position: Vec3 }) => protocol.write('block_place', { ...packet, location: block.position }),
  });
  const world = new MinecraftWorld({ cfg: structuredClone(MINECRAFT_DEFAULTS) });
  let execution = Promise.resolve('');
  const submissions: SkillCall[][] = [];
  const executor = { status: () => ({ running: null, waiting: [], hold: null }), repeatSuccessHold: () => null,
    submit: (steps: SkillCall[], _mode: unknown, _raw: unknown, admitted: (value: boolean) => void) => {
      admitted(true); submissions.push(steps);
      execution = useOnce(bot as unknown as Bot, steps[0] as Extract<SkillCall, { skill: 'use' }>,
        { aborted: () => false } as SkillContext).catch((error: Error) => error.message);
      return '已排进队列';
    } };
  Object.assign(world, { host: new FakeHost(), executor, bridge: { bot } });
  (world as any).hookBotEvents(bot);
  const submit = (item?: string) => (world as any).enqueueTool('mc_do', { steps: [{ skill: 'use', at: AT, ...(item ? { item } : {}) }] }, parseSteps);
  return { world, bot, protocol, packets, submissions, submit, execution: () => execution,
    changeBlock: () => { stateId++; } };
}

describe('interaction cooldown follows actual block use', () => {
  it.each([['bed', 'white_bed'], ['axe', 'oak_door'], ['chest', 'chest']])
    ('missing %s does not block an itemless correction at the same %s', async (item, target) => {
      const r = rig(target);
      expect(r.submit(item)).toContain('已排进队列');
      expect(await r.execution()).toContain('包里没有');
      expect(r.packets).toEqual([]);
      expect(r.submit()).toContain('已排进队列');
      await vi.runAllTimersAsync(); await r.execution();
      expect(r.submissions).toHaveLength(2);
      expect(r.packets).toEqual(['block_place']);
    });

  it('navigation failure does not start a target interaction wait', async () => {
    const r = rig(); navigation.mockRejectedValueOnce(new Error('route unavailable'));
    expect(r.submit()).toContain('已排进队列');
    expect(await r.execution()).toBe('route unavailable');
    expect(r.packets).toEqual([]);
    expect(r.submit()).toContain('已排进队列');
    await vi.runAllTimersAsync(); await r.execution();
    expect(r.packets).toEqual(['block_place']);
  });

  it('a sent use remains throttled after failed readback, and a changed block allows correction', async () => {
    const r = rig('oak_door');
    expect(r.submit()).toContain('已排进队列');
    await vi.runAllTimersAsync();
    expect(await r.execution()).toContain('open false → false');
    expect(r.submit()).toMatchObject({ failed: true, text: expect.stringContaining('同一格刚右键过') });
    expect(r.packets).toEqual(['block_place']);
    r.changeBlock();
    expect(r.submit()).toContain('已排进队列');
    await vi.runAllTimersAsync(); await r.execution();
    expect(r.packets).toEqual(['block_place', 'block_place']);
  });

  it('a sent packet can still bind the actual server countdown', async () => {
    const r = rig(); r.protocol.write('block_place', packet);
    (r.world as any).serverActionWait.noteFeedback('还需 30 秒');
    expect(r.submit()).toMatchObject({ failed: true, text: expect.stringContaining('还需 30 秒') });
  });

  it('only the current connection records packets, duplicate hookup is idempotent and end restores its wrapper', () => {
    const r = rig(); const observed = r.protocol.write;
    (r.world as any).hookBotEvents(r.bot);
    expect(r.protocol.write).toBe(observed);
    Object.assign(r.world, { bridge: { bot: {} } });
    r.protocol.write('block_place', packet);
    const guard = (r.world as any).serverActionWait as ServerActionWait;
    expect(guard.blockReason(AT, Date.now(), (r.world as any).useObservation(AT))).toBeNull();
    r.protocol.emit('end');
    expect(r.protocol.write).not.toBe(observed);
  });

  it('records the pre-write observation and preserves the transport receiver, result and throw', () => {
    const guard = new ServerActionWait(); let state = 'before';
    const protocol = { write(this: unknown, _name: string, _params?: Record<string, unknown>): unknown { expect(this).toBe(protocol); state = 'after'; return 'written'; } };
    const detach = guard.observeUses(protocol, () => state);
    expect(protocol.write('block_place', packet)).toBe('written');
    expect(guard.blockReason(AT, Date.now(), 'before')).toContain('现场可见状态没有变化');
    expect(guard.blockReason(AT, Date.now(), 'after')).toBeNull();
    detach();
    protocol.write = () => { throw new Error('transport failed'); };
    guard.observeUses(protocol, () => state);
    expect(() => protocol.write('block_place', packet)).toThrow('transport failed');
    expect(guard.blockReason(AT, Date.now(), state)).toBeNull();
  });

  it('ignores non-block packets, item-use sentinels, malformed coordinates and a closed serializer', () => {
    const guard = new ServerActionWait(); let writable = true;
    const protocol = { serializer: { get writable() { return writable; } }, write: (_name: string, _params?: Record<string, unknown>): unknown => undefined };
    guard.observeUses(protocol, () => 'unchanged');
    protocol.write('use_item', { hand: 0 });
    protocol.write('block_place', { location: new Vec3(-1, 255, -1), direction: 255 });
    protocol.write('block_place', { location: new Vec3(1.5, 64, 0), direction: 1 });
    writable = false; protocol.write('block_place', packet);
    expect(guard.blockReason(AT, Date.now(), 'unchanged')).toBeNull();
    expect(guard.blockReason([-1, 255, -1], Date.now(), 'unchanged')).toBeNull();
  });

  it('teardown never overwrites a later transport wrapper', () => {
    const guard = new ServerActionWait(); const protocol = { write: (_name: string, _params?: Record<string, unknown>): unknown => undefined };
    const detach = guard.observeUses(protocol, () => 'unchanged');
    const observed = protocol.write;
    const later = (name: string, params?: Record<string, unknown>) => observed.call(protocol, name, params);
    protocol.write = later; detach();
    expect(protocol.write).toBe(later);
  });
});
