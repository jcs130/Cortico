import type { ContextRecord } from '../protocol/open-responses/context.ts';
import { validatePairing } from './truncate.ts';

function isRequestContent(value: unknown): boolean {
  return typeof value === 'string' || Array.isArray(value) && value.every(part =>
    !!part && typeof part === 'object' && !Array.isArray(part) && typeof part.type === 'string');
}

function isRequestRecord(value: unknown): value is ContextRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as ContextRecord;
  if (entry.version !== 2 || !entry.context || typeof entry.context !== 'object' || Array.isArray(entry.context)
    || !entry.item || typeof entry.item !== 'object' || Array.isArray(entry.item) || typeof entry.item.type !== 'string') return false;
  const item = entry.item;
  switch (item.type) {
    case 'message': return typeof item.role === 'string' && isRequestContent(item.content);
    case 'function_call': return typeof item.call_id === 'string' && typeof item.name === 'string' && typeof item.arguments === 'string';
    case 'function_call_output': return typeof item.call_id === 'string' && isRequestContent(item.output);
    case 'reasoning': return Array.isArray(item.summary) && isRequestContent(item.summary);
    default: return typeof item.type === 'string' && item.type.length > 0;
  }
}

/** A request projection must retain valid records and closed tool-call pairs; it never repairs the durable context. */
export function validateRequestContext(value: unknown): asserts value is ContextRecord[] {
  if (!Array.isArray(value) || !value.every(isRequestRecord)) throw new TypeError('prepareRequest 必须返回完整 ContextRecord 数组');
  if (validatePairing(value).length) throw new TypeError('prepareRequest 的工具调用与回执未配对');
}
