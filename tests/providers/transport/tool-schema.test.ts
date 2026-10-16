import { afterEach, expect, it, vi } from 'vitest';
import { prefixTupleItems } from '../../../src/providers/transport/tool-schema.ts';
import { ChatCompatProvider } from '../../../src/providers/openai-chat-compat/native.ts';

afterEach(() => vi.unstubAllGlobals());
const tuple = { type: 'array', minItems: 2, items: [{ type: 'number', minimum: 0 }, { type: 'string', enum: ['a', 'b'] }], additionalItems: false };

it('converts nested heterogeneous tuple constraints without mutating definitions or example data', () => {
  const schema = { type: 'object', properties: { steps: { type: 'array', items: { type: 'object', properties: { rays: { type: 'array', items: tuple } } } } },
    default: { items: [1, 2] }, examples: [{ items: ['literal'] }], $defs: { tuple }, allOf: [{ if: { properties: { position: tuple } }, then: { not: tuple } }] };
  const before = structuredClone(schema), converted = prefixTupleItems(schema) as any;
  expect(converted.properties.steps.items.properties.rays.items).toEqual({ type: 'array', minItems: 2, prefixItems: tuple.items, items: false });
  expect(converted.$defs.tuple.items).toBe(false);
  expect(converted.allOf[0].if.properties.position.prefixItems).toEqual(tuple.items);
  expect(converted.default).toEqual(schema.default); expect(converted.examples).toEqual(schema.examples);
  expect(schema).toEqual(before);
});

it('preserves open tuples and converts additional-item schemas and nested existing prefixes', () => {
  const schema = { anyOf: [{ type: 'array', items: [{ type: 'number' }] },
    { type: 'array', items: [{ type: 'string' }], additionalItems: { anyOf: [tuple, false] } },
    { type: 'array', prefixItems: [tuple], items: true }] };
  const converted = prefixTupleItems(schema) as any;
  expect(converted.anyOf[0]).toEqual({ type: 'array', prefixItems: [{ type: 'number' }] });
  expect(converted.anyOf[1].items.anyOf[0]).toMatchObject({ items: false, prefixItems: tuple.items });
  expect(converted.anyOf[2].prefixItems[0]).toMatchObject({ items: false, prefixItems: tuple.items });
  expect(converted.anyOf[2].items).toBe(true);
  expect(() => prefixTupleItems({ items: [], prefixItems: [] })).toThrow('both items array and prefixItems');
});

it('changes only the configured provider wire representation and keeps tool-call arguments intact', async () => {
  const sent: any[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); sent.push(body);
    return new Response(JSON.stringify({ id: 'r1', choices: [{ message: { tool_calls: [{ id: 'call', type: 'function', function: { name: 'inspect', arguments: '{"position":[1,"a"]}' } }] }, finish_reason: 'tool_calls' }] }));
  });
  const request = { model: 'fixture', input: 'Inspect.', tools: [{ type: 'function' as const, name: 'inspect', parameters: { type: 'object', properties: { position: tuple } } }] };
  const before = structuredClone(request);
  await new ChatCompatProvider({ baseUrl: 'https://fixture.test' }).respond(request);
  const converted = await new ChatCompatProvider({ baseUrl: 'https://fixture.test', tupleSchemaStyle: 'prefixItems' }).respond(request);
  expect(sent[0].tools[0].function.parameters.properties.position.items).toEqual(tuple.items);
  expect(sent[1].tools[0].function.parameters.properties.position).toEqual({ type: 'array', minItems: 2, prefixItems: tuple.items, items: false });
  expect(converted.response.output[0]).toMatchObject({ type: 'function_call', arguments: '{"position":[1,"a"]}' });
  expect(request).toEqual(before);
});
