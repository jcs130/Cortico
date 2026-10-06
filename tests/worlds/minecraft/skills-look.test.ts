import { describe, expect, it } from 'vitest';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { parseSteps } from '../../../src/worlds/minecraft/skills.ts';
import { skillLook } from '../../../src/worlds/minecraft/skills-look.ts';
import type { SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';

function scene() {
  let tick = 0;
  const bot = {
    entity: { position: new Vec3(10.5, 64, -3.5), height: 1.62, yaw: 0, pitch: 0 },
    lookAt: async (point: Vec3) => {
      const delta = point.minus(bot.entity.position.offset(0, bot.entity.height, 0));
      bot.entity.yaw = Math.atan2(-delta.x, -delta.z);
      bot.entity.pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
    },
    waitForTicks: async (count: number) => { tick += count; },
    activateBlock: () => { throw Error('unexpected block use'); },
    dig: () => { throw Error('unexpected digging'); },
    setControlState: () => { throw Error('unexpected movement'); },
  };
  const ctx = { aborted: () => false } as SkillContext;
  return { bot, ctx, tick: () => tick };
}

describe('coordinate look action', () => {
  it('parses relative coordinates and resolved waypoints, rejecting a missing height', () => {
    expect(parseSteps([{ skill: 'look', at: ['~2', '~3', '~-1'] }])).toMatchObject({
      steps: [{ skill: 'look', at: ['~2', '~3', '~-1'] }],
    });
    expect(parseSteps([{ skill: 'look', at: 'house' }], name => name === 'house' ? [12, 68, -2] : null))
      .toMatchObject({ steps: [{ skill: 'look', at: [12, 68, -2] }] });
    expect(parseSteps([{ skill: 'look', at: [12, -2] }])).toHaveProperty('error');
  });

  it('turns toward an elevated target and waits for rotation delivery without moving or interacting', async () => {
    const s = scene();
    const before = s.bot.entity.position.clone();
    const result = await skillLook(s.bot as unknown as Bot,
      { skill: 'look', at: ['~5', '~4', '~'] }, s.ctx);
    expect(s.bot.entity.position).toEqual(before);
    expect(s.bot.entity.yaw).toBeCloseTo(-Math.PI / 2);
    expect(s.bot.entity.pitch).toBeCloseTo(Math.atan2(2.88, 5));
    expect(s.tick()).toBe(1);
    expect(result).toContain('(15, 68, -4)');
    expect(result).toContain('是否可见');
  });

  it('allows a later look to change viewpoint after the first completes', async () => {
    const s = scene();
    await skillLook(s.bot as unknown as Bot, { skill: 'look', at: [15, 68, -4] }, s.ctx);
    const yaw = s.bot.entity.yaw;
    await skillLook(s.bot as unknown as Bot, { skill: 'look', at: [10, 65, 8] }, s.ctx);
    expect(s.bot.entity.yaw).not.toBe(yaw);
    expect(s.bot.entity.pitch).toBeLessThan(0);
    expect(s.bot.entity.position).toEqual(new Vec3(10.5, 64, -3.5));
  });

  it('does not claim completion when cancelled during rotation delivery', async () => {
    const s = scene();
    let cancelled = false;
    s.ctx.aborted = () => cancelled;
    s.bot.waitForTicks = async () => { cancelled = true; };
    await expect(skillLook(s.bot as unknown as Bot, { skill: 'look', at: [15, 68, -4] }, s.ctx))
      .rejects.toThrow('aborted');
  });
});
