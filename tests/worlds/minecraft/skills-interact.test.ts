import { describe, expect, it } from 'vitest';
import { useOnce } from '../../../src/worlds/minecraft/skills-interact.ts';
import type { SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';
import { V, withBotEvents } from './executor-harness.ts';

describe('use 扔三叉戟', () => {
  it('按住满 10 刻再松手,三叉戟才离手', async () => {
    // 原版规则:松手时蓄力不足 10 刻不掷出,一直按着也不掷出
    let tick = 0;
    let chargedAt: number | null = null;
    const bag = [{ name: 'trident', count: 1 }];
    const bot = {
      entity: { position: new V(0, 64, 0) },
      inventory: { items: () => bag.filter((i) => i.count > 0) },
      heldItem: null as unknown,
      equip: async (item: unknown) => { bot.heldItem = item; },
      lookAt: async () => undefined,
      waitForTicks: async (n: number) => { tick += n; },
      activateItem: () => { chargedAt = tick; },
      deactivateItem: () => {
        if (chargedAt !== null && tick - chargedAt >= 10) bag[0].count -= 1;
        chargedAt = null;
      },
    };
    const call = { skill: 'use', item: 'trident', at: [10, 64, 0] } as never;
    withBotEvents(bot);
    const ctx = { aborted: () => false } as SkillContext;
    await expect(useOnce(bot as never, call, ctx)).resolves.toContain('包里还有 0 个(扔前 1)');
  });
});
