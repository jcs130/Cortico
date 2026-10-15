import { describe, expect, it } from 'vitest';
import { OutputTapGate } from '../../src/core/output-tap.ts';
import { ResponseAccumulator } from '../../src/protocol/open-responses/stream.ts';
import type { StreamEvent } from '../../src/protocol/open-responses/index.ts';
import { FixtureStream } from './fixture-protocol.ts';

function harness(transform: (event: StreamEvent) => StreamEvent = event => event) {
  const original = new ResponseAccumulator();
  const projected = new ResponseAccumulator();
  const events: StreamEvent[] = [];
  const gate = new OutputTapGate(name => name === 'inspect' || name === 'reserved', name => name === 'reserved', event => {
    projected.accept(event);
    events.push(event);
  });
  const stream = new FixtureStream({}, raw => {
    const event = transform(raw);
    original.accept(event);
    gate.onEvent(event);
  });
  const begin = (index: number, name: string) => stream.feed({ type: 'tool_call.begin', index, id: `call_${index}`, name });
  const args = (index: number, argsFragment = '{}') => stream.feed({ type: 'tool_call.delta', index, argsFragment });
  const end = (index: number) => stream.feed({ type: 'tool_call.end', index });
  const begins = () => events.filter(event => event.type === 'response.output_item.added' && event.item?.type === 'function_call')
    .map(event => event.type === 'response.output_item.added' && event.item?.type === 'function_call' ? event.item.name : '');
  return { stream, original, projected, events, begin, args, end, begins };
}

describe('OutputTapGate', () => {
  it('streams the barrier itself and removes later calls from every event and terminal snapshot', () => {
    const h = harness();
    h.begin(0, 'inspect');
    h.args(0);
    expect(h.begins()).toEqual(['inspect']);
    h.end(0);
    h.begin(1, 'announce');
    h.args(1, '{"text":"must wait"}');
    h.end(1);
    h.stream.feed({ type: 'content', text: 'response text' });
    h.stream.finish(undefined);
    expect(h.begins()).toEqual(['inspect']);
    expect(JSON.stringify(h.events)).not.toContain('must wait');
    expect(h.original.finish().output).toHaveLength(3);
    expect(h.projected.finish().output).toMatchObject([
      { type: 'function_call', name: 'inspect', call_id: 'call_0' },
      { type: 'message', content: [{ text: 'response text' }] },
    ]);
  });

  it('streams eligible arguments before the call or response is complete', () => {
    const h = harness();
    h.begin(0, 'announce');
    h.args(0, '{"text":"first');
    expect(h.events.at(-1)).toMatchObject({ type: 'response.function_call_arguments.delta', delta: '{"text":"first' });
    h.args(0, '"}');
    h.end(0);
    h.begin(1, 'announce');
    expect(h.begins()).toEqual(['announce', 'announce']);
    h.args(1);
    h.end(1);
    h.stream.finish(undefined);
    expect(h.projected.finish()).toEqual(h.original.finish());
  });

  it('buffers interleaved calls until preceding completion and preserves event order', () => {
    const h = harness();
    h.begin(0, 'prepare');
    h.args(0);
    h.begin(1, 'announce');
    h.args(1);
    h.end(1);
    expect(h.begins()).toEqual(['prepare']);
    h.end(0);
    expect(h.begins()).toEqual(['prepare', 'announce']);
    h.stream.finish(undefined);
    expect(h.projected.finish()).toEqual(h.original.finish());
    const sequences = h.events.map(event => event.sequence_number);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it('drops a buffered call when its preceding call terminates incomplete', () => {
    const h = harness(event => {
      if (event.type === 'response.output_item.done' && event.output_index === 0 && event.item?.type === 'function_call') {
        return { ...event, item: { ...event.item, status: 'incomplete' } };
      }
      if (event.type === 'response.completed') {
        return { ...event, response: { ...event.response, output: event.response.output.map((item, index) =>
          index === 0 && item.type === 'function_call' ? { ...item, status: 'incomplete' } : item) } };
      }
      return event;
    });
    h.begin(0, 'prepare');
    h.args(0);
    h.begin(1, 'announce');
    h.args(1, '{"text":"must wait"}');
    h.end(1);
    h.end(0);
    h.stream.finish(undefined);
    expect(h.begins()).toEqual(['prepare']);
    expect(h.projected.finish().output).toMatchObject([{ name: 'prepare', status: 'incomplete' }]);
    expect(JSON.stringify(h.events)).not.toContain('must wait');
  });

  it('does not let malformed barrier arguments or out of order completion leak later output', () => {
    const h = harness();
    h.begin(0, 'inspect');
    h.args(0, '{bad-json');
    h.begin(1, 'announce');
    h.args(1);
    h.end(1);
    expect(h.begins()).toEqual(['inspect']);
    h.end(0);
    h.stream.finish(undefined);
    expect(h.projected.finish().output).toHaveLength(1);
  });

  it('omits reserved calls without treating them as execution barriers', () => {
    const h = harness();
    h.begin(0, 'reserved');
    h.args(0);
    h.end(0);
    h.begin(1, 'announce');
    h.args(1);
    h.end(1);
    h.stream.finish(undefined);
    expect(h.begins()).toEqual(['announce']);
    expect(h.projected.finish().output).toMatchObject([{ call_id: 'call_1', name: 'announce' }]);
  });

  it('settles buffered calls from an incomplete terminal snapshot without item done events', () => {
    const h = harness(event => {
      if (event.type === 'response.completed') {
        return { ...event, type: 'response.incomplete', response: { ...event.response, status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: event.response.output.map(item => item.type === 'function_call' ? { ...item, status: 'incomplete' } : item) } };
      }
      return event;
    });
    h.begin(0, 'prepare');
    h.args(0, '{"input":');
    h.begin(1, 'announce');
    h.args(1, '{"text":"must wait"}');
    h.stream.finish(undefined);
    expect(h.begins()).toEqual(['prepare']);
    expect(h.projected.finish()).toMatchObject({ status: 'incomplete', output: [{ name: 'prepare', status: 'incomplete' }] });
    expect(JSON.stringify(h.events)).not.toContain('must wait');
  });
});
