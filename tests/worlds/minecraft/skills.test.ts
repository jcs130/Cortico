import { describe, expect, it } from 'vitest';
import { parseSteps } from '../../../src/worlds/minecraft/skills.ts';

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
