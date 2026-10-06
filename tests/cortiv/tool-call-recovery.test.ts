import { afterEach, describe, expect, it, vi } from 'vitest';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { ToolCallRecoveryFallback, TOOL_CALL_RECOVERY_DEFAULTS } from '../../bots/cortiv/persona/tool-call-recovery.ts';
import { PLANNING_DEFAULTS } from '../../bots/cortiv/persona/planning-review.ts';
import { Core } from '../../src/core/core.ts';
import type { EventEnvelope, World } from '../../src/core/types.ts';
import { functionCall, functionResult, message, type ContextRecord } from '../../src/protocol/open-responses/context.ts';
import { FakeLLM, makeCfg, makeLoaded, makeTmpDir, textReply, toolReply } from '../core/helpers.ts';

const available = new Set(['game_move', 'game_observe']);
const fake = (id: string, tool = 'game_move'): ContextRecord[] => [message('assistant', `[调用] ${tool} {"target":[1,2,3]}`, { responseId: id })];
const event = (patch: Partial<EventEnvelope>): EventEnvelope => ({ cursor: 1, ts: new Date().toISOString(), type: 'tick', source: 'persona', origin: 'internal', text: 'Input.', ...patch });

describe('tool interface recovery fallback', () => {
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
    '[历史工具请求] game_move {"target":[1,2,3]}',
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

  it('does not retry when the fallback is disabled', async () => {
    const { core, llm, actions } = await rig([textReply('[调用] game_move {"target":[1,2,3]}')], false);
    await vi.waitFor(() => expect(core.loop.getStatus().batchesHandled).toBe(1));
    expect(llm.calls).toHaveLength(1);
    expect(actions()).toBe(0);
    expect(JSON.stringify(core.session.records)).not.toContain('没有原生工具调用');
  });
});
