/** Dream reading budgets affect request copies; complete observations remain in the reading archive. */
import { createHash } from 'node:crypto';
import type { Logger, ToolDef, ToolOutcome } from 'cortico/core/types.ts';
import { functionResult, withText, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { hasRole, textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { estimateMessagesTokens, estimateTokens } from 'cortico/core/util.ts';

export interface DreamConfig {
  onHandoff: boolean;
  /** Empty uses the active provider. Model selection belongs to that provider. */
  provider: string;
  /** Estimated prompt and tool budget; zero disables the request projection fallback. */
  maxContextTokens: number;
  /** Estimated text returned by read tools in one round; zero disables pagination. */
  maxReadTokensPerRound: number;
  maxOutputTokens: number;
  yieldToForeground: boolean;
  generationWaitTimeoutMs: number;
  /** Total queue, retry and generation lifetime. */
  timeoutMs: number;
  maxPendingTasks: number;
}

export const DREAM_DEFAULTS: DreamConfig = {
  onHandoff: true, provider: '', maxContextTokens: 0, maxReadTokensPerRound: 0,
  maxOutputTokens: 2000, yieldToForeground: false, generationWaitTimeoutMs: 60_000,
  timeoutMs: 180_000, maxPendingTasks: 2,
};

/** Pagination needs room for a source pointer and continuation cursor. Zero keeps whole-file reads. */
export function normalizeDreamConfig(config: DreamConfig): DreamConfig {
  return { ...DREAM_DEFAULTS, ...config, maxReadTokensPerRound: config.maxReadTokensPerRound > 0 ? Math.max(128, config.maxReadTokensPerRound) : 0 };
}

interface ReadingArchive {
  file: string;
  append(text: string): void;
}

interface CapturedRead {
  tool: string;
  argsKey: string;
  outcome: ToolOutcome;
  line: number;
}

/** Largest literal prefix fitting the shared estimate; no inference or summarization. */
export function dreamTextWithinBudget(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

function argsKey(args: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(args).filter(key => key !== 'readCursor').sort().map(key => [key, args[key]])));
}

export interface DreamHistory {
  parts: string[];
  text: string;
}

/** Human-readable observations point to unchanged source rows; protocol metadata stays in the source file. */
export function renderDreamHistory(
  snapshot: readonly ContextRecord[], sourceFile: string,
  userText: (record: ContextRecord) => string = textOf,
): DreamHistory {
  const requests = new Map<string, { name: string; line: number }>();
  snapshot.forEach((record, index) => {
    if (record.item.type === 'function_call') requests.set(record.item.call_id, { name: record.item.name, line: index + 1 });
  });
  const parts: string[] = [];
  snapshot.forEach((record, index) => {
    if (record.context.head || hasRole(record, 'system') || hasRole(record, 'developer')) return;
    let label: string;
    let body: string;
    if (hasRole(record, 'user')) { label = '历史观察或内部输入'; body = userText(record); }
    else if (hasRole(record, 'assistant')) { label = '历史助手正文；不表示工具已执行'; body = textOf(record); }
    else if (record.item.type === 'function_call') {
      label = `历史原生工具请求 ${record.item.name}；执行结果看实际回执`;
      body = record.item.arguments;
    } else if (record.item.type === 'function_call_output') {
      const request = requests.get(record.item.call_id);
      label = `历史工具实际回执${request ? ` ${request.name}；对应原始第 ${request.line} 行请求` : ''}`;
      body = textOf(record);
    } else return;
    if (!body.trim()) return;
    const at = record.context.ts ?? record.context.frame?.events.at(-1)?.ts;
    parts.push(`【${label}${at ? `；观察记录时间 ${at}` : ''}；原始证据 ${sourceFile} 第 ${index + 1} 行】\n${body}`);
  });
  return { parts, text: parts.join('\n\n') };
}

/** Recent complete observation and receipt blocks use the available budget first. */
export function dreamHistoryWithinBudget(history: DreamHistory, maxTokens: number): string {
  if (!Number.isFinite(maxTokens) || estimateTokens(history.text) <= maxTokens) return history.text;
  if (maxTokens <= 0) return '';
  const notice = '【较早正文未展开；必要缺口可检索历史正文，未展开不代表没发生】\n';
  const available = Math.max(0, maxTokens - estimateTokens(notice));
  const selected: string[] = [];
  for (let index = history.parts.length - 1; index >= 0; index--) {
    const part = history.parts[index];
    if (estimateTokens([part, ...selected].join('\n\n')) > available) {
      if (!selected.length) selected.unshift(dreamTextWithinBudget(part, available));
      break;
    }
    selected.unshift(part);
  }
  return dreamTextWithinBudget(notice + selected.join('\n\n'), maxTokens);
}

export class DreamContext {
  readonly tools: ToolDef[];
  private readonly readNames: Set<string>;
  private readonly toolTokens: number;
  private readonly archived = new Map<string, number>();
  private archiveLines = 0;
  private archiveAvailable = true;
  private round = 0;
  private readRemaining: number;
  private readSequence = 0;
  private readonly captured = new Map<string, CapturedRead>();
  private readonly fullMaterials = new Map<string, ContextRecord>();
  private readonly materialExcerpts = new Map<string, (maxTokens: number) => string>();

  constructor(
    private readonly config: DreamConfig,
    tools: readonly ToolDef[],
    private readonly archive: ReadingArchive,
    private readonly log: Logger,
  ) {
    this.config = normalizeDreamConfig(config);
    config = this.config;
    this.readRemaining = config.maxReadTokensPerRound;
    this.readNames = new Set(tools.filter(tool => tool.tags.includes('read')).map(tool => tool.name));
    this.tools = tools.map(tool => !this.readNames.has(tool.name) ? tool
      : config.maxReadTokensPerRound > 0 ? this.pagedTool(tool)
        : config.maxContextTokens > 0 ? this.archivedTool(tool) : tool);
    this.toolTokens = estimateTokens(JSON.stringify(this.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))));
  }

  /** Returns archive line numbers only after the append succeeds. */
  remember(records: readonly ContextRecord[]): number[] | null {
    if (!this.archiveAvailable) return null;
    const keys = records.map(record => createHash('sha256').update(JSON.stringify(record)).digest('hex'));
    const pending = new Map<string, string>();
    records.forEach((record, index) => {
      if (!this.archived.has(keys[index])) pending.set(keys[index], JSON.stringify(record));
    });
    try {
      if (pending.size) this.archive.append([...pending.values()].join('\n') + '\n');
    } catch (error) {
      this.archiveAvailable = false;
      this.log.warn('后台阅读归档失败，使用完整材料', { error: String(error) });
      return null;
    }
    for (const key of pending.keys()) this.archived.set(key, ++this.archiveLines);
    return keys.map(key => this.archived.get(key)!);
  }

  materialBudget(fixed: readonly ContextRecord[]): number {
    if (this.config.maxContextTokens <= 0 || !this.archiveAvailable) return Infinity;
    const available = this.config.maxContextTokens - this.toolTokens - estimateMessagesTokens(fixed);
    return Math.max(0, available);
  }

  preserveFullMaterial(visible: ContextRecord, full: ContextRecord, excerpt?: (maxTokens: number) => string): void {
    const key = createHash('sha256').update(JSON.stringify(visible)).digest('hex');
    this.fullMaterials.set(key, full);
    if (excerpt) this.materialExcerpts.set(key, excerpt);
  }

  prepareRequest({ round, messages }: { round: number; messages: readonly ContextRecord[] }): ContextRecord[] {
    if (this.round !== round) {
      this.round = round;
      this.readRemaining = this.config.maxReadTokensPerRound;
    }
    const lines = this.remember(messages);
    const maxTokens = this.config.maxContextTokens;
    if (!lines) return messages.map(entry => this.fullMaterials.get(createHash('sha256').update(JSON.stringify(entry)).digest('hex')) ?? entry);
    if (maxTokens <= 0) return [...messages];
    const projected = [...messages];
    const beforeTokens = this.toolTokens + estimateMessagesTokens(projected);
    if (beforeTokens <= maxTokens) return projected;

    // The latest generated batch and its receipts are read in full, including multi-call rounds.
    let latest = messages.length;
    for (let index = messages.length - 1; index >= 0; index--) {
      const entry = messages[index];
      if (entry.item.type !== 'function_call' && !hasRole(entry, 'assistant') && entry.item.type !== 'reasoning') continue;
      latest = index;
      const responseId = entry.context.responseId;
      if (responseId) while (latest > 0 && messages[latest - 1].context.responseId === responseId) latest--;
      else while (latest > 0 && (messages[latest - 1].item.type === 'function_call' || hasRole(messages[latest - 1], 'assistant') || messages[latest - 1].item.type === 'reasoning')) latest--;
      break;
    }
    const calls = new Map<string, string>();
    for (const entry of messages) if (entry.item.type === 'function_call') calls.set(entry.item.call_id, entry.item.name);
    let afterTokens = beforeTokens;
    let excerpted = 0;
    const excerpt = (index: number): void => {
      const entry = messages[index];
      const original = textOf(entry);
      const pointer = `[旧阅读节选；完整原文 ${this.archive.file} 第 ${lines[index]} 行；read_file 可按行${this.config.maxReadTokensPerRound > 0 ? '及 readCursor' : ''}继续读取]`;
      const text = dreamTextWithinBudget(original, 96) + '\n' + pointer;
      if (estimateTokens(text) >= estimateTokens(original)) return;
      projected[index] = withText(entry, text);
      afterTokens = this.toolTokens + estimateMessagesTokens(projected);
      excerpted++;
    };
    for (let index = 0; index < latest && afterTokens > maxTokens; index++) {
      const entry = messages[index];
      if (entry.item.type === 'function_call_output' && this.readNames.has(calls.get(entry.item.call_id) ?? '')) excerpt(index);
    }
    for (let index = 0; index < latest && afterTokens > maxTokens; index++) {
      if (hasRole(messages[index], 'assistant')) excerpt(index);
    }
    for (let index = 0; index < latest && afterTokens > maxTokens; index++) {
      const entry = messages[index];
      const render = this.materialExcerpts.get(createHash('sha256').update(JSON.stringify(entry)).digest('hex'));
      if (!render) continue;
      const original = textOf(entry);
      const pointer = `\n【初始过去材料节选；完整当时材料 ${this.archive.file} 第 ${lines[index]} 行】`;
      const remaining = Math.max(0, estimateTokens(original) - (afterTokens - maxTokens) - estimateTokens(pointer));
      const text = render(remaining) + pointer;
      if (estimateTokens(text) >= estimateTokens(original)) continue;
      projected[index] = withText(entry, text);
      afterTokens = this.toolTokens + estimateMessagesTokens(projected);
      excerpted++;
    }
    this.log.info('dream-context', {
      round, maxContextTokens: maxTokens, beforeTokens, afterTokens, excerpted,
      budgetExceeded: afterTokens > maxTokens,
    });
    return projected;
  }

  private rememberRead(callId: string, outcome: ToolOutcome): number[] | null {
    return this.remember([functionResult(callId, outcome.blobs?.length ? JSON.stringify(outcome) : outcome.text)]);
  }

  private archivedTool(tool: ToolDef): ToolDef {
    return {
      ...tool,
      handler: async (args, context) => {
        const result = await tool.handler(args, context);
        this.rememberRead(context.callId ?? `dream_read_${++this.readSequence}`, typeof result === 'string' ? { text: result } : result);
        return result;
      },
    };
  }

  private pagedTool(tool: ToolDef): ToolDef {
    return {
      ...tool,
      description: tool.description + ' Read results share a per-round text budget. A partial result includes readCursor; repeat the same arguments with that cursor to continue the captured result in a later round.',
      parameters: {
        ...tool.parameters,
        properties: {
          ...(tool.parameters.properties as Record<string, unknown> | undefined),
          readCursor: { type: 'string', description: 'Continuation cursor returned by this tool. Keep the other arguments unchanged; omit for a fresh read.' },
        },
      },
      handler: async (args, context) => {
        const { readCursor, ...originalArgs } = args;
        if (!this.archiveAvailable) return tool.handler(originalArgs, context);
        if (this.readRemaining < 128) return '[本轮阅读预算已用尽；下一轮按原参数继续读取，文件未修改]';
        let captured: CapturedRead;
        let id: string;
        let offset = 0;
        if (readCursor !== undefined) {
          const match = /^([0-9]+):([0-9]+)$/.exec(String(readCursor));
          const previous = match ? this.captured.get(match[1]) : undefined;
          if (!match || !previous || previous.tool !== tool.name || previous.argsKey !== argsKey(originalArgs)) return '[无效阅读游标；使用相同工具与原参数，或去掉 readCursor 重新读取]';
          captured = previous;
          id = match[1];
          offset = Number(match[2]);
          if (offset > captured.outcome.text.length) return '[阅读游标超出原结果；去掉 readCursor 重新读取]';
        } else {
          const result = await tool.handler(originalArgs, context);
          const outcome = typeof result === 'string' ? { text: result } : result;
          const row = this.rememberRead(context.callId ?? `dream_read_${this.readSequence + 1}`, outcome);
          if (!row) return result;
          id = String(++this.readSequence);
          captured = { tool: tool.name, argsKey: argsKey(originalArgs), outcome, line: row[0] };
          this.captured.set(id, captured);
        }
        const rest = captured.outcome.text.slice(offset);
        if (estimateTokens(rest) <= this.readRemaining) {
          this.readRemaining -= estimateTokens(rest);
          return { ...captured.outcome, text: rest };
        }
        const source = `\n[阅读节选；原始工具结果 ${this.archive.file} 第 ${captured.line} 行；`;
        const reserve = estimateTokens(source + `未读取 ${rest.length} 字符；readCursor=${id}:${captured.outcome.text.length}]`);
        const excerpt = dreamTextWithinBudget(rest, Math.max(0, this.readRemaining - reserve));
        const next = offset + excerpt.length;
        const text = excerpt + source + `未读取 ${captured.outcome.text.length - next} 字符；readCursor=${id}:${next}]`;
        this.readRemaining = Math.max(0, this.readRemaining - estimateTokens(text));
        return { ...captured.outcome, text };
      },
    };
  }
}
