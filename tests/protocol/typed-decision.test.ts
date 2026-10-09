import { describe, expect, it } from 'vitest';
import { parseTypedChoice } from '../../src/protocol/typed-decision.ts';

const keys = ['inspect', 'change', 'wait'] as const;
const base = { type: 'choice', choice: 'inspect', confidence: 0.8,
  probabilities: { inspect: 0.8, change: 0.1, wait: 0.1 } };

describe('typed choice confidence conventions', () => {
  it.each([0.8, 0.7])('keeps the selected probability stable with reported confidence %s', confidence => {
    expect(parseTypedChoice({ ...base, confidence }, keys)).toEqual({ choice: base.choice,
      probabilities: base.probabilities, confidence, choiceProbability: 0.8 });
  });

  it('accepts tied first choices and a single possible option', () => {
    expect(parseTypedChoice({ choice: 'change', confidence: 0,
      probabilities: { inspect: 1 / 3, change: 1 / 3, wait: 1 / 3 } }, keys)?.choiceProbability).toBeCloseTo(1 / 3);
    expect(parseTypedChoice({ choice: 'wait', confidence: 1, probabilities: { wait: 1 } }, ['wait']))
      .toMatchObject({ choiceProbability: 1 });
  });

  it.each([
    { ...base, confidence: 0.5 },
    { ...base, choice: 'change', confidence: 0.1 },
    { ...base, probabilities: { ...base.probabilities, extra: 0 } },
    { ...base, probabilities: { inspect: 0.8, change: 0.1 } },
    { ...base, probabilities: { inspect: 0.8, change: 0.8, wait: 0.1 } },
    { ...base, probabilities: { inspect: NaN, change: 0.1, wait: 0.1 } },
    { ...base, probabilities: { inspect: 0.8, change: -0.1, wait: 0.3 } },
    { ...base, type: 'score' },
    { ...base, confidence: Infinity },
  ])('rejects invalid answers and an option that did not win', value => {
    expect(parseTypedChoice(value, keys)).toBeNull();
  });
});
