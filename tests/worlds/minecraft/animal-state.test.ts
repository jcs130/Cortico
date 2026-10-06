import type { Bot } from 'mineflayer';
import { EventEmitter } from 'node:events';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import {
  TAME_ITEMS, TRUST_ITEMS, animalStateNote, readTrusting,
} from '../../../src/worlds/minecraft/entity-facts.ts';
import { FindObservationCache } from '../../../src/worlds/minecraft/search-observation.ts';
import { skillFind, skillTrade } from '../../../src/worlds/minecraft/skills-gather.ts';
import {
  narrateWorld, snapshotFingerprint, snapshotFromBot,
} from '../../../src/worlds/minecraft/terrain.ts';

const registry = minecraftData('1.20.6');
const meUuid = '00000000-0000-0000-0000-000000000001';

function animal(name: string, id: number, values: Record<string, unknown>, x = 3) {
  const definition = registry.entitiesByName[name];
  const keys = definition.metadataKeys!;
  const metadata: unknown[] = [];
  for (const [key, value] of Object.entries(values)) metadata[keys.indexOf(key)] = value;
  return { id, name, type: definition.type, position: new Vec3(x, 64, 0.5), metadata };
}

function botWith(...entities: ReturnType<typeof animal>[]) {
  return {
    entity: { uuid: undefined, position: new Vec3(0.5, 64, 0.5) },
    player: { uuid: meUuid },
    entities: Object.fromEntries(entities.map((entity) => [String(entity.id), entity])),
    registry,
    findBlocks: () => [],
    blockAt: () => null,
    world: { raycast: () => null as unknown },
    game: { dimension: 'overworld', gameMode: 'survival' },
    health: 20, food: 20, oxygenLevel: 20,
    time: { timeOfDay: 1000 }, rainState: 0,
    heldItem: null,
    inventory: { slots: [] as Array<null>, items: () => [] },
    players: {},
  };
}

describe('动物状态使用实际协议元数据', () => {
  it('自己的宠物显示身份、名字、幼体、生命、驯服与坐姿', () => {
    const wolf = animal('wolf', 12, {
      custom_name: { text: '小白' }, baby: false, health: 8.5, flags: 0x05, owneruuid: meUuid,
    });
    const note = animalStateNote(botWith(wolf), wolf);
    expect(note).toContain('entityId=12');
    expect(note).toContain('名字「小白」');
    expect(note).toContain('成年');
    expect(note).toContain('生命 8.5');
    expect(note).toContain('已驯服');
    expect(note).toContain('主人是你');
    expect(note).toContain('坐着');
  });

  it('缺元数据省略状态；缺自己的身份时不把主人判成其他玩家', () => {
    const wolf = animal('wolf', 12, {});
    const missing = animalStateNote(botWith(wolf), wolf);
    expect(missing).toBe('entityId=12');
    wolf.metadata[registry.entitiesByName.wolf.metadataKeys!.indexOf('owneruuid')] = meUuid;
    const bot = { ...botWith(wolf), player: null };
    expect(animalStateNote(bot, wolf)).toContain(`主人 UUID=${meUuid}`);
    expect(animalStateNote(bot, wolf)).not.toContain('其他玩家');
    expect(animalStateNote(bot, wolf)).not.toContain('未驯服');
  });

  it('未坐下的猫可能躺着，不把坐姿位解释成站立', () => {
    const cat = animal('cat', 15, { flags: 0x04, is_lying: true });
    const note = animalStateNote(botWith(cat), cat);
    expect(note).toContain('未坐下');
    expect(note).not.toContain('站着');
  });

  it('豹猫信任使用 trusting；未读到时不推断未信任或主人', () => {
    const ocelot = animal('ocelot', 4, { trusting: true });
    expect(TAME_ITEMS.ocelot).toBeUndefined();
    expect(TRUST_ITEMS.ocelot).toEqual(['cod', 'salmon']);
    expect(readTrusting(botWith(ocelot), ocelot)).toBe(true);
    const note = animalStateNote(botWith(ocelot), ocelot);
    expect(note).toContain('已信任玩家');
    expect(note).not.toMatch(/驯服|主人/);
    ocelot.metadata[registry.entitiesByName.ocelot.metadataKeys!.indexOf('trusting')] = false;
    expect(animalStateNote(botWith(ocelot), ocelot)).toContain('尚未信任玩家');
    ocelot.metadata = [];
    expect(readTrusting(botWith(ocelot), ocelot)).toBeNull();
    expect(animalStateNote(botWith(ocelot), ocelot)).not.toContain('信任');
  });

  it('马和骆驼的鞍使用 flags；马同时报告驯服与幼体状态', () => {
    const horse = animal('horse', 7, { baby: true, flags: 0x06, health: 11 });
    const camel = animal('camel', 8, { flags: 0x04 });
    const horseNote = animalStateNote(botWith(horse), horse);
    expect(horseNote).toContain('幼体');
    expect(horseNote).toContain('已驯服');
    expect(horseNote).toContain('有鞍');
    horse.metadata[registry.entitiesByName.horse.metadataKeys!.indexOf('flags')] = 0;
    expect(animalStateNote(botWith(horse), horse)).toContain('未驯服');
    expect(animalStateNote(botWith(horse), horse)).toContain('无鞍');
    expect(animalStateNote(botWith(camel), camel)).toContain('有鞍');
  });

  it('不向普通敌人或村民暴露动物生命读数', () => {
    for (const name of ['zombie', 'villager']) {
      const entity = animal(name, 9, { baby: true, health: 8 });
      expect(animalStateNote(botWith(entity), entity)).toBe('');
    }
    const cow = animal('cow', 10, { health: Number.NaN });
    expect(animalStateNote(botWith(cow), cow)).not.toContain('生命');
  });
});

describe('模型仅观察可见动物的状态', () => {
  it('可见村民也给选择编号，其生命不进入观察文本', async () => {
    const villager = animal('villager', 30, { health: 9, baby: false });
    const bot = botWith(villager);
    const text = narrateWorld(snapshotFromBot(bot, { scanBlocks: false }));
    expect(text).toContain('entityId=30');
    expect(text).not.toContain('生命 9');
    const ctx = {
      search: { scope: () => ({ connectionGeneration: 1, realm: 'test', dimension: 'overworld' }),
        history: new FindObservationCache() },
    } as Parameters<typeof skillFind>[4];
    const found = await skillFind(bot as unknown as Bot, 'villager', undefined, 16, ctx);
    expect(found).toContain('entityId=30');
    expect(found).not.toContain('生命 9');
  });

  it('同种动物各带选择编号，隔墙动物只报动静', () => {
    const visible = animal('wolf', 12, { baby: false, health: 8, flags: 0x05, owneruuid: meUuid });
    const hidden = animal('wolf', 13, {
      custom_name: { text: '隔墙小狼' }, baby: true, health: 3, flags: 0x04, owneruuid: meUuid,
    }, -3);
    const bot = botWith(visible, hidden);
    bot.world.raycast = (_eye?: unknown, direction?: { x: number }) => direction && direction.x < 0
      ? { name: 'stone' } : null;
    const snapshot = snapshotFromBot(bot, { scanBlocks: false });
    expect(snapshot.entities.find((entity) => entity.entityId === 12)?.note).toContain('主人是你');
    const heard = snapshot.entities.find((entity) => !entity.visible);
    expect(heard?.entityId).toBeUndefined();
    expect(heard?.note).toBeUndefined();
    const text = narrateWorld(snapshot);
    expect(text).toContain('entityId=12');
    expect(text).toContain('生命 8');
    expect(text).toContain('狼的动静');
    expect(text).not.toContain('entityId=13');
    expect(text).not.toContain('隔墙小狼');
    expect(text).not.toContain('生命 3');
  });

  it('动物元数据变化不触发快照实质变化指纹', () => {
    const horse = animal('horse', 7, { baby: false, flags: 0x06, health: 11 });
    const bot = botWith(horse);
    const before = snapshotFromBot(bot, { scanBlocks: false });
    horse.metadata[registry.entitiesByName.horse.metadataKeys!.indexOf('health')] = 10;
    horse.metadata[registry.entitiesByName.horse.metadataKeys!.indexOf('flags')] = 0;
    horse.position.x += 1;
    const after = snapshotFromBot(bot, { scanBlocks: false });
    expect(narrateWorld(before)).not.toBe(narrateWorld(after));
    expect(snapshotFingerprint(before)).toBe(snapshotFingerprint(after));
  });

  it('find 区分同种动物，并保持视线边界', async () => {
    const cat = animal('cat', 20, { baby: false, flags: 0x05, health: 8, owneruuid: meUuid });
    const other = animal('cat', 21, { baby: true, flags: 0, health: 4 }, 5);
    const hidden = animal('cat', 22, { baby: true, flags: 0, health: 1 }, -3);
    const bot = botWith(cat, other, hidden);
    bot.world.raycast = (_eye?: unknown, direction?: { x: number }) => direction && direction.x < 0
      ? { name: 'stone' } : null;
    const ctx = {
      search: { scope: () => ({ connectionGeneration: 1, realm: 'test', dimension: 'overworld' }),
        history: new FindObservationCache() },
    } as Parameters<typeof skillFind>[4];
    const text = await skillFind(bot as unknown as Bot, 'cat', undefined, 16, ctx);
    expect(text).toContain('entityId=20');
    expect(text).toContain('主人是你');
    expect(text).toContain('entityId=21');
    expect(text).toContain('幼体');
    expect(text).not.toContain('entityId=22');
    expect(text).not.toContain('生命 1');
  });
});

describe('村民 entityId 选择', () => {
  it('交易目标在选中后被遮挡时拒绝打开窗口', async () => {
    const selected = animal('villager', 31, {}, 3);
    const bot = botWith(selected);
    let observations = 0;
    bot.world.raycast = () => ++observations === 1 ? null : { name: 'stone' };
    const ctx = { aborted: () => false } as Parameters<typeof skillTrade>[2];
    await expect(skillTrade(bot as unknown as Bot, { target: 'villager', entityId: 31 }, ctx))
      .rejects.toThrow('当前被遮挡');
  });

  it('指定远一点的商人按其报价回读，编号失效时不切换到最近商人', async () => {
    const nearest = animal('villager', 30, {}, 2);
    const selected = animal('villager', 31, {}, 3);
    const window = {
      trades: [{ inputItem1: { name: 'emerald', count: 1 }, inputItem2: null,
        outputItem: { name: 'bread', count: 3 }, maximumNbTradeUses: 10, nbTradeUses: 0 }],
    };
    const bot = {
      ...botWith(nearest, selected),
      _client: new EventEmitter(),
      openVillager: async (entity: { id: number }) => entity.id === selected.id ? window : { trades: [] },
      closeWindow: () => undefined,
    };
    const ctx = { aborted: () => false } as Parameters<typeof skillTrade>[2];
    const text = await skillTrade(bot as unknown as Bot, { target: 'villager', entityId: 31 }, ctx);
    expect(text).toContain('面包');
    await expect(skillTrade(bot as unknown as Bot, { target: 'villager', entityId: 99 }, ctx))
      .rejects.toThrow('编号已失效');
    selected.position.x = -3;
    bot.world.raycast = (_eye?: unknown, direction?: { x: number }) => direction && direction.x < 0
      ? { name: 'stone' } : null;
    await expect(skillTrade(bot as unknown as Bot, { target: 'villager', entityId: 31 }, ctx))
      .rejects.toThrow('重新观察');
  });
});
