/** Append-only usage ledger. Failed writes remain queued and are reported to the operator. */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Worker } from 'node:worker_threads';
import type { UsageAggregate, UsageAggregateOptions } from './cost.ts';
import type { UsageRecord } from './types.ts';

interface UsageQueryResult { count: number; aggregate?: UsageAggregate; error: string | null }

function* lines(file: string): Generator<string> {
  const fd = openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  try {
    let bytes: number;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      const text = pending + decoder.write(buffer.subarray(0, bytes));
      let start = 0;
      for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n', start)) {
        yield text.slice(start, end);
        start = end + 1;
      }
      pending = text.slice(start);
    }
    pending += decoder.end();
    if (pending) yield pending;
  } finally {
    closeSync(fd);
  }
}

export class UsageLog {
  private pending: UsageRecord[] = [];
  private error: string | null = null;
  private reconcile = false;
  private queries = new Map<string, Promise<UsageQueryResult>>();
  private queryTail: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string, private readonly report: (message: string) => void = console.error) {}

  append(rec: UsageRecord): void {
    this.pending.push(structuredClone({ ...rec, version: 2, recordId: rec.recordId ?? rec.attempt?.id ?? crypto.randomUUID() }));
    this.flush();
  }

  flush(): void {
    if (!this.pending.length) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      if (this.reconcile) {
        const ids = new Set(this.readDisk().map(record => record.recordId ?? record.attempt?.id));
        this.pending = this.pending.filter(record => !ids.has(record.recordId));
        this.reconcile = false;
      }
      while (this.pending.length) {
        // A newline isolates a prior torn append; damaged lines remain available for inspection.
        appendFileSync(this.file, '\n' + JSON.stringify(this.pending[0]) + '\n', 'utf8');
        this.pending.shift();
      }
      this.error = null;
    } catch (error) { this.reconcile = true; this.note(error); }
  }

  status(): { pending: number; error: string | null } { return { pending: this.pending.length, error: this.error }; }

  private note(error: unknown): void {
    const message = `Usage ledger ${this.file}: ${String(error)}`;
    if (message !== this.error) this.report(message);
    this.error = message;
  }

  private readDisk(): UsageRecord[] {
    if (!existsSync(this.file)) return [];
    const out: UsageRecord[] = [];
    const seen = new Set<string>();
    let damaged = 0;
    for (const line of lines(this.file)) {
      if (!line.trim()) continue;
      let record: UsageRecord;
      try { record = JSON.parse(line) as UsageRecord; } catch { damaged++; continue; }
      if (!record || record.version !== 2 || typeof record.ts !== 'string') { damaged++; continue; }
      const id = record.recordId ?? record.attempt?.id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(record);
    }
    if (damaged) this.note(`${damaged} damaged ledger lines retained on disk`);
    return out;
  }

  readAll(): UsageRecord[] {
    let records: UsageRecord[] = [];
    try { records = this.readDisk(); } catch (error) { this.note(error); }
    const ids = new Set(records.map(record => record.recordId ?? record.attempt?.id));
    return [...records, ...this.pending.filter(record => !ids.has(record.recordId))];
  }

  count(): number { return this.readAll().length; }

  /** Console reads run off the event loop; identical in-flight queries share one snapshot. */
  private query(options?: UsageAggregateOptions): Promise<UsageQueryResult> {
    const key = JSON.stringify(options ?? null);
    const existing = this.queries.get(key);
    if (existing) return existing;
    const query = this.queryTail.then(() => new Promise<UsageQueryResult>((resolve, reject) => {
      const worker = new Worker(new URL('./usage-query-worker.mjs', import.meta.url), {
        workerData: { file: this.file, pending: this.pending, options }, execArgv: [],
      });
      worker.once('message', (result: UsageQueryResult) => {
        if (result.error && result.error !== this.error) { this.error = result.error; this.report(result.error); }
        resolve(result);
        void worker.terminate();
      });
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error(`Usage query worker exited before returning a result (${code})`)));
    }));
    this.queries.set(key, query);
    this.queryTail = query.catch(() => {});
    void query.finally(() => this.queries.delete(key)).catch(() => {});
    return query;
  }

  async countAsync(): Promise<number> { return (await this.query()).count; }

  async aggregateAsync(options: UsageAggregateOptions): Promise<UsageAggregate> {
    return (await this.query(options)).aggregate!;
  }

  clear(): number {
    const count = this.count();
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, '', 'utf8');
    this.pending = [];
    this.error = null;
    return count;
  }
}
