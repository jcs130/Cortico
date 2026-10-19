/** Persona 待办：Memory 保存任务，Core 定时器只索引到期时间；事件触发仅表示可以复核。 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreApi, EventEnvelope, TimerEntry } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { matchingWorkState, readWorldWorkStates, workReferenceOf, type WorldWorkReference, type WorldWorkState } from './work-state-context.ts';

export const PENDING_WORK_OWNER = 'cortiv.pending-work';
export const PENDING_WORK_ID_MAX_CHARS = 80;
export const PENDING_WORK_NOTE_MAX_CHARS = 600;
export const PENDING_WORK_SELECTOR_MAX_CHARS = 160;
export const PENDING_WORK_LIST_MAX_ENTRIES = 20;
/** 活跃待办进入每轮上下文的字符预算；完整记录仍可通过 list 读取。 */
export const PENDING_WORK_SUMMARY_MAX_CHARS = 1600;

interface EventFilter {
  source?: string;
  type?: string;
  sender_key?: string;
  contains?: string;
}

interface Evidence {
  kind: 'event' | 'timer' | 'resolve' | 'cancel';
  at: string;
  cursor?: number;
  summary: string;
  workState?: WorldWorkState;
}

export interface PendingIntent {
  id: string;
  status: string;
  worlds?: readonly string[];
}
export interface PendingWorkOptions {
  worlds?: () => readonly string[];
  intents?: () => readonly PendingIntent[];
}
interface PendingContext {
  worlds?: ReadonlySet<string>;
  intents?: ReadonlyMap<string, PendingIntent>;
}

interface PendingEntry {
  id: string;
  note: string;
  status: 'waiting' | 'ready' | 'resolved' | 'cancelled';
  registeredAt: string;
  dueAt?: string;
  waitFor?: EventFilter;
  timerId?: string;
  evidence?: Evidence;
  workRef?: WorldWorkReference;
  intentId?: string;
  revision?: number;
  updatedAt?: string;
  reviewedAt?: string;
  reviewResult?: string;
  request?: { id: string; fingerprint: string };
  history?: Array<Omit<PendingEntry, 'history'>>;
}

const FILTER_KEYS = ['source', 'type', 'sender_key', 'contains'] as const;
const STATUSES = new Set(['waiting', 'ready', 'resolved', 'cancelled']);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value: unknown, max: number, required = true): value is string {
  return typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0);
}

function filterOf(value: unknown): EventFilter | null {
  if (!object(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !FILTER_KEYS.includes(key as typeof FILTER_KEYS[number]))) return null;
  if (keys.some((key) => !bounded(value[key], PENDING_WORK_SELECTOR_MAX_CHARS))) return null;
  return { ...value } as EventFilter;
}

function stamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validEntry(value: unknown): value is PendingEntry {
  if (!object(value) || !bounded(value.id, PENDING_WORK_ID_MAX_CHARS)
    || !bounded(value.note, PENDING_WORK_NOTE_MAX_CHARS) || !STATUSES.has(String(value.status))
    || !stamp(value.registeredAt)) return false;
  if (value.dueAt !== undefined && !stamp(value.dueAt)) return false;
  if (value.waitFor !== undefined && !filterOf(value.waitFor)) return false;
  if (value.dueAt === undefined && value.waitFor === undefined) return false;
  if (value.timerId !== undefined && !bounded(value.timerId, 160)) return false;
  if (value.workRef !== undefined && !workReferenceOf(value.workRef)) return false;
  if (value.intentId !== undefined && !bounded(value.intentId, 80)) return false;
  if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1)) return false;
  if (value.updatedAt !== undefined && !stamp(value.updatedAt)) return false;
  if (value.reviewedAt !== undefined && !stamp(value.reviewedAt)) return false;
  if (value.reviewResult !== undefined && !bounded(value.reviewResult, PENDING_WORK_NOTE_MAX_CHARS)) return false;
  if (value.request !== undefined && (!object(value.request) || !bounded(value.request.id, 160)
    || typeof value.request.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.request.fingerprint))) return false;
  if (value.history !== undefined && (!Array.isArray(value.history)
    || value.history.some(row => !object(row) || row.history !== undefined || !validEntry(row)))) return false;
  if (Array.isArray(value.history) && value.history.length) {
    const base = value.history[0].revision ?? 1;
    if (value.history.some((row, index) => row.id !== value.id || (row.revision ?? 1) !== base + index)
      || value.revision !== base + value.history.length) return false;
  }
  if (value.evidence !== undefined) {
    if (!object(value.evidence) || !['event', 'timer', 'resolve', 'cancel'].includes(String(value.evidence.kind))
      || !stamp(value.evidence.at) || !bounded(value.evidence.summary, PENDING_WORK_NOTE_MAX_CHARS, false)
      || (value.evidence.cursor !== undefined && (!Number.isInteger(value.evidence.cursor) || Number(value.evidence.cursor) < 0))) return false;
    if (value.evidence.workState !== undefined && (!object(value.evidence.workState)
      || readWorldWorkStates(String(value.evidence.workState.world), [value.evidence.workState]).length !== 1
      || !value.workRef)) return false;
  }
  return true;
}

function clip(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= chars ? flat : `${flat.slice(0, chars - 1)}…`;
}

function idLabel(id: string): string {
  return `id=${JSON.stringify(id)}`;
}

export class PendingWork {
  private readonly file: string;
  private entries: PendingEntry[] = [];
  private retiredRevision = 0;
  private readonly worldWorkStates = new Map<string, WorldWorkState[]>();

  constructor(
    private readonly core: CoreApi,
    private readonly memoryDir: string,
    private readonly timezone: () => string,
    private readonly options: PendingWorkOptions = {},
  ) {
    this.file = join(memoryDir, 'pending-work.json');
    if (!existsSync(this.file)) return;
    const saved: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
    if (!object(saved) || saved.version !== 1 || !Array.isArray(saved.entries)
      || !saved.entries.every(validEntry)
      || new Set(saved.entries.map((entry) => entry.id)).size !== saved.entries.length) {
      throw new Error('pending-work.json 格式无效；原文件未修改');
    }
    this.entries = saved.entries;
    if (saved.retirementRevision !== undefined && (!Number.isSafeInteger(saved.retirementRevision) || Number(saved.retirementRevision) < 0))
      throw new Error('pending-work.json retirementRevision 无效；原文件未修改');
    this.retiredRevision = saved.retirementRevision === undefined
      ? this.entries.filter(item => item.status === 'resolved' || item.status === 'cancelled').length : Number(saved.retirementRevision);
  }

  retirementRevision(): number { return this.retiredRevision; }

  /** 在到期处理器注册后调用；恢复索引，并为离线期间到期的待办生成一次复核提示。 */
  restore(): void {
    for (const timer of [...this.core.timers.list()]) {
      if (timer.payload.owner !== PENDING_WORK_OWNER) continue;
      const item = this.entries.find((entry) => entry.id === timer.payload.workId);
      if (!item || item.status !== 'waiting' || !item.dueAt) this.core.timers.cancel(timer.id);
    }
    for (const item of [...this.entries]) {
      if (item.status !== 'waiting' || !item.dueAt) continue;
      if (Date.parse(item.dueAt) <= Date.now()) {
        this.ready(item, { kind: 'timer', at: this.now(), summary: `复核时间已到：${item.dueAt}` });
        continue;
      }
      const owned = this.ownedTimers(item.id);
      const matching = owned.find((entry) => Date.parse(entry.atIso) === Date.parse(item.dueAt!));
      const id = matching?.id ?? this.setTimer(item);
      try {
        if (item.timerId !== id) this.commit({ ...item, timerId: id });
      } catch (error) {
        if (!matching) this.core.timers.cancel(id);
        throw error;
      }
      for (const timer of owned) if (timer.id !== id) this.core.timers.cancel(timer.id);
    }
  }

  operate(args: Record<string, unknown>): string {
    if (Object.keys(args).some((key) => !['operation', 'id', 'note', 'after_seconds', 'wait_for', 'result', 'include_closed', 'offset', 'limit', 'work_ref',
      'intent_id', 'expected_revision', 'request_id', 'world', 'status', 'needs_review', 'query'].includes(key))) {
      return '[pending_work 输入错误] 含有未知参数。';
    }
    if (args.expected_revision !== undefined && (!Number.isSafeInteger(args.expected_revision) || Number(args.expected_revision) < 0))
      return '[pending_work 输入错误] expected_revision 必须为非负整数。';
    if (args.operation === 'list') return this.list(args);
    if (args.operation === 'read' || args.operation === 'history') return this.read(args);
    if (args.operation === 'defer') return this.defer(args);
    if (args.operation === 'link' || args.operation === 'review') {
      const item = typeof args.id === 'string' ? this.findByInputId(args.id) : undefined;
      if (!item) return '[pending_work 输入错误] 先 read 获取已有 id 和 revision。';
      const conflict = this.revisionError(item, args.expected_revision);
      if (conflict) return conflict;
      if (!bounded(args.result, PENDING_WORK_NOTE_MAX_CHARS)) return '[pending_work 输入错误] link/review 需要 result 中的核验依据。';
      if (args.operation === 'link') {
        const error = this.intentError(args.intent_id);
        if (error) return error;
        if (['resolved', 'cancelled'].includes(item.status)) return '[pending_work 输入错误] 已关闭的提醒不能链接新的目的；请为新目的使用新 id。';
      }
      const correctedFilter = args.operation === 'review' && args.wait_for !== undefined ? filterOf(args.wait_for) : undefined;
      if (correctedFilter === null) return '[pending_work 输入错误] wait_for 需要非空 source/type/sender_key/contains 条件。';
      const selectorError = correctedFilter && this.eventSourceError(correctedFilter);
      if (selectorError) return selectorError;
      this.commit({ ...item, ...(args.operation === 'link' ? { intentId: args.intent_id as string } : {}),
        ...(correctedFilter ? { waitFor: correctedFilter } : {}),
        reviewedAt: this.now(), reviewResult: args.result });
      return this.read({ operation: 'read', id: item.id });
    }
    if (args.operation === 'bind') {
      const item = typeof args.id === 'string' ? this.findByInputId(args.id) : undefined;
      const ref = workReferenceOf(args.work_ref);
      if (!item || !ref) return '[pending_work 输入错误] bind 需要现有 id 和完整 work_ref；从当前 World workStates 读取身份。';
      if (item.status === 'resolved' || item.status === 'cancelled') return '[pending_work] 该待办已关闭；绑定未使它重新开放。';
      const conflict = this.revisionError(item, args.expected_revision);
      if (conflict) return conflict;
      if (this.options.worlds && !this.options.worlds().includes(ref.world)) return '[pending_work 输入错误] work_ref.world 不是当前配置的 World id。';
      this.commit({ ...item, workRef: ref });
      this.reconcileWorldWork(ref.world, this.worldWorkStates.get(ref.world));
      return `[pending_work] ${idLabel(item.id)} 已绑定 ${ref.world}/${ref.subject} 批次 ${ref.instance}；状态 ${this.findByInputId(item.id)!.status}。`;
    }
    if (args.operation !== 'resolve' && args.operation !== 'cancel') return '[pending_work 输入错误] operation 必须为 defer/read/list/history/link/review/resolve/cancel/bind。';
    const item = typeof args.id === 'string' ? this.findByInputId(args.id) : undefined;
    if (!bounded(item?.id ?? args.id, PENDING_WORK_ID_MAX_CHARS)) return '[pending_work 输入错误] 提供有效的待办 id。';
    if (args.result !== undefined && !bounded(args.result, PENDING_WORK_NOTE_MAX_CHARS, false)) return '[pending_work 输入错误] result 必须为长度不超过 600 的文本。';
    if (!item) return '[pending_work 输入错误] 找不到该待办 id。';
    if (item.status === 'resolved' || item.status === 'cancelled') return `[pending_work] ${idLabel(item.id)} 已${item.status === 'resolved' ? '结清' : '取消'}，没有再次改变。`;
    const conflict = this.revisionError(item, args.expected_revision);
    if (conflict) return conflict;
    if (!bounded(args.result, PENDING_WORK_NOTE_MAX_CHARS)) return '[pending_work 输入错误] resolve/cancel 需要 result 中的核验依据或明确撤销原因。';
    const kind = args.operation;
    const next: PendingEntry = { ...item, status: kind === 'resolve' ? 'resolved' : 'cancelled',
      evidence: { kind, at: this.now(), summary: typeof args.result === 'string' ? args.result : '' } };
    delete next.timerId;
    this.commit(next);
    this.cancelTimers(next);
    this.log(next);
    return `[pending_work] ${idLabel(item.id)} 已${kind === 'resolve' ? '由你结清' : '取消'}。`;
  }

  onDelivery(events: EventEnvelope[]): void {
    for (const item of this.entries) {
      if (item.status !== 'waiting' || !item.waitFor) continue;
      const event = events.find((entry) => this.matches(item, entry));
      if (!event) continue;
      this.ready(item, {
        kind: 'event', at: event.ts, cursor: event.cursor,
        summary: clip(`${event.source}/${event.type}${event.senderKey ? ` 来自 ${clip(event.senderKey, 80)}` : ''}：${clip(event.text, 240)}`, PENDING_WORK_NOTE_MAX_CHARS),
      });
    }
  }

  onDue(entry: TimerEntry): void {
    if (entry.payload.owner !== PENDING_WORK_OWNER) return;
    const item = this.entries.find((work) => work.id === entry.payload.workId);
    if (!item || item.status !== 'waiting' || item.timerId !== entry.id
      || !item.dueAt || Date.parse(entry.atIso) !== Date.parse(item.dueAt)) return;
    this.ready(item, { kind: 'timer', at: this.now(), summary: `复核时间已到：${item.dueAt}` });
  }

  summary(): string {
    const context = this.context();
    const active = this.activeEntries(context);
    const retired = this.entries.filter(item => item.evidence?.workState && ['resolved', 'cancelled'].includes(item.status))
      .sort((a, b) => Date.parse(b.evidence!.at) - Date.parse(a.evidence!.at)).slice(0, 3);
    if (active.length === 0 && retired.length === 0) return '';
    const reviewCount = active.filter(item => this.issues(item, context).length).length;
    const lines = [`[待办：等待不占用前台，待复核不代表完成；开放 ${active.length} 项，其中 ${reviewCount} 项需核验登记信息]`];
    if (retired.length) lines.push('[已核验退出当前待办] ' + retired.map(item => `${idLabel(item.id)} ${clip(item.workRef!.subject, 48)} ${item.status}；依据 ${item.evidence!.workState!.observedAt}`).join('；'));
    for (const [index, item] of active.entries()) {
      const line = this.line(item, false, context);
      const rest = `\n还有 ${active.length - index} 项；pending_work list 可按 intent_id/world/needs_review/query 筛选，read 按 id 展开。`;
      if (lines.join('\n').length + line.length + rest.length + 1 > PENDING_WORK_SUMMARY_MAX_CHARS) {
        lines.push(rest.trim());
        break;
      }
      lines.push(line);
    }
    return lines.join('\n');
  }

  reconcileWorldWork(world: string, observations: unknown): void {
    const states = readWorldWorkStates(world, observations);
    this.worldWorkStates.set(world, states);
    for (const item of [...this.entries]) {
      if (!item.workRef || !['waiting', 'ready'].includes(item.status)) continue;
      const state = matchingWorkState(item.workRef, states);
      if (!state || state.status === 'active') continue;
      const next: PendingEntry = { ...item, status: state.status === 'completed' ? 'resolved' : 'cancelled',
        evidence: { kind: state.status === 'completed' ? 'resolve' : 'cancel', at: this.now(),
          summary: clip(`World ${world} ${state.observedAt} ${state.evidence.text}`, PENDING_WORK_NOTE_MAX_CHARS), workState: state } };
      delete next.timerId;
      this.commit(next); this.cancelTimers(next); this.log(next);
    }
  }

  private list(args: Record<string, unknown>): string {
    if (args.include_closed !== undefined && typeof args.include_closed !== 'boolean') return '[pending_work 输入错误] include_closed 必须为布尔值。';
    if (args.offset !== undefined && (!Number.isInteger(args.offset) || Number(args.offset) < 0)) return '[pending_work 输入错误] offset 必须为非负整数。';
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > PENDING_WORK_LIST_MAX_ENTRIES)) {
      return `[pending_work 输入错误] limit 必须为 1 至 ${PENDING_WORK_LIST_MAX_ENTRIES} 的整数。`;
    }
    const offset = Number(args.offset ?? 0);
    const limit = Number(args.limit ?? 10);
    const context = this.context();
    const active = this.activeEntries(context);
    const filtered = this.select(args.include_closed === true ? this.entries : active, args, context);
    if (typeof filtered === 'string') return filtered;
    const visible = filtered;
    const page = visible.slice(offset, offset + limit);
    const next = offset + page.length < visible.length ? offset + page.length : null;
    const counts = `活跃 ${active.length} 项，已结清 ${this.entries.filter((item) => item.status === 'resolved').length} 项，已取消 ${this.entries.filter((item) => item.status === 'cancelled').length} 项`;
    return `[pending_work] ${counts}；匹配 ${visible.length} 项；本页 ${page.length} 项，offset=${offset}，next_offset=${next ?? '无'}。`
      + (page.length > 0 ? `\n${page.map((item) => this.line(item, true, context)).join('\n')}` : '\n本页没有待办。');
  }

  private activeEntries(context: PendingContext): PendingEntry[] {
    const activeIds = new Set([...context.intents?.values() ?? []].filter(item => item.status === 'active').map(item => item.id));
    return this.entries.map((item, order) => ({ item, order }))
      .filter(({ item }) => item.status === 'ready' || item.status === 'waiting')
      .sort((a, b) => Number(!!b.item.intentId && activeIds.has(b.item.intentId)) - Number(!!a.item.intentId && activeIds.has(a.item.intentId))
        || Date.parse(b.item.registeredAt) - Date.parse(a.item.registeredAt) || b.order - a.order).map(({ item }) => item);
  }

  private defer(args: Record<string, unknown>): string {
    const existing = typeof args.id === 'string' ? this.findByInputId(args.id) : undefined;
    if (!bounded(existing?.id ?? args.id, PENDING_WORK_ID_MAX_CHARS)) return '[pending_work 输入错误] defer 需要自己选择的稳定 id；同一提醒复用原 id，先 read/list 对账。';
    if (existing && ['resolved', 'cancelled'].includes(existing.status)) return '[pending_work 已关闭] 原 id 和终态保留；新的事项使用新 id。';
    if (args.request_id !== undefined && !bounded(args.request_id, 160)) return '[pending_work 输入错误] request_id 必须为非空文本且不超过160字符。';
    const selector = args.wait_for === undefined ? undefined : filterOf(args.wait_for);
    if (selector === null) return '[pending_work 输入错误] wait_for 必须含非空 source/type/sender_key/contains 条件，条件按 AND 匹配。';
    const workRef = args.work_ref === undefined ? existing?.workRef : workReferenceOf(args.work_ref);
    if (args.work_ref !== undefined && !workRef) return '[pending_work 输入错误] work_ref 必须含完整的 World、作用域、任务身份、批次和版本。';
    if (workRef && this.options.worlds && !this.options.worlds().includes(workRef.world))
      return '[pending_work 输入错误] work_ref.world 不是当前配置的 World id。';
    const fingerprint = createHash('sha256').update(JSON.stringify([
      existing?.id ?? args.id, args.note, args.after_seconds ?? null,
      selector ? FILTER_KEYS.map(key => selector[key] ?? null) : null,
      args.intent_id ?? null,
      args.work_ref !== undefined && workRef ? [workRef.world, workRef.scope.realm, workRef.scope.account, workRef.scope.agent,
        workRef.subject, workRef.instance, workRef.revision] : null,
    ])).digest('hex');
    if (args.request_id) {
      const previous = this.entries.flatMap(entry => [entry, ...entry.history ?? []]).find(item => item.request?.id === args.request_id);
      if (previous) return previous.request!.fingerprint === fingerprint
        ? `[pending_work] request_id=${JSON.stringify(args.request_id)} 已登记；未重设等待或定时器。\n${this.read({ operation: 'read', id: previous.id })}`
        : '[pending_work 输入错误] 相同 request_id 的内容发生变化；原记录和定时器未修改。';
    }
    if (existing) {
      const conflict = this.revisionError(existing, args.expected_revision);
      if (conflict) return conflict;
    } else if (args.expected_revision !== undefined && args.expected_revision !== 0) return '[pending_work 输入错误] 新 id 的 expected_revision 为0。';
    const intentId = args.intent_id ?? existing?.intentId;
    if (intentId !== undefined) {
      const error = this.intentError(intentId);
      if (error) return error;
    }
    const known = workRef ? matchingWorkState(workRef, [...this.worldWorkStates.get(workRef.world) ?? [],
      ...this.entries.flatMap(item => item.evidence?.workState ? [item.evidence.workState] : [])]) : null;
    if (known && known.status !== 'active') return `[pending_work 已关闭] ${workRef!.subject} 批次 ${workRef!.instance} 已有 ${known.observedAt} 的 ${known.status} 回执；旧意图未重新挂起。依据：${known.evidence.text}`;
    if (args.id !== undefined && !bounded(existing?.id ?? args.id, PENDING_WORK_ID_MAX_CHARS)) return '[pending_work 输入错误] id 必须为非空文本且不超过 80 字符。';
    if (!bounded(args.note, PENDING_WORK_NOTE_MAX_CHARS)) return '[pending_work 输入错误] note 必须为非空文本且不超过 600 字符。';
    const waitFor = selector;
    const selectorError = waitFor && this.eventSourceError(waitFor);
    if (selectorError) return selectorError;
    const delay = args.after_seconds;
    if (delay !== undefined && (typeof delay !== 'number' || !Number.isFinite(delay) || delay <= 0
      || !Number.isFinite(new Date(Date.now() + delay * 1000).getTime()))) return '[pending_work 输入错误] after_seconds 必须为可表示时间的正数。';
    if (delay === undefined && waitFor === undefined) return '[pending_work 输入错误] 至少提供 after_seconds 或 wait_for。';
    const id = existing?.id ?? args.id as string;
    const item: PendingEntry = {
      id, note: args.note, status: 'waiting', registeredAt: this.now(),
      reviewedAt: this.now(),
      ...(intentId ? { intentId: intentId as string } : {}),
      ...(args.request_id ? { request: { id: args.request_id as string, fingerprint } } : {}),
      ...(workRef ? { workRef } : {}),
      ...(typeof delay === 'number' ? { dueAt: new Date(Date.now() + delay * 1000).toISOString() } : {}),
      ...(waitFor ? { waitFor } : {}),
    };
    if (item.dueAt) item.timerId = this.setTimer(item);
    try {
      this.commit(item);
    } catch (error) {
      if (item.timerId) this.core.timers.cancel(item.timerId);
      throw error;
    }
    this.cancelTimers(item, item.timerId);
    this.log(item);
    return `[pending_work] ${idLabel(id)} revision=${this.findByInputId(id)!.revision} 已挂到后台等待${item.dueAt ? `，复核时间 ${item.dueAt}` : ''}。触发只会提醒复核，未判定完成；前台可以继续其他事情。`;
  }

  private revisionError(item: PendingEntry, expected: unknown): string | null {
    return expected === (item.revision ?? 1) ? null
      : `[pending_work 输入错误] 版本冲突：${idLabel(item.id)} 当前 revision=${item.revision ?? 1}；先 read，修改时带 expected_revision。原记录未修改。`;
  }

  private eventSourceError(filter: EventFilter): string | null {
    return filter.source && (['core', 'persona'].includes(filter.source)
      || (this.options.worlds && !this.options.worlds().includes(filter.source)))
      ? '[pending_work 输入错误] wait_for.source 必须是外部事件的 World id，不能拼接事件类型；type 单独填写。当前 World ids：'
        + JSON.stringify(this.options.worlds?.() ?? []) + '。原记录未修改。' : null;
  }

  private intentError(id: unknown): string | null {
    if (!bounded(id, 80)) return '[pending_work 输入错误] intent_id 需要 activity_plan 中已采用目标的精确 id。';
    const intent = this.options.intents?.().find(item => item.id === id);
    return intent && !['done', 'cancelled'].includes(intent.status) ? null
      : '[pending_work 输入错误] intent_id 未找到开放的已采用目标；先 activity_plan read 核验。';
  }

  private context(): PendingContext {
    return { ...(this.options.worlds ? { worlds: new Set(this.options.worlds()) } : {}),
      ...(this.options.intents ? { intents: new Map(this.options.intents().map(item => [item.id, item])) } : {}) };
  }

  private issues(item: PendingEntry, context: PendingContext): string[] {
    const issues: string[] = [];
    if (!item.reviewedAt) issues.push('legacy_unreviewed');
    if (item.waitFor?.source && (['core', 'persona'].includes(item.waitFor.source)
      || (context.worlds && !context.worlds.has(item.waitFor.source)))) issues.push('unknown_event_source');
    if (item.intentId && context.intents) {
      const intent = context.intents.get(item.intentId);
      if (!intent) issues.push('unknown_intent');
      else if (['done', 'cancelled'].includes(intent.status)) issues.push('closed_intent');
    }
    return issues;
  }

  private select(entries: PendingEntry[], args: Record<string, unknown>, context: PendingContext): PendingEntry[] | string {
    if (args.status !== undefined && !STATUSES.has(String(args.status))) return '[pending_work 输入错误] status 必须为 waiting/ready/resolved/cancelled。';
    if (args.needs_review !== undefined && typeof args.needs_review !== 'boolean') return '[pending_work 输入错误] needs_review 必须为布尔值。';
    if (args.query !== undefined && !bounded(args.query, 300, false)) return '[pending_work 输入错误] query 必须为不超过300字符的文本。';
    for (const key of ['world', 'intent_id', 'id']) if (args[key] !== undefined && !bounded(args[key], key === 'id' ? 81 : 80))
      return `[pending_work 输入错误] ${key} 需要有效的精确标识。`;
    const terms = String(args.query ?? '').toLowerCase().split(/\s+/u).filter(Boolean);
    const exact = typeof args.id === 'string' ? this.findByInputId(args.id)?.id : undefined;
    return entries.filter(item => (args.id === undefined || item.id === exact)
      && (args.intent_id === undefined || item.intentId === args.intent_id)
      && (args.status === undefined || item.status === args.status)
      && (args.needs_review === undefined || !!this.issues(item, context).length === args.needs_review)
      && (args.world === undefined || item.waitFor?.source === args.world || item.workRef?.world === args.world
        || !!context.intents?.get(item.intentId ?? '')?.worlds?.includes(String(args.world)))
      && terms.every(term => `${item.id}\n${item.note}\n${item.intentId ?? ''}`.toLowerCase().includes(term)));
  }

  private read(args: Record<string, unknown>): string {
    const item = typeof args.id === 'string' ? this.findByInputId(args.id) : undefined;
    if (!item) return '[pending_work 输入错误] read/history 需要已有的精确 id；list 可按 world/intent_id/needs_review/query 查询。';
    if (args.operation === 'history') {
      const offset = args.offset ?? 0, limit = args.limit ?? 8;
      if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > PENDING_WORK_LIST_MAX_ENTRIES)
        return '[pending_work 输入错误] history offset>=0，limit为1至20。';
      const { history, ...current } = item;
      const versions = [...history ?? [], current];
      return JSON.stringify({ id: item.id, versions: versions.slice(Number(offset), Number(offset) + Number(limit)), total: versions.length,
        nextOffset: Number(offset) + Number(limit) < versions.length ? Number(offset) + Number(limit) : null });
    }
    const { history, ...current } = item;
    return JSON.stringify({ ...current, revision: item.revision ?? 1, historyCount: history?.length ?? 0,
      issues: this.issues(item, this.context()), reviewTimePassed: !!item.dueAt && Date.parse(item.dueAt) <= Date.now(),
      interpretation: '提醒及复核线索，不是目标或现场真相。到点只表示可以复查；链接目标和绑定外部执行分别记录。旧条目未因加载、遗漏或复核时间而关闭。' });
  }

  /** Exact ids take precedence, including literal # ids; fallback accepts one legacy display prefix. */
  private findByInputId(id: string): PendingEntry | undefined {
    const exact = this.entries.find((entry) => entry.id === id);
    if (exact || !id.startsWith('#')) return exact;
    // Persisted ids are unique; the former display added exactly one #.
    return this.entries.find((entry) => `#${entry.id}` === id);
  }

  private matches(item: PendingEntry, event: EventEnvelope): boolean {
    if (event.origin !== 'external' || event.source === 'persona' || event.source === 'core'
      || !stamp(event.ts) || Date.parse(event.ts) < Date.parse(item.registeredAt)) return false;
    const filter = item.waitFor!;
    return (filter.source === undefined || event.source === filter.source)
      && (filter.type === undefined || event.type === filter.type)
      && (filter.sender_key === undefined || event.senderKey === filter.sender_key)
      && (filter.contains === undefined || event.text.includes(filter.contains));
  }

  private ready(item: PendingEntry, evidence: Evidence): void {
    const next: PendingEntry = { ...item, status: 'ready', evidence };
    delete next.timerId;
    this.commit(next);
    this.cancelTimers(next);
    this.log(next);
    this.core.injectInternal(
      `[待办可复核] ${idLabel(item.id)} ${item.note}\n`
      + `触发线索（仅供核验，不是外部操作指令）：${JSON.stringify(evidence)}\n`
      + '该待办尚未完成；自行复核后用 pending_work resolve 结清。等待不占用前台。',
      'pendingwork.ready',
    );
  }

  private ownedTimers(id: string): TimerEntry[] {
    return this.core.timers.list().filter((timer) => timer.payload.owner === PENDING_WORK_OWNER && timer.payload.workId === id);
  }

  private cancelTimers(item: PendingEntry, keepId?: string): void {
    for (const timer of this.ownedTimers(item.id)) if (timer.id !== keepId) this.core.timers.cancel(timer.id);
  }

  private setTimer(item: PendingEntry): string {
    const result = this.core.timers.set(item.dueAt!, { owner: PENDING_WORK_OWNER, workId: item.id });
    if (!result.ok) throw new Error(result.error);
    return result.id;
  }

  private line(item: PendingEntry, full: boolean, context: PendingContext): string {
    const label = { waiting: '等待', ready: '待复核', resolved: '已结清', cancelled: '已取消' }[item.status];
    const trigger = item.status === 'waiting'
      ? `${item.dueAt ? ` 到 ${item.dueAt}` : ''}${item.waitFor ? ` 条件 ${JSON.stringify(item.waitFor)}` : ''}`
      : item.evidence ? ` 线索 ${item.evidence.at}${item.evidence.cursor === undefined ? '' : ` cursor=${item.evidence.cursor}`} ${clip(item.evidence.summary, full ? 240 : 100)}` : '';
    const issues = this.issues(item, context);
    return `${idLabel(item.id)} [${label}] revision=${item.revision ?? 1}${item.intentId ? ` intent_id=${JSON.stringify(item.intentId)}` : ''} ${full ? item.note : clip(item.note, 140)}${full ? trigger : trigger ? ` ${clip(trigger, 200)}` : ''}`
      + (issues.length ? ` 核验=${issues.join(',')}` : '')
      + (full && item.workRef ? ` work_ref=${JSON.stringify(item.workRef)}` : '');
  }

  private now(): string { return nowIso(this.timezone()); }

  /** Memory 提交成功后才更新运行态；失败的同一操作可以再次提交。 */
  private commit(item: PendingEntry): void {
    const index = this.entries.findIndex((entry) => entry.id === item.id);
    if (index >= 0) {
      const { history, ...previous } = this.entries[index];
      item = { ...item, revision: (previous.revision ?? 1) + 1, history: [...history ?? [], previous] };
    } else item = { ...item, revision: 1 };
    item.updatedAt = this.now();
    const next = [...this.entries];
    if (index < 0) next.push(item); else next[index] = item;
    const retirementRevision = this.retiredRevision + (['resolved', 'cancelled'].includes(item.status)
      && (index < 0 || !['resolved', 'cancelled'].includes(this.entries[index].status)) ? 1 : 0);
    mkdirSync(this.memoryDir, { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, retirementRevision, entries: next }, null, 2), 'utf8');
    renameSync(temporary, this.file);
    this.entries = next;
    this.retiredRevision = retirementRevision;
  }

  private log(item: PendingEntry): void {
    this.core.log.info('后台待办状态更新', { id: item.id, status: item.status, evidence: item.evidence, dueAt: item.dueAt });
  }
}
