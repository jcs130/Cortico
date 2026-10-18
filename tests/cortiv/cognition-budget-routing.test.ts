/** Actual Persona/Core/chat provider assembly; only upstream responses are scripted. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Core } from '../../src/core/core.ts';
import type { CoreApi } from '../../src/core/types.ts';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { FOCUSED_COGNITION_DEFAULTS } from '../../bots/cortiv/persona/focused-cognition.ts';
import { PeriodicPlanningReview, PLANNING_DEFAULTS } from '../../bots/cortiv/persona/planning-review.ts';
import { ActivityAgenda } from '../../bots/cortiv/persona/activity-agenda.ts';
import { message } from '../../src/protocol/open-responses/context.ts';
import { FakeLLM, makeCfg, makeLoaded, makeTmpDir, textReply } from '../core/helpers.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const fn of cleanup.splice(0)) await fn(); });
describe('separate speech, routine and deep review budgets', () => {
  it('sends complete speech and plan outputs through their registered connections while retaining high reflection and main configuration', async () => {
    const tmp = makeTmpDir(), config = makeCfg(), current = new FakeLLM();
    for (const [name, effort] of [['draft', 'none'], ['routine', 'low'], ['reflection', 'high']]) {
      config.providers[name] = { kind: 'openai-chat-compat', baseUrl: 'https://model.test',
        spec: { model: 'same-model', thinking: effort !== 'none', ...(effort !== 'none' ? { reasoningEffort: effort } : {}), maxTokens: 8192 } };
    }
    const original = structuredClone(config.providers), active = config.activeProvider;
    const persona = new CortiV({ memoryDir: `${tmp.dir}/memory`,
      focusedCognition: () => ({ ...FOCUSED_COGNITION_DEFAULTS, speechProvider: 'draft' }) });
    let api!: CoreApi;
    const attach = persona.attach.bind(persona);
    persona.attach = value => { api = value; attach(value); };
    const core = new Core(makeLoaded({ config, rootDir: tmp.dir, memoryDir: `${tmp.dir}/memory`, dataDir: `${tmp.dir}/data` }),
      { persona, worlds: [], llm: current });
    const agenda = new ActivityAgenda(`${tmp.dir}/memory`);
    const review = new PeriodicPlanningReview({ core: api, agenda,
      config: () => ({ ...PLANNING_DEFAULTS, enabled: true, provider: 'routine', reflectionProvider: 'reflection', agendaEnabled: true }),
      memory: () => ({ constitution: 'Explore responsibly.', memories: [], pending: 'An earlier journey is not completed.' }) });
    cleanup.push(async () => { review.stop(); await core.stop(); tmp.cleanup(); });
    persona.memory.writeFileAtomic('CONSTITUTION.md', 'I speak briefly and cite observed events.');
    const speech = JSON.stringify({ script: 'The entrance is clear.', evidence: [7] });
    const plan = JSON.stringify({ summary: 'Observed an open entrance.', items: [{ id: 'explore', title: 'Explore the entrance',
      why: 'A current observation shows access.', doneWhen: 'Inspect the first room and report actual observations.',
      when: 'After checking safety.', ifBlocked: 'Retain the objective and verify a different entry.', references: [] }] });
    const replies = [speech, plan, 'The route is a candidate until fresh observations confirm it.'];
    const bodies: Record<string, any>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); bodies.push(body);
      const data = [{ id: `reply-${bodies.length}`, model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: replies.shift() }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 40, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: body.reasoning_effort === 'none' ? 0 : 12 } } }];
      return new Response(data.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    });
    expect(await persona.cognition.request({ brief: 'Draft one JSON utterance using event 7.', hint: { context: 'task', kind: 'vtuber-commentary' } },
      { worldId: 'stage', tools: [], running: 1 })).toEqual({ text: speech });
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'none', max_tokens: 768 });
    review.noteSnapshot([message('user', 'Observed an open entrance; exploration has not begun.', { ts: new Date().toISOString() })]);
    review.start(); expect(review.review().accepted).toBe(true);
    await vi.waitFor(() => expect(review.state()).toMatchObject({ running: false, lastOutcome: 'completed' }));
    expect(bodies[1]).toMatchObject({ reasoning_effort: 'low', max_tokens: 4096 });
    expect(agenda.state().proposal?.items[0].id).toBe('explore');
    expect(review.review('Compare the evidence and possible routes.').accepted).toBe(true);
    await vi.waitFor(() => expect(review.state()).toMatchObject({ running: false, lastOutcome: 'completed' }));
    expect(bodies[2]).toMatchObject({ reasoning_effort: 'high', max_tokens: 8192 });
    current.script(textReply('Ordinary observation remains on the active connection.'));
    await persona.cognition.request({ brief: 'Inspect the new observation.', hint: { context: 'task' } }, { worldId: 'game', tools: [], running: 1 });
    expect(current.calls).toHaveLength(1);
    expect(current.calls[0].spec.maxTokens).toBe(2048);
    expect(config.providers).toEqual(original); expect(config.activeProvider).toBe(active);
    expect(core.usageLog.readAll().flatMap(row => row.attempt ? [row.attempt.origin.instance] : [])).toEqual(['draft', 'routine', 'reflection', active]);
  });
});
