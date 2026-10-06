import { describe, expect, it } from 'vitest';
import { compactStackKey, skillCompact } from '../../../src/worlds/minecraft/skills-container.ts';
import { parseSteps } from '../../../src/worlds/minecraft/skills.ts';

type Stack = { name: string; type: number; count: number; stackSize: number; slot: number;
  components?: unknown[] };

function rig(title = '个人试炼奖励箱') {
  const slots = Array.from({ length: 90 }, () => null) as Array<Stack | null>;
  const win = { title, inventoryStart: 54, inventoryEnd: 90, slots };
  let clicks = 0;
  const bot = {
    currentWindow: win as typeof win | null,
    registry: { itemsByName: {} },
    moveSlotItem: async (source: number, dest: number) => {
      clicks++;
      const from = slots[source]!;
      const to = slots[dest]!;
      if (compactStackKey(from) !== compactStackKey(to)) throw new Error('incompatible');
      const amount = Math.min(from.count, to.stackSize - to.count);
      to.count += amount;
      from.count -= amount;
      if (from.count === 0) slots[source] = null;
    },
    closeWindow: () => { bot.currentWindow = null; },
  };
  return { bot, slots, get clicks() { return clicks; } };
}

describe('已打开容器合堆', () => {
  it('Cortico 技能表能受理打开个人箱并整理的两步任务', () => {
    expect(parseSteps([
      { skill: 'chat', text: '/mycli arena rewards' },
      { skill: 'compact' },
    ])).toEqual({ steps: [
      { skill: 'chat', text: '/mycli arena rewards' },
      { skill: 'compact' },
    ] });
  });

  it('相同物品组件合堆并释放奖励箱空格', async () => {
    const h = rig();
    h.slots[0] = { name: 'arrow', type: 4, count: 40, stackSize: 64, slot: 0 };
    h.slots[1] = { name: 'arrow', type: 4, count: 24, stackSize: 64, slot: 1 };
    for (let i = 2; i < 54; i++) h.slots[i] = { name: 'iron_sword', type: 5, count: 1, stackSize: 1, slot: i };
    const result = await skillCompact(h.bot as never, { aborted: () => false } as never);
    expect(result).toContain('空格 0→1');
    expect(h.slots[0]?.count).toBe(64);
    expect(h.slots[1]).toBeNull();
    expect(h.clicks).toBe(1);
    expect(h.bot.currentWindow).toBeNull();
  });

  it('不同附魔组件与不可堆叠装备不合并', async () => {
    const h = rig();
    h.slots[0] = { name: 'tipped_arrow', type: 8, count: 10, stackSize: 64, slot: 0,
      components: [{ type: 'potion_contents', data: 'healing' }] };
    h.slots[1] = { name: 'tipped_arrow', type: 8, count: 10, stackSize: 64, slot: 1,
      components: [{ type: 'potion_contents', data: 'poison' }] };
    h.slots[2] = { name: 'iron_sword', type: 9, count: 1, stackSize: 1, slot: 2 };
    h.slots[3] = { name: 'iron_sword', type: 9, count: 1, stackSize: 1, slot: 3 };
    const result = await skillCompact(h.bot as never, { aborted: () => false } as never);
    expect(result).toContain('合堆 0 次');
    expect(h.clicks).toBe(0);
    expect(h.slots[0]?.count).toBe(10);
    expect(h.slots[1]?.count).toBe(10);
  });

  it('选择菜单不点击', async () => {
    const h = rig('个人试炼奖励箱选择菜单');
    await expect(skillCompact(h.bot as never, { aborted: () => false } as never))
      .rejects.toThrow('选择菜单');
    expect(h.clicks).toBe(0);
  });
});
