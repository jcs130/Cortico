import { describe, expect, it, vi } from 'vitest';
import module from '../../../src/providers/openai-responses-compat/index.ts';
import { responsesInput } from '../../../src/providers/transport/responses-input.ts';
import { renderMessagesWithMedia } from '../../../src/providers/transport/history.ts';
import { functionCall, functionResult, message, record } from '../../../src/protocol/open-responses/context.ts';
import { nullLogger } from '../../../src/core/util.ts';
import type { LLMProviderEntry } from '../../../src/core/types.ts';

const image = (handle: string) => ({ handle, mime: 'image/png', fallbackText: `fallback ${handle}` });
const context = () => [
  message('system', 'instructions', { blobs: [image('prefix')] }),
  message('user', '[10:00] fallback old', { ts: '10:00', blobs: [image('old')] }),
  functionCall('first', 'visual', '{}'),
  functionResult('first', '[10:01] fallback middle', { ts: '10:01', blobs: [image('middle')] }),
  functionCall('second', 'visual', '{}'),
  functionResult('second', '[10:02] fallback old + newer', { ts: '10:02', blobs: [image('old'), image('newer')] }),
  message('user', '[10:03] fallback latest', { ts: '10:03', blobs: [image('latest')] }),
];
type Wire = Record<string, unknown>;
const imageCount = (input: Wire[]) => input.reduce((sum, item) => sum +
  [item.content, item.output].flatMap(value => Array.isArray(value) ? value : [])
    .filter(part => part.type === 'input_image').length, 0);
const entry: LLMProviderEntry = { kind: 'openai-responses-compat', baseUrl: 'https://unused.test', multimodal: true };

describe('saved image replay budget', () => {
  it('keeps the text prefix stable when a fourth screenshot replaces the oldest saved image', () => {
    const initial = [message('system', 'instructions')];
    for (const handle of ['a', 'b', 'c']) {
      initial.push(functionCall(handle, 'visual', '{}'),
        functionResult(handle, `receipt ${handle}`, { ts: `time-${handle}`, blobs: [image(handle)] }));
    }
    const next = [...initial, functionCall('d', 'visual', '{}'),
      functionResult('d', 'receipt d', { ts: 'time-d', blobs: [image('d')] })];
    const original = structuredClone(next);
    const media = { enabled: () => true, read: (handle: string) => Buffer.from(handle), maxContextImages: 3 };
    const before = responsesInput({}, { context: initial }, { media }).input;
    const after = responsesInput({}, { context: next }, { media }).input;
    expect(after.slice(0, initial.length - 1)).not.toEqual(before.slice(0, initial.length - 1));

    const stableMedia = { ...media, imageReplayPlacement: 'tail' as const };
    const stableBefore = responsesInput({}, { context: initial }, { media: stableMedia }).input;
    const stableAfter = responsesInput({}, { context: next }, { media: stableMedia }).input;
    expect(stableAfter.slice(0, initial.length - 1)).toEqual(stableBefore.slice(0, initial.length - 1));
    expect(stableAfter.slice(0, next.length - 1)).toEqual(next.slice(1).map(row => row.item));
    expect(imageCount(stableAfter)).toBe(3);
    const attachments = stableAfter.slice(next.length - 1);
    expect(attachments.map(row => JSON.parse((row.content as Wire[])[0].text as string))).toEqual(
      ['b', 'c', 'd'].map(handle => ({ attachment: handle, mime: 'image/png', fallbackText: `fallback ${handle}`,
        sourceItem: { type: 'function_call_output', callId: handle, ts: `time-${handle}` } })),
    );
    expect(next).toEqual(original);
  });

  it('tail placement keeps original inline images and does not substitute missing saved bytes', () => {
    const native = record({ type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'explicit image' },
      { type: 'input_image', image_url: 'https://unused.test/image.png' },
    ] });
    const entries = [...context(), native];
    const read = vi.fn((_handle: string) => null);
    const result = responsesInput({}, { context: entries }, {
      media: { enabled: () => true, read, maxContextImages: 1, imageReplayPlacement: 'tail' },
    });
    expect(result.input.at(-1)).toEqual(native.item);
    expect(read.mock.calls.map(([handle]) => handle)).toEqual(['latest']);
    expect(imageCount(result.input)).toBe(1);
    expect(JSON.stringify(result.input)).toContain('[10:00] fallback old');
  });

  it('wires tail placement through the provider while preserving tool outputs as text', () => {
    const read = (handle: string) => Buffer.from(handle);
    const entries = context();
    const instance = module.create('bounded', { ...entry,
      options: { maxContextImages: 1, imageReplayPlacement: 'tail' } }, {
      stateDir: '', secret: () => '', readBlob: read, keepThinking: () => true, log: nullLogger(),
    });
    const body = (instance.client as any).buildResponseBody({ model: 'm' }, { context: entries });
    expect(body.input.at(-1)).toMatchObject({ type: 'message', role: 'user', content: [{ type: 'input_text' }, { type: 'input_image' }] });
    expect(body.input.filter((item: Wire) => item.type === 'function_call_output')).toEqual([
      entries[3].item, entries[5].item,
    ]);
    expect(body).not.toHaveProperty('imageReplayPlacement');
  });

  it('expands the newest distinct handles at their last occurrence, preserving text, times and tool pairing', () => {
    const entries = context();
    const before = structuredClone(entries);
    const read = vi.fn((handle: string) => Buffer.from(handle));
    const result = responsesInput({ model: 'm' }, { context: entries }, {
      media: { enabled: () => true, read, maxContextImages: 3 },
    });
    expect(read.mock.calls.map(([handle]) => handle)).toEqual(['old', 'newer', 'latest']);
    expect(imageCount(result.input)).toBe(3);
    expect(result.instructions).toBe('instructions');
    expect(result.input[0]).toEqual(entries[1].item);
    expect(result.input[2]).toEqual(entries[3].item);
    expect(result.input.filter(item => item.type === 'function_call').map(item => item.call_id)).toEqual(['first', 'second']);
    expect(result.input.filter(item => item.type === 'function_call_output').map(item => item.call_id)).toEqual(['first', 'second']);
    expect(JSON.stringify(result.input)).toContain('[10:02] fallback old + newer');
    expect(entries).toEqual(before);
  });

  it('uses chronological order inside one attachment group and counts each expanded image', () => {
    const read = vi.fn((handle: string) => Buffer.from(handle));
    const entries = [message('user', 'three views', { blobs: [image('a'), image('b'), image('c')] })];
    const result = responsesInput({}, { context: entries }, { media: { enabled: () => true, read, maxContextImages: 2 } });
    expect(read.mock.calls.map(([handle]) => handle)).toEqual(['b', 'c']);
    expect(imageCount(result.input)).toBe(2);
  });

  it('keeps all existing image occurrences when the budget is unset', () => {
    const read = vi.fn((handle: string) => Buffer.from(handle));
    const result = responsesInput({}, { context: context() }, { media: { enabled: () => true, read } });
    expect(read.mock.calls.map(([handle]) => handle)).toEqual(['old', 'middle', 'old', 'newer', 'latest']);
    expect(imageCount(result.input)).toBe(5);
  });

  it.each([true, false])('does not read blobs with budget zero or image support disabled: enabled=%s', enabled => {
    const read = vi.fn(() => { throw new Error('must not read image bytes'); });
    const result = responsesInput({}, { context: context() }, {
      media: { enabled: () => enabled, read, maxContextImages: enabled ? 0 : 3 },
    });
    expect(read).not.toHaveBeenCalled();
    expect(imageCount(result.input)).toBe(0);
    expect(JSON.stringify(result.input)).toContain('[10:00] fallback old');
    expect(JSON.stringify(result.input)).toContain('[10:03] fallback latest');
  });

  it('does not read older images to replace an unreadable retained image', () => {
    const read = vi.fn((_handle: string) => null);
    const result = responsesInput({}, { context: context() }, { media: { enabled: () => true, read, maxContextImages: 1 } });
    expect(read.mock.calls.map(([handle]) => handle)).toEqual(['latest']);
    expect(imageCount(result.input)).toBe(0);
  });

  it('leaves native inline image parts unchanged: the documented budget covers saved blob replay', () => {
    const native = record({ type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'explicit image' },
      { type: 'input_image', image_url: 'https://unused.test/image.png' },
    ] });
    const read = vi.fn((_handle: string) => null);
    const result = responsesInput({}, { context: [native] }, { media: { enabled: () => true, read, maxContextImages: 0 } });
    expect(result.input[0]).toEqual(native.item);
    expect(imageCount(result.input)).toBe(1);
    expect(read).not.toHaveBeenCalled();
  });

  it('applies the shared selection to Chat without changing tool ids or fallback text', () => {
    const read = vi.fn((handle: string) => Buffer.from(handle));
    const result = renderMessagesWithMedia([
      { role: 'user', content: '[10:00] fallback old', blobs: [image('old')] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call', type: 'function', function: { name: 'visual', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call', content: '[10:01] fallback latest', blobs: [image('latest')] },
    ], { enabled: () => true, read, maxContextImages: 1 });
    expect(read.mock.calls.map(([handle]) => handle)).toEqual(['latest']);
    expect(result[0].content).toBe('[10:00] fallback old');
    expect(result[1].tool_calls).toMatchObject([{ id: 'call' }]);
    expect(result[2].tool_call_id).toBe('call');
    expect(result[2].content).toMatchObject([{ type: 'text', text: '[10:01] fallback latest' }, { type: 'image_url' }]);
  });

  it('wires the instance option into the actual body builder without a model request', () => {
    const read = vi.fn((handle: string) => Buffer.from(handle));
    const instance = module.create('bounded', { ...entry, options: { maxContextImages: 1 } }, {
      stateDir: '', secret: () => '', readBlob: read, keepThinking: () => true, log: nullLogger(),
    });
    const body = (instance.client as any).buildResponseBody({ model: 'm' }, { context: context() });
    expect(read.mock.calls.map(([handle]) => handle)).toEqual(['latest']);
    expect(imageCount(body.input)).toBe(1);
    expect(body).not.toHaveProperty('maxContextImages');
  });

  it('declares an optional integer ConfigGroup field, with no automatic zero default', () => {
    const field = module.config('gateway', entry, 'en')[0].schema.properties!['providers.gateway.options.maxContextImages'];
    expect(field).toMatchObject({ type: 'integer', minimum: 0, 'x-hot': true });
    expect(field).not.toHaveProperty('default');
    expect(module.normalize({ ...entry, options: { maxContextImages: '' } }).options).not.toHaveProperty('maxContextImages');
    for (const value of [undefined, 0, 3])
      expect(() => module.validateEntry({ ...entry, options: { maxContextImages: value } }, 'en')).not.toThrow();
  });

  it('declares and validates image placement independently of its replay budget', () => {
    const field = module.config('gateway', entry, 'en')[0].schema.properties!['providers.gateway.options.imageReplayPlacement'];
    expect(field).toMatchObject({ type: 'string', enum: ['inline', 'tail'], 'x-hot': true });
    expect(field).not.toHaveProperty('default');
    expect(module.normalize({ ...entry, options: { imageReplayPlacement: '' } }).options).not.toHaveProperty('imageReplayPlacement');
    for (const value of [undefined, 'inline', 'tail'])
      expect(() => module.validateEntry({ ...entry, options: { imageReplayPlacement: value } }, 'en')).not.toThrow();
    for (const value of [null, 0, 'latest'])
      expect(() => module.validateEntry({ ...entry, options: { imageReplayPlacement: value } }, 'en')).toThrow('inline or tail');
  });

  it.each([-1, 1.5, NaN, Infinity, '3', null, Number.MAX_SAFE_INTEGER + 1])('rejects invalid budgets: %s', value => {
    expect(() => module.validateEntry({ ...entry, options: { maxContextImages: value } }, 'en')).toThrow('safe integer');
  });
});
