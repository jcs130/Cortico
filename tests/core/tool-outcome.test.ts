import { describe, expect, it } from 'vitest';
import { explainToolOutcome } from '../../src/core/tool-outcome.ts';
import type { ToolOutcome } from '../../src/core/types.ts';
import { nullLogger } from '../../src/core/util.ts';

describe('Persona synchronous tool explanations', () => {
  const outcome: ToolOutcome = { text: 'Actual result.', failed: true, endsTurn: true,
    blobs: [{ bytes: new Uint8Array([1, 2]), mime: 'image/png', fallbackText: 'Saved frame.' }] };
  const context = { role: 'main', tool: 'act', args: { target: [1, 2, 3] }, outcome };

  it('keeps unimplemented or empty explanations byte-identical', () => {
    for (const hook of [undefined, () => undefined, () => null, () => '']) {
      expect(explainToolOutcome(hook, context, nullLogger())).toBe(outcome);
    }
  });

  it('appends Persona text while preserving flags, media and the original result', () => {
    const explained = explainToolOutcome(() => 'Reconsider this result.', context, nullLogger());
    expect(explained).toEqual({ ...outcome, text: 'Actual result.\nReconsider this result.' });
    expect(explained.blobs).toBe(outcome.blobs);
    expect(outcome.text).toBe('Actual result.');
  });

  it('isolates hook exceptions and logs no tool arguments', () => {
    const log = nullLogger();
    const warnings: unknown[] = [];
    log.warn = (_message, data) => { warnings.push(data); };
    expect(explainToolOutcome(() => { throw new Error('Hook failed.'); }, context, log)).toBe(outcome);
    expect(warnings).toEqual([{ err: 'Error: Hook failed.' }]);
  });
});
