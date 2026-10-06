import { textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';

export const ACTION_EVIDENCE_MAX_CALLS = 8;
export const ACTION_EVIDENCE_MAX_RECEIPTS = 4;

function excerpt(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > maxChars ? compact.slice(0, maxChars) + '…' : compact;
}

/** Tool tags identify requests; receipts remain evidence rather than inferred task completion. */
export function actionEvidence(
  records: readonly ContextRecord[],
  tools: { act: ReadonlySet<string>; speak: ReadonlySet<string>; read: ReadonlySet<string> },
): string {
  const calls: Array<{ record: ContextRecord; kind: '行动' | '发言' | '读取' }> = [];
  for (let index = records.length - 1; index >= 0 && calls.length < ACTION_EVIDENCE_MAX_CALLS; index--) {
    const record = records[index];
    const call = record.item;
    if (record.context.head || call.type !== 'function_call') continue;
    const kind = tools.speak.has(call.name) ? '发言' : tools.act.has(call.name) ? '行动'
      : tools.read.has(call.name) ? '读取' : null;
    if (kind) calls.unshift({ record, kind });
  }
  if (!calls.some(call => call.kind !== '读取')) return '';
  const counts = (kind: string) => calls.filter(call => call.kind === kind).length;
  const actions = calls.filter(call => call.kind === '行动').slice(-ACTION_EVIDENCE_MAX_RECEIPTS);
  const lines = [`[行动对账] 最近 ${calls.length} 条相关工具请求：行动 ${counts('行动')}、发言 ${counts('发言')}、读取 ${counts('读取')}。请求次数不证明受理、进展或当前忙闲。`];
  for (const action of actions) {
    const call = action.record.item;
    if (call.type !== 'function_call') continue;
    lines.push(`行动请求 ${action.record.context.ts ?? '时间未记录'}：${call.name} ${excerpt(call.arguments, 120)}`);
    let receipt: ContextRecord | undefined;
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      if (!record.context.head && record.item.type === 'function_call_output' && record.item.call_id === call.call_id) {
        receipt = record;
        break;
      }
    }
    lines.push(receipt ? `原回执节选：${excerpt(textOf(receipt), 180)}` : '该请求尚无工具回执。');
  }
  if (!actions.length) {
    lines.push('上述请求中没有行动工具调用；较早的任务是否仍在执行，以 World 当前队列和终态为准。');
  }
  lines.push('对照上述回执与当前现场，判断这些请求是否推进了目标，还是反复改变同一状态、原地操作或等待同一条件。任务结束不等于目标完成；等待只属于具体条件，其他独立事情可以继续。台词里的打算不会执行动作，可行就实际提交，缺条件就查用法或记待办。这段对账不用口播。');
  return lines.join('\n');
}
