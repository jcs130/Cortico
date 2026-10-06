import { describe, expect, it } from 'vitest';
import { parseSteps } from '../../../src/worlds/minecraft/skills.ts';

describe('explicit movement and door states', () => {
  it('preserves exact arrival and both desired door states', () => {
    const steps = [{ skill: 'use', at: [1, 64, 0], open: true },
      { skill: 'goto', at: [2, 64, 0], exact: true },
      { skill: 'use', at: [1, 64, 0], open: false }];
    expect(parseSteps(steps)).toEqual({ steps });
    expect(parseSteps([{ skill: 'goto', at: [2, 0], exact: true }])).toHaveProperty('error');
    expect(parseSteps([{ skill: 'goto', at: [2, 64, 0], exact: 'true' }])).toHaveProperty('error');
    expect(parseSteps([{ skill: 'use', target: 'cow', open: true }])).toHaveProperty('error');
    expect(parseSteps([{ skill: 'use', at: [1, 64, 0], open: false, times: 2 }])).toHaveProperty('error');
  });
});

describe('use target contract', () => {
  it('rejects ambiguous block and entity targets with the correct distinction', () => {
    const parsed = parseSteps([{ skill: 'use', at: [1, 64, 3], target: 'bed' }]);
    expect(parsed).toHaveProperty('error');
    expect(parsed).not.toHaveProperty('steps');
    if ('error' in parsed) {
      expect(parsed.error).toContain('at 点击方块');
      expect(parsed.error).toContain('target 点击活物');
    }
    expect(parseSteps([{ skill: 'use', at: [1, 64, 3] }])).toHaveProperty('steps');
    expect(parseSteps([{ skill: 'use', target: 'sheep', item: 'shears' }])).toHaveProperty('steps');
  });
});

describe('airborne action parameters', () => {
  it('preserves explicit hover, platform landing and the separate landing action', () => {
    expect(parseSteps([
      { skill: 'flight', at: [1, 70, 3], land: false },
      { skill: 'flight', at: [2, 70, 3], land: true },
      { skill: 'land' },
    ])).toEqual({ steps: [
      { skill: 'flight', at: [1, 70, 3], land: false },
      { skill: 'flight', at: [2, 70, 3], land: true },
      { skill: 'land' },
    ] });
    expect(parseSteps([{ skill: 'flight', at: [1, 64, 3] }])).toEqual({ steps: [{ skill: 'flight', at: [1, 64, 3] }] });
  });
});

describe('craft 参数', () => {
  it('同时给目标物品和自摆格子时整单拒收', () => {
    const parsed = parseSteps([
      { skill: 'collect', block: 'spruce_log', count: 1 },
      { skill: 'craft', item: 'stick', grid: [['stick'], ['stick']], count: 4 },
    ]);
    expect(parsed).toHaveProperty('error');
    if ('error' in parsed) {
      expect(parsed.error).toContain('第 2 步');
      expect(parsed.error).toContain('item 和 grid 只能选一个');
      expect(parsed.error).toContain('只写 item 走配方表');
    }
  });

  it('目标物品和自摆格子单独提供时分别保留', () => {
    expect(parseSteps([{ skill: 'craft', item: 'stick', count: 4 }]))
      .toEqual({ steps: [{ skill: 'craft', item: 'stick', count: 4 }] });
    expect(parseSteps([{ skill: 'craft', grid: [['charcoal'], ['stick']], count: 1 }]))
      .toEqual({ steps: [{ skill: 'craft', grid: [['charcoal'], ['stick']], count: 1 }] });
  });

  it('空格只接受 JSON null，字符串 null 不会作为物品名入队', () => {
    expect(parseSteps([{ skill: 'craft', grid: [['spruce_log'], ['null']] }]))
      .toHaveProperty('error');
    expect(parseSteps([{ skill: 'craft', grid: [['spruce_log'], [null]] }]))
      .toEqual({ steps: [{ skill: 'craft', grid: [['spruce_log'], ['']], count: 1 }] });
  });
});

describe('blueprint anchor rebinding', () => {
  it('preserves the explicit previous anchor independently of conflict clearing', () => {
    const step = { skill: 'build', blueprint: 'home', at: [2, 64, 0], rebindFrom: [0, 64, 0], confirm: true };
    expect(parseSteps([step])).toEqual({ steps: [step] });
  });

  it.each([{ rebindFrom: [0, 64, '~'] }, { rebindFrom: [0, 64.5, 0] }, { rebindFrom: [0, 64] }, { rebindFrom: true }])('rejects nonabsolute previous anchor $rebindFrom', ({ rebindFrom }) => {
    expect(parseSteps([{ skill: 'build', blueprint: 'home', at: [2, 64, 0], rebindFrom }])).toHaveProperty('error');
  });

  it('requires the new anchor when requesting rebinding', () => {
    expect(parseSteps([{ skill: 'build', blueprint: 'home', rebindFrom: [0, 64, 0] }])).toHaveProperty('error');
  });
});
