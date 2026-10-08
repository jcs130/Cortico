/** ToolCallRecoveryFallback: bounded advice for pseudo calls or exact delivery-frame echoes. */
import type { EventEnvelope } from 'cortico/core/types.ts';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { hasRole, textOf } from 'cortico/protocol/open-responses/context-helpers.ts';

export interface ToolCallRecoveryConfig { enabled: boolean; }
export const TOOL_CALL_RECOVERY_DEFAULTS: ToolCallRecoveryConfig = { enabled: false };

/** Exact copies of typed delivery inputs are not new observations or executed actions. */
function inputEcho(text: string, inputs: readonly ContextRecord[]): boolean {
  const body = text.trim();
  if (!body) return false;
  return inputs.some(record => {
    const refs = record.context.frame?.events;
    if (!refs?.length || !(hasRole(record, 'user') || record.item.type === 'function_call_output')) return false;
    const source = textOf(record);
    if (body === source.trim()) return true;
    return refs.some(ref => ref.source === 'persona' && ref.type === 'handoff'
      && body === source.slice(ref.start, ref.start + ref.chars).trim());
  });
}

/** Request-only repair: keep the ledger intact, but do not teach the model to repeat its inputs. */
export function withoutInputEchoes(records: readonly ContextRecord[]): ContextRecord[] {
  const echoed = new Set<ContextRecord>();
  for (let index = 0; index < records.length; index++) {
    const entry = records[index];
    if (entry.context.head || !hasRole(entry, 'assistant')) continue;
    const output = entry.context.responseId
      ? records.filter(record => !record.context.head && record.context.responseId === entry.context.responseId)
      : [entry];
    if (output.some(record => record.item.type === 'function_call')) continue;
    const text = output.filter(record => hasRole(record, 'assistant')).map(textOf).join('\n');
    if (inputEcho(text, records.slice(0, index))) {
      for (const record of output) if (hasRole(record, 'assistant') || record.item.type === 'reasoning') echoed.add(record);
    }
  }
  return records.filter(record => !echoed.has(record));
}

function transcriptTools(text: string, availableTools: ReadonlySet<string>): string[] {
  const names = new Set<string>();
  let fenced = false;
  let request: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const match = /^\s*\[历史工具请求\]\s+([A-Za-z_][\w]*)(?:\s|$)/.exec(line);
    if (match) request = availableTools.has(match[1]) ? match[1] : null;
    else if (request && /^\s*\[历史回执\]/.test(line)) { names.add(request); request = null; }
  }
  return [...names];
}

/** Unexecuted transcript-shaped replies remain in the ledger, outside the next request's examples. */
export function projectToolCallRecovery(records: readonly ContextRecord[], availableTools: ReadonlySet<string>): ContextRecord[] {
  const current = withoutInputEchoes(records);
  const discarded = new Set<ContextRecord>();
  for (const entry of current) {
    if (entry.context.head || !hasRole(entry, 'assistant')) continue;
    const output = entry.context.responseId
      ? current.filter(record => !record.context.head && record.context.responseId === entry.context.responseId)
      : [entry];
    if (output.some(record => record.item.type === 'function_call')) continue;
    const text = output.filter(record => hasRole(record, 'assistant')).map(textOf).join('\n');
    if (transcriptTools(text, availableTools).length) {
      for (const record of output) if (hasRole(record, 'assistant') || record.item.type === 'reasoning') discarded.add(record);
    }
  }
  return current.filter(record => !discarded.has(record));
}

export class ToolCallRecoveryFallback {
  private lastResponse: string | null = null;
  private advised = false;

  onDelivery(events: readonly EventEnvelope[]): void {
    if (events.some(event =>
      event.type === 'terminal.message' || event.type === 'terminal.invite'
      || event.origin === 'external' && /(?:^|\.)(?:chat|message|danmaku)$/.test(event.type)
        && !!event.senderKey && event.senderKey !== event.source && !event.tags?.includes('snapshot'))) {
      this.advised = false;
    }
  }

  notice(records: readonly ContextRecord[], availableTools: ReadonlySet<string>): string | null {
    let latest = records.length - 1;
    while (latest >= 0 && (records[latest].context.head
      || !(records[latest].item.type === 'function_call' || hasRole(records[latest], 'assistant')))) latest--;
    if (latest < 0) return null;
    const entry = records[latest];
    const response = entry.context.responseId ?? entry.item.id ?? String(latest);
    if (response === this.lastResponse) return null;
    this.lastResponse = response;
    const output = entry.context.responseId
      ? records.filter(record => !record.context.head && record.context.responseId === entry.context.responseId)
      : [entry];
    if (output.some(record => record.item.type === 'function_call')) {
      this.advised = false;
      return null;
    }
    if (this.advised) return null;
    const text = output.filter(record => hasRole(record, 'assistant')).map(textOf).join('\n');
    if (inputEcho(text, records.slice(0, latest))) {
      this.advised = true;
      return '[工具接口核验] 刚才回复原样复制了已经收到的事件帧或交接通知，没有原生工具调用，也没有执行行动。原始事件和实际回执仍在；请根据当前现场与目标重新选择行动，通过当前原生工具接口执行。需要等待时可以结束本轮。不必复述内部通知。';
    }
    const transcripts = transcriptTools(text, availableTools);
    if (transcripts.length) {
      this.advised = true;
      return `[工具接口核验] 刚才的正文为 ${transcripts.join('、')} 写了历史请求和回执样式，但本轮没有原生工具调用，这些行没有对应本轮执行记录。回顾过去请核验原始账本；需要新的行动或观察时使用当前原生工具接口，等待实际回执。不要模拟工具回执。也可以选择结束本轮。`;
    }
    const names = new Set<string>();
    let fenced = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
      if (fenced) continue;
      const match = /^\s*\[调用(?:\]\s*|\s+)([A-Za-z_][\w]*)(?:\])?\s*(?:\{|\(\s*\{)/.exec(line);
      if (match && availableTools.has(match[1])) names.add(match[1]);
    }
    if (!names.size) return null;
    this.advised = true;
    return `[工具接口核验] 刚才回复没有原生工具调用；正文里的 ${[...names].join('、')} 没有执行。需要行动时，请重新选择并通过当前提供的原生工具接口调用，等待实际回执。也可以选择不行动。历史笔记里的工具行只是记录，写出“[调用]”不会执行工具。`;
  }
}
