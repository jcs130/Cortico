import { afterEach, describe, expect, it, vi } from 'vitest';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { ToolCallRecoveryFallback, TOOL_CALL_RECOVERY_DEFAULTS, withoutInputEchoes, projectToolCallRecovery } from '../../bots/cortiv/persona/tool-call-recovery.ts';
import { PLANNING_DEFAULTS } from '../../bots/cortiv/persona/planning-review.ts';
import { Core } from '../../src/core/core.ts';
import type { EventEnvelope, World } from '../../src/core/types.ts';
import { functionCall, functionResult, message, type ContextRecord } from '../../src/protocol/open-responses/context.ts';
import { FakeLLM, makeCfg, makeLoaded, makeTmpDir, textReply, toolReply } from '../core/helpers.ts';

const available = new Set(['game_move', 'game_observe']);
const fake = (id: string, tool = 'game_move'): ContextRecord[] => [message('assistant', `[调用] ${tool} {"target":[1,2,3]}`, { responseId: id })];
const event = (patch: Partial<EventEnvelope>): EventEnvelope => ({ cursor: 1, ts: new Date().toISOString(), type: 'tick', source: 'persona', origin: 'internal', text: 'Input.', ...patch });
const delivery = (body: string, type = 'handoff'): ContextRecord => message('user', body, { frame: { events: [
  { cursor: 1, ts: '2026-01-01T00:00:00Z', source: 'persona', type, start: 0, chars: body.length },
] } });

describe('tool interface recovery fallback', () => {
  it.each(['', '\n[历史回执] Arrived.'])('reports a written historical request as unexecuted with receipt %j', (receipt) => {
    const text = '[历史工具请求] game_move {"target":[1,2,3]}'+receipt;
    const reply = message('assistant', text, { responseId: 'transcript' });
    const evidence = message('user', 'Player is still at the original position.');
    const records = [evidence, reply];
    const saved = structuredClone(records);
    const recovery = new ToolCallRecoveryFallback();
    expect(recovery.notice(records, available)).toContain('没有对应本轮执行记录');
    expect(projectToolCallRecovery(records, available)).toEqual([evidence]);
    expect(records).toEqual(saved);
    expect(recovery.notice([...records, message('assistant', text, { responseId: 'again' })], available)).toBeNull();
  });

  it('retains quoted transcripts, unknown interfaces and actual executed response groups', () => {
    const text = '[历史工具请求] game_move {}\n[历史回执] Arrived.';
    const records = [
      message('assistant', '```text\n'+text+'\n```'), message('assistant', text.replaceAll('game_move', 'unknown_tool')),
      message('assistant', '> '+text.replace('\n', '\n> ')),
      message('assistant', text, { responseId: 'real' }), functionCall('actual', 'game_move', '{}', { responseId: 'real' }),
      functionResult('actual', 'Blocked by the current wall.'),
    ];
    expect(projectToolCallRecovery(records, available)).toEqual(records);
    expect(new ToolCallRecoveryFallback().notice(records, available)).toBeNull();
  });

  it('corrects an exact typed delivery echo once and excludes it only from future requests', () => {
    const recovery = new ToolCallRecoveryFallback();
    const input = delivery('Internal handoff instructions.');
    const echo = message('assistant', 'Internal handoff instructions.', { responseId: 'echo' });
    const records = [input, echo];
    const saved = structuredClone(records);
    expect(recovery.notice(records, available)).toContain('原样复制');
    expect(recovery.notice([...records, message('assistant', 'Internal handoff instructions.', { responseId: 'repeat' })], available)).toBeNull();
    expect(withoutInputEchoes(records)).toEqual([input]);
    expect(records).toEqual(saved);
  });

  it('recognizes a handoff event within a mixed frame and a full synthetic event receipt', () => {
    const internal = 'Internal handoff instructions.';
    const input = delivery(internal);
    input.item = { ...input.item, content: 'Header\n' + internal + '\nWorld observations.' } as typeof input.item;
    input.context.frame!.events[0].start = 'Header\n'.length;
    expect(withoutInputEchoes([input, message('assistant', internal)])).toEqual([input]);
    const receipt = functionResult('frame', 'Observed delivery frame.', { frame: { events: [
      { cursor: 2, ts: '2026-01-01T00:00:01Z', source: 'game', type: 'game.task', start: 0, chars: 24 },
    ] } });
    const call = functionCall('frame', 'external_event_frame', '{}');
    expect(withoutInputEchoes([call, receipt, message('assistant', 'Observed delivery frame.')])).toEqual([call, receipt]);
  });

  it('retains discussion, untyped user quotes, native-action responses and observations received later', () => {
    const body = 'Internal handoff instructions.';
    const input = delivery(body);
    const records = [
      message('user', 'An ordinary human quote.'), message('assistant', 'An ordinary human quote.'),
      message('assistant', body), input, message('assistant', 'I read: ' + body),
      message('assistant', body, { responseId: 'native' }), functionCall('real', 'game_move', '{}', { responseId: 'native' }),
      functionResult('real', 'Executed.'),
    ];
    expect(withoutInputEchoes(records)).toEqual(records);
  });

  it('reports only the verified absence of a native call and never parses text arguments', () => {
    const recovery = new ToolCallRecoveryFallback();
    const records = fake('first');
    const original = structuredClone(records);
    const notice = recovery.notice(records, available)!;
    expect(notice).toContain('没有原生工具调用');
    expect(notice).toContain('game_move');
    expect(notice).toContain('也可以选择不行动');
    expect(records).toEqual(original);
  });

  it.each([
    '我刚才说了 game_move，接下来先观察。',
    '这是引用：[调用] game_move {"target":[1,2,3]}',
    '> [调用] game_move {"target":[1,2,3]}',
    '```text\n[调用] game_move {"target":[1,2,3]}\n```',
    '> [历史工具请求] game_move {"target":[1,2,3]}',
    '[调用] unavailable_tool {"target":[1,2,3]}',
  ])('leaves normal discussion, examples, history or unavailable tools alone: %s', text => {
    expect(new ToolCallRecoveryFallback().notice([message('assistant', text)], available)).toBeNull();
  });

  it('recognizes the bracketed legacy format but ignores text when the same response includes a native call', () => {
    const recovery = new ToolCallRecoveryFallback();
    expect(recovery.notice([message('assistant', '[调用 game_move] {"target":[1,2,3]}', { responseId: 'legacy' })], available)).not.toBeNull();
    expect(recovery.notice([
      ...fake('native'), functionCall('real', 'game_move', '{}', { responseId: 'native' }), functionResult('real', 'Executed.'),
    ], available)).toBeNull();
    expect(recovery.notice(fake('next'), available)).not.toBeNull();
  });

  it('does not repeat advice for changed text, repeated callbacks, ticks, system chat or snapshots', () => {
    const recovery = new ToolCallRecoveryFallback();
    expect(recovery.notice(fake('first'), available)).not.toBeNull();
    expect(recovery.notice(fake('first'), available)).toBeNull();
    recovery.onDelivery([
      event({}), event({ type: 'game.state', source: 'game', origin: 'external', tags: ['snapshot'] }),
      event({ type: 'game.chat', source: 'game', origin: 'external', senderKey: 'game' }),
    ]);
    expect(recovery.notice(fake('second', 'game_observe'), available)).toBeNull();
    expect(recovery.notice([message('assistant', '暂时观察。', { responseId: 'plain' })], available)).toBeNull();
    expect(recovery.notice(fake('third'), available)).toBeNull();
  });

  it.each([
    event({ type: 'terminal.message', source: 'terminal', senderKey: 'operator' }),
    event({ type: 'game.chat', source: 'game', origin: 'external', senderKey: 'player' }),
  ])('allows one new correction after an identified user input: $type', input => {
    const recovery = new ToolCallRecoveryFallback();
    expect(recovery.notice(fake('first'), available)).not.toBeNull();
    recovery.onDelivery([input]);
    expect(recovery.notice(fake('second'), available)).not.toBeNull();
    expect(recovery.notice(fake('third'), available)).toBeNull();
  });
});

describe('CortiV tool interface recovery', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
  async function rig(replies: ReturnType<typeof textReply>[], enabled = true) {
    const tmp = makeTmpDir();
    const config = makeCfg();
    Object.assign(config.batching, { minBatchAgeMs: 0, quietGapMs: 0, maxBatchAgeMs: 0 });
    let actions = 0;
    const world: World = { id: 'game', envPromptVars: () => ({}),
      tools: () => [{ name: 'game_move', description: 'Move', tags: ['act'], parameters: {}, handler: async () => { actions++; return 'Executed.'; } }],
      start: async () => {}, stop: async () => {} };
    const recoveryConfig = { ...TOOL_CALL_RECOVERY_DEFAULTS, enabled };
    const persona = new CortiV({ memoryDir: `${tmp.dir}/memory`, worlds: [world], toolCallRecovery: () => recoveryConfig,
      planning: () => ({ ...PLANNING_DEFAULTS, enabled: false }) });
    const llm = new FakeLLM(); llm.script(...replies);
    const core = new Core(makeLoaded({ config, rootDir: tmp.dir, memoryDir: persona.memoryDir, dataDir: `${tmp.dir}/data` }), { persona, worlds: [world], llm });
    cleanups.push(async () => { persona.stopRhythm(); await core.stop(); tmp.cleanup(); });
    await core.start();
    return { core, llm, recoveryConfig, actions: () => actions };
  }

  it('asks for a native call, retains both original replies and stops after one failed correction', async () => {
    const { core, llm, actions } = await rig([
      textReply('[调用] game_move {"target":[1,2,3]}'), textReply('[调用] game_move {"target":[4,5,6]}'),
    ]);
    await vi.waitFor(() => expect(core.loop.getStatus().batchesHandled).toBe(2));
    expect(llm.calls).toHaveLength(2);
    expect(actions()).toBe(0);
    const archive = JSON.stringify(core.session.records);
    expect(archive).toContain('[1,2,3]');
    expect(archive).toContain('[4,5,6]');
    expect(archive).toContain('没有原生工具调用');
  });

  it('executes only the new native call chosen by the model', async () => {
    const { core, llm, actions } = await rig([
      textReply('[调用] game_move {"target":[1,2,3]}'), toolReply([{ name: 'game_move', id: 'native', args: { target: [8,9,10] } }]), textReply('Done.'),
    ]);
    await vi.waitFor(() => expect(llm.calls).toHaveLength(3));
    expect(actions()).toBe(1);
    expect(core.session.records).toContainEqual(expect.objectContaining({ item: expect.objectContaining({ type: 'function_call', call_id: 'native', arguments: '{"target":[8,9,10]}' }) }));
  });

  it('recovers from a real internal delivery echo without replaying it as an assistant example', async () => {
    const { core, llm, actions } = await rig([textReply('Initialized.')]);
    await vi.waitFor(() => expect(core.loop.getStatus().batchesHandled).toBe(1));
    const notice = 'Internal handoff delivery instructions.';
    llm.script(textReply(notice), toolReply([{ name: 'game_move', id: 'after-echo' }]), textReply('Done.'));
    core.loop.injectInternal(notice, 'handoff');
    await vi.waitFor(() => expect(actions()).toBe(1));
    expect(core.session.records).toContainEqual(expect.objectContaining({ item: expect.objectContaining({ role: 'assistant',
      content: expect.arrayContaining([expect.objectContaining({ text: notice })]) }) }));
    const retry = llm.calls.find(call => call.messages.some(message => message.content?.includes('原样复制')))!;
    expect(retry).toBeDefined();
    expect(retry.messages.filter(message => message.role === 'assistant').some(message => message.content === notice)).toBe(false);
    expect(retry.messages.some(message => message.role !== 'assistant' && message.content?.includes(notice))).toBe(true);
  });

  it('recovers from written historical receipts with the original record retained and the selected native action executed', async () => {
    const text = '[历史工具请求] game_move {}\n[历史回执] Arrived.';
    const { core, llm, actions } = await rig([textReply(text), toolReply([{ name: 'game_move', id: 'real-after-transcript' }]), textReply('Done.')]);
    await vi.waitFor(() => expect(actions()).toBe(1));
    const retry = llm.calls.find(call => call.messages.some(message => message.content?.includes('没有对应本轮执行记录')))!;
    expect(retry).toBeDefined();
    expect(retry.messages.filter(message => message.role === 'assistant').some(message => message.content === text)).toBe(false);
    expect(JSON.stringify(core.session.records)).toContain('Arrived.');
    expect(core.session.records.some(record => record.item.type === 'function_call' && record.item.call_id === 'real-after-transcript')).toBe(true);
  });

  it('does not retry when the fallback is disabled', async () => {
    const { core, llm, actions } = await rig([textReply('[调用] game_move {"target":[1,2,3]}')], false);
    await vi.waitFor(() => expect(core.loop.getStatus().batchesHandled).toBe(1));
    expect(llm.calls).toHaveLength(1);
    expect(actions()).toBe(0);
    expect(JSON.stringify(core.session.records)).not.toContain('没有原生工具调用');
  });
});
