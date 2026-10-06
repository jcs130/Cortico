import type { Bot } from 'mineflayer';
import { describe, expect, it } from 'vitest';
import { resolveFindTarget, skillCollect } from '../../../src/worlds/minecraft/skills-gather.ts';

describe('找怪目标与同名前缀方块', () => {
  it('zombie 和 skeleton 按实体处理，不把头颅方块当成要挖的目标', () => {
    const bot = { registry: {
      entitiesByName: { zombie: {}, skeleton: {} },
      blocksByName: {
        zombie_head: { id: 1, name: 'zombie_head' },
        skeleton_skull: { id: 2, name: 'skeleton_skull' },
      },
      itemsByName: {},
    } } as unknown as Bot;
    expect(resolveFindTarget(bot, 'zombie')).toEqual({ ids: [], entityName: 'zombie' });
    expect(resolveFindTarget(bot, 'skeleton')).toEqual({ ids: [], entityName: 'skeleton' });
  });

  it('精确方块名仍按方块处理', () => {
    const bot = { registry: {
      entitiesByName: { tnt: {} },
      blocksByName: { tnt: { id: 3, name: 'tnt' } },
      itemsByName: {},
    } } as unknown as Bot;
    expect(resolveFindTarget(bot, 'tnt')).toEqual({ ids: [3], entityName: null });
  });

  it('采木类别只找天然原木，精确 spruce_log 不误选建筑用的去皮原木', () => {
    const bot = { registry: {
      entitiesByName: {},
      blocksByName: {
        spruce_log: { id: 10, name: 'spruce_log' },
        stripped_spruce_log: { id: 11, name: 'stripped_spruce_log' },
        oak_log: { id: 12, name: 'oak_log' },
      },
      itemsByName: {},
    } } as unknown as Bot;
    expect(resolveFindTarget(bot, 'spruce_log')).toEqual({ ids: [10], entityName: null });
    expect(resolveFindTarget(bot, 'log')).toEqual({ ids: [10, 12], entityName: null });
    expect(resolveFindTarget(bot, 'stripped_spruce_log')).toEqual({ ids: [11], entityName: null });
  });

  it('自动采集不拆加工过的建筑原木', async () => {
    await expect(skillCollect({} as Bot, 'stripped_spruce_log', 2,
      {} as Parameters<typeof skillCollect>[3])).rejects.toThrow('去皮原木是加工过的建筑材料');
  });
});
