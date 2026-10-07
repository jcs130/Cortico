import { describe, expect, it } from 'vitest';
import { routeViaServerCommand } from '../src/world.ts';

describe('千灯纪服务端快捷抵达', () => {
  it('个人奖励箱单独打开改查待入箱奖励，并说明不是箱内清单；组合取物仍打开 GUI', () => {
    const standalone = routeViaServerCommand({ steps: [{ skill: 'chat', text: '/mycli arena rewards' }] });
    expect(standalone.args.steps).toEqual([{ skill: 'chat', text: '/mycli arena rewards list' }]);
    expect(standalone.note).toContain('不反映个人箱内物品或空位');
    const combined = [
      { skill: 'chat', text: '/mycli arena rewards' },
      { skill: 'take', item: 'emerald', count: 1, from: 'open' },
    ];
    expect(routeViaServerCommand({ steps: combined }).args.steps).toEqual(combined);
  });

  it('个人箱里的发光浆果使用真实物品 ID，保留存取步骤和目标箱', () => {
    const steps = [
      { skill: 'chat', text: '/mycli arena rewards' },
      { skill: 'take', item: 'glowing_berries', count: 4, from: 'open' },
      { skill: 'stow', item: '发光浆果', count: 4, at: [-473, 67, -491] },
    ];
    const result = routeViaServerCommand({ steps });
    expect(result.args.steps).toEqual([
      steps[0],
      { ...steps[1], item: 'glow_berries' },
      { ...steps[2], item: 'glow_berries' },
    ]);
    expect(result.note).toContain('glow_berries');
    expect(steps[1].item).toBe('glowing_berries');
  });

  it('远程去试炼场入口先使用已验证命令，随后仍核验目标坐标', () => {
    const target = { skill: 'goto', at: [-594, 91, -313], dimension: 'minecraft:overworld' };
    const result = routeViaServerCommand({ steps: [target] });
    expect(result.args.steps).toEqual([
      { skill: 'server_travel', command: '/mycli goto arena', at: [-590, 91, -322], within: 3 },
      { ...target, needs: [1] },
    ]);
    expect(result.note).toContain('/mycli goto arena');
  });

  it('已有同一命令不重复插入；普通路线保持原样', () => {
    const at = { skill: 'goto', at: [-594, 91, -313] };
    const steps = [{ skill: 'chat', text: '/mycli goto arena' }, at];
    expect(routeViaServerCommand({ steps }).args.steps).toEqual([
      { skill: 'server_travel', command: '/mycli goto arena', at: [-590, 91, -322], within: 3 },
      { ...at, needs: [1] },
    ]);
    const other = [{ skill: 'goto', at: [-500, 70, -400] }];
    expect(routeViaServerCommand({ steps: other }).args.steps).toEqual(other);
  });

  it('插入传送步骤后重映射显式依赖，失败时不执行后续到达', () => {
    const steps = [
      { skill: 'look', yaw: 0 },
      { skill: 'goto', at: [-594, 91, -313], needs: [1] },
      { skill: 'chat', text: '抵达', needs: [2] },
    ];
    const result = routeViaServerCommand({ steps }).args.steps as Array<{ skill: string; needs?: number[] }>;
    expect(result[1].skill).toBe('server_travel');
    expect(result[1].needs).toEqual([1]);
    expect(result[2].needs).toEqual([1, 2]);
    expect(result[3].needs).toEqual([3]);
  });

  it('入口落点坐标与 overworld 别名也走快捷传送', () => {
    const target = { skill: 'goto', at: [-590, 91, -322], dimension: 'overworld' };
    expect(routeViaServerCommand({ steps: [target] }).args.steps).toEqual([
      { skill: 'server_travel', command: '/mycli goto arena', at: [-590, 91, -322], within: 3 },
      { ...target, needs: [1] },
    ]);
  });

  it('去出生村庄时先走服务端路标，避免远距离徒步', () => {
    const target = { skill: 'goto', at: [-544, 66, -440] };
    expect(routeViaServerCommand({ steps: [target] }).args.steps).toEqual([
      { skill: 'server_travel', command: '/mycli goto village', at: [-544, 66, -440], within: 3 },
      { ...target, needs: [1] },
    ]);
  });
});
