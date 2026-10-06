/**
 * 右键锄地/种地时，只有明确点在土格上方的空气、且下方方块已加载并适用，
 * 才将点击面落到下方。草苗、火把等有内容的格子不在此处暗中清除。
 */
import type { Bot } from 'mineflayer';
import type { BlockFace, Cell } from './geometry.ts';
import { AIR_NAMES, blockAtCell } from './cell-facts.ts';
import { HOE_TILLED } from './blueprint-registry.ts';
import { SEED_CROP } from './placed-ledger.ts';

export const isHoeUseItem = (item: string): boolean => item === 'hoe' || item.endsWith('_hoe');

export function farmingClickCell(bot: Bot, requested: Cell, item: string, face?: BlockFace): Cell | null {
  if (!isHoeUseItem(item) && SEED_CROP[item] === undefined && item !== 'nether_wart') return null;
  if (face && face !== 'up') return null;
  const upper = blockAtCell(bot, requested);
  if (!upper || !AIR_NAMES.has(upper.name)) return null;
  const below = { x: requested.x, y: requested.y - 1, z: requested.z };
  const soil = blockAtCell(bot, below);
  if (!soil) return null;
  if (isHoeUseItem(item) && HOE_TILLED[soil.name] !== undefined) return below;
  if (SEED_CROP[item] !== undefined && soil.name === 'farmland') return below;
  if (item === 'nether_wart' && soil.name === 'soul_sand') return below;
  return null;
}
