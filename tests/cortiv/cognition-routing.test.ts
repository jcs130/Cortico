/** Persona 蓝图通道经过真实 Core/provider 装配；只有上游生成响应使用脚本。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Core } from '../../src/core/core.ts';
import { createResponse } from '../../src/protocol/open-responses/index.ts';
import { BLUEPRINT_COGNITION_DEFAULTS, COGNITION, CortiV } from '../../bots/cortiv/persona/persona.ts';
import { FakeLLM, makeCfg, makeLoaded, makeTmpDir, textReply } from '../core/helpers.ts';

function designResponse(): Response {
  const response = createResponse('resp_design', { model: 'design-model' });
  const item = { type: 'message', id: 'msg_design', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: '我已经交回设计。', annotations: [] }] };
  const completed = { ...response, status: 'completed', output: [item],
    usage: { input_tokens: 24, output_tokens: 8, total_tokens: 32,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 3 } } };
  const events = [{ type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: completed }];
  return new Response(events.map((event, sequence_number) =>
    `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''),
  { headers: { 'Content-Type': 'text/event-stream' } });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function rig(provider: string) {
  const tmp = makeTmpDir();
  const config = makeCfg();
  config.providers.design = { kind: 'openai-responses-compat', baseUrl: 'https://design.test/v1',
    spec: { model: 'design-model', thinking: true, reasoningEffort: 'high', maxTokens: 512, contextWindow: 48_000 } };
  const persona = new CortiV({ memoryDir: `${tmp.dir}/memory`,
    blueprintCognition: () => ({ ...BLUEPRINT_COGNITION_DEFAULTS, provider }) });
  const current = new FakeLLM();
  const core = new Core(makeLoaded({ config, rootDir: tmp.dir, memoryDir: `${tmp.dir}/memory`, dataDir: `${tmp.dir}/data` }),
    { persona, worlds: [], llm: current });
  cleanups.push(async () => { await core.stop(); tmp.cleanup(); });
  return { persona, core, config, current };
}

describe('蓝图路由真实provider契约', () => {
  it('设计请求携带独立模型思考配置和输出上限，普通构思仍调用当前模型且不改provider配置', async () => {
    const { persona, core, config, current } = rig('design');
    const active = config.activeProvider;
    const design = structuredClone(config.providers.design);
    const transport = vi.fn().mockResolvedValue(designResponse());
    vi.stubGlobal('fetch', transport);
    expect(await persona.cognition.request({ brief: '根据要求设计屋顶', hint: { kind: 'blueprint' } },
      { worldId: 'minecraft', tools: [], running: 1 })).toEqual({ text: '我已经交回设计。' });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toBe('https://design.test/v1/responses');
    const body = JSON.parse((transport.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ model: design.spec!.model, reasoning: { effort: design.spec!.reasoningEffort },
      max_output_tokens: BLUEPRINT_COGNITION_DEFAULTS.maxOutputTokens });
    expect(core.usageLog.readAll().map((record) => record.attempt?.origin.instance)).toEqual(['design']);
    current.script(textReply('我用当前通道完成普通构思。'));
    expect(await persona.cognition.request({ brief: '普通任务包含蓝图一词' },
      { worldId: 'minecraft', tools: [], running: 1 })).toEqual({ text: '我用当前通道完成普通构思。' });
    expect(current.calls).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(config.activeProvider).toBe(active);
    expect(config.providers.design).toEqual(design);
  });

  it('未注册的设计provider如实失败，不发云请求、不继承当前provider也不开设计fork', async () => {
    const { persona, core, current } = rig('missing-design');
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);
    const result = await persona.cognition.request({ brief: '设计一座桥', hint: { kind: 'blueprint' } },
      { worldId: 'minecraft', tools: [], running: 1 });
    expect(result).toHaveProperty('error');
    expect('error' in result && result.error).toContain('missing-design');
    expect(transport).not.toHaveBeenCalled();
    expect(current.calls).toEqual([]);
    expect(core.sessions.list().filter((session) => session.role === COGNITION)).toEqual([]);
  });
});
