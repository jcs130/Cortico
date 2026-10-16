/** UsageLog:追加/读取/清空,坏行跳过。 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLog } from '../../src/core/usage-log.ts';
import { aggregateUsage } from '../../src/core/cost.ts';
import type { UsageRecord } from '../../src/core/types.ts';

let dir: string;
let file: string;
const rec = (n: number): UsageRecord => ({
  ts: `2026-07-19T1${n}:00:00+08:00`, sessionId: 'main', role: 'main', label: '主意识',
  model: 'deepseek-v4-flash', promptTokens: 100 * n, completionTokens: 10 * n,
  cacheHitTokens: 90 * n, cacheMissTokens: 10 * n, reasoningTokens: n,
});

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'usagelog-')); file = join(dir, 'usage.jsonl'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('UsageLog', () => {
  it('queries Unicode, damaged and duplicate rows off-thread with the same totals', async () => {
    const records = Array.from({ length: 5000 }, (_, i) => ({ ...rec(1), model: 'model-a', version: 2, recordId: String(i), label: '观察🐾'.repeat(100) }));
    writeFileSync(file, [...records.map(row => JSON.stringify(row)), 'damaged', JSON.stringify(records[0])].join('\n'));
    const log = new UsageLog(file, () => {});
    const options = { bucket: 'hour' as const, timezone: 'Asia/Shanghai', from: '2026-07-19', to: '2026-07-19' };
    const expected = aggregateUsage(log.readAll(), options);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      const [a, b, count] = await Promise.all([log.aggregateAsync(options), log.aggregateAsync(options), log.countAsync()]);
      expect(a).toEqual(expected);
      expect(b).toBe(a);
      expect(count).toBe(records.length);
      expect(ticks).toBeGreaterThan(0);
      expect(log.status().error).toContain('1 damaged ledger lines');
    } finally { clearInterval(timer); }
    log.append({ ...rec(2), model: 'model-a' });
    expect(await log.countAsync()).toBe(records.length + 1);
  });

  it('includes failed pending appends once and reads missing ledgers as empty', async () => {
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'not a directory');
    const log = new UsageLog(join(blocked, 'usage.jsonl'), () => {});
    log.append({ ...rec(1), model: 'model-a' });
    const options = { bucket: 'day' as const };
    expect(await log.aggregateAsync(options)).toEqual(aggregateUsage(log.readAll(), options));
    expect(await log.countAsync()).toBe(1);
    rmSync(blocked);
    log.flush();
    expect(await log.countAsync()).toBe(1);
    expect(await new UsageLog(join(dir, 'missing.jsonl')).countAsync()).toBe(0);
  });

  it('append 后 readAll 拿到全部,顺序保留', () => {
    const log = new UsageLog(file);
    log.append(rec(1)); log.append(rec(2)); log.append(rec(3));
    const all = log.readAll();
    expect(all.length).toBe(3);
    expect(all.map((r) => r.promptTokens)).toEqual([100, 200, 300]);
    expect(log.count()).toBe(3);
  });

  it('文件不存在→空数组', () => {
    expect(new UsageLog(join(dir, 'nope.jsonl')).readAll()).toEqual([]);
  });

  it('reads current records across restart and excludes old rows without rewriting the ledger', () => {
    writeFileSync(file, JSON.stringify(rec(1)) + '\n');
    const log = new UsageLog(file);
    log.append(rec(2));
    const raw = readFileSync(file, 'utf8');
    const errors: string[] = [];
    const restored = new UsageLog(file, error => errors.push(error));
    expect(restored.readAll()).toEqual([expect.objectContaining({ version: 2, promptTokens: 200 })]);
    expect(restored.status().error).toContain('1 damaged ledger lines');
    expect(errors).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe(raw);
  });

  it('坏行跳过,不影响其它行', () => {
    const log = new UsageLog(file);
    log.append(rec(1));
    appendFileSync(file, '这不是json\n', 'utf8');
    log.append(rec(2));
    expect(log.readAll().map((r) => r.promptTokens)).toEqual([100, 200]);
  });

  it('preserves long Unicode rows, deduplication and an unterminated final record', () => {
    const first = { ...rec(1), version: 2, recordId: 'first', label: '探索与观察🐾'.repeat(20000) };
    const last = { ...rec(2), version: 2, recordId: 'last', label: '再次出发' };
    const original = [JSON.stringify(first), 'damaged row', JSON.stringify(first), '', JSON.stringify(last)].join('\r\n');
    writeFileSync(file, original, 'utf8');
    const errors: string[] = [];
    const log = new UsageLog(file, error => errors.push(error));
    expect(log.readAll()).toEqual([first, last]);
    expect(errors).toHaveLength(1);
    expect(log.status().error).toContain('1 damaged ledger lines');
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('clear 清空并返回条数', () => {
    const log = new UsageLog(file);
    log.append(rec(1)); log.append(rec(2));
    expect(log.clear()).toBe(2);
    expect(log.readAll()).toEqual([]);
  });

  it('retains failed appends and flushes them once the directory becomes writable', () => {
    const blocked = join(dir,'blocked');
    writeFileSync(blocked,'file occupying directory');
    const errors:string[]=[];
    const log=new UsageLog(join(blocked,'usage.jsonl'),error=>errors.push(error));
    log.append(rec(1)); log.append(rec(2));
    expect(log.status().pending).toBe(2);
    expect(log.readAll().map(row=>row.promptTokens)).toEqual([100,200]);
    expect(errors.length).toBeGreaterThan(0);
    rmSync(blocked);
    log.flush(); log.flush();
    expect(log.status()).toEqual({pending:0,error:null});
    expect(new UsageLog(join(blocked,'usage.jsonl')).count()).toBe(2);
  });
});
