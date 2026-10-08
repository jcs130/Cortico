/** Real Persona/Core/provider routing; only the upstream generation is scripted. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Core } from '../../src/core/core.ts';
import { createResponse } from '../../src/protocol/open-responses/index.ts';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { PLANNING_DEFAULTS } from '../../bots/cortiv/persona/planning-review.ts';
import { FakeLLM, makeCfg, makeLoaded, makeTmpDir } from '../core/helpers.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('focused reflection provider contract', () => {
  it('sends the selected model, real reasoning fields and bounded material without switching main or granting action tools', async () => {
    const tmp = makeTmpDir();
    const config = makeCfg();
    config.providers.reflector = { kind: 'openai-responses-compat', baseUrl: 'https://reflector.test/v1',
      spec: { model: 'reflection-model', thinking: true, reasoningEffort: 'high', contextWindow: 48_000 } };
    const persona = new CortiV({ memoryDir: `${tmp.dir}/memory`, tickDelayMs: () => null,
      planning: () => ({ ...PLANNING_DEFAULTS, enabled: true, provider: 'missing-routine',
        reflectionProvider: 'reflector', reflectionMaxContextTokens: 24_000, reflectionMaxOutputTokens: 2800 }) });
    const current = new FakeLLM();
    const core = new Core(makeLoaded({ config, rootDir: tmp.dir, memoryDir: `${tmp.dir}/memory`, dataDir: `${tmp.dir}/data` }),
      { persona, worlds: [], llm: current });
    cleanups.push(async () => { persona.stopRhythm(); await core.stop(); tmp.cleanup(); });
    const active = config.activeProvider;
    const entry = structuredClone(config.providers.reflector);
    const response = createResponse('resp_reflection', { model: entry.spec!.model });
    const final = { type: 'message', id: 'msg_reflection', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: '需分别核对群怪和单体场景，再验证条件分支。', annotations: [] }] };
    const completed = { ...response, status: 'completed', output: [final],
      usage: { input_tokens: 50, output_tokens: 18, total_tokens: 68,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 5 } } };
    const transport = vi.fn().mockResolvedValue(new Response([
      { type: 'response.created', response },
      { type: 'response.output_item.added', output_index: 0, item: final },
      { type: 'response.output_item.done', output_index: 0, item: final },
      { type: 'response.completed', response: completed },
    ].map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', transport);
    persona.startRhythm();
    expect(await persona.console().invoke!('planning', 'review', [{ question: '比较群怪与单体的策略', publicTopic: '研究包围战术' }]))
      .toMatchObject({ accepted: true });
    await vi.waitFor(async () => {
      expect(await persona.console().invoke!('planning', 'state', [])).toMatchObject({ lastOutcome: 'completed' });
    });
    const body = JSON.parse((transport.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ model: entry.spec!.model, reasoning: { effort: entry.spec!.reasoningEffort }, max_output_tokens: 2800 });
    expect(body.tools ?? []).toEqual([]);
    expect(JSON.stringify(body.input)).toContain('比较群怪与单体');
    expect(core.usageLog.readAll().map(record => record.attempt?.origin.instance)).toEqual(['reflector']);
    expect(current.calls).toEqual([]);
    expect(config.activeProvider).toBe(active);
    expect(config.providers.reflector).toEqual(entry);
  });
});
