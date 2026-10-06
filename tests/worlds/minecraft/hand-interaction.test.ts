import { describe, expect, it, vi } from 'vitest';
import type { Bot } from 'mineflayer';
import {
  clearHandForBlockInteraction, installNavigationBareHand, needsBareHandToInteract, withPreparedInteractionHand,
} from '../../../src/worlds/minecraft/hand-interaction.ts';

function fakeBot(full = false, itemName = 'player_head') {
  let held: { name: string } | null = { name: itemName };
  const slots = Array.from({ length: 46 }, () => full ? { name: 'stone' } : null);
  slots[36] = held;
  const observedHands: Array<string | null> = [];
  const activate = vi.fn(async () => {
    observedHands.push(held?.name ?? null);
    if (held?.name === 'player_head') throw new Error('custom item intercepted the door');
  });
  const unequip = vi.fn(async () => { held = null; slots[36] = null; });
  const bot = {
    get heldItem() { return held; },
    inventory: { slots, items: () => slots.slice(9, 45).filter(Boolean) },
    activateBlock: activate,
    unequip,
    equip: vi.fn(async (item: { name: string }) => { held = item; }),
  } as unknown as Bot;
  return { bot, activate, unequip, observedHands };
}

describe('功能方块交互的主手保护', () => {
  it('明确管理主手的右键只影响本次调用，后续导航仍腾手', async () => {
    const r = fakeBot(false, 'torch');
    installNavigationBareHand(r.bot);
    await withPreparedInteractionHand(r.bot, () => r.bot.activateBlock({ name: 'spruce_door' } as never));
    await r.bot.activateBlock({ name: 'spruce_door' } as never);
    expect(r.observedHands).toEqual(['torch', null]);
  });

  it('主手管理范围不会传给另一个 bot 的门交互', async () => {
    const first = fakeBot(false, 'torch');
    const second = fakeBot(false, 'torch');
    installNavigationBareHand(first.bot);
    installNavigationBareHand(second.bot);
    await withPreparedInteractionHand(first.bot, async () => {
      await first.bot.activateBlock({ name: 'spruce_door' } as never);
      await second.bot.activateBlock({ name: 'spruce_door' } as never);
    });
    expect(first.observedHands).toEqual(['torch']);
    expect(second.observedHands).toEqual([null]);
  });

  it('识别门、按钮、箱子；普通方块不误清手', () => {
    expect(needsBareHandToInteract('spruce_door')).toBe(true);
    expect(needsBareHandToInteract('oak_fence_gate')).toBe(true);
    expect(needsBareHandToInteract('stone_button')).toBe(true);
    expect(needsBareHandToInteract('chest')).toBe(true);
    expect(needsBareHandToInteract('stone')).toBe(false);
    expect(needsBareHandToInteract('oak_fence_gate', 'diamond_sword')).toBe(false);
    expect(needsBareHandToInteract('stone_button', 'iron_pickaxe')).toBe(false);
    expect(needsBareHandToInteract('oak_fence_gate', 'player_head')).toBe(true);
    expect(needsBareHandToInteract('chest', 'diamond_sword')).toBe(true);
  });

  it('满包持剑仍可直接开门，不调用会丢物品的 unequip', async () => {
    const { bot, activate, unequip } = fakeBot(true, 'diamond_sword');
    installNavigationBareHand(bot);
    await bot.activateBlock({ name: 'oak_fence_gate' } as never);
    expect(activate).toHaveBeenCalledOnce();
    expect(unequip).not.toHaveBeenCalled();
  });

  it('寻路器开门前腾手，自定义背包不会截走右键', async () => {
    const { bot, activate, unequip } = fakeBot();
    installNavigationBareHand(bot);
    await bot.activateBlock({ name: 'spruce_door' } as never);
    expect(unequip).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
  });

  it('背包满时拒绝腾手，不能丢掉主手物品', async () => {
    const { bot, unequip } = fakeBot(true);
    await expect(clearHandForBlockInteraction(bot)).rejects.toThrow('背包没有空格');
    expect(unequip).not.toHaveBeenCalled();
  });

  it('背包满且手持功能物时改拿普通工具开门', async () => {
    const { bot, activate, unequip } = fakeBot(true);
    bot.inventory.slots[10] = { name: 'iron_axe' } as never;
    installNavigationBareHand(bot);
    await bot.activateBlock({ name: 'spruce_door' } as never);
    expect(bot.heldItem?.name).toBe('iron_axe');
    expect(activate).toHaveBeenCalledOnce();
    expect(unequip).not.toHaveBeenCalled();
  });
});
