import { describe, expect, it } from 'vitest';
import {
  bagStamp, blockedStamp, queueStamp,
  renderBagReadout, renderBlockedReadout, renderQueueReadout, renderStorageReadout, renderStoredItemReadout,
} from '../../../src/worlds/minecraft/readouts.ts';
import type { BlockedRecord, QueueStatus } from '../../../src/worlds/minecraft/executor.ts';
import type { WorldSnapshot } from '../../../src/worlds/minecraft/terrain.ts';
import { RoundOnceGate, roundTokenOf } from '../../../src/worlds/minecraft/round.ts';

function snap(over: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    position: { x: 0, y: 64, z: 0 },
    dimension: 'overworld',
    health: 20,
    food: 20,
    oxygen: 20,
    inWater: false,
    invSynced: true,
    timeOfDay: 1000,
    realTime: '2026-08-28T12:00:00+08:00',
    light: 15,
    raining: false,
    biome: 'plains',
    gameMode: 'survival',
    heldItem: 'stone_pickaxe',
    inventory: [{ name: 'cobblestone', count: 40 }, { name: 'torch', count: 12 }],
    xpLevel: 5,
    equipment: [{ slot: 'chest', name: 'iron_chestplate', durability: null, enchantments: [] }],
    effects: [],
    entities: [],
    players: [],
    blocks: [],
    standingOn: 'stone',
    ...over,
  } as unknown as WorldSnapshot;
}

describe('背包读数(mc_bag)', () => {
  it('四件事都在:格位分母、聚合清单、手上、身上穿的', () => {
    const text = renderBagReadout(snap());
    expect(text).toContain('2/36 格占着,空 34 格');
    expect(text).toContain('圆石×40');
    expect(text).toContain('手里拿着');
    expect(text).toContain('穿着:');
    expect(text).toContain('副手空着');
  });

  it('物品栏还没同步到:照实说没到,不把空栏当「包是空的」报', () => {
    const text = renderBagReadout(snap({ invSynced: false }));
    expect(text).toContain('还在从服务器同步');
    expect(text).not.toContain('0/36');
  });

  it('独立物品显示名进入清单和手持读数', () => {
    const text = renderBagReadout(snap({
      heldItem: 'player_head', heldItemDisplayName: '大背包',
      inventory: [
        { name: 'player_head', count: 1, displayName: '大背包' },
        { name: 'player_head', count: 1 },
      ],
    }));
    expect(text).toContain('大背包×1');
    expect(text).toContain('玩家头×1');
    expect(text).toContain('手里拿着大背包');
  });

  it('指纹认物品与手上那件,不认没进读数的东西', () => {
    const a = snap();
    expect(bagStamp(a)).toBe(bagStamp(snap()));
    expect(bagStamp(snap({ heldItem: 'torch' }))).not.toBe(bagStamp(a));
    expect(bagStamp(null)).toBe('nobot');
  });

  it('cursor ownership is visible without inflating bag slots or the carried item count', () => {
    const before = snap({ inventory: [], heldItem: null });
    const after = snap({ inventory: [], heldItem: null, cursorItem: { name: 'wooden_hoe', count: 1 } });
    const text = renderBagReadout(after);
    expect(text).toContain('0/36 格占着');
    expect(text).toContain('手里空着');
    expect(text).toContain('鼠标光标：木锄');
    expect(text).toContain('wooden_hoe');
    expect(text).toContain('尚未放回背包');
    expect(bagStamp(after)).not.toBe(bagStamp(before));
    expect(renderStoredItemReadout(after, [], 'wooden_hoe')).toContain('鼠标光标');
  });

  it('按物品查仓储历史，不把箱内数量混入随身余额', () => {
    const text = renderStoredItemReadout(snap({ inventory: [] }), [
      { x: -549, y: 63, z: -380, dimension: 'overworld', usedSlots: 27, slots: 27,
        observedAt: Date.parse('2026-10-02T05:14:22Z'), items: [{ name: 'emerald', count: 126 }] },
      { x: -560, y: 65, z: -375, dimension: 'overworld', usedSlots: 27, slots: 27,
        items: [{ name: 'emerald', count: 18 }] },
    ], 'emerald');
    expect(text).toContain('随身绿宝石×0');
    expect(text).toContain('虚拟大背包等未开窗容器未计入');
    expect(text).toContain('(-549,63,-380) 上次见到×126');
    expect(text).toContain('到场开窗重查');
    const open = renderStoredItemReadout(snap({ inventory: [] }), [], 'emerald',
      { title: '大背包', items: [{ name: 'emerald', count: 64 }, { name: 'emerald', count: 8 }] });
    expect(open).toContain('当前打开的「大背包」里绿宝石×72（现读）');
    expect(renderStoredItemReadout(snap(), [], 'diamond')).toContain('不等于其他容器里没有');
  });

  it('keeps registered variants separate across carried, open-window and historical stock', () => {
    const registry = { itemsByName: { golden_apple: {}, enchanted_golden_apple: {} } };
    const text = renderStoredItemReadout(snap({ inventory: [
      { name: 'golden_apple', count: 2 }, { name: 'enchanted_golden_apple', count: 5 },
    ] }), [{ x: 1, y: 64, z: 0, dimension: 'overworld', usedSlots: 2, slots: 27,
      items: [{ name: 'golden_apple', count: 8 }, { name: 'enchanted_golden_apple', count: 13 }] }],
    'golden_apple', { title: '箱子', items: [{ name: 'enchanted_golden_apple', count: 5 }] }, registry);
    expect(text).toContain('随身金苹果×2');
    expect(text).toContain('箱子」里金苹果×0');
    expect(text).toContain('上次见到×8');
  });

  it('finds exact custom names across carried items, cursor, open window and historical stock', () => {
    const s = snap({ inventory: [
      { name: 'diamond_pickaxe', displayName: '矿工镐', count: 1 },
      { name: 'diamond_pickaxe', displayName: '备用矿工镐', count: 2 },
      { name: 'diamond_pickaxe', count: 3 },
    ], cursorItem: { name: 'diamond_pickaxe', displayName: '矿工镐', count: 1 } });
    const records = [{ x: 1, y: 64, z: 0, dimension: 'overworld', usedSlots: 3, slots: 27,
      items: [{ name: 'diamond_pickaxe', displayName: '矿工镐', count: 4 },
        { name: 'diamond_pickaxe', displayName: '备用矿工镐', count: 8 },
        { name: 'diamond_pickaxe', count: 16 }] }];
    const open = { title: '箱子', items: [
      { name: 'diamond_pickaxe', displayName: '矿工镐', count: 5 },
      { name: 'diamond_pickaxe', displayName: '备用矿工镐', count: 10 },
    ] };
    const text = renderStoredItemReadout(s, records, '矿工镐', open);
    expect(text).toContain('随身矿工镐×1');
    expect(text).toContain('工具物品名:diamond_pickaxe');
    expect(text).toContain('鼠标光标：矿工镐×1');
    expect(text).toContain('箱子」里矿工镐×5（现读）');
    expect(text).toContain('上次见到×4');
    const byId = renderStoredItemReadout(s, records, 'minecraft:diamond_pickaxe', open);
    expect(byId).toContain('随身钻石镐×6');
    expect(byId).toContain('箱子」里钻石镐×15（现读）');
    expect(byId).toContain('上次见到×28');
  });

  it('accepts printable custom-name symbols without treating a partial name as an exact match', () => {
    const s = snap({ inventory: [{ name: 'player_head', count: 1, displayName: '✦ 旅行背包' }] });
    expect(renderStoredItemReadout(s, [], ' ✦  旅行背包 ')).toContain('随身✦  旅行背包×1');
    expect(renderStoredItemReadout(s, [], '旅行背包')).toContain('随身旅行背包×0');
    expect(renderStoredItemReadout(s, [], '✦\n旅行背包')).toContain('物品名格式不对');
    expect(renderStoredItemReadout(s, [], '✦\u200b 旅行背包')).toContain('物品名格式不对');
  });

  it('背包把同种备用装备的耐久分别报出，供点名存物', () => {
    const text = renderBagReadout(snap({ inventory: [
      { name: 'diamond_sword', count: 1, durability: { left: 1550, max: 1561 } },
      { name: 'diamond_sword', count: 1, durability: { left: 661, max: 1561 } },
    ] }));
    expect(text).toContain('耐久1550/1561×1');
    expect(text).toContain('耐久661/1561×1');
  });

  it('背包快满时列出已满仓库和最近有空位仓库', () => {
    const inventory = Array.from({ length: 34 }, () => ({ name: 'bow', count: 1 }));
    const s = snap({ inventory });
    const records = [
      { x: 1, y: 64, z: 0, dimension: 'overworld', items: [], usedSlots: 27, slots: 27 },
      { x: 2, y: 64, z: 0, dimension: 'overworld', items: [], usedSlots: 27, slots: 27 },
      { x: 20, y: 64, z: 0, dimension: 'overworld', items: [], usedSlots: 4, slots: 27 },
    ];
    const text = renderStorageReadout(s, records);
    expect(text).toContain('上次占满 2 口');
    expect(text).toContain('(20,64,0) 4/27 格');
    expect(text).toContain('暂缓清空随身容器');
    expect(renderStorageReadout(snap(), records)).toBeNull();
  });

  it('随身满而近处箱子满时，指出可并堆的物品而非重复塞不可堆叠装备', () => {
    const inventory = [
      { name: 'spruce_log', count: 3 },
      ...Array.from({ length: 35 }, () => ({ name: 'bow', count: 1 })),
    ];
    const records = [{
      x: 1, y: 64, z: 0, dimension: 'overworld', usedSlots: 27, slots: 27,
      items: [{ name: 'spruce_log', count: 4 }, { name: 'bow', count: 1 }],
    }];
    const text = renderStorageReadout(snap({ inventory }), records);
    expect(text).toContain('云杉原木×3');
    expect(text).toContain('(1,64,0)');
    expect(text).toContain('不要拿弓');
    expect(text).not.toContain('试把弓');
  });
});

function status(over: Partial<QueueStatus> = {}): QueueStatus {
  return {
    running: {
      id: 7, label: '挖石头', step: '挖 (1, 2, 3)', stepIndex: 0, stepCount: 3,
      elapsedMs: 4_000, taskElapsedMs: 9_000, count: null, pos: { x: 1, y: 64, z: 2 },
    },
    waiting: [{ id: 8, label: '走回家' }],
    ...over,
  };
}

describe('队列读数(mc_queue)', () => {
  it('在做的、排队的、最近一单的下场,三样都报', () => {
    const text = renderQueueReadout(status(), { at: '12:00:01', kind: 'blocked', text: '任务#6:没挖动' });
    expect(text).toContain('[队列]');
    expect(text).toContain('[最近一单] 12:00:01 任务#6:没挖动');
  });

  it('还没跑完过任何一单:照实说,不留空', () => {
    expect(renderQueueReadout(status(), null)).toContain('还没有跑完过任何一单');
  });

  /**
   * 指纹里**不能有时钟**:已跑多少秒每次都在变,进了指纹这道一轮一答的闸等于不存在
   * —— 而拿它轮询正是这三个入口要替掉的那件事。
   */
  it('指纹不含耗时:只是又跑了几秒不算「读数变了」', () => {
    const before = queueStamp(status(), null);
    const later = queueStamp(
      status({ running: { ...status().running!, elapsedMs: 30_000, taskElapsedMs: 60_000 } }),
      null,
    );
    expect(later).toBe(before);
    // 真的走到下一步了才算变
    expect(queueStamp(status({ running: { ...status().running!, stepIndex: 1 } }), null)).not.toBe(before);
    // 最近一单换了也算变
    expect(queueStamp(status(), 123)).not.toBe(before);
  });
});

describe('受阻读数(mc_blocked)', () => {
  const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
  const rec = (at: number, why: string): BlockedRecord => ({ at, task: '任务#3', step: '第 2 步 挖石头', why });

  it('时间、任务、步、原话,一个字不改地摆出来', () => {
    const text = renderBlockedReadout([rec(0, '包里没有能保住砂岩掉落的工具,要木镐及以上')], clock);
    expect(text).toContain('任务#3');
    expect(text).toContain('第 2 步 挖石头');
    expect(text).toContain('包里没有能保住砂岩掉落的工具,要木镐及以上');
  });

  it('一条都没有:照实说没有', () => {
    expect(renderBlockedReadout([], clock)).toContain('还没有记到受阻的步');
  });

  it('指纹看条数与最新那一条的时刻', () => {
    const one = [rec(100, 'a')];
    expect(blockedStamp(one)).toBe(blockedStamp([rec(100, 'a')]));
    expect(blockedStamp([rec(200, 'b'), ...one])).not.toBe(blockedStamp(one));
  });
});

/** 一轮一答闸使用主循环或 IPC 显式提供的轮号。 */
describe('一轮一答闸', () => {
  it('同一轮的几次调用拿到同一个轮号,换一轮换一个', () => {
    const ctx = (round: number) => ({ role: 'x', log: console, round } as never);
    const a1 = roundTokenOf(ctx(1));
    const a2 = roundTokenOf(ctx(1));
    const b1 = roundTokenOf(ctx(2));
    expect(a1).toBe(a2);
    expect(b1).not.toBe(a1);
  });

  it('没有显式轮号时返回 null,闸不生效', () => {
    expect(roundTokenOf({ role: 'x', log: console } as never)).toBeNull();
    const gate = new RoundOnceGate();
    expect(gate.answered('mc_bag', null, 's')).toBe(true);
    expect(gate.answered('mc_bag', null, 's')).toBe(true);
  });

  it('同轮同读数才算重复;读数变了、或换了轮,都照答', () => {
    const gate = new RoundOnceGate();
    expect(gate.answered('mc_bag', 1, 's1')).toBe(true);
    expect(gate.answered('mc_bag', 1, 's1')).toBe(false);
    // 世界真变了:同一轮里也照答,不拿一句过期回执把她挡在外面
    expect(gate.answered('mc_bag', 1, 's2')).toBe(true);
    // 换一轮
    expect(gate.answered('mc_bag', 2, 's2')).toBe(true);
    // 按工具分格,互不影响
    expect(gate.answered('mc_queue', 2, 's2')).toBe(true);
  });

});
