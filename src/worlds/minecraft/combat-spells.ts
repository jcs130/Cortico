import type { Bot } from 'mineflayer';
import { HOSTILE } from './melee.ts';
import { manaSnapshotFromText } from './viewer-state.ts';

export type CombatSpell = string;
export interface CombatTactic {
  spells: CombatSpell[] | null;
  healAtOrBelow: number | null;
}

const SPELLS: ReadonlyArray<CombatSpell> = ['golem', 'frostnova', 'flamewave', 'starbolt'];
const SPELL_COOLDOWN_MS: Readonly<Record<string, number>> = {
  golem: 75_000,
  frostnova: 15_000,
  flamewave: 15_000,
  starbolt: 6_000,
};
const DEFAULT_COST: Readonly<Record<string, number>> = {
  golem: 12, frostnova: 7, flamewave: 8, starbolt: 4,
};
const GLOBAL_GAP_MS = 1_500;
const CHECK_GAP_MS = 250;
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast', 'illusioner', 'breeze']);

/** 只把本次连接中服务器明确公布的战斗/探索法术交给即时战斗决策。 */
export class CombatSpells {
  private readonly available = new Set<CombatSpell>();
  private readonly costs = new Map<CombatSpell, number>();
  private readonly cooldowns = new Map<CombatSpell, number>();
  private readonly lastSent = new Map<CombatSpell, number>();
  private readonly serverReadyAt = new Map<CombatSpell, number>();
  private readonly manaRetryAt = new Map<CombatSpell, number>();
  private lastAny = Number.NEGATIVE_INFINITY;
  private lastCheck = Number.NEGATIVE_INFINITY;
  private manaBlockedUntil = 0;
  private pending: { spell: CombatSpell; at: number } | null = null;
  private mana: number | null = null;
  private manaLoading = false;
  private tactic: CombatTactic | null = null;

  setTactic(tactic: CombatTactic | null): void {
    this.tactic = tactic && { spells: tactic.spells?.slice() ?? null,
      healAtOrBelow: tactic.healAtOrBelow };
  }

  getTactic(): CombatTactic | null {
    return this.tactic && { spells: this.tactic.spells?.slice() ?? null,
      healAtOrBelow: this.tactic.healAtOrBelow };
  }

  wantsHeal(health: number): boolean {
    const line = this.tactic?.healAtOrBelow ?? 10;
    return health > 0 && health <= line;
  }

  reset(): void {
    this.available.clear();
    this.costs.clear();
    this.cooldowns.clear();
    this.lastSent.clear();
    this.serverReadyAt.clear();
    this.manaRetryAt.clear();
    this.lastAny = Number.NEGATIVE_INFINITY;
    this.lastCheck = Number.NEGATIVE_INFINITY;
    this.manaBlockedUntil = 0;
    this.pending = null;
    this.mana = null;
    this.manaLoading = false;
  }

  noteMana(current: number | null, now = Date.now()): void {
    if (current === null) {
      this.mana = null;
      this.manaLoading = true;
      return;
    }
    if (Number.isFinite(current) && current >= 0) {
      this.mana = current;
      this.manaLoading = false;
    }
  }

  noteAbilities(abilities: ReadonlyArray<{ id: string; cooldownMs: number | null;
    cooldownRemainingMs?: number | null; manaCost?: number | null }>, now = Date.now()): void {
    this.available.clear();
    for (const ability of abilities) {
      const spell = ability.id.split(':').at(-1);
      if (!spell) continue;
      this.available.add(spell);
      if (ability.cooldownMs !== null) this.cooldowns.set(spell, ability.cooldownMs);
      if (ability.cooldownRemainingMs !== undefined && ability.cooldownRemainingMs !== null)
        this.serverReadyAt.set(spell, now + ability.cooldownRemainingMs);
      if (ability.manaCost !== undefined && ability.manaCost !== null)
        this.costs.set(spell, ability.manaCost);
    }
  }

  hasAbility(spell: string): boolean {
    return this.available.has(spell);
  }

  noteServerMessage(text: string, now = Date.now()): void {
    const reportedMana = manaSnapshotFromText(text);
    if (reportedMana) this.noteMana(reportedMana.current, now);
    if (/^(?:战斗咏唱|探索咏唱)[：:]/.test(text)) {
      for (const match of text.matchAll(/[（(]([a-z][a-z0-9_:-]*)[，,]([^）)]*)[）)]/gi)) {
        const spell = match[1].toLowerCase();
        if (!this.available.has(spell)) {
          this.available.add(spell);
          this.lastCheck = Number.NEGATIVE_INFINITY;
        }
        const cost = /(\d+)\s*魔力/.exec(match[2]);
        if (cost) this.costs.set(spell, Number(cost[1]));
        const cooldown = /(\d+)\s*秒/.exec(match[2]);
        if (cooldown) this.cooldowns.set(spell, Number(cooldown[1]) * 1_000);
      }
    }
    if (/魔力不足|灵力不足|not enough (?:mana|magic)|insufficient (?:mana|magic)/i.test(text)) {
      if (this.pending && now - this.pending.at <= 3_000) {
        const required = /需要\s*(\d+)/.exec(text);
        if (required) this.costs.set(this.pending.spell, Number(required[1]));
        if (reportedMana) {
          this.manaRetryAt.set(this.pending.spell,
            Math.max(reportedMana.current + 1, Number(required?.[1] ?? 0)));
        }
      }
      this.manaBlockedUntil = now + (reportedMana ? GLOBAL_GAP_MS : 15_000);
      this.pending = null;
    } else if (this.pending && now - this.pending.at <= 3_000
      && /冷却中|cooldown|无法施放|施法失败|cannot cast|failed to cast/i.test(text)) {
      this.pending = null;
    }
  }

  /** 返回一项即时施法决定；调用方成功发包后须调用 noteSent。 */
  next(bot: Bot, fighting: boolean, now = Date.now(), reserveGolem = false): CombatSpell | null {
    if (!fighting || !bot.entity || (bot.health ?? 0) <= 0) return null;
    if (now - this.lastCheck < CHECK_GAP_MS) return null;
    this.lastCheck = now;
    if (now < this.manaBlockedUntil || now - this.lastAny < GLOBAL_GAP_MS) return null;

    const p = bot.entity.position;
    const foes = Object.values(bot.entities ?? {}).filter((e) => {
      if (!e?.position || e.isValid === false || !HOSTILE.has(e.name ?? '')) return false;
      return Math.hypot(e.position.x - p.x, e.position.y - p.y, e.position.z - p.z) <= 16;
    });
    if (foes.length === 0) return null;
    const near = (radius: number): number => foes.filter((e) =>
      Math.hypot(e.position.x - p.x, e.position.y - p.y, e.position.z - p.z) <= radius).length;
    const ready = (spell: CombatSpell): boolean => this.available.has(spell) && this.hasMana(spell, now)
      && now >= (this.serverReadyAt.get(spell) ?? Number.NEGATIVE_INFINITY)
      && now - (this.lastSent.get(spell) ?? Number.NEGATIVE_INFINITY) >= this.cooldownOf(spell);

    const planned = this.tactic?.spells ?? null;
    if (reserveGolem && !planned) return null;
    for (const spell of planned ?? SPELLS) {
      if (!ready(spell)) continue;
      if (spell === 'golem' && foes.length >= (planned ? 1 : 3)) return spell;
      if (spell === 'frostnova' && near(7) >= (planned ? 1 : 2)) return spell;
      if (spell === 'flamewave' && near(8) >= (planned ? 1 : 2)) return spell;
      if (spell === 'starbolt' && (planned ? near(12) >= 1
        : foes.some((e) => RANGED.has(e.name ?? '')))) return spell;
      if (planned && !SPELLS.includes(spell) && near(12) >= 1) return spell;
    }
    return null;
  }

  finalArenaOpening(now = Date.now()): CombatSpell | null {
    if (now < this.manaBlockedUntil || now - this.lastAny < GLOBAL_GAP_MS) return null;
    if (!this.available.has('golem') || !this.hasMana('golem', now)) return null;
    if (now - (this.lastSent.get('golem') ?? Number.NEGATIVE_INFINITY) < this.cooldownOf('golem')) return null;
    return 'golem';
  }

  noteSent(spell: CombatSpell, now = Date.now()): void {
    this.lastSent.set(spell, now);
    this.lastAny = now;
    this.pending = { spell, at: now };
    const cost = this.costs.get(spell) ?? DEFAULT_COST[spell];
    if (this.mana !== null && cost !== undefined) this.mana = Math.max(0, this.mana - cost);
  }

  noteSupportSent(now = Date.now()): void {
    this.noteSent('selfheal', now);
  }

  private hasMana(spell: CombatSpell, now: number): boolean {
    return !this.manaLoading && (this.mana === null || this.mana >= Math.max(
      this.costs.get(spell) ?? DEFAULT_COST[spell] ?? 1,
      this.manaRetryAt.get(spell) ?? 0,
    ));
  }

  noteManualCast(spell: string, now = Date.now()): void {
    this.noteSent(spell, now);
  }

  /** Stop repeated manual commands while the server-known spell is cooling down. */
  manualCastBlock(spell: string, now = Date.now()): string | null {
    const serverLeft = (this.serverReadyAt.get(spell) ?? Number.NEGATIVE_INFINITY) - now;
    if (serverLeft > 0) return `${spell}冷却还需约 ${Math.ceil(serverLeft / 1000)} 秒；等服务端状态更新`;
    const left = this.cooldownOf(spell) - (now - (this.lastSent.get(spell) ?? Number.NEGATIVE_INFINITY));
    if (left > 0) return `${spell}刚发送过，冷却还需约 ${Math.ceil(left / 1000)} 秒；等服务端回执或换技能`;
    if (spell !== 'selfheal' && now - this.lastAny < GLOBAL_GAP_MS)
      return '上一条施法命令刚发送过；稍后再试';
    if (this.manaLoading) return '服务端魔力资料尚未加载；等状态快照再试';
    if (now < this.manaBlockedUntil) return `${spell}暂因魔力不足而受限；等魔力恢复或服务端新读数`;
    if (!this.hasMana(spell, now)) return `${spell}所需魔力高于最近服务端读数；等魔力恢复再试`;
    return null;
  }

  private cooldownOf(spell: CombatSpell): number {
    return this.cooldowns.get(spell) ?? SPELL_COOLDOWN_MS[spell] ?? 15_000;
  }
}
