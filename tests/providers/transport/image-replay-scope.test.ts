import { afterEach, describe, expect, it, vi } from 'vitest';
import module from '../../../src/providers/openai-responses-compat/index.ts';
import { ResponsesProvider } from '../../../src/providers/openai-responses-compat/native.ts';
import { HISTORICAL_IMAGE_TEXT, responsesInput } from '../../../src/providers/transport/responses-input.ts';
import { functionCall, functionResult, message, record, type ContextRecord } from '../../../src/protocol/open-responses/context.ts';
import { nullLogger } from '../../../src/core/util.ts';
import type { LLMProviderEntry } from '../../../src/core/types.ts';

type Wire = Record<string, unknown>;
const image = (handle: string) => ({ handle, mime: 'image/png', fallbackText: `saved image ${handle}` });
const read = (handle: string) => Buffer.from(handle);
const media = { enabled: () => true, read, imageReplayScope: 'fresh' as const, imageReplayPlacement: 'tail' as const };
const countImages = (input: Wire[]) => input.reduce((total, item) => total + [item.content, item.output]
  .flatMap(parts => Array.isArray(parts) ? parts : []).filter(part => part.type === 'input_image').length, 0);
const native = (text?: string): ContextRecord => record({ type: 'message', role: 'user', content: [
  ...(text ? [{ type: 'input_text' as const, text }] : []),
  { type: 'input_image', image_url: 'https://unused.test/image.png' },
] });
const parallelImages = () => [
  message('system', 'instructions'),
  message('user', 'older saved image', { blobs: [image('old')] }),
  message('assistant', 'previous analysis'),
  functionCall('front', 'visual', '{}'),
  functionCall('side', 'visual', '{}'),
  functionResult('front', 'front receipt and saved handle', { ts: '10:00', blobs: [image('front')] }),
  functionResult('side', 'side receipt and saved handle', { ts: '10:00', blobs: [image('side')] }),
];
const entry: LLMProviderEntry = { kind: 'openai-responses-compat', baseUrl: 'https://unused.test', multimodal: true };

afterEach(() => vi.unstubAllGlobals());

describe('fresh image replay', () => {
  it('sends both parallel tool images once and keeps their source text unchanged across the following tool step', () => {
    const first = parallelImages();
    const before = structuredClone(first);
    const firstWire = responsesInput({}, { context: first }, { media }).input;
    expect(countImages(firstWire)).toBe(2);
    expect(firstWire.slice(0, first.length - 1)).toEqual(first.slice(1).map(row => row.item));
    expect(firstWire.slice(first.length - 1).map(row => JSON.parse((row.content as Wire[])[0].text as string).attachment))
      .toEqual(['front', 'side']);

    const next = [...first, functionCall('inventory', 'inventory', '{}'), functionResult('inventory', 'inventory receipt')];
    const nextWire = responsesInput({}, { context: next }, { media }).input;
    expect(countImages(nextWire)).toBe(0);
    expect(nextWire.slice(0, first.length - 1)).toEqual(firstWire.slice(0, first.length - 1));
    expect(nextWire).toEqual(next.slice(1).map(row => row.item));
    expect(first).toEqual(before);
    expect(next[5].context.blobs).toEqual([image('front')]);
  });

  it.each([
    message('assistant', 'analysis'),
    functionCall('next', 'inventory', '{}'),
    record({ type: 'reasoning', id: 'thought', summary: [], content: [{ type: 'reasoning_text', text: 'analysis' }] }),
  ])('ends image replay at real model output without requiring origin metadata: %o', output => {
    const entries = [...parallelImages(), output];
    expect(countImages(responsesInput({}, { context: entries }, { media }).input)).toBe(0);
    expect(entries[5].context.blobs).toEqual([image('front')]);
  });

  it('does not let synthetic head examples or incoming user messages acknowledge images', () => {
    const entries = [
      native('incoming image'),
      message('user', 'new external event'),
      message('assistant', 'style example', { head: true }),
      functionCall('example', 'visual', '{}', { head: true }),
      record({ type: 'reasoning', summary: [] }, { head: true }),
    ];
    const wire = responsesInput({}, { context: entries }, { media }).input;
    expect(countImages(wire)).toBe(1);
    expect(wire[0]).toEqual(entries[0].item);
  });

  it('omits old native image parts only from the wire, preserves other parts, and gives image-only items valid text', () => {
    const file = { type: 'input_file' as const, file_data: 'data:text/plain;base64,ZA==' };
    const mixed = record({ type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'source text' },
      { type: 'input_image', image_url: 'https://unused.test/old.png' },
      file,
    ] });
    const onlyImage = native();
    const imageTool = record({ type: 'function_call_output', call_id: 'native-tool', output: [
      { type: 'input_image', image_url: 'https://unused.test/result.png' },
    ] });
    const freshImage = native('fresh image');
    const entries = [mixed, onlyImage, functionCall('native-tool', 'visual', '{}'), imageTool,
      message('assistant', 'analysis'), freshImage];
    const before = structuredClone(entries);
    const wire = responsesInput({}, { context: entries }, { media }).input;
    expect(wire[0].content).toEqual([{ type: 'input_text', text: 'source text' }, file]);
    expect(wire[1].content).toEqual([{ type: 'input_text', text: HISTORICAL_IMAGE_TEXT }]);
    expect(wire[3].output).toEqual([{ type: 'input_text', text: HISTORICAL_IMAGE_TEXT }]);
    expect(wire.at(-1)).toEqual(freshImage.item);
    expect(countImages(wire)).toBe(1);
    expect(entries).toEqual(before);
  });

  it('defaults to history and can reintroduce an image with a new input reference', () => {
    const entries = [...parallelImages(), message('assistant', 'analysis')];
    expect(countImages(responsesInput({}, { context: entries }, {
      media: { enabled: () => true, read },
    }).input)).toBe(3);
    const referenced = [...entries, message('user', 'inspect the same stored image again', { blobs: [image('front')] })];
    const wire = responsesInput({}, { context: referenced }, { media }).input;
    expect(countImages(wire)).toBe(1);
    expect(JSON.parse((wire.at(-1)!.content as Wire[])[0].text as string).attachment).toBe('front');
  });

  it('applies fresh scope to explicit native images when saved attachment expansion is disabled', () => {
    const entries = [native('old image'), message('assistant', 'analysis'), native('new image')];
    const wire = responsesInput({}, { context: entries }, {
      media: { ...media, enabled: () => false },
    }).input;
    expect(wire[0].content).toEqual([{ type: 'input_text', text: 'old image' }]);
    expect(wire.at(-1)).toEqual(entries.at(-1)!.item);
    expect(countImages(wire)).toBe(1);
  });

  it('retains images after failed or cancelled generations when the same context is retried', async () => {
    const bodies: Wire[] = [];
    const entries = parallelImages();
    const before = structuredClone(entries);
    const controller = new AbortController();
    let mode: 'failure' | 'cancel' | 'success' = 'failure';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      if (mode === 'failure') return new Response('invalid request', { status: 400 });
      if (mode === 'cancel') {
        controller.abort();
        throw new DOMException('cancelled', 'AbortError');
      }
      return Response.json({ id: 'response', model: 'm', status: 'completed', output: [],
        usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 } });
    }));
    const client = new ResponsesProvider({ baseUrl: 'https://unused.test', media });
    await expect(client.respond({ model: 'm' }, { context: entries })).rejects.toThrow();
    mode = 'cancel';
    await expect(client.respond({ model: 'm' }, { context: entries, signal: controller.signal })).rejects.toThrow();
    mode = 'success';
    await client.respond({ model: 'm' }, { context: entries });
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies.map(body => countImages(body.input as Wire[]))).toEqual([2, 2, 2]);
    expect(entries).toEqual(before);
  });

  it('wires fresh scope through the provider and declares an optional hot ConfigGroup field', () => {
    const field = module.config('gateway', entry, 'en')[0].schema.properties!['providers.gateway.options.imageReplayScope'];
    expect(field).toMatchObject({ type: 'string', enum: ['history', 'fresh'], 'x-hot': true });
    expect(field).not.toHaveProperty('default');
    expect(module.normalize({ ...entry, options: { imageReplayScope: '' } }).options).not.toHaveProperty('imageReplayScope');
    for (const value of [undefined, 'history', 'fresh'])
      expect(() => module.validateEntry({ ...entry, options: { imageReplayScope: value } }, 'en')).not.toThrow();
    for (const value of [null, 0, 'latest'])
      expect(() => module.validateEntry({ ...entry, options: { imageReplayScope: value } }, 'en')).toThrow('history or fresh');
    const instance = module.create('gateway', { ...entry, options: { imageReplayScope: 'fresh' } }, {
      stateDir: '', secret: () => '', readBlob: read, keepThinking: () => true, log: nullLogger(),
    });
    const body = (instance.client as any).buildResponseBody({ model: 'm' }, {
      context: [...parallelImages(), message('assistant', 'analysis')],
    });
    expect(countImages(body.input)).toBe(0);
    expect(body).not.toHaveProperty('imageReplayScope');
  });
});
