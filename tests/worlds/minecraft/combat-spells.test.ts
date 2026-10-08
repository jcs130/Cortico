import type { Bot } from 'mineflayer';
import { describe, expect, it } from 'vitest';
import { CombatSpells } from '../../../src/worlds/minecraft/combat-spells.ts';
import { validCombatRules, type CombatRule } from '../../../src/worlds/minecraft/combat-rules.ts';

function botWithFoes(names: string[]): Bot {
  return {
    health: 20,
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: Object.fromEntries(names.map((name, i) => [i + 1, {
      name, isValid: true, position: { x: 3 + i, y: 64, z: 0 },
    }])),
  } as unknown as Bot;
}

const combatNotice = '战斗咏唱：星芒箭(starbolt，自动锁敌、4 魔力)、霜环(frostnova，7 魔力)、焰浪(flamewave，8 魔力)';
const exploreNotice = '探索咏唱：守护傀儡(golem，12 魔力/75 秒，持续 45 秒)';

describe('服务端公布的战斗法术', () => {
  it('同一 Agent 编排随敌人数量、类型、血线与魔力改变选择，不退回违反条件的固定顺序', () => {
    const spells = new CombatSpells();
    spells.noteServerMessage(combatNotice); spells.noteServerMessage(exploreNotice); spells.noteMana(40);
    const rules: CombatRule[] = [
      { id: 'protect', spell: 'golem', when: { hostilesAtLeast: 2, healthAtOrBelow: 12, reserveMana: 6 } },
      { id: 'crowd', spell: 'frostnova', when: { within: 7, hostilesAtLeast: 3, reserveMana: 6 } },
      { id: 'ranged', spell: 'starbolt', when: { within: 12, enemyTypes: ['witch', 'skeleton'], reserveMana: 6 } },
      { id: 'single', spell: 'starbolt', when: { within: 10, hostilesAtMost: 1, reserveMana: 6 } },
    ];
    spells.setTactic({ spells: ['golem', 'flamewave'], healAtOrBelow: 8, rules });
    const crowd = botWithFoes(['zombie', 'husk', 'witch']);
    expect(spells.next(crowd, true, 100_000)).toBe('frostnova');
    crowd.health = 10;
    expect(spells.next(crowd, true, 100_250)).toBe('golem');
    const ranged = botWithFoes(['witch']); ranged.entities[1].position.x = 11;
    expect(spells.next(ranged, true, 100_500)).toBe('starbolt');
    spells.noteSent('starbolt', 100_500);
    const receipt = spells.recordCombat({ startedAt: new Date(100_000).toISOString(), endedAt: new Date(100_501).toISOString(),
      reason: 'clear', healthBefore: 20, healthAfter: 20, kills: {}, swings: 0, meleeLanded: 0, arrows: 0, rangedLanded: 0 });
    expect(receipt.casts[0]).toMatchObject({ spell: 'starbolt', ruleId: 'ranged', tacticRevision: 1 });
    spells.noteMana(9);
    expect(spells.next(botWithFoes(['zombie']), true, 110_000)).toBeNull();
    expect(spells.readout(undefined, 110_000, botWithFoes(['zombie']))).toContain('保留魔力不足');
    spells.noteMana(10);
    expect(spells.next(botWithFoes(['zombie']), true, 110_250)).toBe('starbolt');
    rules[0].spell = 'flamewave';
    expect(spells.getTactic()?.rules?.[0].spell).toBe('golem');
  });

  it('条件编排仍受服务端能力和冷却约束，未知的必要状态不匹配', () => {
    const spells = new CombatSpells();
    const bot = botWithFoes(['witch']);
    spells.setTactic({ spells: ['golem'], healAtOrBelow: 10, rules: [
      { id: 'wet', spell: 'starbolt', when: { dimension: 'the_nether', onGround: true, manaAtLeast: 4 } },
    ] });
    expect(spells.next(bot, true, 100_000)).toBeNull();
    bot.game = { dimension: 'the_nether' } as Bot['game']; bot.entity.onGround = true;
    spells.noteServerMessage(combatNotice);
    expect(spells.next(bot, true, 100_250)).toBeNull();
    spells.noteMana(8);
    expect(spells.next(bot, true, 100_500)).toBe('starbolt'); spells.noteSent('starbolt', 100_500);
    expect(spells.next(bot, true, 103_000)).toBeNull();
    expect(spells.next(bot, true, 107_000)).toBe('starbolt');
    bot.entity.onGround = false;
    expect(spells.next(bot, true, 107_250)).toBeNull();
    expect(validCombatRules([{ id: 'bad', spell: 'starbolt', when: { healthAtOrAbove: 15, healthAtOrBelow: 8 } }])).toBe(false);
    expect(validCombatRules([{ id: 'bad', spell: 'starbolt', when: { unknown: true } }])).toBe(false);
    expect(validCombatRules([{ id: 'bad', spell: 'selfheal', when: {} }])).toBe(false);
  });
  it('默认在半血时优先考虑自愈，战术可调整血线', () => {
    const spells = new CombatSpells();
    expect(spells.wantsHeal(11)).toBe(false);
    expect(spells.wantsHeal(10)).toBe(true);
    spells.setTactic({ spells: null, healAtOrBelow: 14 });
    expect(spells.wantsHeal(14)).toBe(true);
    expect(spells.wantsHeal(15)).toBe(false);
  });

  it('七怪围攻时即时按傀儡、控场、范围伤害、远程威胁选法术', () => {
    const spells = new CombatSpells();
    const bot = botWithFoes(['zombie', 'husk', 'skeleton', 'witch']);
    expect(spells.next(bot, true, 100_000)).toBeNull();
    spells.noteServerMessage(combatNotice);
    spells.noteServerMessage(exploreNotice);
    expect(spells.next(bot, false, 101_000)).toBeNull();
    expect(spells.next(bot, true, 101_000)).toBe('golem');
    spells.noteSent('golem', 101_000);
    expect(spells.next(bot, true, 101_250)).toBeNull();
    expect(spells.next(bot, true, 102_500)).toBe('frostnova');
    spells.noteSent('frostnova', 102_500);
    expect(spells.next(bot, true, 104_000)).toBe('flamewave');
    spells.noteSent('flamewave', 104_000);
    expect(spells.next(bot, true, 105_500)).toBe('starbolt');
  });

  it('手动施过傀儡后不重复，重连清空旧服技能，魔力不足时退避', () => {
    const spells = new CombatSpells();
    const bot = botWithFoes(['zombie', 'husk', 'witch']);
    spells.noteServerMessage(combatNotice);
    spells.noteServerMessage(exploreNotice);
    spells.noteManualCast('golem', 100_000);
    expect(spells.next(bot, true, 102_000)).toBe('frostnova');
    spells.noteSent('frostnova', 102_000);
    spells.noteServerMessage('魔力不足，无法施放', 102_200);
    expect(spells.next(bot, true, 104_000)).toBeNull();
    expect(spells.next(bot, true, 132_200)).toBe('frostnova');
    spells.reset();
    expect(spells.next(bot, true, 133_000)).toBeNull();
  });

  it('手动重复施放同一技能按服务器已知冷却拦住', () => {
    const spells = new CombatSpells();
    spells.noteServerMessage(combatNotice);
    expect(spells.manualCastBlock('starbolt', 100_000)).toBeNull();
    spells.noteManualCast('starbolt', 100_000);
    const sameSpell = spells.manualCastBlock('starbolt', 101_000);
    expect(sameSpell).toContain('还需约 5 秒');
    expect(sameSpell).toContain('按最近已知冷却估算');
    expect(sameSpell).toContain('本次未发送');
    const nextSpell = spells.manualCastBlock('frostnova', 101_000);
    expect(nextSpell).toContain('上一条施法命令');
    expect(nextSpell).toContain('客户端暂缓');
    expect(nextSpell).toContain('不证明服务端存在公共冷却');
    expect(spells.manualCastBlock('frostnova', 101_500)).toBeNull();
    expect(spells.manualCastBlock('starbolt', 106_000)).toBeNull();
  });

  it('默认法术选择依据现场敌人，不按试炼楼层保留全部进攻魔力', () => {
    const spells = new CombatSpells();
    const bot = botWithFoes(['zombie', 'husk', 'witch']);
    spells.noteServerMessage(combatNotice);
    spells.noteServerMessage(exploreNotice);
    expect(spells.next(bot, false, 100_000)).toBeNull();
    expect(spells.next(bot, true, 100_000)).toBe('golem');
    spells.noteSent('golem', 100_000);
    expect(spells.next(bot, true, 101_500)).toBe('frostnova');
  });

  it('使用服务端魔力读数和公布的消耗，魔力不足时不继续试高消耗法术', () => {
    const spells = new CombatSpells();
    const bot = botWithFoes(['zombie', 'husk', 'witch']);
    spells.noteServerMessage(combatNotice);
    spells.noteServerMessage(exploreNotice);
    spells.noteMana(26);
    expect(spells.next(bot, true, 100_000)).toBe('golem');
    spells.noteSent('golem', 100_000);
    expect(spells.next(bot, true, 101_500)).toBe('frostnova');
    spells.noteSent('frostnova', 101_500);
    // 26 - 12 - 7 = 7，焰浪要 8，转而攻击远程怪。
    expect(spells.next(bot, true, 103_000)).toBe('starbolt');
  });

  it('消耗以当前服务器公告为准', () => {
    const spells = new CombatSpells();
    const bot = botWithFoes(['zombie', 'witch']);
    spells.noteServerMessage('战斗咏唱：霜环(frostnova，11 魔力)');
    spells.noteMana(10);
    expect(spells.next(bot, true, 100_000)).toBeNull();
    spells.noteMana(13);
    expect(spells.next(bot, true, 100_250)).toBe('frostnova');
  });

  it('已知魔力不足时等待新读数，不按过期时间盲试', () => {
    const spells = new CombatSpells();
    const bot = botWithFoes(['zombie', 'witch']);
    spells.noteServerMessage('战斗咏唱：霜环(frostnova，7 魔力)');
    spells.noteMana(6, 100_000);
    expect(spells.next(bot, true, 100_000)).toBeNull();
    expect(spells.next(bot, true, 119_999)).toBeNull();
    expect(spells.next(bot, true, 120_249)).toBeNull();
    spells.noteMana(7, 120_300);
    expect(spells.next(bot, true, 120_500)).toBe('frostnova');
    spells.noteSent('frostnova', 120_500);
    spells.noteServerMessage('魔力不足：当前 7/32，需要 7。', 120_600);
    expect(spells.next(bot, true, 140_600)).toBeNull();
    spells.noteMana(8, 140_700);
    expect(spells.next(bot, true, 140_850)).toBe('frostnova');
  });

  it('手动治疗也记录发送与服务端魔力拒绝，足额恢复前不重复发', () => {
    const spells = new CombatSpells();
    spells.noteMana(3, 100_000);
    expect(spells.manualCastBlock('selfheal', 100_000)).toBeNull();
    spells.noteManualCast('selfheal', 100_000);
    spells.noteSupportSent(100_000);
    expect(spells.manualCastBlock('selfheal', 101_000)).toContain('冷却');
    spells.noteServerMessage('魔力不足：当前 3/34，需要 6。', 101_100);
    expect(spells.manualCastBlock('selfheal', 120_000)).toContain('魔力');
    spells.noteMana(6, 120_100);
    expect(spells.manualCastBlock('selfheal', 120_100)).toBeNull();
  });

  it('资料未加载是等待状态，既不当作零也不盲试施法', () => {
    const spells = new CombatSpells();
    const bot = botWithFoes(['zombie', 'witch']);
    spells.noteServerMessage(combatNotice);
    spells.noteMana(null);
    expect(spells.next(bot, true, 100_000)).toBeNull();
    expect(spells.manualCastBlock('starbolt', 100_000)).toContain('尚未加载');
    spells.noteMana(0);
    expect(spells.next(bot, true, 100_250)).toBeNull();
    spells.noteMana(8);
    expect(spells.next(bot, true, 100_500)).toBe('frostnova');
  });

  it('普通系统与动作栏魔力读数也能刷新战斗可用魔力', () => {
    const spells = new CombatSpells();
    const bot = botWithFoes(['zombie', 'witch']);
    spells.noteServerMessage('战斗咏唱：霜环(frostnova，7 魔力)');
    spells.noteMana(6, 100_000);
    expect(spells.next(bot, true, 101_000)).toBeNull();
    spells.noteServerMessage('魔力：8/32', 101_100);
    expect(spells.next(bot, true, 101_250)).toBe('frostnova');
  });

  it('按 Agent 自定优先序在单目标战斗中连用法术并在血线先治疗', () => {
    const spells = new CombatSpells();
    const bot = botWithFoes(['zombie']);
    spells.noteServerMessage(combatNotice);
    spells.noteServerMessage(exploreNotice);
    spells.noteMana(40);
    spells.setTactic({ spells: ['golem', 'starbolt', 'frostnova'], healAtOrBelow: 12 });
    expect(spells.wantsHeal(13)).toBe(false);
    expect(spells.wantsHeal(12)).toBe(true);
    expect(spells.next(bot, true, 100_000)).toBe('golem');
    spells.noteSent('golem', 100_000);
    expect(spells.next(bot, true, 101_000)).toBeNull();
    expect(spells.next(bot, true, 101_500)).toBe('starbolt');
    spells.noteSupportSent(101_500);
    expect(spells.next(bot, true, 102_000)).toBeNull();
    expect(spells.getTactic()).toEqual({ spells: ['golem', 'starbolt', 'frostnova'], healAtOrBelow: 12 });
  });

  it('重连清掉旧服技能确认，但保留 Agent 设置的战术', () => {
    const spells = new CombatSpells();
    const bot = botWithFoes(['zombie']);
    spells.setTactic({ spells: ['starbolt'], healAtOrBelow: 10 });
    spells.noteServerMessage(combatNotice);
    expect(spells.next(bot, true, 100_000)).toBe('starbolt');
    spells.reset();
    expect(spells.getTactic()).toEqual({ spells: ['starbolt'], healAtOrBelow: 10 });
    expect(spells.next(bot, true, 101_000)).toBeNull();
  });

  it('新技能由服务端公告启用，按公告消耗和冷却执行', () => {
    const spells = new CombatSpells();
    const bot = botWithFoes(['zombie']);
    spells.setTactic({ spells: ['thunderlance'], healAtOrBelow: null });
    spells.noteMana(5);
    expect(spells.next(bot, true, 100_000)).toBeNull();
    spells.noteServerMessage('战斗咏唱：雷矛(thunderlance，5 魔力/8 秒)');
    expect(spells.next(bot, true, 100_250)).toBe('thunderlance');
    spells.noteSent('thunderlance', 100_250);
    spells.noteMana(5);
    expect(spells.next(bot, true, 107_999)).toBeNull();
    expect(spells.next(bot, true, 108_250)).toBe('thunderlance');
  });

  it('回读解释未确认、魔力和冷却约束，复盘保留实际发送及回音而不宣布已学会', () => {
    const spells = new CombatSpells();
    spells.setTactic({ spells: ['golem', 'starbolt'], healAtOrBelow: 12 });
    expect(spells.readout(undefined, 100_000)).toContain('本连接尚未确认该能力');
    spells.noteServerMessage(combatNotice, 100_000);
    spells.noteServerMessage(exploreNotice, 100_000);
    spells.noteMana(7, 100_000);
    expect(spells.readout(undefined, 100_000)).toContain('所需魔力高于');
    spells.noteMana(20, 101_000);
    spells.noteManualCast('golem', 101_000);
    spells.noteServerMessage('守护傀儡已经召唤，帮你对抗敌人。', 101_200);
    // A later unrelated reply cannot rewrite that observation.
    spells.noteServerMessage('魔力不足', 106_000);
    expect(spells.readout(undefined, 107_000)).toContain('冷却');
    spells.setTactic({ spells: ['starbolt'], healAtOrBelow: 12 });
    const receipt = spells.recordCombat({ startedAt: new Date(100_000).toISOString(),
      endedAt: new Date(110_000).toISOString(), reason: 'flee', healthBefore: 20, healthAfter: 9,
      kills: { zombie: 1 }, swings: 4, meleeLanded: 3, arrows: 0, rangedLanded: 0 });
    expect(receipt.casts).toEqual([{ spell: 'golem', source: 'manual',
      sentAt: new Date(101_000).toISOString(), tacticRevision: 1, manaBefore: 20,
      reply: '守护傀儡已经召唤，帮你对抗敌人。', replyAt: new Date(101_200).toISOString() }]);
    expect(receipt).toMatchObject({ tacticRevision: 2, tacticAtEnd: { spells: ['starbolt'] } });
    expect(spells.readout(receipt.id)).toContain('归因需结合现场');
    expect(spells.readout()).toContain('"healthAfter":9');
    spells.reset();
    expect(spells.readout(receipt.id)).toContain('守护傀儡已经召唤');
    expect(spells.readout()).toContain('本连接尚未确认该能力');
  });

  it('读回明确指出已确认但未选入编排的默认技能', () => {
    const spells = new CombatSpells();
    spells.noteServerMessage(exploreNotice);
    spells.setTactic({ spells: ['starbolt'], healAtOrBelow: 12 });
    const output = spells.readout();
    const state = JSON.parse(output.split('\n')[1]);
    expect(state.checks.find((s: { spell: string }) => s.spell === 'golem')).toMatchObject({
      observed: true, selected: false, manaCost: 12, block: '未选入当前编排',
    });
  });
});
