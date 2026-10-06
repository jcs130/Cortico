/** Persona activity agenda: persistent intentions and evidence; no World execution. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const AGENDA_FILE = 'activity-agenda.json';
export const AGENDA_SUMMARY_MAX_CHARS = 1_200;
export const AGENDA_MAX_ITEMS = 8;
export interface AgendaItem {
  id: string;
  title: string;
  why: string;
  doneWhen: string;
  when: string;
  ifBlocked: string;
  references: string[];
}
export interface AgendaPlan { summary: string; items: AgendaItem[]; }
type AgendaStatus = 'queued' | 'active' | 'deferred' | 'done';
interface AcceptedItem extends AgendaItem { status: AgendaStatus; note: string; updatedAt: string; }
interface Proposal extends AgendaPlan { baseRevision: number; capturedAt: string; }
interface Ledger {
  version: 1;
  revision: number;
  summary: string;
  items: AcceptedItem[];
  proposal: Proposal | null;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === 'string' && value.length <= max && (empty || !!value.trim());
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function validItem(value: unknown): value is AgendaItem {
  return object(value) && text(value.id, 80) && text(value.title, 100)
    && text(value.why, 240) && text(value.doneWhen, 240) && text(value.when, 240)
    && text(value.ifBlocked, 240) && Array.isArray(value.references)
    && value.references.length <= 4 && value.references.every(ref => text(ref, 160));
}
function validPlan(value: unknown): value is AgendaPlan {
  return object(value) && text(value.summary, 300) && Array.isArray(value.items)
    && value.items.length >= 1 && value.items.length <= AGENDA_MAX_ITEMS
    && value.items.every(validItem) && new Set(value.items.map(item => item.id)).size === value.items.length;
}
function validAccepted(value: unknown): value is AcceptedItem {
  return validItem(value) && object(value) && ['queued', 'active', 'deferred', 'done'].includes(String(value.status))
    && text(value.note, 400, true) && timestamp(value.updatedAt);
}
function cleanItem(item: AgendaItem): AgendaItem {
  return { id: item.id, title: item.title, why: item.why, doneWhen: item.doneWhen,
    when: item.when, ifBlocked: item.ifBlocked, references: [...item.references] };
}
function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

export class ActivityAgenda {
  private readonly file: string;
  private ledger: Ledger = { version: 1, revision: 0, summary: '', items: [], proposal: null };
  constructor(memoryDir: string, private readonly now: () => number = Date.now) {
    this.file = join(memoryDir, AGENDA_FILE);
    if (!existsSync(this.file)) return;
    const saved: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
    if (!object(saved) || saved.version !== 1 || !Number.isSafeInteger(saved.revision) || Number(saved.revision) < 0
      || !text(saved.summary, 300, true) || !Array.isArray(saved.items) || saved.items.length > AGENDA_MAX_ITEMS
      || !saved.items.every(validAccepted) || saved.items.filter(item => item.status === 'active').length > 1
      || new Set(saved.items.map(item => item.id)).size !== saved.items.length
      || !(saved.proposal === null || (validPlan(saved.proposal) && object(saved.proposal)
        && Number.isSafeInteger(saved.proposal.baseRevision) && Number(saved.proposal.baseRevision) >= 0
        && timestamp(saved.proposal.capturedAt)))) {
      throw new Error(`${AGENDA_FILE} 格式无效；原文件未修改`);
    }
    this.ledger = saved as unknown as Ledger;
  }
  revision(): number { return this.ledger.revision; }
  state(): Ledger { return structuredClone(this.ledger); }
  /** A proposal is a candidate, never an adopted intention or a completed action. */
  propose(reply: string, baseRevision: number, capturedAt: string): string {
    const json = reply.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { return '[日程候选未保存] 后台输出不是有效 JSON；现有日程保留。'; }
    if (!validPlan(parsed) || !Number.isSafeInteger(baseRevision) || baseRevision < 0 || !timestamp(capturedAt)) {
      return '[日程候选未保存] 缺少明确的阶段、完成条件或受阻处理；现有日程保留。';
    }
    this.save({ ...this.ledger, proposal: { summary: parsed.summary,
      items: parsed.items.map(cleanItem), baseRevision, capturedAt } });
    return this.summary();
  }
  operate(args: Record<string, unknown>): string {
    if (Object.keys(args).some(key => !['operation', 'id', 'status', 'note'].includes(key))) return '[日程输入错误] 含有未知参数。';
    if (args.operation === 'read') return JSON.stringify(this.ledger);
    if (args.operation === 'adopt') {
      const draft = this.ledger.proposal;
      if (!draft) return '[日程] 没有候选日程；可请求后台重新规划。';
      if (draft.baseRevision !== this.ledger.revision) return '[日程] 候选生成期间已有新进展，不能覆盖；先请求重新规划。';
      const items = draft.items.map(item => {
        const old = this.ledger.items.find(previous => previous.id === item.id
          && previous.title === item.title && previous.doneWhen === item.doneWhen);
        return { ...cleanItem(item), status: old?.status ?? 'queued' as AgendaStatus,
          note: old?.note ?? '', updatedAt: old?.updatedAt ?? this.stamp() };
      });
      this.save({ ...this.ledger, revision: this.ledger.revision + 1, summary: draft.summary, items, proposal: null });
      return this.summary();
    }
    const item = this.ledger.items.find(entry => entry.id === args.id);
    if (!item) return '[日程输入错误] 提供当前日程的有效 id；用 read 查看完整日程。';
    if (args.operation === 'focus') {
      if (item.status === 'done') return '[日程] 此阶段已完成。新的目的需要重新规划，不能重放旧阶段。';
      if (item.status === 'active') return this.summary();
      const items = this.ledger.items.map(entry => entry.id === item.id
        ? { ...entry, status: 'active' as const, updatedAt: this.stamp() }
        : entry.status === 'active' ? { ...entry, status: 'queued' as const } : entry);
      this.save({ ...this.ledger, revision: this.ledger.revision + 1, items });
      return this.summary();
    }
    if (args.operation !== 'update' || !text(args.note, 400)
      || (args.status !== undefined && !['queued', 'deferred', 'done'].includes(String(args.status)))) {
      return '[日程输入错误] update 需要 note 记录实际进展或受阻依据；status 可为 queued/deferred/done。';
    }
    if (item.status === 'done') return '[日程] 已完成记录保留；新的目的请重新规划。';
    const items = this.ledger.items.map(entry => entry.id === item.id
      ? { ...entry, status: (args.status ?? entry.status) as AgendaStatus, note: args.note as string, updatedAt: this.stamp() }
      : entry);
    this.save({ ...this.ledger, revision: this.ledger.revision + 1, items });
    return this.summary();
  }
  summary(): string {
    const active = this.ledger.items.find(item => item.status === 'active');
    const next = this.ledger.items.filter(item => item.status === 'queued');
    const draft = this.ledger.proposal;
    const lines = ['[活动日程；意图与执行结果分别记录]',
      ...(this.ledger.summary ? [clip(this.ledger.summary, 160)] : []),
      active ? `当前 id=${JSON.stringify(active.id)} ${clip(active.title, 80)}；够了就收尾：${clip(active.doneWhen, 160)}；条件：${clip(active.when, 100)}；受阻：${clip(active.ifBlocked, 100)}${active.note ? '；最近证据：' + clip(active.note, 160) : ''}` : '当前阶段尚未选择；结合现场自行选下一项。',
      ...next.map(item => `候选 id=${JSON.stringify(item.id)} ${clip(item.title, 80)}`),
      ...(this.ledger.items.some(item => item.status === 'deferred') ? ['受阻阶段留在日程中，read 可查恢复条件。'] : []),
      ...(draft ? [`后台候选${draft.baseRevision === this.ledger.revision ? '待核验采用' : '已落后于当前进展，需重规划'}：${clip(draft.summary, 180)}；用 activity_plan read 查看。`] : []),
      '阶段变化用 activity_plan update 留证据；详情和资料按需 read；日程不阻止交流、应急和新的选择。'];
    const result = lines.join('\n');
    return result.length <= AGENDA_SUMMARY_MAX_CHARS ? result : result.slice(0, AGENDA_SUMMARY_MAX_CHARS - 1) + '…';
  }
  private stamp(): string { return new Date(this.now()).toISOString(); }
  private save(next: Ledger): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(temporary, this.file);
    this.ledger = next;
  }
}
