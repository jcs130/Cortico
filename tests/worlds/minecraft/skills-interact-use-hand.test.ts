import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { useOnce } from '../../../src/worlds/minecraft/skills-interact.ts';
import type { SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';
import { installNavigationBareHand } from '../../../src/worlds/minecraft/hand-interaction.ts';

const require = createRequire(import.meta.url);
const dependency = createRequire(require.resolve('mineflayer'));
const registry = dependency('prismarine-registry')('1.20.6');
const Item = dependency('prismarine-item')(registry);
const Block = dependency('prismarine-block')(registry);
const AT: [number, number, number] = [10, 63, 0];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Native inventory activation retains its asynchronous look and real packet dispatch. */
function rig(consumeBlockItem = true) {
  const wire: Array<{ name: string; hand: string | null; packet: Record<string, unknown> }> = [];
  const blocks = new Map<string, ReturnType<Bot['blockAt']>>();
  let onBlockPacket: (packet: Record<string, unknown>) => void = () => {};
  const released: Array<string | null> = [];
  const client = Object.assign(new EventEmitter(), { write(name: string, packet: Record<string, unknown>) {
    if (name === 'block_dig' && packet.status === 5) released.push(bot.heldItem?.name ?? null);
    if (name === 'block_place' || name === 'use_item' || name === 'use_entity') {
      wire.push({ name, hand: bot.heldItem?.name ?? null, packet });
      if (consumeBlockItem && bot.heldItem && name === 'block_place') {
        const selected = bot.heldItem;
        const remaining = new Item(selected.type, selected.count - 1, selected.metadata, selected.nbt);
        client.emit('set_slot', { windowId: 0, stateId: 2, slot: selected.slot,
          item: selected.count > 1 ? Item.toNotch(remaining) : Item.toNotch(null) });
      }
      if (name === 'block_place') onBlockPacket(packet);
    }
  } });
  const navigated: string[] = [];
  let onLook: () => Promise<void> = async () => {};
  let onEquip: () => Promise<void> = async () => {};
  let cancelled = false;
  const bot = Object.assign(new EventEmitter(), {
    registry, version: '1.20.6', _client: client, supportFeature: registry.supportFeature,
    QUICK_BAR_START: 36, health: 20, food: 20, game: { dimension: 'overworld' }, entities: {},
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), onGround: true, yaw: 0, pitch: 0 },
    lookAt: async () => { await onLook(); },
    waitForTicks: async () => {}, swingArm: () => {},
    setQuickBarSlot: (slot: number) => {
      bot.quickBarSlot = slot;
      bot.emit('heldItemChanged', bot.heldItem);
    },
    equip: async (item: Bot['heldItem']) => {
      await onEquip();
      const slot = bot.inventory.slots.findIndex((candidate) => candidate === item);
      if (slot < 36 || slot > 44) throw new Error('Fixture equips an existing hotbar stack');
      client.emit('held_item_slot', { slot: slot - 36 });
    },
    unequip: async () => {
      const slot = bot.inventory.slots.findIndex((item, i) => i >= 36 && i < 45 && item === null);
      if (slot < 0) throw new Error('Fixture has no empty hotbar slot');
      client.emit('held_item_slot', { slot: slot - 36 });
    },
    blockAt: (position: Vec3) => {
      const key = position.floored().toArray().join(',');
      if (blocks.has(key)) return blocks.get(key)!;
      const name = position.y <= 63 ? 'stone' : 'air';
      const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0);
      block.position = position.floored();
      return block;
    },
    pathfinder: {
      setGoal: () => {}, stop: () => {},
      goto: async () => {
        client.emit('held_item_slot', { slot: 1 });
        navigated.push(bot.heldItem!.name);
        bot.entity.position = new Vec3(9.5, 64, 0.5);
      },
    },
  }) as unknown as Bot;
  require('mineflayer/lib/plugins/inventory.js')(bot, { hideErrors: true });
  const items = new Array(46).fill(null);
  items[36] = new Item(registry.itemsByName.chest.id, 2);
  items[37] = new Item(registry.itemsByName.cherry_stairs.id, 8);
  items[38] = new Item(registry.itemsByName.snowball.id, 3);
  items[39] = new Item(registry.itemsByName.shield.id, 1);
  client.emit('window_items', { windowId: 0, stateId: 1, items: items.map(Item.toNotch),
    carriedItem: Item.toNotch(null) });
  client.emit('held_item_slot', { slot: 0 });
  return { bot, client, wire, navigated, released,
    setBlock: (at: [number, number, number], name: string | null, stateId?: number) => {
      const block = name === null ? null : Block.fromStateId(stateId ?? registry.blocksByName[name].defaultState, 0);
      if (block) block.position = new Vec3(...at);
      blocks.set(at.join(','), block);
    },
    setBlockPacket: (effect: typeof onBlockPacket) => { onBlockPacket = effect; },
    ctx: { aborted: () => cancelled } as SkillContext,
    cancel: () => { cancelled = true; },
    setLook: (look: () => Promise<void>) => { onLook = look; },
    setEquip: (equip: () => Promise<void>) => { onEquip = equip; },
    select: (slot: number) => client.emit('held_item_slot', { slot }),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('right-clicking a ladder reports the unchanged feet position and does not certify climbing', async () => {
  const r = rig(false);
  const at: [number, number, number] = [1, 64, 0];
  r.setBlock(at, 'ladder');
  const start = r.bot.entity.position.clone();
  const work = useOnce(r.bot, { skill: 'use', at }, r.ctx);
  await vi.runAllTimersAsync();
  const receipt = await work;
  expect(r.wire.some(packet => packet.name === 'block_place')).toBe(true);
  expect(r.bot.entity.position).toEqual(start);
  expect(receipt).toContain('没有执行攀爬');
  expect(receipt).toContain('实测脚格 (0, 64, 0)');
});

it('missing held item explains the target contract without clicking or navigating to an inferred block', async () => {
  const r = rig();
  r.setBlock([1, 64, 0], 'green_bed');
  await expect(useOnce(r.bot, { skill: 'use', item: 'bed' }, r.ctx))
    .rejects.toThrow('点击已有方块用现场确认的 at');
  expect(r.wire).toEqual([]);
  expect(r.navigated).toEqual([]);
  expect(r.bot.entity.position).toEqual(new Vec3(0.5, 64, 0.5));
});

it.each(['cherry_door', 'cherry_trapdoor', 'cherry_fence_gate'].flatMap((name) =>
  [true, false].map((open) => ({ name, open }))))(
  'keeps position, inventory and switch state when a distant $name already has open=$open',
  async ({ name, open }) => {
    const r = rig(false);
    const definition = registry.blocksByName[name];
    const state = Array.from({ length: definition.maxStateId - definition.minStateId + 1 }, (_, i) => definition.minStateId + i)
      .find((id) => {
        const properties = Block.fromStateId(id, 0).getProperties();
        return properties.open === open && (properties.half === undefined || properties.half !== 'upper');
      })!;
    r.setBlock(AT, name, state);
    const beforePosition = r.bot.entity.position.clone();
    const beforeInventory = r.bot.inventory.items().map((item) => [item.name, item.count]);
    const receipt = await useOnce(r.bot, { skill: 'use', at: AT, open }, r.ctx);
    expect(receipt).toContain('保持状态，未点击');
    expect(r.bot.entity.position).toEqual(beforePosition);
    expect(r.bot.inventory.items().map((item) => [item.name, item.count])).toEqual(beforeInventory);
    expect(r.bot.blockAt(new Vec3(...AT))?.getProperties().open).toBe(open);
    expect(r.navigated).toEqual([]);
    expect(r.wire).toEqual([]);
  },
);

describe('use preserves its selected hand through navigation and native look', () => {
  it('keeps an explicitly selected torch when the navigation door wrapper is installed', async () => {
    const r = rig(false);
    r.bot.inventory.slots[40] = new Item(registry.itemsByName.torch.id, 3);
    r.bot.inventory.slots[40]!.slot = 40;
    r.setBlock(AT, 'cherry_door');
    const door = registry.blocksByName.cherry_door;
    const opened = Array.from({ length: door.maxStateId - door.minStateId + 1 }, (_, i) => door.minStateId + i)
      .find((id) => Block.fromStateId(id, 0).getProperties().open === true)!;
    r.setBlockPacket(() => r.setBlock(AT, 'cherry_door', opened));
    installNavigationBareHand(r.bot);
    const pending = useOnce(r.bot, { skill: 'use', item: 'torch', at: AT }, r.ctx);
    const result = pending.then((value) => ({ value }), (error) => ({ error }));
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ value: expect.stringContaining('open false → true') });
    expect(r.wire.map((packet) => packet.hand)).toEqual(['torch']);
    expect(r.bot.inventory.slots[40]?.count).toBe(3);
  });

  it('still blocks a hand change during a wrapped door activation', async () => {
    const r = rig(false);
    r.bot.entity.position = new Vec3(9.5, 64, 0.5);
    r.setBlock(AT, 'cherry_door');
    installNavigationBareHand(r.bot);
    r.setLook(async () => { r.select(1); });
    await expect(useOnce(r.bot, { skill: 'use', item: 'chest', at: AT }, r.ctx))
      .rejects.toMatchObject({ code: 'use-hand-changed' });
    expect(r.wire).toEqual([]);
    expect(r.bot.inventory.slots[36]?.count).toBe(2);
  });

  it('still prevents cancelled wrapped door activations from sending packets', async () => {
    const r = rig(false);
    r.bot.entity.position = new Vec3(9.5, 64, 0.5);
    r.setBlock(AT, 'cherry_door');
    installNavigationBareHand(r.bot);
    r.setLook(async () => { r.cancel(); });
    await expect(useOnce(r.bot, { skill: 'use', item: 'chest', at: AT }, r.ctx)).rejects.toThrow('aborted');
    expect(r.wire).toEqual([]);
    expect(r.bot.inventory.slots[36]?.count).toBe(2);
  });

  it('restores a requested chest after real reachCell navigation selects a stair stack', async () => {
    const r = rig();
    const pending = useOnce(r.bot, { skill: 'use', item: 'chest', at: AT }, r.ctx);
    await vi.runAllTimersAsync();
    expect(await pending).toContain('箱子');
    expect(r.navigated).toEqual(['cherry_stairs']);
    expect(r.wire.map((packet) => packet.hand)).toEqual(['chest']);
    expect(r.bot.inventory.slots[36]?.count).toBe(1);
    expect(r.bot.inventory.slots[37]?.count).toBe(8);
  });

  it('blocks the actual native block-use packet when the hand changes during its final look', async () => {
    const r = rig();
    r.bot.entity.position = new Vec3(9.5, 64, 0.5);
    r.setLook(async () => { r.select(1); });
    await expect(useOnce(r.bot, { skill: 'use', item: 'chest', at: AT }, r.ctx))
      .rejects.toMatchObject({ code: 'use-hand-changed' });
    expect(r.wire).toEqual([]);
    expect(r.bot.inventory.slots[36]?.count).toBe(2);
    expect(r.bot.inventory.slots[37]?.count).toBe(8);
  });

  it('does not right click after cancellation during the native look', async () => {
    const r = rig();
    r.setLook(async () => { r.cancel(); });
    await expect(useOnce(r.bot, { skill: 'use', item: 'chest', at: AT }, r.ctx)).rejects.toThrow('aborted');
    expect(r.wire).toEqual([]);
  });

  it('does not right click after cancellation while restoring the selected item', async () => {
    const r = rig();
    let equips = 0;
    r.setEquip(async () => { if (++equips === 2) r.cancel(); });
    await expect(useOnce(r.bot, { skill: 'use', item: 'chest', at: AT }, r.ctx)).rejects.toThrow('aborted');
    expect(r.navigated).toEqual(['cherry_stairs']);
    expect(r.wire).toEqual([]);
  });

  it('clears a navigation stair stack for an explicitly bare block interaction', async () => {
    const r = rig();
    const pending = useOnce(r.bot, { skill: 'use', at: AT }, r.ctx);
    await vi.runAllTimersAsync();
    expect(await pending).toContain('空手右键');
    expect(r.navigated).toEqual(['cherry_stairs']);
    expect(r.wire.map((packet) => packet.hand)).toEqual([null]);
    expect(r.bot.inventory.slots[36]?.count).toBe(2);
    expect(r.bot.inventory.slots[37]?.count).toBe(8);
  });

  it('opens a barrel with an ordinary tool when inventory is full without consuming or dropping any stack', async () => {
    const r = rig(false);
    r.bot.entity.position = new Vec3(9.5, 64, 0.5);
    for (let slot = 9; slot < 45; slot++) {
      r.bot.inventory.updateSlot(slot, new Item(registry.itemsByName.cobblestone.id, 64));
    }
    r.bot.inventory.updateSlot(40, new Item(registry.itemsByName.iron_sword.id, 1));
    r.setBlock(AT, 'barrel');
    r.setBlockPacket(() => {
      r.client.emit('open_window', {
        windowId: 3, inventoryType: 2, windowTitle: { type: 'string', value: 'Barrel' },
      });
      const window = r.bot.currentWindow!;
      const items = Array.from({ length: window.slots.length }, () => Item.toNotch(null));
      for (let slot = 9; slot < 45; slot++) {
        items[window.inventoryStart + slot - 9] = Item.toNotch(r.bot.inventory.slots[slot]);
      }
      r.client.emit('window_items', { windowId: 3, stateId: 2, items, carriedItem: Item.toNotch(null) });
    });
    const before = r.bot.inventory.items().map(item => [item.name, item.count]);
    const pending = useOnce(r.bot, { skill: 'use', at: AT }, r.ctx);
    await vi.runAllTimersAsync();
    const receipt = await pending;
    expect(receipt).toContain('铁剑右键');
    expect(receipt).not.toContain('空手右键');
    expect(r.wire.map(packet => packet.hand)).toEqual(['iron_sword']);
    expect(receipt).toContain('箱里:空的');
    expect(r.bot.inventory.items().map(item => [item.name, item.count])).toEqual(before);
    expect(r.bot.inventory.selectedItem).toBeNull();
  });

  it('blocks a later nonempty hand after bare-hand preparation while preserving both stacks', async () => {
    const r = rig();
    r.setLook(async () => { r.select(1); });
    await expect(useOnce(r.bot, { skill: 'use', at: AT }, r.ctx)).rejects.toMatchObject({ code: 'use-hand-changed' });
    expect(r.wire).toEqual([]);
    expect(r.bot.inventory.slots[37]?.count).toBe(8);
  });

  it('keeps a cancelled delayed activation isolated from a new task at the same block', async () => {
    const r = rig();
    const look = deferred();
    let looking = 0;
    r.setLook(async () => { if (++looking === 1) await look.promise; });
    const old = useOnce(r.bot, { skill: 'use', item: 'chest', at: AT }, r.ctx);
    const rejected = expect(old).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(0);
    expect(looking).toBe(1);
    r.cancel();
    const current = useOnce(r.bot, { skill: 'use', item: 'chest', at: AT }, { aborted: () => false } as SkillContext);
    await vi.advanceTimersByTimeAsync(400);
    expect(await current).toContain('箱子');
    expect(r.wire.map((packet) => packet.hand)).toEqual(['chest']);
    look.resolve();
    await rejected;
    expect(r.wire.map((packet) => packet.hand)).toEqual(['chest']);
    expect(r.bot.inventory.slots[36]?.count).toBe(1);
  });

  it('restores the selected projectile after the final aim tick changes the hotbar', async () => {
    const r = rig();
    r.bot.waitForTicks = async () => { r.select(1); };
    const pending = useOnce(r.bot, { skill: 'use', item: 'snowball', at: AT }, r.ctx);
    await vi.runAllTimersAsync();
    expect(await pending).toContain('扔了雪球');
    expect(r.wire.map((packet) => packet.hand)).toEqual(['snowball']);
  });

  it('guards a first entity activation with an asynchronous native look before use_entity', async () => {
    const r = rig();
    const cow = { id: 42, name: 'cow', isValid: true, position: new Vec3(9.5, 64, 0.5), height: 1.4 };
    r.bot.entities[42] = cow as never;
    r.bot.useOn = r.bot.activateEntity;
    let looks = 0;
    r.setLook(async () => { if (++looks === 2) r.select(1); });
    await expect(useOnce(r.bot, { skill: 'use', item: 'chest', target: 'cow' }, r.ctx))
      .rejects.toMatchObject({ code: 'use-hand-changed' });
    expect(looks).toBe(2);
    expect(r.wire).toEqual([]);
  });

  it('a cancelled old item-use continuation cannot release a new task shield', async () => {
    const r = rig();
    const old = useOnce(r.bot, { skill: 'use', item: 'chest' }, r.ctx);
    const rejected = expect(old).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(100);
    r.cancel();
    const current = useOnce(r.bot, { skill: 'use', item: 'shield' }, { aborted: () => false } as SkillContext);
    await vi.advanceTimersByTimeAsync(1_100);
    await rejected;
    expect(r.bot.heldItem?.name).toBe('shield');
    expect(r.bot.usingHeldItem).toBe(true);
    expect(r.released).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(await current).toContain('盾牌');
    expect(r.released).toEqual(['shield']);
  });

  it('does not send a sign update after cancellation during the editor settle interval', async () => {
    const r = rig();
    const originalBlockAt = r.bot.blockAt;
    r.bot.blockAt = (position) => {
      if (position.x !== AT[0] || position.y !== AT[1] || position.z !== AT[2]) return originalBlockAt(position);
      const sign = Block.fromStateId(registry.blocksByName.oak_sign.defaultState, 0);
      sign.position = new Vec3(...AT);
      return sign;
    };
    const updates: string[] = [];
    r.bot.updateSign = (_block, text) => { updates.push(text); };
    const pending = useOnce(r.bot, { skill: 'use', at: AT, text: 'A small garden' }, r.ctx);
    const rejected = expect(pending).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.wire.map((packet) => packet.hand)).toEqual([null]);
    r.cancel();
    await vi.runAllTimersAsync();
    await rejected;
    expect(updates).toEqual([]);
  });

  it.each(['component', 'nbt'] as const)('uses the same selected axe after navigation changes only its %s durability', async (format) => {
    const r = rig();
    const axe = new Item(registry.itemsByName.diamond_axe.id, 1);
    const enchant = { type: 'minecraft:enchantments', data: { enchantments: [{ id: 1, level: 2 }] } };
    axe.components = format === 'component' ? [enchant] : [];
    r.bot.inventory.updateSlot(40, axe);
    r.bot.pathfinder.goto = async () => {
      r.select(1);
      const worn = new Item(axe.type, 1);
      worn.components = format === 'component'
        ? [{ type: 'minecraft:damage', data: 7 }, enchant] : [];
      if (format === 'nbt') worn.nbt = { type: 'compound', name: '', value: { Damage: { type: 'int', value: 7 } } };
      r.bot.inventory.updateSlot(40, worn);
      r.bot.entity.position = new Vec3(9.5, 64, 0.5);
    };
    const pending = useOnce(r.bot, { skill: 'use', item: 'diamond_axe', at: AT }, r.ctx);
    await vi.runAllTimersAsync();
    expect(await pending).toContain('钻石斧');
    expect(r.wire.map((packet) => packet.hand)).toEqual(['diamond_axe']);
    expect(r.bot.inventory.slots[37]?.count).toBe(8);
  });

  it('does not replace a missing selected custom axe with a same-named item with different custom data', async () => {
    const r = rig();
    const first = new Item(registry.itemsByName.diamond_axe.id, 1);
    const second = new Item(first.type, 1);
    const name = { type: 'minecraft:custom_name', data: '{"text":"Traveler axe"}' };
    first.components = [name, { type: 'minecraft:custom_data', data: { serial: 'first' } }];
    second.components = [name, { type: 'minecraft:custom_data', data: { serial: 'second' } }];
    r.bot.inventory.updateSlot(40, first);
    r.bot.inventory.updateSlot(41, second);
    r.bot.pathfinder.goto = async () => {
      r.select(1);
      r.client.emit('set_slot', { windowId: 0, stateId: 2, slot: 40, item: Item.toNotch(null) });
      r.bot.entity.position = new Vec3(9.5, 64, 0.5);
    };
    await expect(useOnce(r.bot, { skill: 'use', item: 'Traveler axe', at: AT }, r.ctx))
      .rejects.toThrow('本次选定');
    expect(r.wire).toEqual([]);
    expect(r.bot.inventory.slots[41]).toBe(second);
    expect(second.count).toBe(1);
  });
});

describe('off-table block-item use reports the reference and face-adjacent readback', () => {
  it.each([
    ['up', 1, [10, 64, 0]], ['down', 0, [10, 62, 0]],
    ['north', 2, [10, 63, -1]], ['south', 3, [10, 63, 1]],
    ['west', 4, [9, 63, 0]], ['east', 5, [11, 63, 0]],
  ] as const)('reads the %s face neighbor after a native packet and authoritative block update', async (face, direction, spot) => {
    const r = rig();
    const out: [number, number, number] = [...spot];
    r.setBlock(out, 'air');
    r.setBlockPacket((packet) => {
      expect(packet.location).toEqual(new Vec3(...AT));
      expect(packet.direction).toBe(direction);
      setTimeout(() => { r.setBlock(out, 'cherry_stairs'); }, 40);
    });
    const pending = useOnce(r.bot, { skill: 'use', item: 'cherry_stairs', at: AT, face }, r.ctx);
    await vi.runAllTimersAsync();
    const receipt = await pending;
    expect(receipt).toContain('点击格 (10, 63, 0) 石头 → 石头');
    expect(receipt).toContain(`面外相邻格 (${out.join(', ')}) 空气 → 樱花楼梯[`);
    expect(receipt).toContain('facing=');
    expect(r.bot.inventory.slots[37]?.count).toBe(7);
  });

  it('inventory loss without a block update remains a click readback with an unchanged adjacent cell', async () => {
    const r = rig();
    const pending = useOnce(r.bot, { skill: 'use', item: 'cherry_stairs', at: AT }, r.ctx);
    await vi.runAllTimersAsync();
    const receipt = await pending;
    expect(r.bot.inventory.slots[37]?.count).toBe(7);
    expect(receipt).toContain('面外相邻格 (10, 64, 0) 空气 → 空气');
    expect(receipt).toContain('放置目标用 build 的 anchors 指定并核验');
  });

  it('an unloaded neighbor is unknown instead of an air cell or a placement claim', async () => {
    const r = rig(); r.setBlock([10, 64, 0], null);
    const pending = useOnce(r.bot, { skill: 'use', item: 'chest', at: AT }, r.ctx);
    await vi.runAllTimersAsync();
    expect(await pending).toContain('面外相邻格 (10, 64, 0) 区块未加载，未知 → 区块未加载，未知');
  });

  it('retains a same-kind stair property change instead of reporting an unchanged name', async () => {
    const r = rig();
    const out: [number, number, number] = [10, 64, 0];
    const before = registry.blocksByName.cherry_stairs.defaultState;
    const after = before + 20; // Facing changes by one real registry enum stride.
    const oldFacing = Block.fromStateId(before, 0).getProperties().facing;
    const newFacing = Block.fromStateId(after, 0).getProperties().facing;
    expect(newFacing).not.toBe(oldFacing);
    r.setBlock(out, 'cherry_stairs', before);
    r.setBlockPacket(() => { r.setBlock(out, 'cherry_stairs', after); });
    const pending = useOnce(r.bot, { skill: 'use', item: 'cherry_stairs', at: AT }, r.ctx);
    await vi.runAllTimersAsync();
    const receipt = await pending;
    expect(receipt).toContain(`facing=${oldFacing}`);
    expect(receipt).toContain(`facing=${newFacing}`);
  });
});
