import { GenerationError } from '../../src/core/generation.ts';
import { FixtureForkOptions as ForkOptions, FixtureSessionInfo as SessionInfo } from '../core/fixture-protocol.ts';
import { records } from '../core/fixture-protocol.ts';
/** 验证观众档案按上下文去重、recall_viewer 检索、目录折叠、软阈值交接与串行梦任务。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CortiV,
  HANDOFF_DIR,
  RECENT_FILE,
  renderDreamTranscript,
} from '../../bots/cortiv/persona/persona.ts';
import { HANDOFF_NOTE_TYPE } from '../../bots/cormini/persona/handoffNote.ts';
import type { ChatMessage } from '../core/fixture-types.ts';
import type { EventEnvelope, World } from '../../src/core/types.ts';
import { estimateTokens, nullLogger } from '../../src/core/util.ts';
import { CoreState } from '../../src/core/state.ts';
import { makeFakeHarnessApi, sleep } from '../core/helpers.ts';

/** core 交给交接策略的物理上限;这些用例不靠它 */
const HANDOFF_CTX = { hardTokens: null };
/** 阶段预算 1000 tok，软阈值比例 0.85。 */
const CONTEXT = () => ({ maxTokens: 1000, softRatio: 0.85, keepRatio: 0.25, firstTurn: false });
/** 交接笔记用例的阶段裁量:900 tok 就越过软阈值(笔记分早/近两段),笔记预算 4096 */
const NOTE_CONTEXT = () => ({ maxTokens: 16384, softRatio: 0.05, keepRatio: 0.25, firstTurn: false });

let seq = 0;
function ev(patch: Partial<EventEnvelope>): EventEnvelope {
  return {
    cursor: ++seq,
    type: 'bilibili.danmaku',
    ts: '2026-08-15T20:00:00+08:00',
    source: 'bilibili',
    origin: 'external',
    text: '弹幕正文',
    ...patch,
  };
}

function sessionInfoOf(est: number | null) {
  return (id: string): SessionInfo => ({
    id,
    running: 0,
    snapshot: null,
    estTokens: est,
    hardTokens: null,
  });
}

describe('CortiV 观众档案唤起', () => {
  let dir: string;
  let p: CortiV;
  let injected: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cormini-mem-'));
    p = new CortiV({ memoryDir: dir });
    mkdirSync(join(dir, 'viewers', 'bilibili'), { recursive: true });
    writeFileSync(
      join(dir, 'viewers', 'bilibili', '314544096.md'),
      '五子棋赢过她一次,爱抬杠\n\n2026-08-01 第一次来,聊了很久。\n',
      'utf8',
    );
    injected = [];
    p.attach(makeFakeHarnessApi({ injectInternal: (text) => injected.push(text) }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('首见注入档案首行;同 session 第二次出现不再注入', () => {
    p.onDelivery({ events: [ev({ senderKey: '314544096' })] });
    const recalls = injected.filter((t) => t.startsWith('[memory]'));
    expect(recalls).toHaveLength(1);
    expect(recalls[0]).toContain('314544096');
    expect(recalls[0]).toContain('五子棋赢过她一次');
    // 摘要只取首行,不吐全文
    expect(recalls[0]).not.toContain('第一次来');

    p.onDelivery({ events: [ev({ senderKey: '314544096' })] });
    expect(injected.filter((t) => t.startsWith('[memory]'))).toHaveLength(1);
  });

  it('多人归并事件按私有参与者表逐人召回，正文无需展开姓名', () => {
    writeFileSync(
      join(dir, 'viewers', 'bilibili', '271828182.md'),
      '总在关键时刻提醒她看背包\n',
      'utf8',
    );
    p.onDelivery({ events: [ev({
      text: '[弹幕×3] 同一句',
      meta: {
        participants: [
          { senderKey: '314544096', uname: '甲', count: 2 },
          { senderKey: '271828182', uname: '乙', count: 1 },
        ],
      },
    })] });

    const recalls = injected.filter((text) => text.startsWith('[memory] 你记得'));
    expect(recalls).toHaveLength(2);
    expect(recalls.join('\n')).toContain('五子棋赢过她一次');
    expect(recalls.join('\n')).toContain('总在关键时刻提醒她看背包');
  });

  it('限流批只唤起已准入的重要观众', () => {
    writeFileSync(join(dir, 'viewers', 'bilibili', '271828182.md'), '普通观众档案\n', 'utf8');
    p.onDelivery({ events: [ev({
      text: '[弹幕×2] 同一句',
      meta: {
        participants: [
          { senderKey: '314544096', uname: '甲', count: 1 },
          { senderKey: '271828182', uname: '乙', count: 1 },
        ],
        audienceAdmission: {
          limitingActive: true,
          importantParticipants: [
            { senderKey: '314544096', uname: '甲', count: 1, reasons: ['guard'] },
          ],
        },
      },
    })] });

    const recalls = injected.filter((text) => text.startsWith('[memory] 你记得'));
    expect(recalls).toHaveLength(1);
    expect(recalls[0]).toContain('314544096');
    expect(recalls[0]).not.toContain('271828182');
  });

  it('准入观众在限流批首次出现就可递交立档主键', () => {
    p.onDelivery({ events: [ev({
      meta: {
        audienceAdmission: {
          limitingActive: true,
          importantParticipants: [
            { senderKey: '777', uname: '过海米线', count: 1, reasons: ['superchat'] },
          ],
        },
      },
    })] });

    expect(injected.filter((text) => text.startsWith('[memory]'))).toEqual([
      expect.stringContaining('过海米线(id 777)'),
    ]);
  });

  it('限流批的档案唤起总量受独立 token 预算限制', () => {
    const participants: Array<Record<string, unknown>> = [];
    for (let i = 1000; i < 1040; i++) {
      writeFileSync(
        join(dir, 'viewers', 'bilibili', `${i}.md`),
        `${'长期记忆'.repeat(100)}\n`,
        'utf8',
      );
      participants.push({ senderKey: String(i), uname: `观众${i}`, count: 1, reasons: ['interaction'] });
    }
    p.onDelivery({ events: [ev({
      meta: { audienceAdmission: { limitingActive: true, importantParticipants: participants } },
    })] });

    const recalls = injected.filter((text) => text.startsWith('[memory] 你记得'));
    expect(recalls.length).toBeGreaterThan(0);
    expect(recalls.length).toBeLessThan(participants.length);
    expect(recalls.reduce((sum, text) => sum + estimateTokens(text), 0)).toBeLessThanOrEqual(2445);
  });

  it('没有档案或没有 senderKey(脱敏):安静走过', () => {
    p.onDelivery({ events: [ev({ senderKey: '999' }), ev({})] });
    expect(injected.filter((t) => t.startsWith('[memory]'))).toHaveLength(0);
  });


  /**
   * 唤起按上下文窗口去重。交接会清空上文中的 [memory] 行，交接笔记只带上一窗，因此新窗口须重新唤起。
   */
  it('交接清空上文后再次出现重念一次;同一窗口内仍只说一次', async () => {
    p.onDelivery({ events: [ev({ senderKey: '314544096' })] });
    p.onDelivery({ events: [ev({ senderKey: '314544096' })] });
    await p.onHandoff(records([{ role: 'user', content: 'x' }]), HANDOFF_CTX);
    p.onDelivery({ events: [ev({ senderKey: '314544096' })] });
    p.onDelivery({ events: [ev({ senderKey: '314544096' })] });
    expect(injected.filter((t) => t.startsWith('[memory] 你记得'))).toHaveLength(2);
  });

  /** 重启清空进程内状态，load 从模拟磁盘恢复；保存使用 JSON 序列化隔离对象身份。 */
  function fakeHarnessState() {
    let onDisk = '{}';
    // state.data.persona:新进程刚构造时是空袋子
    let bag: Record<string, unknown> = {};
    return {
      load: () => { bag = JSON.parse(onDisk) as Record<string, unknown>; },
      api: (sink: string[], onSave?: () => void) => makeFakeHarnessApi({
        injectInternal: (text) => sink.push(text),
        personaState: () => bag,
        savePersonaState: () => { onDisk = JSON.stringify(bag); onSave?.(); },
      }),
      /** 新进程 = 新的 CoreState 实例:构造出来还是空的,盘上那份不动 */
      restart: () => { bag = {}; },
      peekDisk: () => JSON.parse(onDisk) as Record<string, unknown>,
    };
  }

  it('热重启续用本场摘要指纹；全新 session 才重新唤起', () => {
    const disk = fakeHarnessState();
    let saves = 0;
    disk.load();
    p.attach(disk.api(injected, () => { saves++; }));
    p.onOpening({ reason: 'new' });
    p.onDelivery({ events: [ev({ senderKey: '314544096' })] });
    expect(injected.filter((t) => t.startsWith('[memory] 你记得'))).toHaveLength(1);
    expect(saves).toBe(1);

    const afterRestart: string[] = [];
    disk.restart();
    disk.load();
    const restarted = new CortiV({ memoryDir: dir });
    restarted.attach(disk.api(afterRestart, () => { saves++; }));
    restarted.onOpening({ reason: 'restarted' });
    restarted.onDelivery({ events: [ev({ senderKey: '314544096' })] });
    expect(afterRestart.filter((t) => t.startsWith('[memory] 你记得'))).toHaveLength(0);

    // ——边界二:开新场(同一进程里换 session)照旧归零,跨场去重不打开——
    restarted.onOpening({ reason: 'new' });
    expect(disk.peekDisk()).toEqual({});
    restarted.onDelivery({ events: [ev({ senderKey: '314544096' })] });
    expect(afterRestart.filter((t) => t.startsWith('[memory] 你记得'))).toHaveLength(1);
  });

  it('交接归零的指纹落盘:之后热重启不会把交接前念过的人当成已念', async () => {
    const disk = fakeHarnessState();
    disk.load();
    p.attach(disk.api(injected));
    p.onOpening({ reason: 'new' });
    p.onDelivery({ events: [ev({ senderKey: '314544096' })] });
    await p.onHandoff(records([{ role: 'user', content: 'x' }]), HANDOFF_CTX);

    const afterRestart: string[] = [];
    disk.restart();
    disk.load();
    const restarted = new CortiV({ memoryDir: dir });
    restarted.attach(disk.api(afterRestart));
    restarted.onOpening({ reason: 'restarted' });
    restarted.onDelivery({ events: [ev({ senderKey: '314544096' })] });
    expect(afterRestart.filter((t) => t.startsWith('[memory] 你记得'))).toHaveLength(1);
  });

  /**
   * 使用真实 CoreState 读写临时状态文件；重启创建新人格和状态实例，再投递同一批观众事件。
   */
  it('进程重启后同批观众不再重复注入(真 CoreState 从盘恢复)', () => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(
        join(dir, 'viewers', 'bilibili', `${9000 + i}.md`),
        `第${i}位熟客的一句话摘要\n\n更早的记录。\n`,
        'utf8',
      );
    }
    const keys = ['314544096', '9000', '9001', '9002'];
    const dataDir = mkdtempSync(join(tmpdir(), 'cormini-state-'));
    const apiFor = (state: CoreState, sink: string[]) => makeFakeHarnessApi({
      injectInternal: (text) => sink.push(text),
      personaState: () => state.data.persona,
      savePersonaState: () => state.save(),
    });
    try {
      // 第一个进程
      const first = new CoreState(dataDir);
      first.load();
      const firstInjected: string[] = [];
      const before = new CortiV({ memoryDir: dir });
      before.attach(apiFor(first, firstInjected));
      before.onOpening({ reason: 'new' });
      before.onDelivery({ events: keys.map((senderKey) => ev({ senderKey })) });
      expect(firstInjected.filter((t) => t.startsWith('[memory] 你记得'))).toHaveLength(keys.length);

      const second = new CoreState(dataDir);
      second.load();
      const secondInjected: string[] = [];
      const after = new CortiV({ memoryDir: dir });
      after.attach(apiFor(second, secondInjected));
      after.onOpening({ reason: 'restarted' });
      after.onDelivery({ events: keys.map((senderKey) => ev({ senderKey })) });
      expect(secondInjected.filter((t) => t.startsWith('[memory] 你记得'))).toHaveLength(0);

      // 同一份盘上状态,开的是新场:整表归零,四个人都重新唤起一次
      const third = new CoreState(dataDir);
      third.load();
      const thirdInjected: string[] = [];
      const fresh = new CortiV({ memoryDir: dir });
      fresh.attach(apiFor(third, thirdInjected));
      fresh.onOpening({ reason: 'new' });
      fresh.onDelivery({ events: keys.map((senderKey) => ev({ senderKey })) });
      expect(thirdInjected.filter((t) => t.startsWith('[memory] 你记得'))).toHaveLength(keys.length);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('摘要被梦改过:对不上就重念一次新的', async () => {
    p.onDelivery({ events: [ev({ senderKey: '314544096' })] });
    writeFileSync(
      join(dir, 'viewers', 'bilibili', '314544096.md'),
      '现在改口说自己是象棋高手\n\n旧的都在下面。\n',
      'utf8',
    );
    await p.onHandoff(records([{ role: 'user', content: 'x' }]), HANDOFF_CTX);
    p.onDelivery({ events: [ev({ senderKey: '314544096' })] });
    const recalls = injected.filter((t) => t.startsWith('[memory] 你记得'));
    expect(recalls).toHaveLength(2);
    expect(recalls[1]).toContain('象棋高手');
  });

  it('恶意 senderKey 不能逃出工作区', () => {
    const bad = { senderKey: '../../CONSTITUTION', meta: { uname: '坏人' } };
    for (let i = 0; i < 5; i++) p.onDelivery({ events: [ev(bad)] });
    expect(injected.filter((t) => t.startsWith('[memory]'))).toHaveLength(0);
  });

  /**
   * senderKey 不进归一化正文，renderEventLines 只发 text。
   * 无档案的发言人须在攒够互动后显式报出 id。
   */
  it('无档案:攒够互动才报 id,报一次就够', () => {
    const who = { senderKey: '777', meta: { uname: '过海米线' } };
    p.onDelivery({ events: [ev(who), ev(who)] });
    expect(injected.filter((t) => t.startsWith('[memory]'))).toHaveLength(0);

    p.onDelivery({ events: [ev(who)] });
    const nudges = injected.filter((t) => t.startsWith('[memory]'));
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain('过海米线');
    expect(nudges[0]).toContain('777');

    p.onDelivery({ events: [ev(who), ev(who)] });
    expect(injected.filter((t) => t.startsWith('[memory]'))).toHaveLength(1);
  });

  it('同一观众被归并的原始条数仍计入立档门槛', () => {
    p.onDelivery({ events: [ev({
      text: '[弹幕×3] 复读',
      senderKey: '777',
      meta: { participants: [{ senderKey: '777', uname: '过海米线', count: 3 }] },
    })] });

    const nudges = injected.filter((text) => text.startsWith('[memory]'));
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain('过海米线');
    expect(nudges[0]).toContain('777');
  });

  it('无档案:World 不报昵称就整条不发(光有 id 认不出是谁)', () => {
    for (let i = 0; i < 5; i++) p.onDelivery({ events: [ev({ senderKey: '888' })] });
    expect(injected.filter((t) => t.startsWith('[memory]'))).toHaveLength(0);
  });

  it('无档案:交接后重报(每个窗口的梦都要拿到钥匙),但门槛不重新挣', async () => {
    const who = { senderKey: '777', meta: { uname: '过海米线' } };
    for (let i = 0; i < 3; i++) p.onDelivery({ events: [ev(who)] });
    expect(injected.filter((t) => t.startsWith('[memory]'))).toHaveLength(1);

    await p.onHandoff(records([{ role: 'user', content: 'x' }]), HANDOFF_CTX);
    p.onDelivery({ events: [ev(who)] });
    expect(injected.filter((t) => t.startsWith('[memory]'))).toHaveLength(2);
  });

  /**
   * 无档案的发言人随交接重新报 id，最多覆盖三个窗口。
   */
  it('无档案:同一个人至多报三个交接窗口', async () => {
    const who = { senderKey: '777', meta: { uname: '过海米线' } };
    for (let window = 0; window < 5; window++) {
      for (let i = 0; i < 3; i++) p.onDelivery({ events: [ev(who)] });
      await p.onHandoff(records([{ role: 'user', content: 'x' }]), HANDOFF_CTX);
    }
    expect(injected.filter((t) => t.startsWith('[memory]'))).toHaveLength(3);
  });

  it('有档案的人不会被当成待立档', () => {
    const who = { senderKey: '314544096', meta: { uname: '老熟人' } };
    for (let i = 0; i < 5; i++) p.onDelivery({ events: [ev(who)] });
    const recalls = injected.filter((t) => t.startsWith('[memory]'));
    expect(recalls).toHaveLength(1);
    expect(recalls[0]).toContain('你记得');
  });

  it('前缀树 viewers/ 折叠为计数;list_files 保持全量', async () => {
    const segs = await p.systemSegments({ now: new Date(), timezone: 'Asia/Shanghai', worlds: [] });
    const ws = segs.find((s) => s.title === 'WORKSPACE')!.text;
    expect(ws).toContain('viewers/ (1 份人物档案');
    expect(ws).toContain('recall_viewer');
    expect(ws).not.toContain('viewers/bilibili/314544096.md');
    // 记忆说明段关联可编辑模板。
    const memory = segs.find((s) => s.title === 'MEMORY')!;
    expect(memory.text).toContain('viewers/');
    expect(memory.sourceKey).toBe('memoryNote');

    const list = p.declareSessions()[0].tools().find((t) => t.name === 'list_files')!;
    const out = await list.handler({}, { role: 'main', log: console as never });
    expect(String(out)).toContain('viewers/bilibili/314544096.md');
  });

  it('阅读归档增长不扩张常驻目录，当前笔记与按需原文仍可读取', async () => {
    mkdirSync(join(dir, 'sessions', 'archive'), { recursive: true });
    writeFileSync(join(dir, RECENT_FILE), '当前正在进行的阶段', 'utf8');
    writeFileSync(join(dir, 'sessions', 'archive-notes.md'), '归档使用说明', 'utf8');
    const source = 'sessions/archive/source-first.jsonl';
    const body = '{"observedAt":"2026-01-01T00:00:00Z","text":"原始执行回执"}\n';
    writeFileSync(join(dir, source), body, 'utf8');
    const workspace = async () => (await p.systemSegments({ now: new Date(), timezone: 'Asia/Shanghai', worlds: [] }))
      .find(segment => segment.title === 'WORKSPACE')!.text;
    const before = await workspace();
    for (let index = 0; index < 150; index++) {
      writeFileSync(join(dir, 'sessions', 'archive', `reading-${index}.jsonl`), '{}\n', 'utf8');
    }
    const after = await workspace();
    expect(after).toContain(RECENT_FILE);
    expect(after).toContain('sessions/archive-notes.md');
    expect(after).toContain('sessions/archive/ (151 ');
    expect(after).not.toContain(source);
    expect(after).not.toContain('reading-149.jsonl');
    expect(after.length - before.length).toBeLessThan(10);

    const tools = p.declareSessions()[0].tools();
    const ctx = { role: 'main', log: console as never };
    const listing = await tools.find(tool => tool.name === 'list_files')!.handler({ dir: 'sessions/archive' }, ctx);
    expect(String(listing)).toContain(source);
    expect(String(listing)).toContain('reading-149.jsonl');
    const read = await tools.find(tool => tool.name === 'read_file')!.handler({ path: source }, ctx);
    expect(typeof read === 'string' ? read : read.text).toContain(body.trim());
    expect(readFileSync(join(dir, source), 'utf8')).toBe(body);
  });
});

describe('CortiV recall_viewer:按 id 或名字取整份档案', () => {
  let dir: string;
  let p: CortiV;
  const FULL = '抬杠王(314544096) — 五子棋赢过她一次,爱抬杠\n\n2026-08-01 第一次来,聊了很久。\n';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortiv-recall-'));
    p = new CortiV({ memoryDir: dir });
    mkdirSync(join(dir, 'viewers', 'bilibili'), { recursive: true });
    writeFileSync(join(dir, 'viewers', 'bilibili', '314544096.md'), FULL, 'utf8');
    writeFileSync(join(dir, 'viewers', 'bilibili', '777.md'), '抬杠二号(777) — 也爱抬杠\n', 'utf8');
    p.attach(makeFakeHarnessApi());
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const recall = async (args: Record<string, unknown>): Promise<string> => {
    const tool = p.declareSessions()[0].tools().find((t) => t.name === 'recall_viewer')!;
    return String(await tool.handler(args, { role: 'main', log: console as never }));
  };

  it('按 id 交回整份档案,附本场见到的昵称', async () => {
    p.onDelivery({ events: [ev({ senderKey: '314544096', meta: { uname: '抬杠王改名了' } })] });
    const out = await recall({ id: '314544096' });
    expect(out).toContain('viewers/bilibili/314544096.md');
    expect(out).toContain('本场叫「抬杠王改名了」');
    expect(out).toContain('2026-08-01 第一次来');
  });

  it('按名字唯一命中一份档案:直接带全文', async () => {
    const out = await recall({ name: '抬杠王' });
    expect(out).toContain('viewers/bilibili/314544096.md');
    expect(out).toContain('2026-08-01 第一次来');
  });

  it('本场改了名的人:按新名字找得到那份首行还是旧名的档案', async () => {
    p.onDelivery({ events: [ev({ senderKey: '314544096', meta: { uname: '抬杠王改名了' } })] });
    const out = await recall({ name: '改名了' });
    expect(out).toContain('viewers/bilibili/314544096.md');
    expect(out).toContain('2026-08-01 第一次来');
    expect(out).not.toContain('还没有档案');
  });

  it('按名字多命中:只列首行,不带正文', async () => {
    const out = await recall({ name: '抬杠' });
    expect(out).toContain('找到 2 个');
    expect(out).toContain('viewers/bilibili/314544096.md');
    expect(out).toContain('viewers/bilibili/777.md');
    expect(out).not.toContain('2026-08-01 第一次来');
  });

  it('本场见过但没档案的人:按名字或 id 都给出「还没有档案」和 id', async () => {
    p.onDelivery({ events: [ev({ senderKey: '999', meta: { uname: '新来的观众' } })] });
    const byName = await recall({ name: '新来' });
    expect(byName).toContain('id 999');
    expect(byName).toContain('还没有档案');
    expect(await recall({ id: '999' })).toContain('还没有档案');
  });

  it('找不到、缺参数、逃逸 id:回执说清,不抛', async () => {
    expect(await recall({ name: '没这个人' })).toContain('没找到');
    expect(await recall({})).toContain('[缺参数]');
    expect(await recall({ id: '../../CONSTITUTION' })).toContain('没有 id');
  });

  it('本场名字表随新 session 清空', async () => {
    p.onDelivery({ events: [ev({ senderKey: '999', meta: { uname: '新来的观众' } })] });
    p.onOpening({ reason: 'new' });
    expect(await recall({ name: '新来' })).toContain('没找到');
  });
});

describe('CortiV 软阈值提醒与交接', () => {
  let dir: string;
  let p: CortiV;
  let injected: string[];
  let handoffRequests: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cormini-mem-'));
    injected = [];
    handoffRequests = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function attach(p2: CortiV, est: number | null): void {
    p2.attach(
      makeFakeHarnessApi({
        injectInternal: (text) => injected.push(text),
        sessionInfo: sessionInfoOf(est),
        requestContextHandoff: () => {
          handoffRequests++;
          return true;
        },
      }),
    );
  }

  it('阈值下不动作;超阈值先速记提醒一轮,再超才请求交接', () => {
    p = new CortiV({ memoryDir: dir, context: CONTEXT });
    attach(p, 100);
    p.onBatchEnd();
    expect(injected).toHaveLength(0);
    expect(handoffRequests).toBe(0);

    attach(p, 900);
    p.onBatchEnd();
    expect(injected.filter((t) => t.includes('很早以前'))).toHaveLength(1);
    expect(handoffRequests).toBe(0);

    p.onBatchEnd();
    expect(injected.filter((t) => t.includes('很早以前'))).toHaveLength(1); // 不重复提醒
    expect(handoffRequests).toBe(1);
  });

  it('交接重置提醒状态:下个 session 压力再起时重新走"先提醒后交接"', async () => {
    p = new CortiV({ memoryDir: dir, context: CONTEXT });
    attach(p, 900);
    p.onBatchEnd();
    await p.onHandoff(records([{ role: 'user', content: 'x' }]), HANDOFF_CTX);
    p.onBatchEnd();
    expect(injected.filter((t) => t.includes('很早以前'))).toHaveLength(2);
    expect(handoffRequests).toBe(0);
  });

  it('fork 等无主 session 拿不到量表(null):不动作', () => {
    p = new CortiV({ memoryDir: dir, context: CONTEXT });
    attach(p, null);
    p.onBatchEnd();
    expect(injected).toHaveLength(0);
    expect(handoffRequests).toBe(0);
  });
});

describe('CortiV 并行梦', () => {
  let dir: string;
  let p: CortiV;
  let injected: Array<{ text: string; kind?: string }>;
  let externals: Array<{ text: string; kind?: string }>;
  let forks: ForkOptions[];
  let forkResult: (opts: ForkOptions) => Promise<string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cormini-mem-'));
    injected = [];
    externals = [];
    forks = [];
    forkResult = async () => '(nothing)';
    p = new CortiV({ memoryDir: dir, context: NOTE_CONTEXT });
    p.attach(
      makeFakeHarnessApi({
        injectInternal: (text, kind) => injected.push({ text, kind }),
        injectExternal: (text, kind) => externals.push({ text, kind }),
        toolsTagged: (tag) => new Set(tag === 'speak' ? ['vtuber_act'] : []),
        sessionInfo: sessionInfoOf(900),
        spawnFork: async (opts) => {
          forks.push(opts);
          return forkResult(opts);
        },
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('声明 dream session:同档模型、只有文件工具、不收事件', () => {
    const decls = p.declareSessions();
    // planning reads preassembled materials and returns optional directions; it has no file or body tools.
    expect(decls.map((d) => d.id).sort()).toEqual(['cognition', 'dream', 'focused-cognition', 'main', 'planning', 'social-memory']);
    const planning = decls.find((d) => d.id === 'planning')!;
    expect(planning.tools()).toEqual([]);
    expect(planning.persistent).toBe(false);
    expect(planning.receivesEvents).toBe(false);
    const dream = decls.find((d) => d.id === 'dream')!;
    expect(dream.persistent).toBe(false);
    expect(dream.receivesEvents).toBe(false);
    // 梦也拿得到历史:它合并/蒸馏档案时同样会遇到"这份笔记怎么突然变短了";
    // 也拿得到 recall_viewer:并档前按名字查有没有,免得另立一份
    expect(dream.tools().map((t) => t.name).sort())
      .toEqual([
        'append_file', 'delete_file', 'edit_file', 'git_log', 'git_show', 'glob_files', 'grep_files',
        'list_files', 'read_file', 'recall_viewer', 'save_blob', 'write_file',
      ]);
  });

  it('交回空尾并落盘、投递两段笔记:仅最近段保留台词与真实回执,梦仍读取原快照', async () => {
    const split = Date.now();
    p.onBatchEnd();
    const early = new Date(split - 60000).toISOString();
    const recent = new Date(split + 60000).toISOString();
    const act = (id: string, script: string, ts: string): ChatMessage => ({
      role: 'assistant',
      content: '',
      ts,
      tool_calls: [{ id, type: 'function', function: { name: 'vtuber_act', arguments: JSON.stringify({ script }) } }],
    });
    const snapshot: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '很久以前:观众老王说他养了三只猫', ts: early },
      act('a0', '老王你那三只猫还好吗', early),
      { role: 'tool', content: '已开演(流式)。', tool_call_id: 'a0' },
      { role: 'user', content: '事件帧', ts: recent },
      act('a1', '第二句', recent),
      { role: 'tool', content: '已开演(流式)。', tool_call_id: 'a1' },
      act('a2', '第三句', recent),
      { role: 'tool', content: '[未播出] 合成失败。', tool_call_id: 'a2' },
    ];
    const before = structuredClone(snapshot);
    const r = await p.onHandoff(records(snapshot), HANDOFF_CTX);
    expect(r.tail).toEqual([]);
    // 笔记落在 handoffs/<UTC 时间戳>.md,同一份正文以外部事件投递
    const files = readdirSync(join(dir, HANDOFF_DIR));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.md$/);
    const text = readFileSync(join(dir, HANDOFF_DIR, files[0]), 'utf8');
    expect(externals).toHaveLength(2);
    expect(externals.map((part) => part.kind)).toEqual(['handoff-note', 'handoff-note']);
    expect(externals.map((part) => part.text).join('\n')).toBe(text);
    expect(externals[0].text).toContain('更早的一段');
    expect(externals[0].text).not.toContain('[历史工具请求] vtuber_act');
    expect(externals[1].text).toContain('最近的一段');
    expect(text).toContain('三只猫');
    expect(text).toContain('事件帧');
    expect(text).not.toContain('三只猫还好吗');
    expect(text).toContain('[历史工具请求] vtuber_act {"script":"第二句"}\n[历史回执] 已开演(流式)。');
    expect(text).toContain('[历史工具请求] vtuber_act {"script":"第三句"}\n[历史回执] [未播出] 合成失败。');
    expect(snapshot).toEqual(before);
    // 醒来说明指向同一份文件,交代最近段的内容与继续行动的方式。
    const wake = injected.find((i) => i.kind === 'handoff')!.text;
    expect(wake).toContain(`${HANDOFF_DIR}${files[0]}`);

    await sleep(0);
    expect(forks).toHaveLength(1);
    expect(forks[0].id).toBe('dream');
    const user = forks[0].messages.find((m) => m.role === 'user')!;
    expect(user.content).toContain('三只猫');
    // 梦仍能核对早段的拟发内容和实际回执。
    expect(user.content).toContain('老王你那三只猫还好吗');
    const sys = forks[0].messages.find((m) => m.role === 'system')!;
    expect(sys.content).toContain('viewers/');
    expect(sys.content).toContain(RECENT_FILE);
    expect(forks[0].messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('梦在截断的历史之外收到 World 的短证据；无事实的 World 不增加内容', async () => {
    const fact = '服务端回执 2026-10-03T14:38:43+08:00：章节 15/15 已完成';
    const worlds: World[] = [{
      id: 'adventure',
      envPromptVars: () => ({}),
      verifiedFacts: () => fact,
      tools: () => [],
      start: async () => {},
      stop: async () => {},
    }, {
      id: 'ordinary',
      envPromptVars: () => ({}),
      tools: () => [],
      start: async () => {},
      stop: async () => {},
    }];
    p = new CortiV({ memoryDir: dir, context: NOTE_CONTEXT, worlds });
    p.attach(makeFakeHarnessApi({
      injectInternal: (text, kind) => injected.push({ text, kind }),
      injectExternal: (text, kind) => externals.push({ text, kind }),
      sessionInfo: sessionInfoOf(900),
      spawnFork: async (opts) => { forks.push(opts); return '(nothing)'; },
    }));
    const snapshot = records(Array.from({ length: 80 }, (_, i) => ({
      role: 'user' as const, content: `旧记录 ${i} ${'甲'.repeat(1200)}`,
    })));
    await p.onHandoff(snapshot, HANDOFF_CTX);
    await sleep(0);

    expect(forks).toHaveLength(1);
    expect(forks[0].messages).toHaveLength(3);
    expect(forks[0].messages[1].content).toContain('旧记录 0');
    expect(forks[0].messages[1].content).toContain('旧记录 79');
    expect(forks[0].messages[1].content).toContain('未展开');
    const latest = forks[0].messages[2].content;
    expect(latest).toContain('[adventure]');
    expect(latest).toContain(fact);
    expect(latest).toContain('读取于');
    expect(latest).not.toContain('ordinary');
  });

  it('记忆整理接收交接历史之后的现场缓存与结果，读取不把原始采样时间改为当前时间', async () => {
    const sampledAt = '2026-10-03T14:38:43+08:00';
    const current = `采样 ${sampledAt}：背包小麦×0；个人重生点尚未核实。`;
    const fact = '服务端回执：收粮委托已完成，小麦×16已扣除。';
    const worlds: World[] = [{ id: 'adventure', envPromptVars: () => ({}), tools: () => [],
      start: async () => {}, stop: async () => {},
      requestFacts: () => ({ text: current, snapshotTypes: ['adventure.snapshot'] }),
      verifiedFacts: () => fact }];
    p = new CortiV({ memoryDir: dir, context: NOTE_CONTEXT, worlds });
    p.attach(makeFakeHarnessApi({ injectInternal: (text, kind) => injected.push({ text, kind }),
      injectExternal: (text, kind) => externals.push({ text, kind }), sessionInfo: sessionInfoOf(900),
      spawnFork: async (opts) => { forks.push(opts); return '(nothing)'; } }));
    await p.onHandoff(records([{ role: 'user', content: '旧观察：小麦×16，尚未交付委托。' }]), HANDOFF_CTX);
    await sleep(0);
    expect(forks).toHaveLength(1);
    const latest = forks[0].messages[2].content as string;
    expect(latest).toContain(current);
    expect(latest).toContain(fact);
    expect(latest).toContain('原始采样时刻');
    expect(forks[0].messages[1].content).toContain('旧观察');
    expect(latest).not.toContain('旧观察');
  });

  it('一种 World 事实来源失败仍保留另一种来源，不用旧历史代替读取失败', async () => {
    const worlds: World[] = [{ id: 'current-only', envPromptVars: () => ({}), tools: () => [],
      start: async () => {}, stop: async () => {},
      requestFacts: () => ({ text: '现场缓存：位置已经改变。', snapshotTypes: ['current-only.snapshot'] }),
      verifiedFacts: () => { throw new Error('durable evidence unavailable'); } },
    { id: 'durable-only', envPromptVars: () => ({}), tools: () => [],
      start: async () => {}, stop: async () => {},
      requestFacts: () => { throw new Error('current cache unavailable'); },
      verifiedFacts: () => '服务端已核实完成。' }];
    p = new CortiV({ memoryDir: dir, context: NOTE_CONTEXT, worlds });
    p.attach(makeFakeHarnessApi({ injectInternal: (text, kind) => injected.push({ text, kind }),
      injectExternal: (text, kind) => externals.push({ text, kind }), sessionInfo: sessionInfoOf(900),
      spawnFork: async (opts) => { forks.push(opts); return '(nothing)'; } }));
    await p.onHandoff(records([{ role: 'user', content: '旧观察：尚未完成。' }]), HANDOFF_CTX);
    await sleep(0);
    const latest = forks[0].messages[2].content as string;
    expect(latest).toContain('[current-only] 已有现场事实');
    expect(latest).toContain('位置已经改变');
    expect(latest).toContain('[durable-only] 已核实结果');
    expect(latest).toContain('服务端已核实完成');
    expect(latest).not.toContain('尚未完成');
  });

  it('无软阈值连续交接仅投递本窗最近段,上一份 note 不套娃且新台词不逐轮缩短', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let previous: Array<{ text: string; kind?: string }> = [];
      for (let round = 1; round <= 3; round++) {
        vi.setSystemTime(new Date(`2026-09-04T06:0${round}:00Z`));
        const script = `第${round}窗的完整话题。`.repeat(40);
        const snapshot: ChatMessage[] = [
          ...previous.map((part, i): ChatMessage => ({
            role: 'user', content: part.text,
            frame: { events: [{
              cursor: i + 1, ts: new Date().toISOString(), source: 'persona', type: 'handoff-note',
              start: 0, chars: part.text.length,
            }] },
          })),
          { role: 'user', content: `第${round}窗当前事件` },
          {
            role: 'assistant', content: '',
            tool_calls: [{ id: `s${round}`, type: 'function', function: { name: 'vtuber_act', arguments: JSON.stringify({ script }) } }],
          },
          { role: 'tool', tool_call_id: `s${round}`, content: `第${round}窗已受理,尚未播放` },
        ];
        expect((await p.onHandoff(records(snapshot), HANDOFF_CTX)).tail).toEqual([]);
        previous = externals.splice(0);
        expect(previous).toHaveLength(1);
        const text = previous[0].text;
        expect(text).toContain(JSON.stringify({ script }));
        expect(text).toContain(`[历史回执] 第${round}窗已受理,尚未播放`);
        expect(text).toContain(`第${round}窗当前事件`);
        if (round > 1) expect(text).not.toContain(`第${round - 1}窗`);
        expect(text.match(/# 交接笔记 ·/g)).toHaveLength(1);
        const file = `${HANDOFF_DIR}2026-09-04T06-0${round}-00Z.md`;
        expect(readFileSync(join(dir, file), 'utf8')).toBe(text);
        expect(injected.filter((i) => i.kind === 'handoff').at(-1)!.text).toContain(file);
        await sleep(0);
      }
      expect(readdirSync(join(dir, HANDOFF_DIR))).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('梦写了交接笔记就推回主 session;没写就不推', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // 没写:只有 (nothing),不打扰
    await p.onHandoff(records([{ role: 'user', content: 'x' }]), HANDOFF_CTX);
    await vi.advanceTimersByTimeAsync(0);
    expect(injected.filter((i) => i.text.includes('最近在说的事'))).toHaveLength(0);

    // 写了:整份原样送到她面前
    forkResult = async (opts) => {
      await opts.tools!.find(tool => tool.name === 'write_file')!.handler(
        { path: RECENT_FILE, content: '还差两只羊做床,云那个梗还挂着。' }, { role: 'dream', log: nullLogger() });
      return '(nothing)';
    };
    await p.onHandoff(records([{ role: 'user', content: 'y' }]), HANDOFF_CTX);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(injected.filter(i => i.text.includes('最近在说的事'))).toHaveLength(1));
    const notes = injected.filter((i) => i.text.includes('最近在说的事'));
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe('dream');
    expect(notes[0].text).toContain('还差两只羊做床');
  });

  it('超长结构化短笺保留现场、未完目标与清单后的完结证据', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const recent = [
      '# 最近在说的事',
      '我在河边等队友回信，准备继续钓鱼。',
      '## 位置与状态',
      ...Array.from({ length: 45 }, (_, i) => `- 背包格${i}: 备用材料和装备明细${'甲'.repeat(18)}`),
      '## 还在跟的事',
      '- 约好的钓鱼还差两竿，等队友回信后再决定路线。',
      '## 未完成事项',
      '- 任务甲也被旧计划列作未完成，仍需按回执对账。',
      '## 已完结',
      '- 任务甲已有服务端完成回执；后来一次失败不撤销这条回执。',
    ].join('\n');
    expect(recent.indexOf('## 已完结')).toBeGreaterThan(900);
    forkResult = async (opts) => {
      await opts.tools!.find(tool => tool.name === 'write_file')!.handler(
        { path: RECENT_FILE, content: recent }, { role: 'dream', log: nullLogger() });
      return '(nothing)';
    };

    await p.onHandoff(records([{ role: 'user', content: '本场记录' }]), HANDOFF_CTX);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(injected.filter(i => i.kind === 'dream' && i.text.includes('最近在说的事'))).toHaveLength(1));
    const notes = injected.filter((i) => i.kind === 'dream' && i.text.includes('最近在说的事'));
    expect(notes).toHaveLength(1);
    const excerpt = notes[0].text.split('】\n').slice(1).join('】\n');
    expect(excerpt.length).toBeLessThanOrEqual(900);
    expect(excerpt).toContain('我在河边等队友回信');
    expect(excerpt).toContain('还差两竿');
    expect(excerpt).toContain('旧计划列作未完成');
    expect(excerpt).toContain('服务端完成回执');
    expect(excerpt).toContain('若有冲突');
    expect(readFileSync(join(dir, RECENT_FILE), 'utf8')).toBe(recent);
  });

  it('无可识别标题的超长短笺保留首尾原文', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const recent = `开头现场：我在等雨停。\n${'途中的琐事。'.repeat(220)}\n末尾确认：约定的灯已经点亮。`;
    forkResult = async (opts) => {
      await opts.tools!.find(tool => tool.name === 'write_file')!.handler(
        { path: RECENT_FILE, content: recent }, { role: 'dream', log: nullLogger() });
      return '(nothing)';
    };

    await p.onHandoff(records([{ role: 'user', content: '本场记录' }]), HANDOFF_CTX);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(injected.filter(i => i.kind === 'dream' && i.text.includes('最近在说的事'))).toHaveLength(1));
    const notes = injected.filter((i) => i.kind === 'dream' && i.text.includes('最近在说的事'));
    expect(notes).toHaveLength(1);
    const excerpt = notes[0].text.split('】\n').slice(1).join('】\n');
    expect(excerpt.length).toBeLessThanOrEqual(900);
    expect(excerpt).toContain('开头现场');
    expect(excerpt).toContain('末尾确认');
    expect(excerpt).toContain('灯已经点亮');
  });

  it('上一场留下的旧交接笔记不冒充这一场的', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    writeFileSync(join(dir, RECENT_FILE), '上一场的旧笔记', 'utf8');
    await p.onHandoff(records([{ role: 'user', content: 'x' }]), HANDOFF_CTX);
    await vi.advanceTimersByTimeAsync(0);
    expect(injected.filter((i) => i.text.includes('最近在说的事'))).toHaveLength(0);
  });

  it('梦浮现 (nothing) 不打扰;非空浮现注入 [memory] 行', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await p.onHandoff(records([{ role: 'user', content: 'x' }]), HANDOFF_CTX);
    await vi.advanceTimersByTimeAsync(0);
    expect(injected.filter((i) => i.kind === 'dream')).toHaveLength(0);

    forkResult = async () => '老王托我明天提醒他交房租,这事在旧会话开头。';
    await p.onHandoff(records([{ role: 'user', content: 'y' }]), HANDOFF_CTX);
    await vi.advanceTimersByTimeAsync(0);
    const dreams = injected.filter((i) => i.kind === 'dream');
    expect(dreams).toHaveLength(1);
    expect(dreams[0].text).toContain('老王托我明天提醒他交房租');
  });

  it('单实例排队:上一场梦没结束,下一场快照排队等', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release!: (v: string) => void;
    forkResult = () => new Promise<string>((res) => (release = res));
    await p.onHandoff(records([{ role: 'user', content: '第一场' }]), HANDOFF_CTX);
    await vi.advanceTimersByTimeAsync(0);
    expect(forks).toHaveLength(1);

    forkResult = async () => '(nothing)';
    await p.onHandoff(records([{ role: 'user', content: '第二场' }]), HANDOFF_CTX);
    await vi.advanceTimersByTimeAsync(0);
    expect(forks).toHaveLength(1); // 第二场在排队

    release('(nothing)');
    await vi.advanceTimersByTimeAsync(0);
    expect(forks).toHaveLength(2);
    expect(forks[1].messages.find((m) => m.role === 'user')!.content).toContain('第二场');
  });

  it('晚到的摘要保留旧观察时间，事件帧时间可用且前缀时间不冒充现场', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T00:30:00Z'));
    let release!: (value: string) => void;
    forkResult = () => new Promise<string>((resolve) => { release = resolve; });
    const snapshot = records([
      { role: 'system', content: '常驻前缀', ts: '2026-10-04T02:00:00Z', head: true },
      { role: 'user', content: '任务正在执行', ts: '2026-10-04T00:29:50Z', frame: { events: [{
        cursor: 10, ts: '2026-10-04T00:29:57Z', source: 'ordinary', type: 'ordinary.task', start: 0, chars: 7,
      }] } },
    ]);
    await p.onHandoff(snapshot, HANDOFF_CTX);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(new Date('2026-10-04T00:31:00Z'));
    p.onDelivery({ events: [ev({ source: 'ordinary', type: 'ordinary.task', ts: new Date().toISOString(), text: '任务已完成' })] });
    await forks[0].tools!.find(tool => tool.name === 'write_file')!.handler(
      { path: RECENT_FILE, content: '任务还在执行，等它结束。' }, { role: 'dream', log: nullLogger() });
    release('我还在等任务结束。');
    await vi.advanceTimersByTimeAsync(0);

    const notes = injected.filter((item) => item.kind === 'dream');
    expect(notes).toHaveLength(2);
    for (const note of notes) {
      expect(note.text).toContain('旧会话观察截止 2026-10-04T00:29:57Z');
      expect(note.text).toContain('交接排队于 2026-10-04T00:30:00.000Z');
      expect(note.text).toContain('较新的实际回执');
      expect(note.text).not.toContain('观察截止 2026-10-04T00:31:00');
      expect(note.text).not.toContain('2026-10-04T02:00:00');
    }
    expect(notes.find(note => note.text.includes('最近在说的事'))!.text)
      .toContain('整理写入于 2026-10-04T00:31:00.000Z');
    expect(forks[0].messages.find((item) => item.role === 'user')!.content).toContain('旧会话观察截止 2026-10-04T00:29:57Z');
    expect(readFileSync(join(dir, RECENT_FILE), 'utf8')).toBe('任务还在执行，等它结束。');
  });

  it('串行排队保留入队时间，无时间戳的记录明确不提供观察时间', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T00:30:00Z'));
    let release!: (value: string) => void;
    forkResult = () => new Promise<string>((resolve) => { release = resolve; });
    await p.onHandoff(records([{ role: 'user', content: '第一段' }]), HANDOFF_CTX);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(new Date('2026-10-04T00:31:00Z'));
    forkResult = async () => '第二段的结论';
    await p.onHandoff(records([{ role: 'user', content: '第二段' }]), HANDOFF_CTX);
    vi.setSystemTime(new Date('2026-10-04T00:40:00Z'));
    release('(nothing)');
    await vi.advanceTimersByTimeAsync(0);

    const note = injected.find((item) => item.kind === 'dream')!.text;
    expect(note).toContain('旧会话观察截止 未记录时间');
    expect(note).toContain('交接排队于 2026-10-04T00:31:00.000Z');
    expect(note).not.toContain('2026-10-04T00:40:00');
  });

  it('空 session(只有 system)不入梦', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await p.onHandoff(records([{ role: 'system', content: 'sys' }]), HANDOFF_CTX);
    await vi.advanceTimersByTimeAsync(0);
    expect(forks).toHaveLength(0);
  });
});


describe('CortiV 梦整理失败重试', () => {
  let dir: string;
  let p: CortiV;
  let forks: ForkOptions[];
  let warns: string[];
  let injected: Array<{ text: string; kind?: string }>;
  let outcomes: Array<'abort' | 'fatal' | 'ok'>;
  const handoffNote = (): string =>
    injected.filter((i) => i.kind === 'handoff').at(-1)!.text;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cormini-dream-retry-'));
    forks = [];
    warns = [];
    injected = [];
    outcomes = [];
    p = new CortiV({ memoryDir: dir });
    const log = nullLogger();
    p.attach(
      makeFakeHarnessApi({
        injectInternal: (text, kind) => injected.push({ text, kind }),
        toolsTagged: (tag) => new Set(tag === 'speak' ? ['vtuber_act'] : []),
        log: { ...log, child: () => log, warn: (msg: string) => { warns.push(msg); } } as typeof log,
        spawnFork: async (opts) => {
          forks.push(opts);
          const outcome = outcomes.shift() ?? 'ok';
          if (outcome === 'abort') {
            const error = new GenerationError('流被掐断', [], null, { instance: 'test', module: 'test', model: 'm', compatibilityDomain: 'test' });
            throw error;
          }
          if (outcome === 'fatal') throw new Error('工作区写坏了');
          return '(nothing)';
        },
      }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('断流这类可重试错误退避一次再跑,成功后不留"没整理"的痕', async () => {
    vi.useFakeTimers();
    outcomes = ['abort'];
    await p.onHandoff(records([{ role: 'user', content: '第一场' }]), HANDOFF_CTX);
    await vi.advanceTimersByTimeAsync(0);
    expect(forks).toHaveLength(1);
    expect(warns.some((m) => m.includes('30 秒后重试一次'))).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(forks).toHaveLength(2);
    expect(forks[1].messages.find((item) => item.role === 'user')!.content)
      .toBe(forks[0].messages.find((item) => item.role === 'user')!.content);

    // 重试成功 ⇒ 下一次交接的告知里不该出现"没整理"
    await p.onHandoff(records([{ role: 'user', content: '第二场' }]), HANDOFF_CTX);
    const note = handoffNote();
    expect(note).not.toContain('没跑成');
    vi.useRealTimers();
  });

  it('重试仍失败:下一次交接的告知里说清上一段没有短笺', async () => {
    vi.useFakeTimers();
    outcomes = ['abort', 'abort'];
    await p.onHandoff(records([{ role: 'user', content: '第一场' }]), HANDOFF_CTX);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(forks).toHaveLength(2);
    expect(warns.some((m) => m.includes('重试仍失败'))).toBe(true);

    await p.onHandoff(records([{ role: 'user', content: '第二场' }]), HANDOFF_CTX);
    const note = handoffNote();
    expect(note).toContain('没跑成');
    expect(note).toContain('没有短笺');
    vi.useRealTimers();
  });

  it('不可重试的错误不白等 30 秒,只跑一次', async () => {
    vi.useFakeTimers();
    outcomes = ['fatal'];
    await p.onHandoff(records([{ role: 'user', content: '第一场' }]), HANDOFF_CTX);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(forks).toHaveLength(1);
    expect(warns.some((m) => m.includes('不可重试'))).toBe(true);
    vi.useRealTimers();
  });
});

describe('renderDreamTranscript', () => {
  it('超预算仍保留早期线索和近期失败、改法、成功回执，按时间顺序标出缺口', () => {
    const snapshot: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '早期线索：田里有一株成熟小麦。' },
      ...Array.from({ length: 8 }, (_, i): ChatMessage => ({ role: 'user', content: `中段-${i}:${'经过'.repeat(90)}` })),
      { role: 'assistant', content: '', tool_calls: [
        { id: 'failed', type: 'function', function: { name: 'mymc_do', arguments: '{"skill":"use","at":[1,2,3]}' } },
      ] },
      { role: 'tool', tool_call_id: 'failed', content: '右键已执行，但背包小麦未增加。' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'revised', type: 'function', function: { name: 'mymc_do', arguments: '{"skill":"collect","block":"wheat"}' } },
      ] },
      { role: 'tool', tool_call_id: 'revised', content: '收获成功，背包小麦增加 1。' },
    ];
    const out = renderDreamTranscript(records(snapshot), 500);
    expect(out).toContain('早期线索');
    expect(out).not.toContain('中段-0');
    expect(out).toContain('背包小麦未增加');
    expect(out).toContain('"skill":"collect"');
    expect(out).toContain('背包小麦增加 1');
    expect(out.indexOf('背包小麦未增加')).toBeLessThan(out.indexOf('"skill":"collect"'));
    expect(out.indexOf('"skill":"collect"')).toBeLessThan(out.indexOf('背包小麦增加 1'));
    expect(out).toContain('未展开');
    expect(out.length).toBeLessThanOrEqual(500);
    expect(renderDreamTranscript(records(snapshot), 12).length).toBeLessThanOrEqual(12);
  });

  it('跳过上一份交接笔记的事件正文，保留同一帧的近期事件', () => {
    const oldNote = '# 交接笔记 · 最近的一段\n旧目标待办';
    const current = '新的服务端回执：目标已经完成';
    const snapshot: ChatMessage[] = [{
      role: 'user', content: `${oldNote}\n${current}`,
      frame: { events: [
        { cursor: 1, ts: '2026-10-03T10:00:00+08:00', type: HANDOFF_NOTE_TYPE,
          source: 'persona', start: 0, chars: oldNote.length },
        { cursor: 2, ts: '2026-10-03T10:01:00+08:00', type: 'mymc.task',
          source: 'mymc', start: oldNote.length + 1, chars: current.length },
      ] },
    }];
    const out = renderDreamTranscript(records(snapshot));
    expect(out).not.toContain('旧目标待办');
    expect(out).toContain(current);
  });

  it('工具调用与回执被截短且带名字;system 不出现', () => {
    const snapshot: ChatMessage[] = [
      { role: 'system', content: 'SECRET-PREFIX' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'dig', arguments: `{"x":${'9'.repeat(500)}}` } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'R'.repeat(2000) },
    ];
    const out = renderDreamTranscript(records(snapshot), 10_000);
    expect(out).toContain('[历史原生工具请求 dig]');
    expect(out).not.toContain('SECRET-PREFIX');
    expect(out.length).toBeLessThan(1500);
  });
});

/**
 * 凡特主档常驻前缀(PARTNER 段):一对一合播的关系记忆住 workspace/PHANT.md,
 * 整份进前缀;文件是工作区的一员(她与梦都会改、「清除所有数据」会删),
 * 所以现读且缺失容错——段空掉,不炸、不漏 {{persona.partner}} 字面。
 */
describe('CortiV 凡特主档常驻前缀', () => {
  let dir: string;
  let p: CortiV;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cormini-partner-'));
    p = new CortiV({ memoryDir: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const segs = () => p.systemSegments({ now: new Date(), timezone: 'Asia/Shanghai', worlds: [] });

  it('PHANT.md 整份进 PARTNER 段;现读,改文件后重拼即生效', async () => {
    writeFileSync(join(dir, 'PHANT.md'), '=== 凡特 Phant ===\n\n后台的人,我的搭档。\n', 'utf8');
    const first = await segs();
    expect(first.find((s) => s.title === 'PARTNER')?.text).toContain('后台的人,我的搭档');
    expect(first.at(-1)?.title).toBe('PARTNER');
    const stableHead = first.slice(0, -1).map((s) => s.text).join('');
    writeFileSync(join(dir, 'PHANT.md'), '=== 凡特 Phant ===\n\n改过的主档。\n', 'utf8');
    const second = await segs();
    expect(second.slice(0, -1).map((s) => s.text).join('')).toBe(stableHead);
    expect(second.find((s) => s.title === 'PARTNER')?.text).toContain('改过的主档');
    expect(second.find((s) => s.title === 'PARTNER')?.text).not.toContain('我的搭档');
  });

  it('文件不存在(如工作区被清空):段为空,不炸也不漏占位符字面', async () => {
    const all = await segs();
    const partner = all.find((s) => s.title === 'PARTNER')!;
    expect(partner.text.trim()).toBe('');
    expect(all.map((s) => s.text).join('')).not.toContain('{{persona.partner}}');
  });
});
