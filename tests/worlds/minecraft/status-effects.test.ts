import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { observeStatusEffects, remainingEffectTicks } from '../../../src/worlds/minecraft/status-effects.ts';
import { narrateWorld, snapshotFromBot } from '../../../src/worlds/minecraft/terrain.ts';

interface Effect { id: number; amplifier: number; duration: number }
function rig() {
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 0), effects: {} as Record<number, Effect> },
    entities: {}, registry: { effects: { 19: { name: 'Poison' } }, biomes: {}, blocksByName: {} },
    game: { dimension: 'overworld', gameMode: 'survival' },
    health: 20, food: 20, oxygenLevel: 20, time: { timeOfDay: 1000 }, rainState: 0,
    heldItem: null, inventory: { items: () => [] }, players: {},
    findBlocks: () => [], blockAt: () => null, world: { raycast: () => null },
  });
  observeStatusEffects(bot);
  const receive = (duration: number) => {
    const effect = { id: 19, amplifier: 0, duration };
    bot.entity.effects[effect.id] = effect;
    bot.emit('entityEffect', bot.entity, effect);
    return effect;
  };
  return { bot, receive };
}

afterEach(() => vi.useRealTimers());

describe('status effect receipt clock', () => {
  it('snapshots and viewer replay read elapsed time without changing the server record', () => {
    vi.useFakeTimers();
    const r = rig();
    const effect = r.receive(500);
    vi.advanceTimersByTime(7_000);
    expect(snapshotFromBot(r.bot).effects).toEqual([{ name: 'Poison', level: 1, seconds: 18 }]);
    expect(remainingEffectTicks(effect)).toBe(360);
    observeStatusEffects(r.bot);
    vi.advanceTimersByTime(3_000);
    expect(snapshotFromBot(r.bot).effects[0].seconds).toBe(15);
    expect(remainingEffectTicks(effect)).toBe(300);
    expect(effect.duration).toBe(500);
  });

  it('a renewal packet starts a new duration, even when its effect ID is unchanged', () => {
    vi.useFakeTimers();
    const r = rig();
    r.receive(500);
    vi.advanceTimersByTime(20_000);
    expect(snapshotFromBot(r.bot).effects[0].seconds).toBe(5);
    r.receive(900);
    vi.advanceTimersByTime(1_000);
    expect(snapshotFromBot(r.bot).effects[0].seconds).toBe(44);
    expect(r.bot.listenerCount('entityEffect')).toBe(1);
  });

  it('an elapsed duration remains unconfirmed until the server removes the effect', () => {
    vi.useFakeTimers();
    const r = rig();
    r.receive(20);
    vi.advanceTimersByTime(2_000);
    const snapshot = snapshotFromBot(r.bot);
    expect(snapshot.effects[0].seconds).toBe(0);
    expect(narrateWorld(snapshot)).toContain('等待服务端确认结束');
    expect(r.bot.entity.effects[19].duration).toBe(20);
    delete r.bot.entity.effects[19];
    r.bot.emit('entityEffectEnd', r.bot.entity, { id: 19 });
    expect(snapshotFromBot(r.bot).effects).toEqual([]);
  });

  it('a new connection cannot inherit an old connection clock for the same effect ID', () => {
    vi.useFakeTimers();
    const first = rig();
    first.receive(500);
    vi.advanceTimersByTime(20_000);
    const second = rig();
    second.receive(500);
    expect(snapshotFromBot(first.bot).effects[0].seconds).toBe(5);
    expect(snapshotFromBot(second.bot).effects[0].seconds).toBe(25);
  });

  it('late observers seed existing effects once, and preserve the protocol infinity value', () => {
    vi.useFakeTimers();
    const effect = { duration: 100 };
    const bot = Object.assign(new EventEmitter(), { entity: { effects: { 1: effect } } });
    observeStatusEffects(bot);
    vi.advanceTimersByTime(50);
    expect(remainingEffectTicks(effect)).toBe(99);
    observeStatusEffects(bot);
    vi.advanceTimersByTime(50);
    expect(remainingEffectTicks(effect)).toBe(98);
    expect(remainingEffectTicks({ duration: -1 })).toBe(-1);
  });
});
