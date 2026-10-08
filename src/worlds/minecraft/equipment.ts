/** Equipment slot moves wait for server inventory snapshots before reporting success. */
import type { Bot } from 'mineflayer';
import { clickInventoryConfirmed, isInventoryClickError, resumeInventoryCursor,
  sameInventoryStack } from './inventory-click-sync.ts';
import { itemCustomName } from './item-display.ts';
import { zhName } from './names.ts';
import { SkillBlocked } from './skill-context.ts';

type EquipmentDestination = 'head' | 'torso' | 'legs' | 'feet' | 'off-hand';
type Item = NonNullable<Bot['heldItem']>;
const itemText = (item: Item | null): string => item ? itemCustomName(item) ?? zhName(item.name) : '空';

function requirePlayerInventory(bot: Bot): void {
  if (bot.currentWindow) throw new SkillBlocked('换装需要先关闭当前容器窗口');
}

async function equipmentMove(bot: Bot, slot: number, move: () => Promise<void>): Promise<void> {
  try { await move(); } catch (error) {
    if (!isInventoryClickError(error)) throw error;
    throw new SkillBlocked(`换装未确认：${(error as Error).message}；装备槽回读为${itemText(bot.inventory.slots[slot])}，` +
      `光标为${itemText(bot.inventory.selectedItem)}。先核对库存，不重复换装`,
    [], 'server', 'inventory-click-sync');
  }
}

/** Each pickup, swap and cursor return has its own authoritative confirmation. */
export async function equipSlotConfirmed(bot: Bot, item: Item, dest: EquipmentDestination): Promise<void> {
  requirePlayerInventory(bot);
  const slot = bot.getEquipmentDestSlot(dest);
  if (item.slot === slot) return;
  await equipmentMove(bot, slot, async () => {
    if (bot.supportFeature?.('stateIdUsed') !== true) {
      await bot.equip(item, dest);
      return;
    }
    const window = bot.inventory;
    await resumeInventoryCursor(bot);
    const source = item.slot;
    const found = window.slots[source];
    if (!found || !sameInventoryStack(found, item)) {
      throw new SkillBlocked('待穿装备所在槽位已经变化，先重新核对背包');
    }
    await clickInventoryConfirmed(bot, source, 0, 0, window);
    await clickInventoryConfirmed(bot, slot, 0, 0, window);
    if (window.selectedItem) await clickInventoryConfirmed(bot, source, 0, 0, window);
  });
  const worn = bot.inventory.slots[slot];
  if (!worn || !sameInventoryStack(worn, item) || bot.inventory.selectedItem) {
    throw new SkillBlocked(`换装后装备槽回读为${itemText(worn)}，未确认穿上点名装备`, [], 'server');
  }
}

/** The caller checks storage capacity; cursor recovery never drops the item. */
export async function clearOffHandConfirmed(bot: Bot): Promise<void> {
  requirePlayerInventory(bot);
  const slot = bot.getEquipmentDestSlot('off-hand');
  await equipmentMove(bot, slot, async () => {
    if (bot.supportFeature?.('stateIdUsed') !== true) {
      await bot.unequip('off-hand');
      return;
    }
    await resumeInventoryCursor(bot);
    await clickInventoryConfirmed(bot, slot, 0, 0, bot.inventory);
    await resumeInventoryCursor(bot);
  });
  if (bot.inventory.slots[slot] || bot.inventory.selectedItem) {
    throw new SkillBlocked(`腾空后副手回读为${itemText(bot.inventory.slots[slot])}，未确认收回背包`, [], 'server');
  }
}
