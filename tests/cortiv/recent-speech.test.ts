import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CortiV, renderDreamTranscript } from '../../bots/cortiv/persona/persona.ts';
import { RecentSpeech } from '../../bots/cortiv/persona/recent-speech.ts';
import { records } from '../core/fixture-protocol.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';
import type { ChatMessage } from '../core/fixture-types.ts';
import type { EventEnvelope } from '../../src/core/types.ts';

const dirs: string[] = [];
function memoryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cortiv-speech-'));
  dirs.push(dir);
  return dir;
}

function exchange(id: string, script: string, receipt: string, at: string): ChatMessage[] {
  return [
    {
      role: 'assistant', content: '', ts: at,
      tool_calls: [{ id, type: 'function', function: { name: 'vtuber_act', arguments: JSON.stringify({ script }) } }],
    },
    { role: 'tool', content: receipt, tool_call_id: id, ts: at },
  ];
}

function event(type: string, ts: string, meta?: Record<string, unknown>): EventEnvelope {
  return { cursor: 1, source: type.split('.')[0], type, ts, origin: 'external', text: '', meta };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('CortiV recent speech', () => {
  it('renders speech evidence without performance metadata or a future execution claim', () => {
    const ledger = new RecentSpeech(memoryDir());
    const at = new Date().toISOString();
    ledger.capture(records(exchange('planned', '【看向屏幕】(calm@0.5) 我去炉子旁看看。<微笑> 今天聊点什么？', '已排入演出。', at)));
    expect(ledger.note()).toContain('我去炉子旁看看。');
    expect(ledger.note()).not.toContain('(calm@0.5)');
    expect(ledger.note()).not.toContain('看向屏幕');
    expect(ledger.note()).toContain('不证明其中说的打算已经执行');
  });

  it('keeps accepted scripts across instances and names the question with no later audience message', () => {
    const dir = memoryDir();
    const atMs = Date.now() - 60_000;
    const at = new Date(atMs).toISOString();
    const ledger = new RecentSpeech(dir);
    ledger.capture(records([
      ...exchange('accepted', '【微笑】你们今晚那边天气怎么样？', '已开演(流式)。这段约 5 秒。', at),
      ...exchange('rejected', '你们现在在做什么？', '[未排入] 积压。', at),
    ]));

    const fresh = new RecentSpeech(dir);
    expect(fresh.note()).toContain('你们今晚那边天气怎么样？');
    expect(fresh.note()).toContain('此后暂无新弹幕记录');
    expect(fresh.note()).not.toContain('你们现在在做什么');

    fresh.observe([event('bilibili.danmaku', new Date(atMs + 10_000).toISOString())]);
    expect(new RecentSpeech(dir).note()).toContain('此后有新弹幕');
  });

  it('uses interrupted playback results and omits a script that never aired', () => {
    const dir = memoryDir();
    const at = new Date(Date.now() - 60_000).toISOString();
    const ledger = new RecentSpeech(dir);
    ledger.capture(records([
      ...exchange('partial', '先看这边。你们晚上想聊什么？', '已排入演出。', at),
      ...exchange('silent', '你们想看什么游戏？', '已排入演出。', at),
    ]));
    ledger.observe([event('vtuber.act.outcome', at, { outcomes: [
      { callId: 'partial', script: '先看这边。', reason: 'interrupted' },
      { callId: 'silent', script: '', reason: 'interrupted' },
    ] })]);

    const fresh = new RecentSpeech(dir);
    expect(fresh.note()).toContain('先看这边。');
    expect(fresh.note()).not.toContain('晚上想聊什么');
    expect(fresh.note()).not.toContain('你们想看什么游戏');
    expect(fresh.note()).not.toContain('最近向观众提问');
  });

  it('appends changed speech facts once at delivery and restores them after handoff and restart', async () => {
    const dir = memoryDir();
    const at = new Date(Date.now() - 60_000).toISOString();
    let snapshot = exchange('first', '你们今晚吃什么？', '已开演(流式)。', at);
    const delivered: string[] = [];
    const make = (): CortiV => {
      const persona = new CortiV({ memoryDir: dir });
      persona.attach(makeFakeHarnessApi({
        sessionInfo: (id) => ({ id, running: 0, snapshot, estTokens: null, hardTokens: null }),
        injectInternal: (text, kind) => { if (kind === 'recent_speech') delivered.push(text); },
      }));
      return persona;
    };
    const persona = make();
    persona.onOpening({ reason: 'new' });
    const head = JSON.stringify(persona.sessionHead());
    persona.onTurnEnded();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('你们今晚吃什么？');
    expect(head).not.toContain('你们今晚吃什么？');

    snapshot = exchange('second', '好，我先看一下箱子。', '已排入演出。', new Date().toISOString());
    persona.onTurnEnded();
    expect(delivered).toHaveLength(1);
    await persona.onDelivery({ events: [] });
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toContain('你们今晚吃什么？');
    expect(delivered[1]).toContain('好，我先看一下箱子');
    expect(JSON.stringify(persona.sessionHead())).toBe(head);
    await persona.onDelivery({ events: [] });
    expect(delivered).toHaveLength(2);

    await persona.onHandoff(records([{ role: 'system', content: 'sys' }]), { hardTokens: null });
    expect(delivered).toHaveLength(3);
    expect(delivered[2]).toContain('你们今晚吃什么？');
    expect(JSON.stringify(persona.sessionHead())).toBe(head);

    const restarted = make();
    restarted.onOpening({ reason: 'restarted' });
    expect(delivered).toHaveLength(4);
    expect(delivered[3]).toContain('你们今晚吃什么？');
    expect(JSON.stringify(restarted.sessionHead())).toBe(head);
  });

  it('recovers recent accepted speech from the loaded session on the first restart', () => {
    const dir = memoryDir();
    const snapshot = exchange('before-upgrade', '你们今晚还有谁在线？', '已开演(流式)。', new Date().toISOString());
    const delivered: string[] = [];
    const persona = new CortiV({ memoryDir: dir });
    persona.attach(makeFakeHarnessApi({
      sessionInfo: (id) => ({ id, running: 0, snapshot, estTokens: null, hardTokens: null }),
      injectInternal: (text, kind) => { if (kind === 'recent_speech') delivered.push(text); },
    }));

    persona.onOpening({ reason: 'restarted' });
    expect(delivered.join('\n')).toContain('你们今晚还有谁在线？');
    expect(JSON.stringify(persona.sessionHead())).not.toContain('你们今晚还有谁在线？');
    expect(new RecentSpeech(dir).note()).toContain('你们今晚还有谁在线？');
  });

  it('appends an explicit correction when accepted speech did not air', async () => {
    const dir = memoryDir();
    const at = new Date().toISOString();
    const delivered: string[] = [];
    const persona = new CortiV({ memoryDir: dir });
    persona.attach(makeFakeHarnessApi({
      sessionInfo: (id) => ({ id, running: 0, snapshot: exchange('silent', '今天聊点什么？', '已排入演出。', at), estTokens: null, hardTokens: null }),
      injectInternal: (text, kind) => { if (kind === 'recent_speech') delivered.push(text); },
    }));
    persona.onOpening({ reason: 'new' });
    await persona.onDelivery({ events: [event('vtuber.act.outcome', at, { outcomes: [{ callId: 'silent', script: '', reason: 'interrupted' }] })] });
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toContain('没有近期台词记录');
    await persona.onDelivery({ events: [] });
    expect(delivered).toHaveLength(2);
  });

  it('keeps the synthetic speech note out of dream transcripts', () => {
    const transcript = renderDreamTranscript(records([
      { role: 'user', content: 'synthetic recent speech', head: true },
      { role: 'user', content: 'new audience message' },
    ]));
    expect(transcript).not.toContain('synthetic recent speech');
    expect(transcript).toContain('new audience message');
  });
});
