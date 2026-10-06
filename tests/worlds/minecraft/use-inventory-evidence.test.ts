import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from 'mineflayer';
import { invSnapshot } from '../../../src/worlds/minecraft/inventory.ts';
import { useInvNote, useOnce } from '../../../src/worlds/minecraft/skills-interact.ts';
import type { SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';

afterEach(() => vi.useRealTimers());

describe('use inventory evidence', () => {
  it('inventory differences remain net observations, including unrelated pickups', () => {
    const items = [{ name: 'torch', count: 5 }, { name: 'cobblestone', count: 3 }];
    const bot = { inventory: { items: () => items } } as unknown as Bot;
    const before = invSnapshot(bot);
    items[0].count -= 1;
    items[1].count += 2;
    const result = useInvNote(before, bot);
    expect(result).toContain('背包净增:圆石×2');
    expect(result).toContain('背包净减:火把×1');
    expect(result).not.toContain('用掉');
    expect(useInvNote(invSnapshot(bot), bot)).toBe('');
  });

  it('an unregistered item use cannot be confirmed by a pickup during its observation window', async () => {
    vi.useFakeTimers();
    const items = [{ name: 'torch', count: 5 }, { name: 'cobblestone', count: 3 }];
    const bot = {
      _client: { write: () => {} },
      heldItem: items[0], inventory: { items: () => items }, registry: {}, currentWindow: null,
      activateItem: async () => { setTimeout(() => { items[1].count += 2; }, 100); },
      deactivateItem: () => {},
    } as unknown as Bot;
    const result = useOnce(bot, { skill: 'use' }, { aborted: () => false } as SkillContext);
    await vi.runAllTimersAsync();
    const receipt = await result;
    expect(receipt).toContain('发送了使用请求');
    expect(receipt).toContain('背包净增:圆石×2');
    expect(receipt).toContain('不能单独证明本次使用生效');
  });
});
