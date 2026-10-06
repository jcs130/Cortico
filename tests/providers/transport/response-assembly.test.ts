import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NativeResponseAssembly } from '../../../src/providers/transport/response-assembly.ts';
import { EventDecoder } from '../../../src/providers/transport/response-http.ts';
import { ResponseAccumulator } from '../../../src/protocol/open-responses/stream.ts';
import { ResponsesProvider } from '../../../src/providers/openai-responses-compat/native.ts';
import type { StreamEvent } from '../../../src/protocol/open-responses/index.ts';
import { vi } from 'vitest';

const fixture = readFileSync(new URL('../../fixtures/responses-summary-alias-stream.sse', import.meta.url), 'utf8');

function capturedEvents(): Array<Record<string, any>> {
  return new EventDecoder().feed(fixture).filter(payload => payload !== '[DONE]').map(payload => JSON.parse(payload));
}

describe('Native reasoning alias compatibility', () => {
  it('replays an observed summary-only alias stream as valid standard events without duplicating text', () => {
    const assembly = new NativeResponseAssembly();
    const validation = new ResponseAccumulator();
    const events: StreamEvent[] = [];
    const decoder = new EventDecoder();
    for (let index = 0; index < fixture.length; index += 17) {
      for (const payload of decoder.feed(fixture.slice(index, index + 17))) {
        if (payload !== '[DONE]') assembly.feed(JSON.parse(payload), event => {
          validation.accept(event);
          events.push(event);
        });
      }
    }
    const response = assembly.finish();
    expect(validation.finish()).toEqual(response);
    expect(response.output).toMatchObject([
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'checked' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
    ]);
    expect(response.output[0]).not.toHaveProperty('content');
    expect(events.filter(event => event.type === 'response.reasoning_summary_part.added')).toHaveLength(1);
    expect(events.filter(event => event.type === 'response.reasoning_summary_part.done')).toHaveLength(1);
    expect(events.flatMap(event => 'delta' in event ? [event.delta] : []).join('')).toBe('checkedhello');
    expect(assembly.meters()).toMatchObject({ input: 10, output: 4, reasoning: 2 });
  });

  it('uses the announced content part for an alias stream with ordinary reasoning content', () => {
    const assembly = new NativeResponseAssembly();
    const events: StreamEvent[] = [];
    const reasoning = { id: 'r-content', type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'checked' }] };
    [
      { type: 'response.created', response: { id: 'r1', model: 'test', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, content: [] } },
      { type: 'response.content_part.added', output_index: 0, item_id: reasoning.id, content_index: 0,
        part: { type: 'reasoning_text', text: '' } },
      { type: 'response.reasoning_text.delta', output_index: 0, item_id: reasoning.id, content_index: 0, delta: 'checked' },
      { type: 'response.reasoning_text.done', output_index: 0, item_id: reasoning.id, content_index: 0, text: 'checked' },
      { type: 'response.content_part.done', output_index: 0, item_id: reasoning.id, content_index: 0, part: reasoning.content[0] },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.completed', response: { id: 'r1', model: 'test', status: 'completed', output: [reasoning] } },
    ].forEach((event, sequence_number) => assembly.feed({ ...event, sequence_number }, event => events.push(event)));
    expect(assembly.finish().output).toEqual([reasoning]);
    expect(events.map(event => event.type)).toContain('response.reasoning.delta');
    expect(events.map(event => event.type)).not.toContain('response.reasoning_summary_part.added');
  });

  it('still rejects repeated native sequence numbers after inserting a missing part event', () => {
    const assembly = new NativeResponseAssembly();
    const input = capturedEvents();
    input.slice(0, 4).forEach(event => assembly.feed(event, () => {}));
    expect(() => assembly.feed(input[3], () => {})).toThrow('Non-increasing event sequence');
  });

  it.each(['response.reasoning_text.done', 'response.output_item.done'])('rejects final reasoning disagreement at %s', type => {
    const assembly = new NativeResponseAssembly();
    const input = capturedEvents();
    const target = input.find(event => event.type === type && event.output_index === 0)!;
    if (type === 'response.reasoning_text.done') target.text = 'different';
    else target.item.summary[0].text = 'different';
    expect(() => input.forEach(event => assembly.feed(event, () => {}))).toThrow(/disagrees with deltas/);
  });

  it('preserves partial observed reasoning if the stream stops before a terminal resource', () => {
    const assembly = new NativeResponseAssembly();
    capturedEvents().slice(0, 4).forEach(event => assembly.feed(event, () => {}));
    expect(() => assembly.finish()).toThrow('before a terminal response');
    expect(assembly.snapshot()?.output[0]).toMatchObject({ type: 'reasoning', summary: [{ text: 'checked' }] });
  });

  it('completes the real provider transport with this stream and one metered attempt', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(fixture, { headers: { 'Content-Type': 'text/event-stream' } }));
    try {
      const result = await new ResponsesProvider({ baseUrl: 'https://fixture.test', reasoningReplay: 'plaintext' })
        .respond({ model: 'test', input: 'hello' }, { diagnostic: true, onEvent: () => {} });
      expect(result.response.status).toBe('completed');
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]).toMatchObject({ outcome: 'completed', meters: { input: 10, output: 4 } });
    } finally { globalThis.fetch = previousFetch; }
  });
});
