import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { retryBusy, retryBusyAsync } from '../../core/fs-busy.ts';
import type { ContextRecord } from './context.ts';

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function isRecord(row: unknown): row is ContextRecord {
  const r = row as ContextRecord | null;
  return !!r && r.version === 2 && !!r.item && typeof r.item === 'object' && !Array.isArray(r.item)
    && !!r.context && typeof r.context === 'object' && !Array.isArray(r.context);
}

export type ContextLoadRepair =
  | { kind: 'torn-tail'; bytes: number }
  | { kind: 'unterminated-tail' };

export class ContextLog {
  private entries: readonly ContextRecord[];
  private recordTarget: ContextRecord[];
  private offsets: number[] = [];
  private ends: number[] = [];
  private cache = new Map<number, ContextRecord>();
  private revision = 0;
  private fileBytes = 0;
  constructor(readonly file: string, private readonly stamp?: () => string, private readonly residentRecords = 8192) {
    mkdirSync(dirname(file), { recursive: true });
    const target: ContextRecord[] = [];
    this.recordTarget = target;
    this.entries = new Proxy(target, {
      get: (array, property, receiver) => {
        if (property === 'length') return this.offsets.length;
        if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) return this.readRecord(Number(property));
        if (property === Symbol.iterator || property === 'values') return () => this.iterateRecords();
        if (property === 'keys') return () => Array.from({ length: this.offsets.length }, (_, index) => index).values();
        if (property === 'entries') return () => this.recordEntries();
        if (property === 'forEach') return (callback: (row: ContextRecord, index: number, array: readonly ContextRecord[]) => void, thisArg?: unknown) => {
          let index = 0; for (const row of this.iterateRecords()) callback.call(thisArg, row, index++, receiver);
        };
        if (property === 'map') return (callback: (row: ContextRecord, index: number, array: readonly ContextRecord[]) => unknown, thisArg?: unknown) => {
          const result: unknown[] = []; let index = 0;
          for (const row of this.iterateRecords()) result.push(callback.call(thisArg, row, index++, receiver));
          return result;
        };
        if (property === 'filter') return (callback: (row: ContextRecord, index: number, array: readonly ContextRecord[]) => unknown, thisArg?: unknown) => {
          const result: ContextRecord[] = []; let index = 0;
          for (const row of this.iterateRecords()) if (callback.call(thisArg, row, index++, receiver)) result.push(row);
          return result;
        };
        if (property === 'some') return (callback: (row: ContextRecord, index: number, array: readonly ContextRecord[]) => unknown, thisArg?: unknown) => {
          let index = 0; for (const row of this.iterateRecords()) if (callback.call(thisArg, row, index++, receiver)) return true; return false;
        };
        if (property === 'every') return (callback: (row: ContextRecord, index: number, array: readonly ContextRecord[]) => unknown, thisArg?: unknown) => {
          let index = 0; for (const row of this.iterateRecords()) if (!callback.call(thisArg, row, index++, receiver)) return false; return true;
        };
        if (property === 'find') return (callback: (row: ContextRecord, index: number, array: readonly ContextRecord[]) => unknown, thisArg?: unknown) => {
          let index = 0; for (const row of this.iterateRecords()) if (callback.call(thisArg, row, index++, receiver)) return row; return undefined;
        };
        if (property === 'findLast') return (callback: (row: ContextRecord, index: number, array: readonly ContextRecord[]) => unknown, thisArg?: unknown) => {
          for (let index = this.offsets.length - 1; index >= 0; index--) { const row = this.readRecord(index)!; if (callback.call(thisArg, row, index, receiver)) return row; } return undefined;
        };
        if (property === 'reduce') return (callback: (previous: unknown, row: ContextRecord, index: number, array: readonly ContextRecord[]) => unknown, ...rest: unknown[]) => {
          let index = 0, previous: unknown;
          if (rest.length) previous = rest[0];
          else { if (!this.offsets.length) throw new TypeError('Reduce of empty array with no initial value'); previous = this.readRecord(0); index = 1; }
          for (const row of this.iterateRecords(index)) previous = callback(previous, row, index++, receiver);
          return previous;
        };
        if (property === 'slice') return (start = 0, end = this.offsets.length) => {
          const length = this.offsets.length, from = start < 0 ? Math.max(length + start, 0) : Math.min(start, length);
          const to = end < 0 ? Math.max(length + end, 0) : Math.min(end, length);
          return Array.from(this.iterateRecords(from, Math.max(from, to)));
        };
        if (property === 'at') return (index: number) => this.readRecord(index < 0 ? this.offsets.length + index : index);
        const value = Reflect.get(array, property, receiver);
        return typeof value === 'function' && property !== 'constructor' ? value.bind(receiver) : value;
      },
      has: (array, property) => typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)
        ? Number(property) < this.offsets.length : Reflect.has(array, property),
      ownKeys: () => [...Array.from({ length: this.offsets.length }, (_, index) => String(index)), 'length'],
      getOwnPropertyDescriptor: (array, property) => typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)
        && Number(property) < this.offsets.length
        ? { configurable: true, enumerable: true, writable: false, value: this.readRecord(Number(property)) }
        : Reflect.getOwnPropertyDescriptor(array, property),
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
    });
  }

  get records(): readonly ContextRecord[] { return this.entries; }

  private syncLength(): void { this.recordTarget.length = this.offsets.length; }

  private cacheRecord(index: number, row: ContextRecord): void {
    this.cache.delete(index); this.cache.set(index, row);
    while (this.cache.size > Math.max(1, this.residentRecords)) this.cache.delete(this.cache.keys().next().value!);
  }

  private readRecord(index: number): ContextRecord | undefined {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.offsets.length) return undefined;
    const cached = this.cache.get(index); if (cached) return cached;
    const start = this.offsets[index]!, end = this.ends[index] ?? this.fileBytes;
    const fd = openSync(this.file, 'r');
    try {
      const bytes = Buffer.alloc(end - start); let read = 0;
      while (read < bytes.length) { const count = readSync(fd, bytes, read, bytes.length - read, start + read); if (!count) throw new Error('Session file is missing a context record'); read += count; }
      const row: unknown = JSON.parse(bytes.toString('utf8'));
      if (!isRecord(row)) throw new Error(`Invalid context record at ${this.file}:${index + 1}`);
      const frozen = freeze(row); this.cacheRecord(index, frozen); return frozen;
    } finally { closeSync(fd); }
  }

  private *iterateRecords(start = 0, end = this.offsets.length): Generator<ContextRecord> {
    if (start >= end) return;
    const fd = openSync(this.file, 'r');
    try {
      for (let index = start; index < end; index++) {
        const cached = this.cache.get(index); if (cached) { yield cached; continue; }
        const offset = this.offsets[index]!, lineEnd = this.ends[index] ?? this.fileBytes;
        const bytes = Buffer.alloc(lineEnd - offset); let read = 0;
        while (read < bytes.length) { const count = readSync(fd, bytes, read, bytes.length - read, offset + read); if (!count) throw new Error('Session file is missing a context record'); read += count; }
        const row: unknown = JSON.parse(bytes.toString('utf8'));
        if (!isRecord(row)) throw new Error(`Invalid context record at ${this.file}:${index + 1}`);
        const frozen = freeze(row); this.cacheRecord(index, frozen); yield frozen;
      }
    } finally { closeSync(fd); }
  }

  private *recordEntries(): Generator<[number, ContextRecord]> {
    let index = 0; for (const row of this.iterateRecords()) yield [index++, row];
  }

  private scan(repair: boolean): ContextLoadRepair | null {
    const offsets: number[] = [], ends: number[] = [], cache = new Map<number, ContextRecord>();
    const keep = (index: number, row: ContextRecord) => {
      cache.delete(index); cache.set(index, row);
      while (cache.size > Math.max(1, this.residentRecords)) cache.delete(cache.keys().next().value!);
    };
    const fd = openSync(this.file, 'r');
    let result: ContextLoadRepair | null = null;
    try {
      const buffer = Buffer.alloc(64 * 1024); let carry = Buffer.alloc(0), readOffset = 0, lineStart = 0;
      for (;;) {
        const bytesRead = readSync(fd, buffer, 0, buffer.length, readOffset);
        if (!bytesRead) break;
        const dataStart = readOffset - carry.length; readOffset += bytesRead;
        const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
        let from = 0;
        for (;;) {
          const newline = data.indexOf(10, from);
          if (newline < 0) { carry = Buffer.from(data.subarray(from)); break; }
          const end = dataStart + newline + 1, line = data.subarray(from, newline);
          if (line.toString('utf8').trim()) {
            let row: unknown;
            try { row = JSON.parse(line.toString('utf8')); } catch { throw new Error(`Invalid session JSON at ${this.file}:${offsets.length + 1}`); }
            if (!isRecord(row)) throw new Error(`Invalid context record at ${this.file}:${offsets.length + 1}`);
            offsets.push(lineStart); ends.push(end); keep(offsets.length - 1, freeze(row));
          }
          from = newline + 1; lineStart = end;
        }
      }
      if (carry.length) {
        let row: unknown = null;
        try { row = JSON.parse(carry.toString('utf8')); } catch { /* torn tail */ }
        if (isRecord(row)) {
          offsets.push(lineStart); keep(offsets.length - 1, freeze(row));
          if (repair) { appendFileSync(this.file, '\n'); ends.push(statSync(this.file).size); result = { kind: 'unterminated-tail' }; }
          else ends.push(readOffset);
        } else if (repair) {
          result = { kind: 'torn-tail', bytes: statSync(this.file).size - lineStart };
          truncateSync(this.file, lineStart);
        } else throw new Error(`Invalid session JSON at ${this.file}:${offsets.length + 1}`);
      }
    } finally { closeSync(fd); }
    this.offsets = offsets; this.ends = ends; this.cache = cache; this.fileBytes = statSync(this.file).size; this.syncLength();
    return result;
  }

  load(): ContextLoadRepair | null {
    this.revision++;
    if (!existsSync(this.file)) { this.offsets = []; this.ends = []; this.cache.clear(); this.fileBytes = 0; this.syncLength(); return null; }
    return this.scan(true);
  }

  append(entry: ContextRecord): ContextRecord {
    const next = structuredClone(entry);
    if (this.stamp && next.context.ts === undefined) next.context.ts = this.stamp();
    const line = JSON.stringify(next) + '\n';
    retryBusy(() => appendFileSync(this.file, line));
    this.offsets.push(this.fileBytes); this.fileBytes += Buffer.byteLength(line); this.ends.push(this.fileBytes); this.syncLength();
    this.cacheRecord(this.offsets.length - 1, freeze(next));
    return next;
  }

  private replaceWith(entries: Iterable<ContextRecord>): void {
    const temporary = `${this.file}.${process.pid}.tmp`;
    const fd = openSync(temporary, 'w');
    const offsets: number[] = [], ends: number[] = [], cache = new Map<number, ContextRecord>();
    let size = 0;
    try {
      for (const entry of entries) {
        const row = freeze(structuredClone(entry)), line = JSON.stringify(row) + '\n';
        writeFileSync(fd, line); offsets.push(size); size += Buffer.byteLength(line); ends.push(size);
        cache.delete(offsets.length - 1); cache.set(offsets.length - 1, row);
        while (cache.size > Math.max(1, this.residentRecords)) cache.delete(cache.keys().next().value!);
      }
      fsyncSync(fd); size = fstatSync(fd).size;
    } finally { closeSync(fd); }
    retryBusy(() => renameSync(temporary, this.file));
    this.revision++; this.fileBytes = size; this.offsets = offsets; this.ends = ends; this.cache = cache; this.syncLength();
  }

  reset(records: readonly ContextRecord[]): void {
    this.replaceWith(records);
  }

  retainWhere(predicate: (entry: ContextRecord, index: number) => boolean): number {
    const before = this.offsets.length;
    const entries = (function* (log: ContextLog) {
      let index = 0;
      for (const entry of log.iterateRecords()) if (predicate(entry, index++)) yield entry;
    })(this);
    this.replaceWith(entries);
    return before - this.offsets.length;
  }

  async replacePrefix(removed: number, entry: ContextRecord, active: () => boolean, committed: () => void): Promise<boolean> {
    if (!active()) return false;
    if (this.entries.length === 0) { this.reset([entry]); committed(); return true; }
    const revision = this.revision;
    const prefix = freeze(structuredClone(entry));
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    const current = () => this.revision === revision && active();
    let created = false;
    let replaced = false;
    try {
      while (current()) {
        const first = !created;
        let count: number;
        const target = await open(temporary, first ? 'wx' : 'a');
        created = true;
        try {
          if (first) await target.writeFile(JSON.stringify(prefix) + '\n');
          if (!current()) return false;
          const source = await open(this.file, 'r');
          try {
            if (!current()) return false;
            count = this.entries.length;
            const end = fstatSync(source.fd).size;
            if (end !== this.fileBytes) throw new Error('Session file size changed outside the active writer');
            if (first) position = await offsetAfterRecords(source, removed, buffer);
            while (position < end) {
              const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, end - position), position);
              if (!bytesRead) throw new Error('Unexpected end of session file during prefix replacement');
              position += bytesRead;
              await target.writeFile(buffer.subarray(0, bytesRead));
              if (!current()) return false;
            }
          } finally { await source.close(); }
          await target.sync();
        } finally { await target.close(); }
        const done = await retryBusyAsync(() => {
          if (!current()) return false;
          if (this.entries.length !== count) return null;
          if (statSync(this.file).size !== this.fileBytes) throw new Error('Session file size changed outside the active writer');
          const retainedCache = new Map([...this.cache].filter(([index]) => index >= removed)
            .map(([index, row]) => [index - removed + 1, row] as const));
          renameSync(temporary, this.file);
          replaced = true;
          this.revision++;
          this.scan(false);
          for (const [index, row] of retainedCache) { this.cache.delete(index); this.cache.set(index, row); }
          while (this.cache.size > Math.max(1, this.residentRecords)) this.cache.delete(this.cache.keys().next().value!);
          committed();
          return true;
        });
        if (done !== null) return done;
        await unlink(temporary); created = false; position = 0;
      }
      return false;
    } finally {
      if (created && !replaced) await unlink(temporary);
    }
  }
}

async function offsetAfterRecords(source: FileHandle, count: number, buffer: Buffer): Promise<number> {
  let position = 0;
  let nonblank = false;
  while (count > 0) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
    if (!bytesRead) throw new Error('Session file is missing the prefix being replaced');
    const chunk = buffer.subarray(0, bytesRead);
    let from = 0;
    while (from < bytesRead) {
      const newline = chunk.indexOf(10, from);
      const end = newline === -1 ? bytesRead : newline + 1;
      nonblank ||= chunk.subarray(from, end).includes(0x7b);
      if (newline !== -1) {
        if (nonblank && --count === 0) return position + end;
        nonblank = false;
      }
      from = end;
    }
    position += bytesRead;
  }
  return position;
}
