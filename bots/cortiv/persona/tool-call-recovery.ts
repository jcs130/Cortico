/** ToolCallRecoveryFallback: bounded advice for text that imitates an available native tool call. */
import type { EventEnvelope } from 'cortico/core/types.ts';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { hasRole, textOf } from 'cortico/protocol/open-responses/context-helpers.ts';

export interface ToolCallRecoveryConfig { enabled: boolean; }
export const TOOL_CALL_RECOVERY_DEFAULTS: ToolCallRecoveryConfig = { enabled: false };

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
