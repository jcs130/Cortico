/** Persona activity agenda: persistent intentions and evidence; no World execution. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const AGENDA_FILE = 'activity-agenda.json';
export const AGENDA_SUMMARY_MAX_CHARS = 1_200;
export const AGENDA_MAX_ITEMS = 8;
export const AGENDA_RECENT_COMPLETIONS = 3;
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
type AgendaStatus = 'queued' | 'active' | 'deferred' | 'done' | 'cancelled';
interface AcceptedItem extends AgendaItem { status: AgendaStatus; note: string; updatedAt: string;
  sourceCapturedAt?: string;
  whyUpdatedAt?: string;
  whyHistory?: Array<{ why: string; sourceAt?: string; correctedAt: string; correctionNote: string }>;
  corrections?: Array<{ note: string; updatedAt: string; status?: AgendaStatus }>; }
interface Proposal extends AgendaPlan { baseRevision: number; capturedAt: string; }
interface Ledger {
  version: 1;
  revision: number;
  /** Proposals captured before this correction boundary cannot be reused. */
  premiseRevision?: number;
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
  return validItem(value) && object(value) && ['queued', 'active', 'deferred', 'done', 'cancelled'].includes(String(value.status))
    && text(value.note, 400, true) && timestamp(value.updatedAt)
    && (value.sourceCapturedAt === undefined || timestamp(value.sourceCapturedAt))
    && (value.whyUpdatedAt === undefined || timestamp(value.whyUpdatedAt))
    && (value.whyHistory === undefined || (Array.isArray(value.whyHistory) && value.whyHistory.every(entry =>
      object(entry) && text(entry.why, 240) && text(entry.correctionNote, 400) && timestamp(entry.correctedAt)
      && (entry.sourceAt === undefined || timestamp(entry.sourceAt)))))
    && (value.corrections === undefined || (Array.isArray(value.corrections) && value.corrections.every(entry =>
      object(entry) && text(entry.note, 400, true) && timestamp(entry.updatedAt)
      && (entry.status === undefined || ['queued', 'active', 'deferred', 'done', 'cancelled'].includes(String(entry.status))))));
}
function closed(item: AcceptedItem): boolean { return item.status === 'done' || item.status === 'cancelled'; }
function restoredCompletion(item: AcceptedItem): boolean { return !!item.corrections?.some(entry => entry.status === 'done'); }
function closedLabel(item: AcceptedItem): string { return item.status === 'cancelled' ? '已撤销' : '已完成'; }
function cleanItem(item: AgendaItem): AgendaItem {
  return { id: item.id, title: item.title, why: item.why, doneWhen: item.doneWhen,
    when: item.when, ifBlocked: item.ifBlocked, references: [...item.references] };
}
function currentItem({ whyHistory: _history, ...item }: AcceptedItem): Omit<AcceptedItem, 'whyHistory'> { return item; }
function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

/** Each state section keeps a reading window; omitted detail remains in the ledger. */
function section(lines: string[], budget: number): string {
  const text = lines.join('\n');
  if (text.length <= budget) return text;
  const omitted = '\n[其余未展开；activity_plan read 查看]';
  const kept: string[] = [];
  for (const line of lines) {
    if ([...kept, line].join('\n').length + omitted.length > budget) break;
    kept.push(line);
  }
  return kept.length ? kept.join('\n') + omitted : omitted.trim().slice(0, budget);
}

export class ActivityAgenda {
  private readonly file: string;
  private ledger: Ledger = { version: 1, revision: 0, summary: '', items: [], proposal: null };
  constructor(memoryDir: string, private readonly now: () => number = Date.now) {
    this.file = join(memoryDir, AGENDA_FILE);
    if (!existsSync(this.file)) return;
    const saved: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
    if (!object(saved) || saved.version !== 1 || !Number.isSafeInteger(saved.revision) || Number(saved.revision) < 0
      || (saved.premiseRevision !== undefined && (!Number.isSafeInteger(saved.premiseRevision)
        || Number(saved.premiseRevision) < 0 || Number(saved.premiseRevision) > Number(saved.revision)))
      || !text(saved.summary, 300, true) || !Array.isArray(saved.items) || !saved.items.every(validAccepted)
      || saved.items.filter(item => !closed(item) && !restoredCompletion(item)).length > AGENDA_MAX_ITEMS
      || saved.items.filter(item => item.status === 'active').length > 1
      || new Set(saved.items.map(item => item.id)).size !== saved.items.length
      || !(saved.proposal === null || (validPlan(saved.proposal) && object(saved.proposal)
        && Number.isSafeInteger(saved.proposal.baseRevision) && Number(saved.proposal.baseRevision) >= 0
        && timestamp(saved.proposal.capturedAt)))) {
      throw new Error(`${AGENDA_FILE} 格式无效；原文件未修改`);
    }
    this.ledger = saved as unknown as Ledger;
    // Older correction records have timestamps but no proposal dependency revision.
    // Retire their candidate once rather than treating an unknown dependency as current.
    if (this.ledger.premiseRevision === undefined && this.ledger.items.some(item => item.whyUpdatedAt !== undefined)) {
      this.save({ ...this.ledger, premiseRevision: this.ledger.revision, proposal: null });
    }
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
    if (baseRevision < (this.ledger.premiseRevision ?? 0)) {
      return '[日程候选未保存] 采样之后已有前提订正，旧候选不能复用；按当前前提重新规划。';
    }
    this.save({ ...this.ledger, proposal: { summary: parsed.summary,
      items: parsed.items.map(cleanItem), baseRevision, capturedAt } });
    return this.summary();
  }
  operate(args: Record<string, unknown>): string {
    if (Object.keys(args).some(key => !['operation', 'id', 'status', 'note', 'why', 'when', 'ifBlocked', 'offset', 'limit', 'includeCompleted', 'includeClosed', 'expected_revision'].includes(key))) return '[日程输入错误] 含有未知参数。';
    if (args.why !== undefined && args.operation !== 'update') return '[日程输入错误] why 只能通过 update 连同 note 和当前 expected_revision 订正。';
    if (args.expected_revision !== undefined && !['amend', 'reopen'].includes(String(args.operation))
      && !(args.operation === 'update' && args.why !== undefined)) return '[日程输入错误] expected_revision 仅用于 amend/reopen 或 update 订正 why。';
    if (args.operation !== 'update' && (args.when !== undefined || args.ifBlocked !== undefined)) {
      return '[日程输入错误] when/ifBlocked 只能通过 update 连同 note 修订。';
    }
    if (args.operation === 'read') {
      const offset = args.offset ?? 0, limit = args.limit ?? AGENDA_MAX_ITEMS;
      if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit)
        || Number(limit) < 1 || Number(limit) > AGENDA_MAX_ITEMS
        || (args.id !== undefined && !text(args.id, 80))
        || [args.includeCompleted, args.includeClosed].some(flag => flag !== undefined && typeof flag !== 'boolean')) return '[日程输入错误] read 的 id 为有效字符串，offset 为非负整数，limit 为 1 至 8，includeCompleted/includeClosed 为布尔值。';
      const selected = this.ledger.items.filter(item => args.id !== undefined
        ? item.id === args.id : args.includeClosed || !closed(item) || (args.includeCompleted && item.status === 'done'));
      const draft = this.ledger.proposal;
      const candidate = draft?.items.find(item => item.id === args.id);
      if (args.id !== undefined && !selected.length && !candidate) return this.missingItem(args.id);
      // A targeted read must not reintroduce unrelated goals or historical planning background.
      const detail = args.id === undefined ? this.ledger : { version: this.ledger.version, revision: this.ledger.revision,
        proposal: draft && candidate ? { baseRevision: draft.baseRevision, capturedAt: draft.capturedAt, items: [candidate] } : null };
      const end = Number(offset) + Number(limit);
      return JSON.stringify({ ...detail, items: selected.slice(Number(offset), end).map(item => args.id === undefined ? currentItem(item) : item),
        interpretation: 'summary、doneWhen 来自 sourceCapturedAt 对应的规划采样，不是当前现场读数。why 经订正后以 whyUpdatedAt 为记录时间，旧值仅在定向 read 的 whyHistory 中保留；未订正时来源为 sourceCapturedAt。when/ifBlocked 可由 update 修订。记录时间不证明现场事实，旧记录缺少来源时不能用 updatedAt 推定。实际进展见 status、note 及其 updatedAt，并与最新观察对账。',
        completedCount: this.ledger.items.filter(item => item.status === 'done').length,
        cancelledCount: this.ledger.items.filter(item => item.status === 'cancelled').length,
        page: { offset, limit, total: selected.length, nextOffset: end < selected.length ? end : null } });
    }
    if (args.operation === 'adopt') {
      const draft = this.ledger.proposal;
      if (!draft) return '[日程] 没有候选日程；可请求后台重新规划。';
      if (args.id !== undefined) return this.adoptItem(args.id, draft);
      if (draft.baseRevision !== this.ledger.revision) return '[日程] 候选生成期间已有新进展，不能覆盖；先请求重新规划。';
      const reused = draft.items.find(item => this.ledger.items.some(previous => previous.id === item.id
        && (previous.title !== item.title || previous.doneWhen !== item.doneWhen)));
      if (reused) return `[日程] 已记录的 id=${JSON.stringify(reused.id)} 不能改成新目标；原进展与关闭依据保留，新目的使用新的 id。`;
      const items = draft.items.map(item => {
        const old = this.ledger.items.find(previous => previous.id === item.id
          && previous.title === item.title && previous.doneWhen === item.doneWhen);
        return old ? { ...old } : { ...cleanItem(item), sourceCapturedAt: draft.capturedAt, status: 'queued' as AgendaStatus,
          note: '', updatedAt: this.stamp() };
      });
      // Omission from a generated proposal is not a foreground cancellation decision.
      const retained = this.ledger.items.filter(item => !items.some(next => next.id === item.id));
      if ([...retained, ...items].filter(item => !closed(item)).length > AGENDA_MAX_ITEMS) return this.capacityError();
      this.save({ ...this.ledger, revision: this.ledger.revision + 1, summary: draft.summary, items: [...retained, ...items], proposal: null });
      return this.summary();
    }
    const item = this.ledger.items.find(entry => entry.id === args.id);
    if (!item) return this.missingItem(args.id);
    if (args.operation === 'amend') {
      if (!closed(item) || !text(args.note, 400) || args.status !== undefined
        || !Number.isSafeInteger(args.expected_revision) || args.expected_revision !== this.ledger.revision) {
        return '[日程输入错误] amend 只订正已关闭阶段的 note，需 read 返回的当前 expected_revision；不能改变状态、目标或条件。';
      }
      const items = this.ledger.items.map(entry => entry.id === item.id ? { ...entry, note: args.note as string,
        updatedAt: this.stamp(), corrections: [...entry.corrections ?? [], { note: entry.note, updatedAt: entry.updatedAt }] } : entry);
      this.save({ ...this.ledger, revision: this.ledger.revision + 1, items });
      return this.operate({ operation: 'read', id: item.id });
    }
    if (args.operation === 'reopen') {
      if (item.status !== 'done' || !text(args.note, 400) || args.status !== undefined
        || !Number.isSafeInteger(args.expected_revision) || args.expected_revision !== this.ledger.revision) {
        return '[日程输入错误] reopen 只恢复误记完成的阶段，需 read 返回的当前 expected_revision 和 note 中的新核验证据；不能改变目标、条件或重开已撤销阶段。';
      }
      const items = this.ledger.items.map(entry => entry.id === item.id ? { ...entry, status: 'queued' as const,
        note: args.note as string, updatedAt: this.stamp(),
        corrections: [...entry.corrections ?? [], { status: entry.status, note: entry.note, updatedAt: entry.updatedAt }] } : entry);
      this.save({ ...this.ledger, revision: this.ledger.revision + 1, items });
      return this.operate({ operation: 'read', id: item.id });
    }
    if (args.operation === 'focus') {
      if (closed(item)) return `[日程] 此阶段${closedLabel(item)}。误记完成先 read 后 reopen 留新证据；新的目的需要重新规划。`;
      if (item.status === 'active') return this.summary();
      const items = this.ledger.items.map(entry => entry.id === item.id
        ? { ...entry, status: 'active' as const, updatedAt: this.stamp() }
        : entry.status === 'active' ? { ...entry, status: 'queued' as const } : entry);
      this.save({ ...this.ledger, revision: this.ledger.revision + 1, items });
      return this.summary();
    }
    if (args.operation !== 'update' || !text(args.note, 400)
      || (args.status !== undefined && !['queued', 'deferred', 'done', 'cancelled'].includes(String(args.status)))
      || [args.when, args.ifBlocked].some(value => value !== undefined && !text(value, 240))) {
      return '[日程输入错误] update 需要 note 记录实际进展、受阻依据或明确撤销原因；status 可为 queued/deferred/done/cancelled；when/ifBlocked 可修订为 1 至 240 字符的条件，并在 note 记录依据。';
    }
    if (closed(item)) return `[日程] ${closedLabel(item)}记录保留；误记完成先 read 后 reopen 留新证据，新的目的请重新规划。`;
    if (args.why !== undefined && (!text(args.why, 240) || !Number.isSafeInteger(args.expected_revision)
      || args.expected_revision !== this.ledger.revision)) {
      return '[日程输入错误] 订正 why 需要 1 至 240 字符的新前提、note 中的核验证据和 read 返回的当前 expected_revision；先重新读取已变化的日程。';
    }
    const updatedAt = this.stamp();
    const premiseChanged = args.why !== undefined && args.why !== item.why;
    const premise = premiseChanged ? {
      why: args.why as string, whyUpdatedAt: updatedAt,
      whyHistory: [...item.whyHistory ?? [], { why: item.why,
        ...((item.whyUpdatedAt ?? item.sourceCapturedAt) ? { sourceAt: item.whyUpdatedAt ?? item.sourceCapturedAt } : {}),
        correctedAt: updatedAt, correctionNote: args.note as string }],
    } : {};
    const items = this.ledger.items.map(entry => entry.id === item.id
      ? { ...entry, ...premise, status: (args.status ?? entry.status) as AgendaStatus, note: args.note as string,
        when: (args.when ?? entry.when) as string, ifBlocked: (args.ifBlocked ?? entry.ifBlocked) as string, updatedAt }
      : entry);
    this.save({ ...this.ledger, revision: this.ledger.revision + 1, items,
      ...(premiseChanged ? { premiseRevision: this.ledger.revision + 1, proposal: null } : {}) });
    return this.summary();
  }
  summary(): string {
    const active = this.ledger.items.find(item => item.status === 'active');
    const next = this.ledger.items.filter(item => item.status === 'queued');
    const deferred = this.ledger.items.filter(item => item.status === 'deferred')
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const completed = this.ledger.items.filter(item => item.status === 'done')
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const cancelled = this.ledger.items.filter(item => item.status === 'cancelled')
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const draft = this.ledger.proposal;
    const lines = ['[活动日程；意图与执行结果分别记录]',
      `已完成 ${completed.length} 项，排队 ${next.length} 项，挂起 ${deferred.length} 项，已撤销 ${cancelled.length} 项；规划时的背景说明仅在 read 中保留，现场以当前观察为准。`,
      active ? `当前 id=${JSON.stringify(active.id)} ${clip(active.title, 48)}；规划来源采样于 ${active.sourceCapturedAt ?? '未记录'}；阶段记录更新于 ${active.updatedAt}，记录时间不证明世界已变化。`
        : next.length || deferred.length ? '当前阶段尚未选择；结合现场自行选下一项。'
          : '当前没有未完成阶段；完成记录是历史。结合长期目标和现场选择新阶段，可 review 异步请求候选，期间独立行动可以继续。',
      ...(draft ? [`后台候选采样于 ${draft.capturedAt}，共 ${draft.items.length} 项，${draft.baseRevision === this.ledger.revision ? '待核验采用' : '整份已落后于当前进展'}；activity_plan read 带 id 定向核验候选与前提，adopt 指定一项不改现有进展；整份过期则 review。`] : [])];
    const footer = '阶段变化用 activity_plan update 留证据；when/ifBlocked 可修订；why 订正需 read 的当前 expected_revision 与核验证据；误记完成先 read 后 reopen 留新证据；明确放弃用 cancelled 加原因；read 带 id 查详情；日程不阻止交流、应急和新的选择。';
    const sections = [
      ...(active ? [[`够了就收尾：${clip(active.doneWhen, 160)}`,
        `条件：${clip(active.when, 100)}；受阻：${clip(active.ifBlocked, 100)}`,
        ...(active.note ? ['最近证据：' + clip(active.note, 160)] : [])]] : []),
      next.map(item => `候选 id=${JSON.stringify(item.id)} ${clip(item.title, 48)}`),
      deferred.map(item => `挂起 id=${JSON.stringify(item.id)} ${clip(item.title, 32)}；${item.updatedAt} 记录的依据：${clip(item.note, 64)}；新观察是否改变条件须核验。`),
      draft?.items.map(item => `后台候选 id=${JSON.stringify(item.id)} ${clip(item.title, 36)}`) ?? [],
      completed.slice(0, AGENDA_RECENT_COMPLETIONS).map(item =>
        `已结案 id=${JSON.stringify(item.id)} ${clip(item.title, 24)}；${item.updatedAt} 记录（外部生效仍以实际回执为准）：${clip(item.note, 64)}`),
      cancelled.slice(0, AGENDA_RECENT_COMPLETIONS).map(item =>
        `已撤销 id=${JSON.stringify(item.id)} ${clip(item.title, 24)}；${item.updatedAt} 原因：${clip(item.note, 64)}；不表示完成。`),
    ].filter(part => part.length);
    const remaining = AGENDA_SUMMARY_MAX_CHARS - [...lines, footer].join('\n').length - sections.length;
    const activeBudget = active ? Math.min(Math.max(0, remaining), sections[0].join('\n').length) : 0;
    const otherCount = sections.length - (active ? 1 : 0);
    const budget = otherCount ? Math.max(0, Math.floor((remaining - activeBudget) / otherCount)) : 0;
    return [...lines, ...sections.map((part, index) => section(part, active && index === 0 ? activeBudget : budget)), footer].join('\n');
  }
  /** Background planning reads open objectives and bounded, separately labelled closure evidence. */
  planningReadout(): string {
    const history = this.ledger.items.filter(closed)
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    return JSON.stringify({ revision: this.ledger.revision,
      items: [...this.ledger.items.filter(item => !closed(item)), ...history.slice(-AGENDA_MAX_ITEMS)]
        .map(currentItem),
      interpretation: 'whyUpdatedAt 是已订正前提的记录时间，否则 why 来源为 sourceCapturedAt；记录仍需核对最新观察。前提订正历史仅通过 activity_plan read 定向查阅。',
      completedCount: history.filter(item => item.status === 'done').length,
      cancelledCount: history.filter(item => item.status === 'cancelled').length,
      history: 'done 是完成记录，cancelled 是明确撤销，不应重放。较早关闭记录未展开；activity_plan read includeClosed:true 分页或按 id 查询。' });
  }
  /** Accept one explicitly selected new objective without replacing concurrent progress. */
  private adoptItem(id: unknown, draft: Proposal): string {
    const item = draft.items.find(entry => entry.id === id);
    if (!item) return '[日程输入错误] adopt 的 id 必须来自当前候选；用 read 核验候选与现场前提。';
    const current = this.ledger.items.find(entry => entry.id === id);
    if (current) return closed(current)
      ? `[日程] 此 id ${closedLabel(current)}，原记录保留；新的目的需要单独规划。`
      : '[日程] 此 id 已在现有日程中，进展保留；用 focus/update 选择或记录，不覆盖。';
    if (this.ledger.items.filter(entry => !closed(entry)).length >= AGENDA_MAX_ITEMS) return this.capacityError();
    const remaining = draft.items.filter(entry => entry.id !== id);
    this.save({ ...this.ledger, revision: this.ledger.revision + 1,
      items: [...this.ledger.items, { ...cleanItem(item), sourceCapturedAt: draft.capturedAt,
        status: 'queued', note: '', updatedAt: this.stamp() }],
      proposal: remaining.length ? { ...draft, items: remaining } : null });
    return this.summary();
  }
  private missingItem(id: unknown): string {
    if (this.ledger.proposal?.items.some(item => item.id === id)) return `[日程输入错误] id=${JSON.stringify(id)} 是后台候选，尚未采用；read 带此 id 定向核验，adopt 带此 id 明确采用后才能 focus/update。本次未保存进展。`;
    return `[日程输入错误] 未找到已采用阶段 id=${JSON.stringify(id) ?? 'null'}。当前阶段 id：${JSON.stringify(this.ledger.items.filter(item => !closed(item)).map(item => item.id))}；后台候选 id：${JSON.stringify(this.ledger.proposal?.items.map(item => item.id) ?? [])}。read 带目标 id 定向查询。`;
  }
  private capacityError(): string {
    return '[日程] 未完成阶段已达到上限；先按实际依据 update 完成、或以 cancelled 明确撤销不再推进的阶段。挂起仍是未完成，不能通过省略候选删除旧目标。';
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
