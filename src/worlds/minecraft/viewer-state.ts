/** Data sent to the read-only Minecraft picture for open menus and server skills. */

import { itemCustomName, itemProfileSkinHash } from './item-display.ts';
import { readDamage, readDurability, readEnchants } from './item-facts.ts';
import { minecraftTextComponent } from './text-component.ts';

export interface ViewerItem {
  name: string;
  type: number;
  itemId: number;
  displayName: string;
  count: number;
  metadata: number;
  customName?: string;
  headTextureHash?: string;
  enchanted?: boolean;
  durability?: { left: number; max: number };
  components?: unknown;
  nbt?: unknown;
}

type WindowLike = {
  id: number;
  type: string;
  title: unknown;
  slots: unknown[];
  inventoryStart: number;
  hotbarStart: number;
};

export type ViewerTradeOffer = {
  input: ViewerItem;
  secondInput: ViewerItem | null;
  output: ViewerItem;
  uses: number;
  maxUses: number;
  disabled: boolean;
  realPrice: number | null;
  xp: number | null;
};

export type ViewerTrades = {
  windowId: number;
  offers: ViewerTradeOffer[];
  level: number | null;
  experience: number | null;
  regularVillager: boolean;
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const bounded = (value: unknown, min: number, max: number): number | null =>
  finite(value) && value >= min && value <= max ? value : null;

function viewerItemData(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, 4096);
  if (!value || typeof value !== 'object' || depth >= 8) return undefined;
  if (Array.isArray(value)) return value.slice(0, 64).map((part) => viewerItemData(part, depth + 1) ?? null);
  const result: Record<string, unknown> = {};
  for (const [key, part] of Object.entries(value).slice(0, 64)) {
    const safe = viewerItemData(part, depth + 1);
    if (safe !== undefined) result[key.slice(0, 128)] = safe;
  }
  return result;
}

export function viewerItem(value: unknown): ViewerItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item.name !== 'string' || !finite(item.type)) return null;
  const customName = itemCustomName(item);
  const headTextureHash = item.name.replace(/^minecraft:/, '') === 'player_head' ? itemProfileSkinHash(item) : null;
  const componentMap = item.componentMap instanceof Map ? item.componentMap as Map<string, { data?: unknown }> : null;
  const enchantComponent = (componentMap?.get('enchantments')?.data ??
    (Array.isArray(item.components) ? (item.components as Array<{ type?: string; data?: unknown }>)
      .find(component => component.type === 'enchantments')?.data : undefined)) as { enchantments?: unknown } | undefined;
  const enchanted = (Array.isArray(enchantComponent?.enchantments) && enchantComponent.enchantments.length > 0) ||
    readEnchants(item as unknown as Parameters<typeof readEnchants>[0]).length > 0;
  const vanillaDurability = readDurability(item as unknown as Parameters<typeof readDurability>[0]);
  const customMax = componentMap?.get('max_damage')?.data;
  const max = finite(customMax) && customMax > 0 && customMax <= 1_000_000
    ? customMax : vanillaDurability?.max;
  const damage = readDamage(item as unknown as Parameters<typeof readDamage>[0]) ?? 0;
  const durability = max && !componentMap?.has('unbreakable')
    ? { left: Math.max(0, max - damage), max } : null;
  return {
    name: item.name.slice(0, 96), type: item.type, itemId: item.type,
    displayName: customName ?? (typeof item.displayName === 'string' ? item.displayName.slice(0, 80) : item.name.slice(0, 80)),
    count: bounded(item.count, 1, 127) ?? 1,
    metadata: bounded(item.metadata, 0, 65535) ?? 0,
    ...(customName ? { customName } : {}),
    ...(headTextureHash ? { headTextureHash } : {}),
    ...(enchanted ? { enchanted: true } : {}),
    ...(durability ? { durability } : {}),
    ...(item.components ? { components: viewerItemData(item.components) } : {}),
    ...(item.nbt ? { nbt: viewerItemData(item.nbt) } : {}),
  };
}

/** The 1.20.6 trade list is sent separately from the merchant's slot contents. */
export function viewerTradeList(packet: unknown,
  decodeItem: (item: unknown) => ViewerItem | null): ViewerTrades | null {
  if (!packet || typeof packet !== 'object') return null;
  const source = packet as Record<string, unknown>;
  if (!Number.isInteger(source.windowId) || !Array.isArray(source.trades)) return null;
  const offers: ViewerTradeOffer[] = [];
  for (const entry of source.trades.slice(0, 128)) {
    if (!entry || typeof entry !== 'object') continue;
    const trade = entry as Record<string, unknown>;
    const input = decodeItem(trade.inputItem1);
    const output = decodeItem(trade.outputItem);
    if (!input || !output) continue;
    const secondInput = decodeItem(trade.inputItem2);
    const uses = bounded(trade.nbTradeUses, 0, 65_535) ?? 0;
    const maxUses = bounded(trade.maximumNbTradeUses, 0, 65_535) ?? 0;
    const demand = finite(trade.demand) ? trade.demand : 0;
    const multiplier = finite(trade.priceMultiplier) ? trade.priceMultiplier : 0;
    const special = finite(trade.specialPrice) ? trade.specialPrice : 0;
    const calculatedPrice = Math.max(1, Math.min(64,
      input.count + special + Math.max(0, Math.floor(input.count * demand * multiplier))));
    const compact = (item: ViewerItem): ViewerItem => {
      const display = { ...item };
      delete display.components;
      delete display.nbt;
      return display;
    };
    offers.push({
      input: compact(input), secondInput: secondInput ? compact(secondInput) : null,
      output: compact(output), uses, maxUses,
      disabled: trade.tradeDisabled === true || (maxUses > 0 && uses >= maxUses),
      realPrice: bounded(trade.realPrice, 1, 64) ?? calculatedPrice,
      xp: bounded(trade.xp, 0, 9_999),
    });
  }
  return {
    windowId: source.windowId as number,
    offers,
    level: bounded(source.villagerLevel, 0, 5),
    experience: bounded(source.experience, 0, 1_000_000),
    regularVillager: source.isRegularVillager === true,
  };
}

export function windowSnapshot(window: WindowLike | null | undefined,
  properties: ReadonlyMap<number, number> = new Map(),
  serializeItem: (item: unknown) => object | null = viewerItem,
  trades: ViewerTrades | null = null) {
  if (!window) return null;
  const type = String(window.type || 'minecraft:generic_9x3').slice(0, 80);
  const inventoryStart = Math.max(0, Math.min(90, Number(window.inventoryStart) || 0));
  const hotbarStart = Math.max(inventoryStart, Math.min(90, Number(window.hotbarStart) || 0));
  const furnace = /(?:^|:)(?:furnace|blast_furnace|smoker)$/.test(type);
  const currentBurn = properties.get(0);
  const totalBurn = properties.get(1);
  const currentCook = properties.get(2);
  const totalCook = properties.get(3);
  const ratio = (current: number | undefined, total: number | undefined) =>
    finite(current) && finite(total) && total > 0 ? Math.max(0, Math.min(1, current / total)) : null;
  return {
    id: window.id,
    type,
    title: minecraftTextComponent(window.title).slice(0, 100) || type.replace(/^minecraft:/, '').replaceAll('_', ' '),
    slots: window.slots.slice(0, 90).map(serializeItem),
    inventoryStart,
    hotbarStart,
    containerCount: inventoryStart,
    furnace: furnace ? { burn: ratio(currentBurn, totalBurn), cook: ratio(currentCook, totalCook) } : null,
    properties: Object.fromEntries([...properties].filter(([key, value]) =>
      Number.isInteger(key) && key >= 0 && key < 16 && finite(value))),
    trades: /(?:^|:)(?:merchant|villager)$/.test(type) && trades?.windowId === window.id ? trades : null,
  };
}

export interface ViewerSkills {
  schemaVersion: 1;
  mana: { current: number; max: number } | null;
  skills: Array<{ id: string; name: string; level: number; xp: number | null; requiredXp: number | null }>;
  abilities: Array<{ id: string; name: string; level: number | null; cooldownMs: number | null;
    cooldownRemainingMs?: number | null; manaCost?: number | null; icon?: string }>;
  source?: 'plugin' | 'chat';
  observedAt?: number;
}

/** Per-player plugin payload; any Java agent client may subscribe on its own connection. */
export const VIEWER_STATE_CHANNEL = 'mcagent:state';

/** A conservative fallback for servers that report current/max mana as text. */
export function manaSnapshotFromText(text: unknown): { current: number; max: number } | null {
  if (typeof text !== 'string' || text.length > 512) return null;
  const label = /(?:魔力|法力|\b(?:mana|mp)\b)/iu.exec(text);
  if (!label) return null;
  const part = text.slice(label.index + label[0].length, label.index + label[0].length + 60);
  const pair = /(?:当前|current)?[^\d\n]{0,24}(\d{1,6})\s*\/\s*(\d{1,6})/iu.exec(part);
  if (!pair) return null;
  const current = Number(pair[1]);
  const max = Number(pair[2]);
  return max > 0 && current <= max ? { current, max } : null;
}

/** A bounded display fallback for a spell catalogue already sent to the player as system text. */
export function spellCatalogueFromText(text: unknown): ViewerSkills['abilities'] | null {
  if (typeof text !== 'string' || text.length > 16_384 ||
      !/(?:战斗咏唱|探索咏唱)[：:]/u.test(text)) return null;
  const abilities: ViewerSkills['abilities'] = [];
  for (const match of text.matchAll(/([^、，；：:()（）\s]{1,32})[（(]([a-z][a-z0-9_:-]{0,63})[，,]([^）)]{0,160})[）)]/giu)) {
    const id = match[2].toLowerCase();
    const cost = /(\d{1,4})\s*魔力/u.exec(match[3]);
    const cooldown = /(?:\/|冷却\s*)(\d{1,5})\s*秒/u.exec(match[3]);
    abilities.push({ id, name: match[1], level: null,
      cooldownMs: cooldown ? Number(cooldown[1]) * 1_000 : null,
      manaCost: cost ? Number(cost[1]) : null });
  }
  return abilities.length ? abilities : null;
}

export function viewerBossBars(value: unknown): Array<{ title: string; progress: number; color: string }> {
  if (!Array.isArray(value)) return [];
  const colors = new Set(['pink', 'blue', 'red', 'green', 'yellow', 'purple', 'white']);
  return value.slice(0, 8).flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const bar = entry as { title?: unknown; health?: unknown; color?: unknown };
    const title = minecraftTextComponent(bar.title).slice(0, 100);
    if (!title) return [];
    const health = finite(bar.health) ? Math.max(0, Math.min(1, bar.health)) : 0;
    const color = typeof bar.color === 'string' && colors.has(bar.color) ? bar.color : 'purple';
    return [{ title, progress: health, color }];
  });
}

/** Player metadata's player_absorption field is the actual remaining gold hearts. */
export function viewerPlayerAbsorption(metadata: unknown, metadataKeys?: string[]): number {
  if (!metadata || typeof metadata !== 'object') return 0;
  const index = metadataKeys?.indexOf('player_absorption') ?? 15;
  const value = (metadata as Record<number, unknown>)[index >= 0 ? index : 15];
  return finite(value) ? Math.max(0, Math.min(80, value)) : 0;
}

export function parseSkillsPayload(channel: unknown, data: unknown): ViewerSkills | null {
  if ((channel !== VIEWER_STATE_CHANNEL && channel !== 'mcviewer:state' && channel !== 'corti:viewer_state') ||
      !Buffer.isBuffer(data) || data.length > 65_536) return null;
  let raw: unknown;
  try { raw = JSON.parse(data.toString('utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  if (channel === VIEWER_STATE_CHANNEL) {
    if (input.schemaVersion !== 1 || !Object.hasOwn(input, 'mana')) return null;
    if (input.mana !== null) {
      if (!input.mana || typeof input.mana !== 'object' || Array.isArray(input.mana)) return null;
      const mana = input.mana as Record<string, unknown>;
      const current = bounded(mana.current, 0, 1_000_000);
      const max = bounded(mana.max, 0, 1_000_000);
      if (current === null || max === null || max <= 0 || current > max) return null;
    }
  }
  if (input.schemaVersion !== 1 || !('mana' in input || 'skills' in input || 'abilities' in input) ||
      (input.skills !== undefined && !Array.isArray(input.skills)) ||
      (input.abilities !== undefined && !Array.isArray(input.abilities))) return null;
  const mana = input.mana as Record<string, unknown> | null | undefined;
  const current = bounded(mana?.current, 0, 1_000_000);
  const max = bounded(mana?.max, 0, 1_000_000);
  const readName = (value: unknown, maxLength: number) => typeof value === 'string' && value.length <= maxLength ? value : null;
  const skillsInput = Array.isArray(input.skills) ? input.skills : [];
  const skills = skillsInput.map((value: unknown) => {
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    const id = readName(row.id, 64);
    const name = readName(row.name, 80);
    const level = bounded(row.level, 0, 100_000);
    if (!id || !/^[a-z0-9_:.-]+$/.test(id) || !name || level === null) return null;
    return { id, name, level, xp: bounded(row.xp, 0, 1_000_000_000),
      requiredXp: bounded(row.requiredXp, 0, 1_000_000_000) };
  });
  if (skills.some((entry) => !entry)) return null;
  const abilitiesInput = Array.isArray(input.abilities) ? input.abilities : [];
  const abilities = abilitiesInput.map((value) => {
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    const id = readName(row.id, 64);
    const name = readName(row.name, 80);
    if (!id || !/^[a-z0-9_:.-]+$/.test(id) || !name) return null;
    const icon = readName(row.icon, 64);
    const cooldownMs = bounded(row.cooldownMs, 0, 86_400_000);
    return { id, name, level: bounded(row.level, 0, 100_000),
      cooldownMs: channel === 'mcviewer:state' ? null : cooldownMs,
      ...(channel === 'mcviewer:state'
        ? { cooldownRemainingMs: cooldownMs }
        : row.cooldownRemainingMs !== undefined
          ? { cooldownRemainingMs: bounded(row.cooldownRemainingMs, 0, 86_400_000) } : {}),
      manaCost: bounded(row.manaCost, 0, 1_000_000),
      ...(icon && /^(?:minecraft:)?[a-z0-9_]+$/.test(icon)
        ? { icon: icon.replace(/^minecraft:/, '') } : {}) };
  });
  if (abilities.some((entry) => !entry)) return null;
  return { schemaVersion: 1, mana: current !== null && max !== null && max > 0 && current <= max ? { current, max } : null,
    skills: skills as ViewerSkills['skills'], abilities: abilities as ViewerSkills['abilities'] };
}

function matchingAbility(abilities: ViewerSkills['abilities'], id: string) {
  const exact = abilities.find((entry) => entry.id === id);
  if (exact) return exact;
  const suffix = id.split(':').at(-1);
  const matches = abilities.filter((entry) => entry.id.split(':').at(-1) === suffix);
  return matches.length === 1 ? matches[0] : undefined;
}

/** The private state channel owns the ability roster and cooldown; older channels may still supply skill XP. */
export function mergeViewerSkillState(previous: ViewerSkills | null, next: ViewerSkills,
  channel: string, agentStateSeen: boolean): ViewerSkills {
  const authoritative = channel === VIEWER_STATE_CHANNEL;
  const oldAbilities = previous?.abilities ?? [];
  const abilities = authoritative
    ? next.abilities.map((ability) => ({ ...ability,
      manaCost: ability.manaCost ?? matchingAbility(oldAbilities, ability.id)?.manaCost ?? null }))
    : agentStateSeen ? oldAbilities : next.abilities.length ? next.abilities : oldAbilities;
  return { ...next,
    mana: authoritative || !agentStateSeen ? next.mana : previous?.mana ?? null,
    skills: next.skills.length ? next.skills : previous?.skills ?? [],
    abilities, source: 'plugin', observedAt: Date.now() };
}

/** Chat catalogue entries supply costs until structured state offers them; they never replace its roster. */
export function mergeViewerSpellCatalogue(previous: ViewerSkills | null,
  catalogue: ViewerSkills['abilities'], agentStateSeen: boolean): ViewerSkills {
  const oldAbilities = previous?.abilities ?? [];
  const abilities = agentStateSeen
    ? oldAbilities.map((ability) => ({ ...ability,
      manaCost: ability.manaCost ?? matchingAbility(catalogue, ability.id)?.manaCost ?? null }))
    : (() => {
      const merged = new Map(oldAbilities.map((ability) => [ability.id, ability]));
      for (const entry of catalogue) {
        const old = matchingAbility(oldAbilities, entry.id);
        merged.set(old?.id ?? entry.id, old ? { ...entry, ...old,
          cooldownMs: old.cooldownMs ?? entry.cooldownMs,
          manaCost: old.manaCost ?? entry.manaCost } : entry);
      }
      return [...merged.values()];
    })();
  return { ...(previous ?? { schemaVersion: 1, mana: null, skills: [] }),
    abilities, observedAt: Date.now() };
}
