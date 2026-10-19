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
export const STATE_MEMORY_SEARCH_NOTICE = '[检索范围：普通目标、偏好、经历及交接文件按原文检索；仅内部结论账本及其版本归档默认省略正文，查这些原始版本可加 history:true。命中保留来源，旧观察须核对较新 World 回执。]\n';
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const dated = (value: unknown): value is string => typeof value === 'string'
  && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const text = (value: unknown, max: number): value is string => typeof value === 'string'
  && !!value.trim() && value.length <= max;

export interface MemoryObservation { id: string; reference?: string; source: string; observedAt: string; text: string; }
export type MemoryClaimKind = 'observation' | 'event' | 'belief';
const CLAIM_KINDS: readonly MemoryClaimKind[] = ['observation', 'event', 'belief'];
export interface MemoryClaim {
  key: string; revision: number; value: string; recordedAt: string;
  observation: MemoryObservation; expiresAt: string | null; retired: boolean;
  /** Missing on legacy entries; classification does not advance the observation time. */
  kind?: MemoryClaimKind;
  classificationReason?: string;
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
        || (claim.kind !== undefined && !CLAIM_KINDS.includes(claim.kind))
        || (claim.classificationReason !== undefined && !text(claim.classificationReason, 600))
        || (claim.kind === 'observation' && claim.expiresAt === null)
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

  private expiry(args: Record<string, unknown>, observation: MemoryObservation, kind: MemoryClaimKind | undefined): string | null {
    if (args.expires_at !== undefined && args.valid_for_seconds !== undefined) throw new Error('expires_at 与 valid_for_seconds 二选一');
    let expiresAt = args.expires_at ?? null;
    if (args.valid_for_seconds !== undefined) {
      if (typeof args.valid_for_seconds !== 'number' || !Number.isFinite(args.valid_for_seconds) || args.valid_for_seconds <= 0)
        throw new Error('valid_for_seconds 必须为可表示时间的正数，以原始观察时间起算');
      const expiry = Date.parse(observation.observedAt) + args.valid_for_seconds * 1000;
      if (!Number.isFinite(new Date(expiry).getTime())) throw new Error('有效期无法表示');
      expiresAt = new Date(expiry).toISOString();
    }
    if (expiresAt !== null && (!dated(expiresAt) || Date.parse(expiresAt) <= Date.parse(observation.observedAt)))
      throw new Error('expires_at 必须晚于原始观察；写入或读取时间不能使旧观察续期');
    if (kind === 'observation' && expiresAt === null) throw new Error('observation 是临时观测，必须提供 expires_at 或 valid_for_seconds');
    return expiresAt as string | null;
  }

  operate(args: Record<string, unknown>): string | { failed: true; text: string } {
    try {
      if (args.kind !== undefined && args.kind !== 'legacy' && !CLAIM_KINDS.includes(args.kind as MemoryClaimKind))
        throw new Error('kind 必须为 observation/event/belief；read/history 可用 legacy 查询未分类旧记录');
      if (args.operation === 'evidence') {
        if (args.evidence_id !== undefined) {
          const entry = this.observations.get(String(args.evidence_id))
            ?? this.load().claims.find(claim => claim.observation.id === args.evidence_id)?.observation;
          if (!entry) throw new Error('未找到该观察');
          return JSON.stringify(entry);
        }
        if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 300)) {
          throw new Error('query 需要不超过 300 字符的字符串；空格分隔关键词，同一观察需包含全部关键词');
        }
        const terms = String(args.query ?? '').trim().toLowerCase().split(/\s+/u).filter(Boolean);
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 4;
        if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit)
          || Number(limit) < 1 || Number(limit) > 20) throw new Error('分页 offset >= 0，limit 为 1 至 20');
        const matches = [...this.observations.values()].reverse().filter(entry => {
          const searchable = `${entry.source}\n${entry.reference ?? ''}\n${entry.id}\n${entry.text}`.toLowerCase();
          return terms.every(term => searchable.includes(term));
        }).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
        const entries = matches.slice(Number(offset), Number(offset) + Number(limit))
          .map(entry => ({ ...entry, text: entry.text.slice(0, 600), chars: entry.text.length, truncated: entry.text.length > 600 }));
        return JSON.stringify({ observations: entries, total: matches.length,
          nextOffset: Number(offset) + Number(limit) < matches.length ? Number(offset) + Number(limit) : null,
          scope: { kind: 'retained_observations', retained: this.observations.size, capacity: 128 },
          queryTerms: terms, match: 'all_terms_case_insensitive',
          interpretation: '实际观察原文，包含失败回执；id 用于 evidence_id，reference 只是来源编号。truncated 表示仅预览，用 evidence_id 读取全文再解释。未命中仅说明当前保留的观察没有匹配项；读文件和自己的台词不产生观察证据。' });
      }
      if (args.operation === 'read' || args.operation === 'history') {
        if (args.query !== undefined) throw new Error('read/history 按 key 读取，不能接受 query。按主题查持久历史请用 memory_record {"operation":"recall","query":"查询词"}；当前未返回任何旧记录。');
        if (args.operation === 'history' && !text(args.key, 120)) throw new Error('history 需要 key');
        if (args.include_inactive !== undefined && typeof args.include_inactive !== 'boolean') throw new Error('include_inactive 必须为布尔值');
        const ledger = this.load();
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 8;
        if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit)
          || Number(limit) < 1 || Number(limit) > 20) throw new Error('分页 offset >= 0，limit 为 1 至 20');
        const all = (args.operation === 'history' ? ledger.claims : this.latest(ledger).filter(claim => args.key !== undefined || args.include_inactive === true || this.active(claim)))
          .filter(claim => (args.key === undefined || claim.key === args.key)
            && (args.kind === undefined || (claim.kind ?? 'legacy') === args.kind));
        return JSON.stringify({ claims: all.slice(Number(offset), Number(offset) + Number(limit)).map(claim => ({ ...claim,
          kind: claim.kind ?? 'legacy',
          interpretation: claim.kind === 'observation' ? '短时观察的版本和有效期；实际现场由较新 World 回执核验'
            : claim.kind === 'event' ? '发生过的事件；不证明现场状态持续不变'
              : claim.kind === 'belief' ? '基于所附观察的认识或经验，可被新证据修订'
                : '未分类旧记录，保留原始内容和证据；不得默认为持续有效的现场读数',
          active: this.active(claim) && this.latest(ledger).find(head => head.key === claim.key)?.revision === claim.revision,
          observation: { ...claim.observation, text: claim.observation.text.slice(0, 600), chars: claim.observation.text.length } })),
          total: all.length, nextOffset: Number(offset) + Number(limit) < all.length ? Number(offset) + Number(limit) : null });
      }
      if (args.operation === 'classify') {
        if (!text(args.key, 120) || !Number.isSafeInteger(args.expected_revision) || !text(args.reason, 600)
          || !CLAIM_KINDS.includes(args.kind as MemoryClaimKind)) throw new Error('classify 需要 key、expected_revision、kind 和 reason；先读原始证据，不修改旧正文');
        return this.transaction(ledger => {
          const previous = this.latest(ledger).find(claim => claim.key === args.key);
          if (!previous || previous.revision !== args.expected_revision) throw new Error('版本冲突或未找到该 key；未分类');
          if (previous.kind !== undefined || previous.retired) throw new Error('classify 只分类未撤回的旧记录；已有分类的认识修订需要较新的外部观察');
          const expiresAt = this.expiry(args.expires_at === undefined && args.valid_for_seconds === undefined
            ? { ...args, ...(previous.expiresAt ? { expires_at: previous.expiresAt } : {}) } : args,
          previous.observation, args.kind as MemoryClaimKind);
          if (previous.expiresAt !== null && (expiresAt === null || Date.parse(expiresAt) > Date.parse(previous.expiresAt)))
            throw new Error('分类不能延长或移除原有效期；观察时间保持原值');
          const claim: MemoryClaim = { ...previous, revision: previous.revision + 1, kind: args.kind as MemoryClaimKind,
            classificationReason: args.reason as string, expiresAt, recordedAt: new Date(this.now()).toISOString() };
          ledger.claims.push(claim);
          return { result: JSON.stringify({ recorded: claim, interpretation: '旧内容及观察时间未改；分类不证明原解释正确，也不使过期观察重新有效。' }), changed: true };
        });
      }
      if (!['set', 'retire'].includes(String(args.operation)) || !text(args.key, 120)
        || !Number.isSafeInteger(args.expected_revision) || Number(args.expected_revision) < 0
        || !text(args.value, 600)) throw new Error('set/retire 需要 key、expected_revision 和 value（结论或撤回原因）');
      const observation = this.observations.get(String(args.evidence_id));
      if (!observation) throw new Error('evidence_id 不属于已收到的外部观察；先 evidence 查原始回执，使用返回的 id，不能用任务号、消息号或 reference 代替。query 可用单个关键词，省略时列最近观察');
      return this.transaction(ledger => {
        const previous = this.latest(ledger).find(claim => claim.key === args.key);
        const revision = previous?.revision ?? 0;
        if (args.expected_revision !== revision) throw new Error(`版本冲突：${args.key} 当前 revision=${revision}；未写入`);
        if (previous && Date.parse(observation.observedAt) <= Date.parse(previous.observation.observedAt)) {
          throw new Error('观察时间未推进；旧证据不能覆盖、续期或复活当前结论');
        }
        const kind = args.operation === 'retire' ? previous?.kind : args.kind ?? previous?.kind;
        if (args.operation === 'set' && !CLAIM_KINDS.includes(kind as MemoryClaimKind))
          throw new Error('set 需要 kind：临时观测 observation、发生过的事件 event 或认识经验 belief；旧记录可先 classify');
        const expiresAt = args.operation === 'retire' ? previous?.expiresAt ?? null
          : this.expiry(args, observation, kind as MemoryClaimKind);
        const claim: MemoryClaim = { key: args.key as string, revision: revision + 1, value: args.value as string,
          ...(kind && kind !== 'legacy' ? { kind: kind as MemoryClaimKind } : {}),
          observation: structuredClone(observation), expiresAt: expiresAt as string | null,
          recordedAt: new Date(this.now()).toISOString(), retired: args.operation === 'retire' };
        ledger.claims.push(claim);
        return { result: JSON.stringify({ recorded: claim, interpretation: '结论是对所附观察的解释；时间、来源与版本已校验，不代表系统已证明结论语义。' }), changed: true };
      });
    } catch (error) { return { failed: true, text: `[memory failed] ${String(error)}` }; }
  }

  summary(): string {
    const active = this.latest(this.load()).filter(claim => this.active(claim));
    const header = '[当前记忆记录；由 memory_record 管理。有效指版本与期限，不保证现场仍如此；区分临时观测、历史事件、认识经验和未分类旧记录。日程与现场由各自账本提供。]\n'
      + `有效记录 ${active.length} 条，其中未分类旧记录 ${active.filter(claim => claim.kind === undefined).length} 条；未展开的条目仍可定向查询。\n`;
    const footer = '\nmemory_record read 按 key/kind 查询；history 查旧版本；evidence 只查近期128条观察；recall(query) 查持久历史及已配置游戏记忆。未分类旧记录先查原始证据再 classify，不能据省略判断不存在。';
    let body = '';
    for (const claim of active.sort((a, b) => Date.parse(b.observation.observedAt) - Date.parse(a.observation.observedAt))) {
      const label = { observation: '临时观测', event: '历史事件', belief: '认识经验', legacy: '未分类旧记录' }[claim.kind ?? 'legacy'];
      const line = `[${label}] ${claim.key} r${claim.revision}：${claim.value}（观察 ${claim.observation.observedAt}，${claim.observation.source}${claim.expiresAt ? `，有效至 ${claim.expiresAt}` : ''}）\n`;
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
      description: 'Read versioned interpretations and dated history, filtered by key or kind. set requires kind: observation (temporary reading, requires expiry), event (past occurrence) or belief (revisable understanding). valid_for_seconds starts at the original observation, never at reading or writing time. evidence lists actual observations including failures. set/retire requires the exact revision (0 for new key), value and evidence_id; new evidence must be later. Legacy entries remain unclassified; classify with key/revision/kind/reason preserves their value and observation time, cannot extend an old expiry, and does not establish correctness. Rewriting prose does not update these records; goals and World facts retain their own authority.',
      parameters: { type: 'object', additionalProperties: false, properties: {
        operation: { type: 'string', enum: ['read', 'history', 'evidence', 'set', 'retire', 'classify'] },
        kind: { type: 'string', enum: [...CLAIM_KINDS, 'legacy'], description: 'set/classify: observation, event or belief. read/history: legacy selects unclassified old entries.' },
        reason: { type: 'string', minLength: 1, maxLength: 600, description: 'classify: interpretation of the original evidence; original value and observation time are retained.' },
        key: { type: 'string', minLength: 1, maxLength: 120 },
        expected_revision: { type: 'integer', minimum: 0 }, value: { type: 'string', minLength: 1, maxLength: 600 },
        evidence_id: { type: 'string', maxLength: 80, description: 'Exact id returned by evidence. A task number, message id or reference is not this id.' },
        expires_at: { type: 'string' },
        valid_for_seconds: { type: 'number', exclusiveMinimum: 0, description: 'Expiry relative to the original observation time. An already expired observation stays historical.' },
        include_inactive: { type: 'boolean', description: 'read: also include expired and retired latest versions for explicit review; does not reactivate them.' },
        query: { type: 'string', maxLength: 300,
          description: 'Evidence search: whitespace-separated literal terms, case-insensitive; all terms must occur in one retained observation (source, reference, id or text). Omit to list recent observations. Searches up to 128 retained observations, newest observation time first; offset/limit paginate results. Read a truncated preview in full using its id before interpreting it.' },
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
      if (itemText(record.item).startsWith('[tool failed]')) return record;
      const call = calls.get(record.item.call_id);
      if (!call || call.args.history === true || call.args.operation === 'history') return record;
      if (call.name === 'memory_record' && ['read', 'set', 'retire', 'classify'].includes(call.args.operation)) {
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
