import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { FOCUSED_COGNITION } from '../../bots/cortiv/persona/focused-cognition.ts';
import { PLANNING } from '../../bots/cortiv/persona/planning-review.ts';
import { Core } from '../core/fixture-core.ts';
import type { BotConfig } from '../../bots/corti-soulmate/assemble.ts';
import type { WorldHost } from '../../src/core/types.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeLLM, makeCfg, makeFakeIO, makeLoaded, makeTool, sleep, toolReply } from '../core/helpers.ts';

describe('CortiV pending work with the event loop', () => {
  const dirs: string[] = [];
  const cores: Core<BotConfig>[] = [];
  afterEach(async () => {
    for (const core of cores.splice(0)) await core.stop();
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function until(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 250; attempt++) {
      if (check()) return;
      await sleep(10);
    }
    throw new Error('event loop did not reach the expected state');
  }

  async function open(dir?: string) {
    if (!dir) {
      dir = mkdtempSync(join(tmpdir(), 'cortiv-pending-loop-'));
      dirs.push(dir);
    }
    const memoryDir = join(dir, 'memory');
    const actions: string[] = [];
    const world = makeFakeIO('social', [
      makeTool('social_ask', () => { actions.push('asked'); return 'Question sent; no answer yet.'; }),
      makeTool('social_work', () => { actions.push('worked'); return 'Independent work completed.'; }),
    ]);
    let host!: WorldHost;
    world.start = async (value) => { host = value; };
    const persona = new CortiV({ memoryDir, worlds: [world] });
    const llm = new FakeLLM();
    const opening = toolReply([{ name: 'end_turn' }]);
    llm.script(opening);
    const core = new Core(makeLoaded({
      config: makeCfg(), rootDir: dir, memoryDir, dataDir: join(dir, 'data'),
    }), { persona, worlds: [world], llm });
    cores.push(core);
    await core.start();
    await until(() => core.session.messages.some((item) => item.role === 'tool'
      && item.tool_call_id === opening.tool_calls![0].id && item.content === '[turn ended]'));
    const send = (senderKey: string, text: string) => host.pushEvent({
      type: 'social.chat', source: 'social', senderKey, text, ts: new Date().toISOString(),
    }, { trigger: 'flush' });
    const ledger = () => JSON.parse(readFileSync(join(memoryDir, 'pending-work.json'), 'utf8')) as {
      entries: Array<{ id: string; status: string; evidence?: { summary: string } }>;
    };
    return { dir, persona, core, llm, actions, send, ledger };
  }

  it('asking and deferring leaves the foreground and unrelated conversations available', async () => {
    const rig = await open();
    rig.llm.script(
      toolReply([{ name: 'social_ask' }]),
      toolReply([
        { name: 'pending_work', args: { operation: 'defer', id: 'search-reply', note: 'Review the search when the guide responds.',
          wait_for: { source: 'social', type: 'social.chat', sender_key: 'guide' } } },
        { name: 'social_work' },
      ]),
      toolReply([{ name: 'end_turn' }]),
    );
    await rig.send('operator', 'Ask the guide about the missing target.');
    await until(() => rig.actions.length === 2 && rig.llm.calls.length >= 4);
    expect(rig.actions).toEqual(['asked', 'worked']);
    expect(rig.ledger().entries[0].status).toBe('waiting');
    expect(rig.core.bus.isDeliveryBlocked()).toBe(false);

    const stableHead = JSON.stringify(rig.persona.sessionHead());
    await sleep(20);
    expect(JSON.stringify(rig.persona.sessionHead())).toBe(stableHead);

    rig.llm.script(toolReply([{ name: 'social_work' }]), toolReply([{ name: 'end_turn' }]));
    await rig.send('visitor', 'I am here; what are you doing?');
    await until(() => rig.actions.length === 3);
    expect(rig.ledger().entries[0].status).toBe('waiting');
    expect(rig.llm.calls.at(-1)?.messages.some((message) => message.content?.includes('I am here'))).toBe(true);

    await until(() => rig.llm.calls.length >= 6);
    const priorRequest = rig.llm.calls.at(-1)!.messages;
    rig.llm.script(toolReply([{ name: 'end_turn' }]));
    await rig.send('guide', 'The missing target moved to another place.');
    await until(() => rig.ledger().entries[0].status === 'ready');
    expect(rig.ledger().entries[0].evidence?.summary).toContain('The missing target moved');
    await until(() => rig.llm.calls.at(-1)?.messages.some((message) => message.content?.includes('待复核')) === true);
    expect(rig.llm.calls.at(-1)!.messages.slice(0, priorRequest.length)).toEqual(priorRequest);
    expect(JSON.stringify(rig.persona.sessionHead())).toBe(stableHead);

    rig.llm.script(toolReply([{ name: 'pending_work', args: { operation: 'resolve', id: 'search-reply',
      result: 'Checked the guide response; the old search has ended.' } }]), toolReply([{ name: 'end_turn' }]));
    await until(() => rig.llm.calls.length >= 7);
    await rig.send('operator', 'Record the verified conclusion.');
    await until(() => rig.ledger().entries[0].status === 'resolved');
    expect(JSON.stringify(rig.persona.sessionHead())).not.toContain('search-reply');
    rig.llm.script(toolReply([{ name: 'end_turn' }]));
    await until(() => rig.llm.calls.length >= 9);
    await rig.send('operator', 'Continue independent work.');
    await until(() => rig.llm.calls.at(-1)?.messages.some((message) => message.content?.includes('当前没有等待中或待复核')) === true);
  });

  it('restores an overdue intention through a real Core and timer store after a restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const rig = await open();
    const pending = rig.persona.declareSessions().find((session) => session.id === 'main')!.tools()
      .find((tool) => tool.name === 'pending_work')!;
    await pending.handler({ operation: 'defer', id: 'later-review', note: 'Review the observed condition later.', after_seconds: 60 },
      { role: 'main', log: nullLogger() });
    expect(rig.ledger().entries[0].status).toBe('waiting');
    await rig.core.stop();
    vi.setSystemTime(new Date(Date.now() + 120_000));

    const restarted = await open(rig.dir);
    expect(restarted.ledger().entries[0]).toMatchObject({ id: 'later-review', status: 'ready' });
    expect(restarted.llm.calls[0].messages.some((message) => message.content?.includes('later-review'))).toBe(true);
    expect(restarted.core.bus.isDeliveryBlocked()).toBe(false);
    expect(restarted.core.timers.list()).toHaveLength(0);
    const before = JSON.stringify(restarted.persona.sessionHead());
    vi.setSystemTime(new Date(Date.now() + 30_000));
    expect(JSON.stringify(restarted.persona.sessionHead())).toBe(before);
  });

  it('keeps scheduler records owned by the main session while ordinary memory tools remain usable', async () => {
    const rig = await open();
    const sessions = rig.persona.declareSessions();
    const main = sessions.find((session) => session.id === 'main')!;
    const pending = main.tools().find((tool) => tool.name === 'pending_work')!;
    await pending.handler({ operation: 'defer', id: 'protected-record', note: 'Wait for a new observation.',
      wait_for: { source: 'social' } }, { role: 'main', log: nullLogger() });
    expect(rig.persona.ownToolNames()).toContain('pending_work');
    for (const session of sessions.filter((entry) => entry.id !== 'main')) {
      expect(session.tools().some((tool) => tool.name === 'pending_work')).toBe(false);
    }

    const saved = readFileSync(join(rig.dir, 'memory', 'pending-work.json'), 'utf8');
    const readOnlyIds = new Set([PLANNING, FOCUSED_COGNITION]);
    expect(sessions.filter(session => readOnlyIds.has(session.id))).toHaveLength(readOnlyIds.size);
    for (const session of sessions) {
      if (readOnlyIds.has(session.id)) {
        expect(session.tools()).toEqual([]);
        expect(session).toMatchObject({ persistent: false, receivesEvents: false });
        expect(session.rounds()).toEqual({ soft: 1, hard: 1 });
        expect(readFileSync(join(rig.dir, 'memory', 'pending-work.json'), 'utf8')).toBe(saved);
        continue;
      }
      for (const name of ['write_file', 'append_file', 'edit_file', 'delete_file']) {
        const tool = session.tools().find((entry) => entry.name === name)!;
        const out = await tool.handler({ path: './pending-work.json', content: '{}', old_string: saved, new_string: '{}' },
          { role: session.id, log: nullLogger() });
        expect(out).toContain('pending_work');
        expect(readFileSync(join(rig.dir, 'memory', 'pending-work.json'), 'utf8')).toBe(saved);
      }
    }
    const ordinaryWrite = main.tools().find((tool) => tool.name === 'write_file')!;
    expect(await ordinaryWrite.handler({ path: 'observations.md', content: 'An independent observation.' },
      { role: 'main', log: nullLogger() })).toContain('[written]');
    expect(readFileSync(join(rig.dir, 'memory', 'observations.md'), 'utf8')).toBe('An independent observation.');
  });
});
