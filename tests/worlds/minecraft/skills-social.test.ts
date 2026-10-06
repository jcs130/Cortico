import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { parseSteps } from '../../../src/worlds/minecraft/skills.ts';
import { skillGesture } from '../../../src/worlds/minecraft/skills-social.ts';
import type { SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';

function scene() {
  const events: string[] = [];
  const state = { sneak: false };
  const player = {
    type: 'player', isValid: true, height: 1.8, position: new Vec3(2, 64, 0),
  };
  const bot = {
    entity: { position: new Vec3(0, 64, 0), height: 1.8, yaw: 1, pitch: 0.2 },
    players: { Alice: { entity: player } },
    world: { raycast: () => null },
    heldItem: null,
    lookAt: async () => { events.push('look'); },
    look: async (yaw: number, pitch: number) => {
      bot.entity.yaw = yaw;
      bot.entity.pitch = pitch;
      events.push('lookDir');
    },
    swingArm: () => { events.push('swing'); },
    getControlState: (key: string) => key === 'sneak' && state.sneak,
    setControlState: (key: string, value: boolean) => {
      if (key === 'sneak') state.sneak = value;
      events.push(`${key}:${value}`);
    },
    attack: () => { throw new Error('gesture must not attack'); },
    chat: () => { throw new Error('gesture must not send chat'); },
  };
  let aborted = false;
  const ctx = { aborted: () => aborted, bodyState: () => ({ combatActive: false }) } as SkillContext;
  return { bot, ctx, events, state, player, abort: () => { aborted = true; } };
}

afterEach(() => vi.useRealTimers());

describe('Minecraft social gestures', () => {
  it('parses a named player and a bounded motion', () => {
    expect(parseSteps([{ skill: 'gesture', name: 'Alice', motion: 'wave' }])).toMatchObject({
      steps: [{ skill: 'gesture', name: 'Alice', motion: 'wave' }],
    });
    expect(parseSteps([{ skill: 'gesture', name: 'Alice', motion: 'dance' }])).toHaveProperty('error');
    expect(parseSteps([{ skill: 'gesture', name: 'Alice', motion: 'beckon' }])).toMatchObject({
      steps: [{ skill: 'gesture', name: 'Alice', motion: 'beckon' }],
    });
    expect(parseSteps([{ skill: 'gesture', name: 'Alice', motion: 'shake_head' }])).toMatchObject({
      steps: [{ skill: 'gesture', name: 'Alice', motion: 'shake_head' }],
    });
  });

  it('waves without attacking or chatting', async () => {
    vi.useFakeTimers();
    const s = scene();
    const done = skillGesture(s.bot as unknown as Bot,
      { skill: 'gesture', name: 'Alice', motion: 'wave' }, s.ctx);
    await vi.advanceTimersByTimeAsync(500);
    expect(await done).toContain('挥了两下手');
    expect(s.events).toEqual(['look', 'swing', 'swing']);
  });

  it('releases crouch when interrupted', async () => {
    vi.useFakeTimers();
    const s = scene();
    const done = skillGesture(s.bot as unknown as Bot,
      { skill: 'gesture', name: 'Alice', motion: 'bow' }, s.ctx);
    const rejected = expect(done).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(100);
    s.abort();
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(s.state.sneak).toBe(false);
    expect(s.events).toEqual(['look', 'sneak:true', 'sneak:false']);
  });

  it('beckons a nearby player without attacking, chatting or moving', async () => {
    vi.useFakeTimers();
    const s = scene();
    const done = skillGesture(s.bot as unknown as Bot,
      { skill: 'gesture', name: 'Alice', motion: 'beckon' }, s.ctx);
    await vi.advanceTimersByTimeAsync(500);
    expect(await done).toContain('招了招手');
    expect(s.events).toEqual(['look', 'swing', 'sneak:true', 'sneak:false', 'swing']);
    expect(s.state.sneak).toBe(false);
  });

  it('releases the beckon crouch if another task interrupts it', async () => {
    vi.useFakeTimers();
    const s = scene();
    const done = skillGesture(s.bot as unknown as Bot,
      { skill: 'gesture', name: 'Alice', motion: 'beckon' }, s.ctx);
    const rejected = expect(done).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(300);
    s.abort();
    await vi.advanceTimersByTimeAsync(300);
    await rejected;
    expect(s.state.sneak).toBe(false);
    expect(s.events).toEqual(['look', 'swing', 'sneak:true', 'sneak:false']);
  });

  it('does not change sneak when interrupted before the beckon crouch', async () => {
    vi.useFakeTimers();
    const s = scene();
    const done = skillGesture(s.bot as unknown as Bot,
      { skill: 'gesture', name: 'Alice', motion: 'beckon' }, s.ctx);
    const rejected = expect(done).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(0);
    s.abort();
    await vi.advanceTimersByTimeAsync(300);
    await rejected;
    expect(s.events).toEqual(['look', 'swing']);
  });

  it('shakes its head and restores the original direction', async () => {
    vi.useFakeTimers();
    const s = scene();
    const done = skillGesture(s.bot as unknown as Bot,
      { skill: 'gesture', name: 'Alice', motion: 'shake_head' }, s.ctx);
    await vi.advanceTimersByTimeAsync(400);
    expect(await done).toContain('摇了摇头');
    expect(s.events).toEqual(['look', 'lookDir', 'lookDir', 'lookDir']);
    expect(s.bot.entity.yaw).toBe(1);
    expect(s.bot.entity.pitch).toBe(0.2);
  });

  it('requires a visible nearby player and an empty hand for waving', async () => {
    const s = scene();
    s.player.position = new Vec3(12, 64, 0);
    await expect(skillGesture(s.bot as unknown as Bot,
      { skill: 'gesture', name: 'Alice', motion: 'wave' }, s.ctx)).rejects.toThrow('6 格内');
    s.player.position = new Vec3(2, 64, 0);
    s.bot.heldItem = { name: 'diamond_sword' } as never;
    await expect(skillGesture(s.bot as unknown as Bot,
      { skill: 'gesture', name: 'Alice', motion: 'wave' }, s.ctx)).rejects.toThrow('主手腾空');
    expect(s.events).toEqual([]);
  });
});
