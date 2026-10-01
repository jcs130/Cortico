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

export function windowSnapshot(window: WindowLike | null | undefined,
  properties: ReadonlyMap<number, number> = new Map(),
  serializeItem: (item: unknown) => object | null = viewerItem) {
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
  };
}

export interface ViewerSkills {
  schemaVersion: 1;
  mana: { current: number; max: number } | null;
  skills: Array<{ id: string; name: string; level: number; xp: number | null; requiredXp: number | null }>;
  abilities: Array<{ id: string; name: string; level: number | null; cooldownMs: number | null }>;
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

export function parseSkillsPayload(channel: unknown, data: unknown): ViewerSkills | null {
  if ((channel !== VIEWER_STATE_CHANNEL && channel !== 'mcviewer:state' && channel !== 'corti:viewer_state') ||
      !Buffer.isBuffer(data) || data.length > 16_384) return null;
  let raw: unknown;
  try { raw = JSON.parse(data.toString('utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  if (channel === VIEWER_STATE_CHANNEL) {
    if (input.schemaVersion !== 1 || !Object.hasOwn(input, 'mana')) return null;
    if (input.mana === null) return { schemaVersion: 1, mana: null, skills: [], abilities: [] };
    if (!input.mana || typeof input.mana !== 'object' || Array.isArray(input.mana)) return null;
    const mana = input.mana as Record<string, unknown>;
    const current = bounded(mana.current, 0, 1_000_000);
    const max = bounded(mana.max, 0, 1_000_000);
    if (current === null || max === null || max <= 0 || current > max) return null;
    return { schemaVersion: 1, mana: { current, max }, skills: [], abilities: [] };
  }
  if (input.schemaVersion !== 1 || !('mana' in input || 'skills' in input || 'abilities' in input) ||
      (input.skills !== undefined && !Array.isArray(input.skills)) ||
      (Array.isArray(input.skills) && input.skills.length > 24) ||
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
  if (abilitiesInput.length > 24) return null;
  const abilities = abilitiesInput.map((value) => {
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    const id = readName(row.id, 64);
    const name = readName(row.name, 80);
    if (!id || !/^[a-z0-9_:.-]+$/.test(id) || !name) return null;
    return { id, name, level: bounded(row.level, 0, 100_000),
      cooldownMs: bounded(row.cooldownMs, 0, 86_400_000) };
  });
  if (abilities.some((entry) => !entry)) return null;
  return { schemaVersion: 1, mana: current !== null && max !== null && max > 0 && current <= max ? { current, max } : null,
    skills: skills as ViewerSkills['skills'], abilities: abilities as ViewerSkills['abilities'] };
}
