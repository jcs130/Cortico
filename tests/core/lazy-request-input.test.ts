import { describe, expect, it, vi } from 'vitest';
import { message, type ContextRecord } from '../../src/protocol/open-responses/context.ts';
import { responseRequest } from '../../src/protocol/open-responses/context-helpers.ts';
import { buildResponsesBody } from '../../src/providers/openai-responses-compat/native.ts';

function entry(text: string): ContextRecord {
  return message('user', text, { ephemeral: true });
}

describe('deferred request input', () => {
  it('does not clone the retained transcript while a provider projects it', async () => {
    const history: ContextRecord[] = Array.from({ length: 20_000 }, (_, index) => ({
      version: 2, item: { type: 'function_call_output', id: `fco_${index}`, call_id: `call_${index}`, status: 'completed', output: `row-${index}` }, context: { ephemeral: true },
    }));
    vi.spyOn(globalThis, 'structuredClone');
    const clone = vi.mocked(globalThis.structuredClone);
    clone.mockClear();
    try {
      const request = responseRequest({ model: 'fixture', thinking: false }, history, [], { deferInput: true });
      const compact = [entry('compact replacement')];
      expect(Object.prototype.propertyIsEnumerable.call(request, 'input')).toBe(false);
      expect({ ...request }.input).toBeUndefined();
      expect(clone).not.toHaveBeenCalled();
      const prepared = responseRequest({ model: 'fixture', thinking: false }, compact);
      expect(prepared.input).toEqual(compact.map(row => row.item));
      expect(clone).toHaveBeenCalledTimes(1);
    } finally {
      clone.mockRestore();
    }
  });

  it('materializes independent wire items and leaves stored history unchanged', () => {
    const history = [entry('kept')];
    const request = responseRequest({ model: 'fixture', thinking: false }, history, [], { deferInput: true });
    const first = request.input;
    const second = request.input;
    expect(Array.isArray(first)).toBe(true);
    expect(Array.isArray(second)).toBe(true);
    if (!Array.isArray(first) || !Array.isArray(second)) throw new Error('Expected materialized arrays');
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0]).not.toBe(history[0]!.item);
    const firstItem = first[0], secondItem = second[0];
    if (firstItem && typeof firstItem === 'object' && firstItem.type === 'message'
      && secondItem && typeof secondItem === 'object' && secondItem.type === 'message') {
      firstItem.content = 'changed wire copy';
      expect(secondItem.content).toEqual([{ type: 'input_text', text: 'kept' }]);
    }
    expect(history[0].item).toMatchObject({ content: [{ type: 'input_text', text: 'kept' }] });
  });

  it('builds the actual provider body from the selected compact context', () => {
    const history = [entry('discarded full history')];
    const compact = [entry('selected request')];
    const request = responseRequest({ model: 'fixture', thinking: false }, history);
    const prepared = { ...request, ...responseRequest({ model: 'fixture', thinking: false }, compact) };
    const body = buildResponsesBody(prepared, { context: compact }, {});
    expect(body.input).toEqual([compact[0]!.item]);
    expect(JSON.stringify(body)).not.toContain('discarded full history');
  });
});
