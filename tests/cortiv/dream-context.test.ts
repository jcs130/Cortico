import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DreamContext, DREAM_DEFAULTS, dreamHistoryWithinBudget, normalizeDreamConfig, renderDreamHistory, type DreamConfig } from '../../bots/cortiv/persona/dream-context.ts';
import definition, { CORTIV_DREAM_CONFIG_GROUP, CORTIV_PLANNING_CONFIG_GROUP } from '../../bots/cortiv/index.ts';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { functionCall, functionResult, message, type ContextRecord } from '../../src/protocol/open-responses/context.ts';
import { textOf } from '../../src/protocol/open-responses/context-helpers.ts';
import { validateRequestContext } from '../../src/core/request-context.ts';
import { estimateMessagesTokens, estimateTokens, nullLogger } from '../../src/core/util.ts';
import type { ToolDef, ToolOutcome } from '../../src/core/types.ts';
import { makeFakeHarnessApi, sleep } from '../core/helpers.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string { const dir = mkdtempSync(join(tmpdir(), 'dream-context-')); dirs.push(dir); return dir; }
function readTool(handler: ToolDef['handler'] = async () => '旧笔记'.repeat(10_000)): ToolDef {
  return { name: 'read_file', description: 'Read notes.', tags: ['read'],
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, handler };
}
function rig(patch: Partial<DreamConfig> = {}, tool = readTool()) {
  const file = join(temp(), 'archive.jsonl');
  const config = { ...DREAM_DEFAULTS, ...patch };
  const reading = new DreamContext(config, [tool], { file: 'sessions/archive/reading.jsonl',
    append: text => writeFileSync(file, text, { flag: 'a', encoding: 'utf8' }) }, nullLogger());
  const rows = () => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as ContextRecord);
  return { reading, rows, config };
}
function outcome(result: string | ToolOutcome): string { return typeof result === 'string' ? result : result.text; }
const ctx = { role: 'dream', log: nullLogger(), callId: 'read_1' };

describe('dream request reading budget', () => {
  it('defaults disable both fallbacks and leave model selection with the provider', () => {
    expect(definition.defaults().dream).toEqual(DREAM_DEFAULTS);
    expect(CORTIV_DREAM_CONFIG_GROUP.owner).toBe('persona');
    expect(CORTIV_DREAM_CONFIG_GROUP.schema.properties).not.toHaveProperty('dream.model');
    expect(CORTIV_PLANNING_CONFIG_GROUP.schema.properties['planning.yieldToForeground']['x-hot']).toBe(true);
    const original = readTool();
    expect(rig({}, original).reading.tools[0]).toBe(original);
  });

  it('archives native items completely and appends each unchanged observation once', () => {
    const r = rig();
    const records = [message('user', '原始消息'.repeat(20_000)), functionCall('one', 'read_file', '{"path":"notes.md"}'), functionResult('one', '原始回执')];
    expect(r.reading.remember(records)).toEqual([1, 2, 3]);
    expect(r.reading.remember(structuredClone(records))).toEqual([1, 2, 3]);
    expect(r.rows()).toEqual(records);
  });

  it('uses the actual available prompt budget for initial history', () => {
    const r = rig({ maxContextTokens: 8000 });
    const fixed = [message('system', '固定人格'.repeat(100)), message('user', '观察依据')];
    const schemas = r.reading.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
    expect(r.reading.materialBudget(fixed)).toBe(r.config.maxContextTokens - estimateTokens(JSON.stringify(schemas)) - estimateMessagesTokens(fixed));
  });

  it('renders multiple static heads and large native metadata only in the complete source, with precise evidence rows', () => {
    const sourceFile = 'sessions/archive/source-native.jsonl';
    const snapshot = [message('system', '系统前缀'.repeat(1000)), message('developer', '另一个前缀'.repeat(1000)),
      message('user', '静态Memory前缀'.repeat(1000), { head: true }), message('assistant', '合成首轮示范', { head: true }),
      message('user', '玩家说门打不开', { ts: '2026-08-15T20:00:00Z' }),
      functionCall('native_call', 'use', '{"target":"door"}', { responseId: 'native_response_metadata'.repeat(1000) }),
      functionResult('native_call', '实际回执：距离太远，未打开门'),
      message('assistant', '可能需要靠近，并未再次执行', { responseId: 'second_native_metadata'.repeat(1000) })];
    const history = renderDreamHistory(snapshot, sourceFile);
    expect(history.text).not.toContain('系统前缀'); expect(history.text).not.toContain('静态Memory前缀');
    expect(history.text).not.toContain('合成首轮示范'); expect(history.text).not.toContain('native_response_metadata');
    expect(history.text).not.toContain('second_native_metadata');
    expect(history.text).toContain(`原始证据 ${sourceFile} 第 5 行`);
    expect(history.text).toContain('历史原生工具请求 use；执行结果看实际回执');
    expect(history.text).toContain('历史工具实际回执 use；对应原始第 6 行请求');
    expect(history.text).toContain('距离太远，未打开门');
    expect(history.text).toContain('历史助手正文；不表示工具已执行');
    const file = join(temp(), 'source.jsonl');
    writeFileSync(file, snapshot.map(record => JSON.stringify(record)).join('\n') + '\n');
    expect(readFileSync(file, 'utf8').trim().split('\n').map(row => JSON.parse(row))).toEqual(snapshot);
  });

  it('initial history selects recent complete requests and actual receipts before older large observations', () => {
    const snapshot = [message('user', '较早观察'.repeat(5000)),
      functionCall('done', 'store', '{"count":3}'), functionResult('done', '实际回执：3个铁锭已经存入箱子')];
    const history = renderDreamHistory(snapshot, 'source.jsonl');
    const initial = dreamHistoryWithinBudget(history, 300);
    expect(initial).toContain('较早正文未展开'); expect(initial).not.toContain('较早观察');
    expect(initial).toContain('历史原生工具请求 store'); expect(initial).toContain('实际回执：3个铁锭已经存入箱子');
    expect(estimateTokens(initial)).toBeLessThanOrEqual(300);
  });

  it('archives the original read result before the Core receipt cap when only the request budget is enabled', async () => {
    const full = '完整读取'.repeat(12_000);
    const r = rig({ maxContextTokens: 2000 }, readTool(async () => full));
    expect(await r.reading.tools[0].handler({ path: 'notes.md' }, ctx)).toBe(full);
    expect(textOf(r.rows()[0])).toBe(full);
    expect(r.reading.tools[0].parameters.properties).not.toHaveProperty('readCursor');
  });

  it('bounds two large reads in one round and retains the captured original in the archive', async () => {
    let calls = 0;
    const full = '当时的二万字符档案'.repeat(3000);
    const r = rig({ maxReadTokensPerRound: 1000 }, readTool(async () => { calls++; return full; }));
    r.reading.prepareRequest({ round: 1, messages: [message('user', '整理')] });
    const first = outcome(await r.reading.tools[0].handler({ path: 'world.md' }, ctx));
    const blocked = outcome(await r.reading.tools[0].handler({ path: 'viewer.md' }, ctx));
    expect(estimateTokens(first)).toBeLessThanOrEqual(r.config.maxReadTokensPerRound);
    expect(first).toContain('readCursor=');
    expect(blocked).toContain('本轮阅读预算已用尽');
    expect(calls).toBe(1);
    expect(r.rows().some(row => textOf(row) === full)).toBe(true);
    r.reading.prepareRequest({ round: 2, messages: [message('user', '整理')] });
    await r.reading.tools[0].handler({ path: 'viewer.md' }, ctx);
    expect(calls).toBe(2);
  });

  it('uses a readable minimum for positive budgets below the pagination overhead and leaves zero disabled', async () => {
    expect(normalizeDreamConfig({ ...DREAM_DEFAULTS, maxReadTokensPerRound: 0 }).maxReadTokensPerRound).toBe(0);
    for (const budget of [1, 127]) {
      const r = rig({ maxReadTokensPerRound: budget });
      const records = [message('user', '整理')];
      r.reading.prepareRequest({ round: 1, messages: records });
      const result = outcome(await r.reading.tools[0].handler({ path: 'notes.md' }, ctx));
      expect(result).not.toContain('预算已用尽');
      expect(result).toContain('旧笔记');
      expect(result).toContain('readCursor=');
      expect(estimateTokens(result)).toBeLessThanOrEqual(normalizeDreamConfig(r.config).maxReadTokensPerRound);
      r.reading.prepareRequest({ round: 2, messages: records });
      expect(outcome(await r.reading.tools[0].handler({ path: 'notes.md' }, ctx))).toContain('旧笔记');
    }
  });

  it('does not replenish the reading budget when the same generation round is retried', async () => {
    const r = rig({ maxReadTokensPerRound: 1000 });
    const records = [message('user', '整理')];
    r.reading.prepareRequest({ round: 1, messages: records });
    await r.reading.tools[0].handler({ path: 'notes.md' }, ctx);
    r.reading.prepareRequest({ round: 1, messages: structuredClone(records) });
    expect(outcome(await r.reading.tools[0].handler({ path: 'notes.md' }, ctx))).toContain('本轮阅读预算已用尽');
  });

  it('continues the captured result after the live file changes', async () => {
    let calls = 0;
    let text = '甲'.repeat(4000) + '当时的末尾';
    const r = rig({ maxReadTokensPerRound: 1000 }, readTool(async () => { calls++; return text; }));
    r.reading.prepareRequest({ round: 1, messages: [] });
    const first = outcome(await r.reading.tools[0].handler({ path: 'notes.md' }, ctx));
    let cursor = /readCursor=([0-9]+:[0-9]+)/.exec(first)![1];
    text = '现在的新内容';
    const pieces = [first.split('\n[阅读节选')[0]];
    for (let round = 2; round <= 8; round++) {
      r.reading.prepareRequest({ round, messages: [] });
      const page = outcome(await r.reading.tools[0].handler({ path: 'notes.md', readCursor: cursor }, ctx));
      pieces.push(page.split('\n[阅读节选')[0]);
      const next = /readCursor=([0-9]+:[0-9]+)/.exec(page);
      if (!next) break;
      cursor = next[1];
    }
    expect(pieces.join('')).toBe('甲'.repeat(4000) + '当时的末尾');
    expect(calls).toBe(1);
  });

  it('rejects an unknown cursor and a cursor for another set of arguments', async () => {
    const r = rig({ maxReadTokensPerRound: 1000 });
    r.reading.prepareRequest({ round: 1, messages: [] });
    expect(outcome(await r.reading.tools[0].handler({ path: 'notes.md', readCursor: '99:0' }, ctx))).toContain('无效阅读游标');
    const first = outcome(await r.reading.tools[0].handler({ path: 'notes.md' }, ctx));
    r.reading.prepareRequest({ round: 2, messages: [] });
    const cursor = /readCursor=([0-9]+:[0-9]+)/.exec(first)![1];
    expect(outcome(await r.reading.tools[0].handler({ path: 'other.md', readCursor: cursor }, ctx))).toContain('无效阅读游标');
  });

  it('retains reference attachments when paginating a read result', async () => {
    const blobs = [{ handle: 'mem:blobs/source.png', fallbackText: '原图' }];
    const r = rig({ maxReadTokensPerRound: 1000 }, readTool(async () => ({ text: '甲'.repeat(4000), blobs })));
    const result = await r.reading.tools[0].handler({ path: 'notes.md' }, ctx);
    expect(result).toMatchObject({ blobs });
    expect(JSON.parse(textOf(r.rows()[0]))).toEqual({ text: '甲'.repeat(4000), blobs });
  });

  it('excerpts old read receipts and preserves the whole latest multi-call batch and all write arguments', () => {
    const r = rig({ maxContextTokens: 1700 });
    const old = functionResult('old', '旧的很长阅读结果'.repeat(2000));
    const latest = { responseId: 'response_now' };
    const records = [message('system', '人格'), message('user', '观察'),
      functionCall('old', 'read_file', '{"path":"old.md"}', { responseId: 'response_old' }), old,
      functionCall('write', 'write_file', '{"path":"recent.md","content":"已经写入"}', { responseId: 'response_old_write' }), functionResult('write', '[written] recent.md'),
      message('assistant', '最新决定', latest), functionCall('a', 'read_file', '{"path":"a.md"}', latest), functionCall('b', 'read_file', '{"path":"b.md"}', latest),
      functionResult('a', '最新读取甲'.repeat(300)), functionResult('b', '最新读取乙'.repeat(300))];
    const saved = structuredClone(records);
    const projected = r.reading.prepareRequest({ round: 3, messages: records });
    expect(textOf(projected[3])).toContain('完整原文');
    expect(projected.slice(6)).toEqual(records.slice(6));
    expect(projected[4]).toBe(records[4]); expect(projected[5]).toBe(records[5]);
    expect(records).toEqual(saved);
    expect(r.rows()).toEqual(records);
    expect(() => validateRequestContext(projected)).not.toThrow();
    const line = /第 (\d+) 行/.exec(textOf(projected[3]))![1];
    expect(r.rows()[Number(line) - 1]).toEqual(old);
  });

  it('keeps oversized mandatory prefix and new results in full', () => {
    const r = rig({ maxContextTokens: 1024 });
    const records = [message('system', '完整人格'.repeat(2000)), functionCall('latest', 'read_file', '{"path":"a.md"}'), functionResult('latest', '最新的超预算回执'.repeat(2000))];
    expect(r.reading.prepareRequest({ round: 2, messages: records })).toEqual(records);
  });

  it('makes room by excerpting only registered past materials while preserving the latest full native batch and World facts', () => {
    const r = rig({ maxContextTokens: 1900 });
    const history = renderDreamHistory(Array.from({ length: 8 }, (_, index) => message('user', `过去记录${index}：${'甲'.repeat(300)}`)), 'source.jsonl');
    const material = message('user', history.text);
    r.reading.preserveFullMaterial(material, material, budget => dreamHistoryWithinBudget(history, budget));
    const system = message('system', '人格保持原样');
    const facts = message('user', '当前World事实，采样时间已知，未被裁剪。');
    const call = functionCall('new_read', 'read_file', '{"path":"current.md"}', { responseId: 'current_response' });
    const receipt = functionResult('new_read', '当前完整回执'.repeat(150));
    const records = [system, material, facts, call, receipt];
    const projected = r.reading.prepareRequest({ round: 2, messages: records });
    expect(projected[0]).toEqual(system); expect(projected[2]).toEqual(facts);
    expect(projected.slice(3)).toEqual([call, receipt]);
    expect(textOf(projected[1])).toContain('初始过去材料节选');
    const schemas = r.reading.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
    expect(estimateMessagesTokens(projected) + estimateTokens(JSON.stringify(schemas))).toBeLessThanOrEqual(r.config.maxContextTokens);
    const line = /完整当时材料[^\n]* 第 (\d+) 行/.exec(textOf(projected[1]))![1];
    expect(r.rows()[Number(line) - 1]).toEqual(material);
  });

  it('falls back to full request and unpaged reads when archiving fails', async () => {
    const original = '完整档案'.repeat(5000);
    const reading = new DreamContext({ ...DREAM_DEFAULTS, maxContextTokens: 1024, maxReadTokensPerRound: 1000 }, [readTool(async () => original)], {
      file: 'archive.jsonl', append: () => { throw new Error('disk unavailable'); },
    }, nullLogger());
    const records = [message('system', '人格'), functionCall('old', 'read_file', '{}'), functionResult('old', original), message('assistant', '新一轮')];
    expect(reading.prepareRequest({ round: 2, messages: records })).toEqual(records);
    expect(await reading.tools[0].handler({ path: 'notes.md' }, ctx)).toBe(original);
  });

  it('restores initial unabridged materials when a later archive append fails', () => {
    let appends = 0;
    const reading = new DreamContext({ ...DREAM_DEFAULTS, maxContextTokens: 1024 }, [readTool()], {
      file: 'archive.jsonl', append: () => { if (++appends > 1) throw new Error('disk full'); },
    }, nullLogger());
    reading.remember([message('user', '先归档的快照')]);
    const visible = message('user', '首轮阅读节选');
    const full = message('user', '完整未节选材料'.repeat(1000));
    reading.preserveFullMaterial(visible, full);
    const latest = message('assistant', '刚刚生成的决定');
    expect(reading.prepareRequest({ round: 1, messages: [visible, latest] })).toEqual([full, latest]);
  });

  it('builds short dream materials with readable complete source records and routes its optional provider', async () => {
    const dir = temp();
    const config = { ...DREAM_DEFAULTS, provider: 'background', maxContextTokens: 8000,
      maxReadTokensPerRound: 1000, maxOutputTokens: 900, yieldToForeground: true };
    const persona = new CortiV({ memoryDir: dir, dream: () => config });
    const forks: any[] = [];
    persona.attach(makeFakeHarnessApi({ spawnFork: async options => { forks.push(options); return '(nothing)'; } }));
    const source = Array.from({ length: 100 }, (_, index) => message('user', `${index} 原始经历 ${'甲'.repeat(1600)}`));
    await persona.onHandoff(source, { hardTokens: null }); await sleep(0);
    expect(forks).toHaveLength(1);
    const options = forks[0];
    expect(options).toMatchObject({ provider: 'background', generationPriority: 'background', maxOutputTokens: config.maxOutputTokens });
    expect(options.model).toBeUndefined();
    expect(options.prepareRequest).toBeTypeOf('function');
    const material = options.messages.find((entry: any) => entry.role === 'user').content as string;
    const file = /精确原文在 (sessions\/archive\/[^，]+)，/.exec(material)![1];
    const archive = readFileSync(join(dir, file), 'utf8').trim().split('\n').map(row => JSON.parse(row));
    expect(archive).toEqual(source);
    expect(material).toContain('未展开');
    expect(material.length).toBeLessThan(12_000);
    expect(options.messages[0].content).toContain('810 token');
    expect(options.messages[0].content).toContain('写短笺不以读完归档为前提');
    const viewFile = /历史正文备查：(sessions\/archive\/[^。]+)。/.exec(material)![1];
    expect(readFileSync(join(dir, viewFile), 'utf8')).toContain(`原始证据 ${file} 第 100 行`);
    const originalBytes = readFileSync(join(dir, file));
    options.prepareRequest({ round: 1, messages: [message('user', '后台已完成的新输入')] });
    await options.tools.find((tool: ToolDef) => tool.name === 'read_file').handler({ path: viewFile, offset: 1, limit: 1 }, ctx);
    options.prepareRequest({ round: 2, messages: [message('user', '后台继续观察')] });
    expect(readFileSync(join(dir, file))).toEqual(originalBytes);
    const readArchive = file.replace('source-', 'reading-');
    const captured = readFileSync(join(dir, readArchive), 'utf8');
    expect(captured).toContain('后台已完成的新输入'); expect(captured).toContain('后台继续观察');
  });
});
