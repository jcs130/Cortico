import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionLog } from '../../../src/core/session.ts';
import { GenerationError } from '../../../src/core/generation.ts';
import { functionCall, functionResult, message, responseRecords, type ItemOrigin } from '../../../src/protocol/open-responses/context.ts';
import { responseRequest } from '../../../src/protocol/open-responses/context-helpers.ts';
import { ChatCompatProvider } from '../../../src/providers/openai-chat-compat/native.ts';
import { nativeChatInput } from '../../../src/providers/transport/native-input.ts';
import { ChatResponseAssembly } from '../../../src/providers/transport/response-assembly.ts';

afterEach(() => vi.unstubAllGlobals());

const spec = { model: 'fixture-model', thinking: false };
const origin: ItemOrigin = { instance: 'fixture', module: 'openai-chat-compat', model: spec.model, compatibilityDomain: 'fixture-domain' };
const extra = { fixture: { signature: 'opaque-continuation', version: 2 } };
const migration = { fixture: { signature: 'explicit-migration' } };
const tools = [{ name: 'inspect', description: 'Read visible state.', parameters: { type: 'object', properties: {} } }];

function chunksResponse(chunks: unknown[], end = true): Response {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + (end ? 'data: [DONE]\n\n' : ''),
    { headers: { 'content-type': 'text/event-stream' } });
}
function toolChunks() {
  return [
    { id: 'turn-1', model: spec.model, choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call-a', function: { name: 'inspect', arguments: '{}' } },
      { index: 1, id: 'call-b', function: { name: 'inspect', arguments: '{}' } },
    ] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, extra_content: extra }] }, finish_reason: 'tool_calls' }] },
  ];
}

describe('Chat continuation metadata', () => {
  it('accepts complete stream calls without indices and associates later metadata by call ID', () => {
    const assembly = new ChatResponseAssembly({ model: spec.model, input: 'Inspect.' });
    assembly.feed({ id: 'r1', choices: [{ delta: { tool_calls: [
      { id: 'a', function: { name: 'inspect', arguments: '{}' }, extra_content: extra },
      { id: 'b', function: { name: 'inspect', arguments: '{}' } },
    ] } }] }, () => {});
    assembly.feed({ choices: [{ delta: { tool_calls: [{ id: 'b', extra_content: migration }] }, finish_reason: 'tool_calls' }] }, () => {});
    const response = assembly.finish(() => {});
    expect(response.output.map((item: any) => item.call_id)).toEqual(['a', 'b']);
    expect(assembly.itemData()).toEqual({
      [response.output[0].id!]: { chatExtraContent: extra }, [response.output[1].id!]: { chatExtraContent: migration },
    });
  });

  it('rejects ambiguous indexless deltas and a conflicting explicit index', () => {
    const assembly = new ChatResponseAssembly({ model: spec.model, input: 'Inspect.' });
    expect(() => assembly.feed({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{}' } }] } }] }, () => {}))
      .toThrow('lacks index or complete identity');
    assembly.feed({ id: 'r1', choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'inspect', arguments: '{}' } }] } }] }, () => {});
    expect(() => assembly.feed({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'a' }] } }] }, () => {})).toThrow('identity changed');
  });

  it.each([false, true])('replays provider data after durable session reset and reload (stream=%s)', async stream => {
    const directory = mkdtempSync(join(tmpdir(), 'cortico-continuation-'));
    const sent: any[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      if (sent.length > 1) return new Response(JSON.stringify({ id: 'turn-2', choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }] }));
      if (stream) return chunksResponse(toolChunks());
      return new Response(JSON.stringify({ id: 'turn-1', model: spec.model, choices: [{ message: { tool_calls: [
        { id: 'call-a', type: 'function', function: { name: 'inspect', arguments: '{}' }, extra_content: extra },
        { id: 'call-b', type: 'function', function: { name: 'inspect', arguments: '{}' } },
      ] }, finish_reason: 'tool_calls' }] }));
    });
    try {
      const client = new ChatCompatProvider({ baseUrl: 'https://fixture.test', keepThinking: () => false,
        legacyFunctionCallExtraContent: migration });
      const session = new SessionLog(directory);
      session.append(message('user', 'Inspect both targets.'));
      const identity = session.conversationId;
      const first = await client.respond(responseRequest(spec, session.records, tools), {
        origin, context: session.records, nativeSpec: spec, ...(stream ? { onEvent() {} } : {}),
      });
      const entries = responseRecords(first.response, first.origin, {}, first.itemData);
      entries.forEach(entry => session.append(entry));
      session.append(functionResult('call-a', 'visible'));
      session.append(functionResult('call-b', 'visible'));
      // A handoff/reset retains the context envelope; a process restart reads that same data.
      session.reset(session.records);
      const restarted = new SessionLog(directory);
      restarted.load();
      expect(restarted.conversationId).toBe(identity);
      expect(restarted.records.find(entry => entry.item.type === 'function_call')?.context.providerData).toEqual({ chatExtraContent: extra });
      expect(JSON.stringify(first.response)).not.toContain('opaque-continuation');
      expect(JSON.stringify(responseRequest(spec, restarted.records, tools))).not.toContain('opaque-continuation');
      first.itemData![first.response.output[0].id!].chatExtraContent = { changed: true };
      await client.respond(responseRequest(spec, restarted.records, tools), { origin, context: restarted.records, nativeSpec: spec });
      const calls = sent[1].messages.find((item: any) => item.tool_calls).tool_calls;
      expect(calls[0].extra_content).toEqual(extra);
      // The unsigned parallel call from the same provider stays unsigned.
      expect(calls[1]).not.toHaveProperty('extra_content');
      expect(sent[1].messages.filter((item: any) => item.role === 'tool').map((item: any) => item.tool_call_id)).toEqual(['call-a', 'call-b']);
      expect(JSON.stringify(first.attempts)).not.toContain('opaque-continuation');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('uses explicitly configured migration data only for synthetic or foreign-provider calls', () => {
    const recorded = functionCall('call', 'inspect', '{}', { origin, providerData: { chatExtraContent: extra } });
    for (const field of ['instance', 'module', 'model', 'compatibilityDomain'] as const) {
      const current = { ...origin, [field]: 'other' };
      const request = responseRequest(spec, [recorded], tools);
      expect(nativeChatInput(request, { context: [recorded], origin: current })[0].tool_calls![0]).not.toHaveProperty('extra_content');
      expect(nativeChatInput(request, { context: [recorded], origin: current }, { legacyFunctionCallExtraContent: migration })[0].tool_calls![0].extra_content).toEqual(migration);
    }
    const synthetic = functionCall('synthetic', 'event_frame', '{}');
    const request = responseRequest(spec, [synthetic], tools);
    expect(nativeChatInput(request, { context: [synthetic], origin })[0].tool_calls![0]).not.toHaveProperty('extra_content');
    expect(nativeChatInput(request, { context: [synthetic], origin }, { legacyFunctionCallExtraContent: migration })[0].tool_calls![0].extra_content).toEqual(migration);
    expect(recorded.context.providerData).toEqual({ chatExtraContent: extra });
  });

  it('retains observed continuation data in a failed partial stream without logging it as usage', async () => {
    const frames = toolChunks().map((chunk, index) => index === 1 ? { choices: [{ delta: { tool_calls: [{ index: 0, extra_content: extra }] } }] } : chunk);
    vi.stubGlobal('fetch', async () => chunksResponse(frames, false));
    const client = new ChatCompatProvider({ baseUrl: 'https://fixture.test' });
    const error = await client.respond(responseRequest(spec, [message('user', 'Inspect.')], tools), {
      origin, diagnostic: true, onEvent() {}, nativeSpec: spec,
    }).catch(error => error);
    expect(error).toBeInstanceOf(GenerationError);
    const entries = responseRecords(error.partial, error.origin, {}, error.itemData);
    expect(entries.find(entry => entry.item.type === 'function_call')?.context.providerData).toEqual({ chatExtraContent: extra });
    expect(JSON.stringify(error.attempts)).not.toContain('opaque-continuation');
  });
});
