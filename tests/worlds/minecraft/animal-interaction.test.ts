import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { parseSteps } from '../../../src/worlds/minecraft/skills.ts';
import { leaveVehicle, useEntityOf, useNoteOn, useOnce } from '../../../src/worlds/minecraft/skills-interact.ts';
import type { SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';

function animalBot() {
  const keys = ['health', 'baby', 'flags', 'owneruuid', 'trusting'];
  const near = { id: 11, name: 'chicken', isValid: true, position: new Vec3(1, 64, 0), metadata: [4, false] };
  const far = { id: 12, name: 'chicken', isValid: true, position: new Vec3(2, 64, 0), metadata: [4, false] };
  const bag = [{ name: 'wheat_seeds', count: 3 }];
  const fed: number[] = [];
  const bot = {
    _client: { write: () => {} },
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    player: { uuid: 'self' },
    entities: { 11: near, 12: far } as Record<number, typeof near>,
    registry: { entitiesByName: Object.fromEntries(['chicken', 'wolf', 'cat', 'horse', 'ocelot'].map(name => [name, { metadataKeys: keys }])) },
    world: { raycast: () => null as unknown },
    inventory: { items: () => bag },
    heldItem: bag[0],
    pathfinder: { goto: async () => {}, goal: null },
    lookAt: async () => {},
    useOn: async (entity: typeof near) => { fed.push(entity.id); bag[0].count -= 1; },
    fed,
  };
  return bot;
}

afterEach(() => vi.useRealTimers());

describe('动物交互选择与结果', () => {
  it('同种两只分别按当前 ID 喂养，默认仍选择最近者', async () => {
    vi.useFakeTimers();
    const bot = animalBot();
    const ctx = { aborted: () => false } as SkillContext;
    const first = useOnce(bot as unknown as Bot, { skill: 'use', target: 'chicken', entityId: 12 }, ctx);
    await vi.runAllTimersAsync();
    expect(await first).toContain('用掉:');
    const second = useOnce(bot as unknown as Bot, { skill: 'use', target: 'chicken', entityId: 11 }, ctx);
    await vi.runAllTimersAsync();
    await second;
    expect(bot.fed).toEqual([12, 11]);
    expect(bot.inventory.items()[0].count).toBe(1);
    expect(useEntityOf(bot as unknown as Bot, 'chicken').id).toBe(11);
  });

  it('丢失、种类不符、超出范围或被遮挡的指定实体不会改点最近者', () => {
    const bot = animalBot();
    expect(() => useEntityOf(bot as unknown as Bot, 'chicken', 99)).toThrow('未改点');
    expect(() => useEntityOf(bot as unknown as Bot, 'wolf', 12)).toThrow('未改点');
    bot.entities[12].position.x = 50;
    expect(() => useEntityOf(bot as unknown as Bot, 'chicken', 12)).toThrow('未改点');
    bot.entities[12].position.x = 2;
    bot.world.raycast = () => ({});
    expect(() => useEntityOf(bot as unknown as Bot, 'chicken', 12)).toThrow('被遮挡');
    expect(bot.fed).toEqual([]);
  });

  it('严格校验 ID，同时保留原有不指定实体的用法', () => {
    expect(parseSteps([{ skill: 'use', target: 'chicken', entityId: 0 }])).toEqual({ steps: [{ skill: 'use', target: 'chicken', entityId: 0 }] });
    expect(parseSteps([{ skill: 'use', item: 'wheat_seeds', target: 'chicken' }])).toEqual({ steps: [{ skill: 'use', item: 'wheat_seeds', target: 'chicken' }] });
    for (const entityId of [-1, 1.5, '12', null, NaN, 2_147_483_648]) {
      expect(parseSteps([{ skill: 'use', target: 'chicken', entityId }])).toHaveProperty('error');
    }
    expect(parseSteps([{ skill: 'use', at: [0, 64, 0], entityId: 12 }])).toHaveProperty('error');
  });

  it('缺少元数据不声称没有主人或属于别人，喂已驯猫也不声称每次消耗或随机驯服', () => {
    const bot = animalBot();
    const unread = useNoteOn(bot as unknown as Bot, 'bone', 'wolf', { name: 'wolf', metadata: [] });
    expect(unread).not.toMatch(/还没有主人|别的主人|每次都会|再来一次/);
    const cat = useNoteOn(bot as unknown as Bot, 'cod', 'cat', { name: 'cat', metadata: [10, false, 4, 'self'] });
    expect(cat).toMatch(/你|自己|本人/);
    expect(cat).not.toMatch(/随机|每次都会|还没有主人/);
    const baby = useNoteOn(bot as unknown as Bot, 'wheat_seeds', 'chicken', { name: 'chicken', metadata: [4, true] });
    expect(baby).not.toContain('未成年、');
  });

  it('豹猫信任与主人分开回报，上马回执声明驾驶边界', () => {
    const bot = animalBot();
    const note = useNoteOn(bot as unknown as Bot, 'cod', 'ocelot', { name: 'ocelot', metadata: [10, false, undefined, undefined, true] });
    expect(note).toContain('信任');
    expect(note).not.toContain('认你当主人');
    const mounted = { ...bot, vehicle: { name: 'horse' } };
    expect(leaveVehicle(mounted as unknown as Bot, 'horse')).toContain('尚不支持驾驶');
    expect(leaveVehicle(mounted as unknown as Bot, 'horse')).not.toContain('"to"');
    expect(leaveVehicle({ ...mounted, vehicle: { name: 'boat' } } as unknown as Bot, 'boat')).toContain('"to"');
  });
});
