import { describe, expect, it } from 'vitest';
import { runForkLoop } from '../../src/core/fork.ts';
import { estimateMessagesTokens, estimateToolTokens } from '../../src/protocol/open-responses/tokens.ts';
import { message } from '../../src/protocol/open-responses/context.ts';
import { responseRequest } from '../../src/protocol/open-responses/context-helpers.ts';
import { createResponse } from '../../src/protocol/open-responses/index.ts';
import type { ResponseClient } from '../../src/core/generation.ts';
import { nullLogger } from '../../src/core/util.ts';

describe('complete request budgets', () => {
  it('includes system, history, tool schema and reserved output before opening an oversized fork request', async () => {
    const messages = [message('system', 'Stable instruction'), message('user', 'Required history')];
    const tools = [{ name: 'inspect', description: 'Required schema. '.repeat(80), parameters: { type: 'object' }, tags: ['read' as const], handler: async () => 'read' }];
    let submissions = 0;
    const llm: ResponseClient = { async respond(request) { submissions++; return { response: { ...createResponse('response', request), status: 'completed' },
      origin: { instance: 'fixture', module: 'fixture', model: 'test', compatibilityDomain: 'fixture' }, attempts: [] }; } };
    const input = estimateMessagesTokens(messages), schemas = estimateToolTokens(tools), reserve = 200;
    expect(input).toBeLessThan(input + reserve + schemas - 1);
    await expect(runForkLoop({ id: 'review', agentId: 'agent', llm, spec: { model: 'test', thinking: true, reasoningEffort: 'high',
      maxTokens: reserve, contextWindow: input + schemas + reserve - 1 }, messages, tools, maxRounds: 1, log: nullLogger() })).rejects.toThrow('complete input');
    expect(submissions).toBe(0);
    expect(messages).toHaveLength(2);
  });

  it('keeps tool order stable without changing message order, schema array order or caller objects', () => {
    const context = [message('system', 'Stable instruction'), message('user', 'First'), message('assistant', 'Second')];
    const tools = [{ name: 'z', description: 'Last', parameters: { required: ['b', 'a'] } }, { name: 'a', description: 'First', parameters: {} }];
    const request = responseRequest({ model: 'test', thinking: true, reasoningEffort: 'high', maxTokens: 2048 }, context, tools);
    expect(request.tools!.map(tool => tool.name)).toEqual(['a', 'z']);
    expect(request.tools![1].parameters!.required).toEqual(['b', 'a']);
    expect(request.input).toHaveLength(3);
    expect(tools.map(tool => tool.name)).toEqual(['z', 'a']);
    expect(request.reasoning?.effort).toBe('high');
    expect(request.max_output_tokens).toBe(2048);
  });
});
