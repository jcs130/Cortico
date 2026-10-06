/** Request-only excerpts of earlier Persona handoff notes; source records remain expandable. */
import { itemText, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import type { FrameEventRef } from 'cortico/core/types.ts';
import { HANDOFF_NOTE_TYPE } from '../../cormini/persona/handoffNote.ts';

interface Edit { start: number; end: number; text: string; }

interface HandoffExcerptOptions {
  protectedRecords?: readonly ContextRecord[];
  /** Only these unchanged automatic spans may be excerpted inside protected/latest input. */
  currentHandoffs?: readonly FrameEventRef[];
}

function inputBoundary(records: readonly ContextRecord[]): number {
  let user = -1;
  let external = -1;
  for (const [index, record] of records.entries()) {
    if (record.context.head) continue;
    if (record.item.type === 'message' && record.item.role === 'user') user = index;
    if (record.context.frame?.events.some((event) => event.source !== 'persona')) external = index;
  }
  if (user < 0) return external < 0 ? records.length : external;
  return external < 0 ? user : Math.min(user, external);
}

function validRanges(refs: readonly FrameEventRef[], length: number): boolean {
  let end = 0;
  for (const ref of refs) {
    if (!Number.isInteger(ref.start) || !Number.isInteger(ref.chars)
      || ref.start < end || ref.chars < 0 || ref.start + ref.chars > length) return false;
    end = ref.start + ref.chars;
  }
  return true;
}

function editedText(text: string, start: number, edits: readonly Edit[]): string {
  const end = start + text.length;
  let at = start;
  let out = '';
  for (const edit of edits) {
    if (edit.start >= end || edit.end <= start) continue;
    const cut = Math.max(start, edit.start);
    out += text.slice(at - start, cut - start);
    if (edit.start >= start) out += edit.text;
    at = Math.min(end, edit.end);
  }
  return out + text.slice(at - start);
}

function excerptRecord(
  record: ContextRecord, excerpt: (text: string) => string, allowed?: ReadonlySet<FrameEventRef>,
): ContextRecord {
  const refs = record.context.frame?.events;
  if (!refs?.some((ref) => ref.source === 'persona' && ref.type === HANDOFF_NOTE_TYPE)) return record;
  const item = record.item;
  if (item.type !== 'message' && item.type !== 'function_call_output') return record;
  if (item.type === 'message' && (item.role === 'system' || item.role === 'developer')) return record;
  const source = itemText(item);
  if (!validRanges(refs, source.length)) return record;
  const edits: Edit[] = [];
  try {
    for (const ref of refs) {
      if (ref.source !== 'persona' || ref.type !== HANDOFF_NOTE_TYPE || ref.chars === 0
        || (allowed && !allowed.has(ref))) continue;
      const original = source.slice(ref.start, ref.start + ref.chars);
      const selected = excerpt(original);
      if (!selected.trim()) continue;
      const text = `[交接笔记原文节选；事件#${ref.cursor}，投递于${ref.ts}。`
        + '未展示部分仍在完整账本；需要旧原话、承诺或实际回执时用 expand_context。节选不证明当前完成状态。]\n'
        + selected;
      if (text.length < original.length) edits.push({ start: ref.start, end: ref.start + ref.chars, text });
    }
  } catch { return record; }
  if (edits.length === 0) return record;
  edits.sort((a, b) => a.start - b.start);
  const content = item.type === 'message' ? item.content : item.output;
  let rewritten: typeof content;
  if (typeof content === 'string') rewritten = editedText(content, 0, edits);
  else if (Array.isArray(content)) {
    let offset = 0;
    rewritten = content.map((part) => {
      const value = part as { text?: string; refusal?: string };
      const key = typeof value.text === 'string' ? 'text' : typeof value.refusal === 'string' ? 'refusal' : null;
      if (key === null) return part;
      const text = value[key]!;
      const next = editedText(text, offset, edits);
      offset += text.length;
      return next === text ? part : { ...part, [key]: next };
    }) as typeof content;
  } else return record;
  const updated = refs.map((ref) => {
    const before = edits.filter((edit) => edit.end <= ref.start).reduce((sum, edit) => sum + edit.text.length - (edit.end - edit.start), 0);
    const matching = edits.find((edit) => edit.start === ref.start && edit.end === ref.start + ref.chars);
    return { ...ref, start: ref.start + before, chars: matching ? matching.text.length : ref.chars };
  });
  const nextItem = item.type === 'message' ? { ...item, content: rewritten } : { ...item, output: rewritten };
  return { ...record, item: nextItem as typeof item,
    context: { ...record.context, frame: { ...record.context.frame!, events: updated } } };
}

/**
 * Earlier handoff spans are excerpted only where sidecar ranges identify their exact text.
 * Explicit currentHandoffs may also shorten unchanged automatic spans in protected input.
 * Other latest input text, media parts and blob refs remain intact.
 */
export function excerptHandoffRecords(
  records: readonly ContextRecord[], excerpt: (text: string) => string,
  options: HandoffExcerptOptions = {},
): ContextRecord[] {
  const boundary = inputBoundary(records);
  const protectedRecords = new Set(options.protectedRecords);
  const current = new Set(options.currentHandoffs);
  return records.map((record, index) => record.context.head ? record
    : excerptRecord(record, excerpt, index >= boundary || protectedRecords.has(record) ? current : undefined));
}
