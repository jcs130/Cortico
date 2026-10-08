/** Versioned claims reference immutable observations; prose files remain historical sources. */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import type { ToolDef } from 'cortico/core/types.ts';
import { itemText, withText, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import type { GitWorkspaceMemory } from '../../cormini/persona/memory.ts';

export const STATE_MEMORY_FILE = '.state-memory.json';
export const MEMORY_HISTORY_DIR = '.memory-history';
export const STATE_MEMORY_MAX_CHARS = 1800;
/** Default search receipts carrying this header excluded managed historical bodies before matching. */
export const STATE_MEMORY_SEARCH_NOTICE = '[检索范围：默认省略状态笔记的历史正文；查原始经历、坐标或回执，原参数加 history:true，再用 read_file 带 history:true 读命中段落。]\n';
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const dated = (value: unknown): value is string => typeof value === 'string'
  && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const text = (value: unknown, max: number): value is string => typeof value === 'string'
  && !!value.trim() && value.length <= max;

export interface MemoryObservation { id: string; reference?: string; source: string; observedAt: string; text: string; }
export interface MemoryClaim {
  key: string; revision: number; value: string; recordedAt: string;
  observation: MemoryObservation; expiresAt: string | null; retired: boolean;
}
interface Ledger {
  version: 1;
  claims: MemoryClaim[];
  legacy: Record<string, { revision: string; archive: string }>;
}
const empty = (): Ledger => ({ version: 1, claims: [], legacy: {} });

export class StateMemory {
  private readonly observations = new Map<string, MemoryObservation>();
  constructor(private readonly memory: GitWorkspaceMemory, private readonly now: () => number = Date.now) {}

  private load(): Ledger {
    if (!existsSync(this.memory.resolveSafe(STATE_MEMORY_FILE))) return empty();
    const saved = JSON.parse(this.memory.readFile(STATE_MEMORY_FILE)) as Ledger;
    if (saved.version !== 1 || !Array.isArray(saved.claims) || !saved.legacy || typeof saved.legacy !== 'object'
      || saved.claims.some(claim => !text(claim.key, 120) || !Number.isSafeInteger(claim.revision) || claim.revision < 1
        || !text(claim.value, 600) || !dated(claim.recordedAt) || typeof claim.retired !== 'boolean'
        || (claim.expiresAt !== null && !dated(claim.expiresAt)) || !claim.observation
        || !dated(claim.observation.observedAt) || !text(claim.observation.id, 80)
        || !text(claim.observation.source, 160) || !text(claim.observation.text, 8000))) {
      throw new Error(`${STATE_MEMORY_FILE} 格式无效；未覆盖现有记忆。`);
    }
    const versions = new Map<string, number>();
    for (const claim of saved.claims) {
      if (claim.revision !== (versions.get(claim.key) ?? 0) + 1) throw new Error('Memory claim revision sequence is invalid');
      versions.set(claim.key, claim.revision);
    }
    return saved;
  }

  private transaction<T>(operation: (ledger: Ledger) => { result: T; changed: boolean }): T {
    const lock = this.memory.resolveSafe(`${STATE_MEMORY_FILE}.lock`);
    const fd = openSync(lock, 'wx');
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      const ledger = this.load();
      const { result, changed } = operation(ledger);
      if (changed) this.memory.writeFileAtomic(STATE_MEMORY_FILE, JSON.stringify(ledger) + '\n');
      return result;
    } finally { closeSync(fd); unlinkSync(lock); }
  }

  /** Copy legacy sources once without treating their write time as an observation. */
  migrate(paths: readonly string[]): void {
    const existing = paths.flatMap(path => {
      try { return [{ path: this.memory.normalize(path), body: this.memory.readFile(path) }]; }
      catch { return []; }
    });
    if (!existing.length) return;
    this.transaction(ledger => {
      let changed = false;
      for (const { path, body } of existing) {
        if (Object.hasOwn(ledger.legacy, path)) continue;
        const revision = digest(body);
        const archive = `${MEMORY_HISTORY_DIR}/${digest(path + '\n' + body)}.md`;
        this.memory.writeFileAtomic(archive, body);
        ledger.legacy[path] = { revision, archive };
        changed = true;
      }
      return { result: undefined, changed };
    });
  }

  observe(observation: Omit<MemoryObservation, 'id'> & { id?: string }): string | null {
    if (!dated(observation.observedAt) || !text(observation.source, 160) || !observation.text.trim()) return null;
    const id = digest(JSON.stringify([observation.source, observation.id ?? '', observation.observedAt, observation.text]));
    const entry: MemoryObservation = { id, source: observation.source, observedAt: observation.observedAt,
      ...(observation.id ? { reference: observation.id } : {}),
      text: observation.text.slice(0, 8000) };
    this.observations.set(id, entry);
    while (this.observations.size > 128) this.observations.delete(this.observations.keys().next().value!);
    return id;
  }

  /** Only external events and actual non-Memory tool results can support a current claim. */
  observeRecords(records: readonly ContextRecord[], evidenceTools: ReadonlySet<string>): void {
    const calls = new Map(records.flatMap(record => record.item.type === 'function_call'
      ? [[record.item.call_id, record.item.name] as const] : []));
    for (const record of records) {
      const body = itemText(record.item);
      for (const ref of record.context.frame?.events ?? []) {
        if (ref.source === 'persona' || ref.start < 0 || ref.chars <= 0 || ref.start + ref.chars > body.length) continue;
        this.observe({ id: String(ref.cursor), source: `${ref.source}/${ref.type}`, observedAt: ref.ts,
          text: body.slice(ref.start, ref.start + ref.chars) });
      }
      if (record.item.type !== 'function_call_output') continue;
      const name = calls.get(record.item.call_id);
      if (!name || !evidenceTools.has(name) || !record.context.ts) continue;
      this.observe({ id: record.item.call_id, source: `tool/${name}`, observedAt: record.context.ts, text: body });
    }
  }

  private latest(ledger: Ledger): MemoryClaim[] {
    return [...new Map(ledger.claims.map(claim => [claim.key, claim])).values()];
  }
  private active(claim: MemoryClaim): boolean {
    return !claim.retired && (claim.expiresAt === null || Date.parse(claim.expiresAt) > this.now());
  }

  operate(args: Record<string, unknown>): string | { failed: true; text: string } {
    try {
      if (args.operation === 'evidence') {
        if (args.evidence_id !== undefined) {
          const entry = this.observations.get(String(args.evidence_id))
            ?? this.load().claims.find(claim => claim.observation.id === args.evidence_id)?.observation;
          if (!entry) throw new Error('未找到该观察');
          return JSON.stringify(entry);
        }
        const entries = [...this.observations.values()].filter(entry => !args.query
          || `${entry.source}\n${entry.text}`.includes(String(args.query))).slice(-4).reverse()
          .map(entry => ({ ...entry, text: entry.text.slice(0, 600), chars: entry.text.length }));
        return JSON.stringify({ observations: entries, interpretation: '实际观察原文；包含失败的回执。结论仍需判断，读文件和自己的台词不产生观察证据。' });
      }
      if (args.operation === 'read' || args.operation === 'history') {
        if (args.operation === 'history' && !text(args.key, 120)) throw new Error('history 需要 key');
        const ledger = this.load();
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 8;
        if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit)
          || Number(limit) < 1 || Number(limit) > 20) throw new Error('分页 offset >= 0，limit 为 1 至 20');
        const all = (args.operation === 'history' ? ledger.claims : this.latest(ledger).filter(claim => args.key !== undefined || this.active(claim)))
          .filter(claim => args.key === undefined || claim.key === args.key);
        return JSON.stringify({ claims: all.slice(Number(offset), Number(offset) + Number(limit)).map(claim => ({ ...claim,
          active: this.active(claim) && this.latest(ledger).find(head => head.key === claim.key)?.revision === claim.revision,
          observation: { ...claim.observation, text: claim.observation.text.slice(0, 600), chars: claim.observation.text.length } })),
          total: all.length, nextOffset: Number(offset) + Number(limit) < all.length ? Number(offset) + Number(limit) : null });
      }
      if (!['set', 'retire'].includes(String(args.operation)) || !text(args.key, 120)
        || !Number.isSafeInteger(args.expected_revision) || Number(args.expected_revision) < 0
        || !text(args.value, 600)) throw new Error('set/retire 需要 key、expected_revision 和 value（结论或撤回原因）');
      const observation = this.observations.get(String(args.evidence_id));
      if (!observation) throw new Error('evidence_id 不属于已收到的外部观察；先 evidence 查原始回执');
      const expiresAt = args.expires_at ?? null;
      if (expiresAt !== null && (!dated(expiresAt) || Date.parse(expiresAt) <= this.now()
        || Date.parse(expiresAt) <= Date.parse(observation.observedAt))) throw new Error('expires_at 必须晚于观察和当前时刻');
      return this.transaction(ledger => {
        const previous = this.latest(ledger).find(claim => claim.key === args.key);
        const revision = previous?.revision ?? 0;
        if (args.expected_revision !== revision) throw new Error(`版本冲突：${args.key} 当前 revision=${revision}；未写入`);
        if (previous && Date.parse(observation.observedAt) <= Date.parse(previous.observation.observedAt)) {
          throw new Error('观察时间未推进；旧证据不能覆盖、续期或复活当前结论');
        }
        const claim: MemoryClaim = { key: args.key as string, revision: revision + 1, value: args.value as string,
          observation: structuredClone(observation), expiresAt: expiresAt as string | null,
          recordedAt: new Date(this.now()).toISOString(), retired: args.operation === 'retire' };
        ledger.claims.push(claim);
        return { result: JSON.stringify({ recorded: claim, interpretation: '结论是对所附观察的解释；时间、来源与版本已校验，不代表系统已证明结论语义。' }), changed: true };
      });
    } catch (error) { return { failed: true, text: `[memory failed] ${String(error)}` }; }
  }

  summary(): string {
    const active = this.latest(this.load()).filter(claim => this.active(claim));
    const header = '[当前记忆记录；由 memory_record 管理。结论附原始观察，日程与现场由各自账本提供。]\n';
    const footer = '\nmemory_record read 按 key 查证据；history 查旧版本；evidence 查收到的外部观察。写入需 expected_revision 和 evidence_id。经历笔记不会自动成为当前状态。';
    let body = '';
    for (const claim of active.sort((a, b) => Date.parse(b.observation.observedAt) - Date.parse(a.observation.observedAt))) {
      const line = `${claim.key} r${claim.revision}：${claim.value}（观察 ${claim.observation.observedAt}，${claim.observation.source}）\n`;
      if (header.length + body.length + line.length + footer.length > STATE_MEMORY_MAX_CHARS) break;
      body += line;
    }
    if (!body) body = active.length ? '当前记录需按 key 分页读取。' : '暂无有效的结构化结论；不能据此认定没有目标或经历。';
    return header + body + footer;
  }

  hasClaims(): boolean { return this.load().claims.length > 0; }

  historicalSource(path: string): string {
    return `[历史笔记入口 ${path}；正文不会自动充当当前状态。read_file 带 history:true 查当时的记录。]\n`;
  }

  tool(): ToolDef {
    return { name: 'memory_record', tags: ['read', 'write'],
      description: 'Read versioned current claims or their dated history. evidence lists received external observations (including failures). set/retire requires a stable object/property key, the exact current revision (0 for new key), value and evidence_id. New evidence must be later than the previous observation. Use expires_at for temporary readings. Rewriting prose never updates these records; completion remains in activity_plan and pending_work. A claim is an interpretation; inspect its evidence.',
      parameters: { type: 'object', additionalProperties: false, properties: {
        operation: { type: 'string', enum: ['read', 'history', 'evidence', 'set', 'retire'] },
        key: { type: 'string', minLength: 1, maxLength: 120 },
        expected_revision: { type: 'integer', minimum: 0 }, value: { type: 'string', minLength: 1, maxLength: 600 },
        evidence_id: { type: 'string', maxLength: 80 }, expires_at: { type: 'string' }, query: { type: 'string', maxLength: 300 },
        offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 },
      }, required: ['operation'] }, handler: async args => this.operate(args) };
  }

  /** Replayed memory tool results are re-resolved; original records remain in the event store. */
  project(records: readonly ContextRecord[], managed: (path: string) => boolean): ContextRecord[] {
    const calls = new Map(records.flatMap(record => {
      if (record.item.type !== 'function_call') return [];
      try { return [[record.item.call_id, { name: record.item.name, args: JSON.parse(record.item.arguments) }] as const]; }
      catch { return []; }
    }));
    return records.map(record => {
      if (record.item.type !== 'function_call_output') return record;
      const call = calls.get(record.item.call_id);
      if (!call || call.args.history === true || call.args.operation === 'history') return record;
      if (call.name === 'memory_record' && ['read', 'set', 'retire'].includes(call.args.operation)) {
        if (itemText(record.item).startsWith('[memory failed]')) return record;
        const args = call.args.operation === 'read' ? call.args : { operation: 'read', key: call.args.key };
        const current = this.operate(args);
        return withText(record, typeof current === 'string' ? current : current.text);
      }
      if (call.name === 'read_file' && managed(String(call.args.path ?? ''))) {
        return withText(record, '[旧读取视图未重放；当前结论见本轮当前记忆。]\n' + this.historicalSource(String(call.args.path)));
      }
      if (call.name === 'grep_files' && !itemText(record.item).startsWith(STATE_MEMORY_SEARCH_NOTICE)) {
        return withText(record, '[旧检索结果未重放；原参数加 history:true 可读原始命中，再用 read_file 带 history:true 查对应段落。]');
      }
      return record;
    });
  }
}
