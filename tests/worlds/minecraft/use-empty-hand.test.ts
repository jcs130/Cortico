import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { useOnce } from '../../../src/worlds/minecraft/skills-interact.ts';
import { describeSkill } from '../../../src/worlds/minecraft/receipt.ts';

const AT: [number, number, number] = [1, 64, 0];

function rig(name: string, full = false) {
  const stack = { name, type: 1, count: 2, slot: 36 };
  const slots = Array.from({ length: 46 }, (_, slot) =>
    full ? { name: 'stone', type: 2, count: 64, slot } : null) as Array<typeof stack | null>;
  slots[36] = stack;
  let held: typeof stack | null = stack;
  let activatedItems = 0;
  let openedContainers = 0;
  let entityHand: string | null = null;
  const chest = { name: 'chest', stateId: 1, position: new Vec3(...AT), boundingBox: 'block' };
  const cow = { id: 2, name: 'cow', position: new Vec3(1.5, 64, 0.5), height: 1.4, isValid: true };
  const win = { id: 1, type: 'minecraft:generic_9x3', title: 'Chest', inventoryStart: 27,
    inventoryEnd: 63, slots: Array.from({ length: 63 }, () => null), items: () => [] };
  const bot = {
    _client: { write: () => {} },
    get heldItem() { return held; },
    inventory: { slots, items: () => slots.slice(9, 45).filter((item) => item && item.count > 0) },
    registry: { foodsByName: {}, entitiesByName: { cow: {} } },
    entity: { id: 1, uuid: 'self', position: new Vec3(0.5, 64, 0.5), onGround: true },
    entities: { 2: cow }, players: {}, game: { dimension: 'overworld' },
    currentWindow: null as typeof win | null,
    blockAt: () => chest,
    pathfinder: { goto: async () => undefined, stop: () => undefined, setGoal: () => undefined },
    lookAt: async () => undefined,
    waitForTicks: async () => undefined,
    equip: async (item: typeof stack) => { held = item; },
    unequip: async () => {
      const destination = slots.findIndex((item, slot) => slot >= 9 && slot < 45 && item === null);
      if (destination < 0) { stack.count = 0; return; }
      slots[destination] = stack; slots[36] = null; held = null;
    },
    activateItem: async () => { activatedItems++; stack.count--; },
    activateBlock: async () => {
      if (held) { await bot.activateItem(); return; }
      openedContainers++; bot.currentWindow = win;
    },
    useOn: async () => { entityHand = held?.name ?? null; },
    closeWindow: () => { bot.currentWindow = null; },
  };
  return { bot: bot as unknown as Bot, stack, slots, chest,
    facts: () => ({ activatedItems, openedContainers, entityHand }) };
}

const ctx = { aborted: () => false };

describe('use at without item', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(['ender_pearl', 'bread', 'bow', 'player_head', 'iron_sword'])
    ('opens the container bare handed and preserves the held %s', async (name) => {
      const r = rig(name);
      const result = useOnce(r.bot, { skill: 'use', at: AT }, ctx as never);
      await vi.runAllTimersAsync();
      expect(await result).toContain('空手右键了');
      expect(r.bot.heldItem).toBeNull();
      expect(r.stack.count).toBe(2);
      expect(r.bot.inventory.items()).toContain(r.stack);
      expect(r.facts()).toMatchObject({ activatedItems: 0, openedContainers: 1 });
    });

  it('rejects a full inventory without a safe ordinary tool before using or dropping the held item', async () => {
    const r = rig('ender_pearl', true);
    await expect(useOnce(r.bot, { skill: 'use', at: AT }, ctx as never)).rejects.toThrow('找不到可安全右键');
    expect(r.bot.heldItem).toBe(r.stack);
    expect(r.stack.count).toBe(2);
    expect(r.facts()).toMatchObject({ activatedItems: 0, openedContainers: 0 });
  });

  it('uses an explicitly named projectile toward at without clearing it', async () => {
    const r = rig('ender_pearl');
    const result = useOnce(r.bot, { skill: 'use', item: 'ender_pearl', at: AT }, ctx as never);
    await vi.runAllTimersAsync();
    expect(await result).toContain('扔了末影珍珠');
    expect(r.bot.heldItem).toBe(r.stack);
    expect(r.stack.count).toBe(1);
    expect(r.facts()).toMatchObject({ activatedItems: 1, openedContainers: 0 });
  });

  it('preserves the current hand for an entity target without item', async () => {
    const r = rig('wheat');
    const result = useOnce(r.bot, { skill: 'use', target: 'cow' }, ctx as never);
    await vi.runAllTimersAsync();
    expect(await result).toContain('小麦右键了牛');
    expect(r.bot.heldItem).toBe(r.stack);
    expect(r.facts().entityHand).toBe('wheat');
  });

  it('describes omitted item by its at or entity target contract', () => {
    expect(describeSkill({ skill: 'use', at: AT }, 'ender_pearl')).toContain('空手右键');
    expect(describeSkill({ skill: 'use', target: 'cow' }, 'wheat')).toContain('用小麦右键');
    expect(describeSkill({ skill: 'use', item: 'ender_pearl', at: AT }, 'wheat')).toContain('用末影珍珠右键');
  });

  it('sets a desired door state once and preserves it on the repeated request', async () => {
    const r = rig('iron_sword');
    let open = false;
    let clicks = 0;
    r.chest.name = 'spruce_door';
    Object.assign(r.chest, { getProperties: () => ({ open, half: 'lower' }) });
    r.bot.activateBlock = async () => { clicks++; open = !open; };
    for (const desired of [true, true, false, false]) {
      const pending = useOnce(r.bot, { skill: 'use', at: AT, open: desired }, ctx as never);
      await vi.runAllTimersAsync();
      expect(await pending).toContain('open');
      expect(open).toBe(desired);
    }
    expect(clicks).toBe(2);
    expect(r.stack.count).toBe(2);
  });

  it('reads the lower door half when the upper half has a different transient state', async () => {
    const r = rig('iron_sword');
    r.bot.blockAt = position => ({ ...r.chest, name: 'spruce_door', position,
      getProperties: () => ({ half: position.y === AT[1] ? 'lower' : 'upper', open: position.y !== AT[1] }) }) as never;
    let clicks = 0;
    r.bot.activateBlock = async () => { clicks++; };
    const pending = useOnce(r.bot, { skill: 'use', at: [AT[0], AT[1] + 1, AT[2]], open: false }, ctx as never);
    await vi.runAllTimersAsync();
    expect(await pending).toContain('已经关闭');
    expect(clicks).toBe(0);
  });

  it('reports a server refusal to reach the desired state and rejects unsupported targets', async () => {
    const r = rig('iron_sword');
    r.chest.name = 'iron_door';
    Object.assign(r.chest, { getProperties: () => ({ open: false, half: 'lower' }) });
    r.bot.activateBlock = async () => undefined;
    const pending = useOnce(r.bot, { skill: 'use', at: AT, open: true }, ctx as never);
    const check = expect(pending).rejects.toThrow('open false → false');
    await vi.runAllTimersAsync();
    await check;
    r.chest.name = 'chest';
    await expect(useOnce(r.bot, { skill: 'use', at: AT, open: true }, ctx as never)).rejects.toThrow('不支持 open');
    expect(r.facts().openedContainers).toBe(0);
  });

  it('reports an unchanged portal dimension and the crossing operation without moving or crossing', async () => {
    const r = rig('iron_sword');
    r.chest.name = 'nether_portal';
    r.bot.activateBlock = async () => undefined;
    const pending = useOnce(r.bot, { skill: 'use', at: AT }, ctx as never);
    await vi.runAllTimersAsync();
    const receipt = await pending;
    expect(receipt).toContain('维度仍为主世界，未确认穿门');
    expect(receipt).toContain(JSON.stringify({ skill: 'transit', at: AT }));
    expect(r.bot.game.dimension).toBe('overworld');
    expect(r.bot.entity.position).toEqual(new Vec3(0.5, 64, 0.5));
    expect(r.stack.count).toBe(2);
  });

  it('reports an observed dimension change rather than asserting the portal stayed unchanged', async () => {
    const r = rig('iron_sword');
    r.chest.name = 'nether_portal';
    r.bot.activateBlock = async () => { r.bot.game.dimension = 'the_nether'; };
    const pending = useOnce(r.bot, { skill: 'use', at: AT }, ctx as never);
    await vi.runAllTimersAsync();
    const receipt = await pending;
    expect(receipt).toContain('维度从主世界变为下界');
    expect(receipt).toContain('坐标须按当前维度核对');
    expect(receipt).not.toContain('未确认穿门');
  });
});
