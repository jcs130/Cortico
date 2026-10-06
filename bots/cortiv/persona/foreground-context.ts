/** Foreground request projection; the session and event ledger retain the original records. */
import { estimateMessagesTokens } from 'cortico/core/util.ts';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { HANDOFF_NOTE_TYPE } from '../../cormini/persona/handoffNote.ts';

export interface ForegroundContextConfig {
  enabled: boolean;
  maxHistoryTokens: number;
  minRecentRounds: number;
}

/** Optional deployment fallback for models whose routine calls benefit from shorter history. */
export const FOREGROUND_CONTEXT_DEFAULTS: ForegroundContextConfig = {
  enabled: false, maxHistoryTokens: 6_000, minRecentRounds: 2,
};

export interface ForegroundProjection {
  messages: ContextRecord[];
  omittedRecords: number;
  /** Retained history and supplied pins; system, developer and synthetic head are excluded. */
  historyTokens: number;
  /** Required history can exceed the configured budget; records are never truncated. */
  protectedTokens: number;
  projected: boolean;
}

interface Group { start: number; end: number; }
const FRAME_TOOL = 'external_event_frame';
const PINNED_TYPES = new Set([HANDOFF_NOTE_TYPE, 'pending_work', 'recent_speech', 'planning', 'activity_plan']);

function prefix(record: ContextRecord): boolean {
  return record.context.head === true || (record.item.type === 'message'
    && (record.item.role === 'system' || record.item.role === 'developer'));
}

/** Response siblings and tool partners form contiguous units, including intervening inputs. */
function atomicGroups(records: readonly ContextRecord[]): Group[] | null {
  const responses = new Map<string, Group>();
  const calls = new Map<string, number>();
  const receipts = new Map<string, number>();
  const intervals: Group[] = [];
  for (const [index, record] of records.entries()) {
    const response = record.context.responseId;
    if (response) {
      const group = responses.get(response);
      if (group) group.end = index;
      else responses.set(response, { start: index, end: index });
    }
    const item = record.item;
    if (item.type === 'function_call') {
      if (calls.has(item.call_id)) return null;
      calls.set(item.call_id, index);
    } else if (item.type === 'function_call_output') {
      if (receipts.has(item.call_id)) return null;
      receipts.set(item.call_id, index);
    }
  }
  for (const [id, start] of calls) {
    const end = receipts.get(id);
    if (end === undefined || end <= start) return null;
    intervals.push({ start, end });
  }
  if (calls.size !== receipts.size) return null;
  intervals.push(...responses.values());
  for (let index = 0; index < records.length;) {
    if (records[index].context.responseId || !isResponse(records[index])) { index++; continue; }
    const start = index++;
    while (index < records.length && !records[index].context.responseId && isResponse(records[index])) index++;
    intervals.push({ start, end: index - 1 });
  }
  const ends = records.map((_, index) => index);
  for (const group of intervals) ends[group.start] = Math.max(ends[group.start], group.end);
  const groups: Group[] = [];
  for (let start = 0; start < records.length;) {
    let end = ends[start];
    for (let index = start; index <= end; index++) end = Math.max(end, ends[index]);
    groups.push({ start, end });
    start = end + 1;
  }
  return groups;
}

function isResponse(record: ContextRecord): boolean {
  if (prefix(record)) return false;
  return !!record.context.responseId || record.item.type === 'reasoning'
    || (record.item.type === 'message' && record.item.role === 'assistant')
    || (record.item.type === 'function_call' && record.item.name !== FRAME_TOOL);
}

/**
 * Keeps the latest input batch and everything after it, recent complete responses, and Persona
 * checkpoint records. Other history is a suffix of whole response/tool units within the budget.
 * A malformed original pairing is returned unchanged so projection cannot hide the defect.
 */
export function projectForeground(
  records: readonly ContextRecord[],
  options: {
    maxHistoryTokens: number;
    minRecentRounds: number;
    /** Supplied current facts fully replace these source/type snapshot streams. */
    coveredSnapshots?: readonly { source: string; type: string }[];
    /** Supplied Persona state replaces historical checkpoint notes of these types. */
    coveredCheckpoints?: readonly string[];
  },
  pins: readonly ContextRecord[] = [],
): ForegroundProjection {
  const groups = atomicGroups(records);
  const supplied = pins.filter((pin, index) => !records.includes(pin) && pins.indexOf(pin) === index);
  if (!groups) {
    const messages = [...records, ...supplied];
    const historyTokens = estimateMessagesTokens(messages.filter((record) => !prefix(record)));
    return { messages, omittedRecords: 0, historyTokens, protectedTokens: historyTokens, projected: false };
  }
  const mandatory = new Set<number>();
  let latestInput = -1;
  let latestUserInput = -1;
  const latestPins = new Map<string, number>();
  const coveredSnapshots = new Set((options.coveredSnapshots ?? []).map(({ source, type }) => JSON.stringify([source, type])));
  const coveredCheckpoints = new Set(options.coveredCheckpoints ?? []);
  for (const [index, record] of records.entries()) {
    if (prefix(record)) mandatory.add(index);
    const item = record.item;
    if (item.type === 'message' && item.role === 'user' && !prefix(record)) latestUserInput = index;
    if ((item.type === 'function_call' && item.name === FRAME_TOOL)
      || record.context.frame?.events.some((event) => event.source !== 'persona')) latestInput = index;
    for (const event of record.context.frame?.events ?? []) {
      if (event.source === 'persona' && PINNED_TYPES.has(event.type)
        && !coveredCheckpoints.has(event.type)) latestPins.set(event.type, index);
      // Snapshot frames may carry deltas whose earlier baseline remains necessary.
      if (event.tags?.includes('snapshot') && !coveredSnapshots.has(JSON.stringify([event.source, event.type]))) mandatory.add(index);
    }
  }
  for (const index of latestPins.values()) mandatory.add(index);
  const inputBoundary = latestInput < 0 ? latestUserInput : latestUserInput < 0 ? latestInput : Math.min(latestInput, latestUserInput);
  for (let index = inputBoundary; inputBoundary >= 0 && index < records.length; index++) mandatory.add(index);
  let rounds = Math.max(0, Math.floor(options.minRecentRounds));
  for (let index = groups.length - 1; index >= 0 && rounds > 0; index--) {
    const group = groups[index];
    if (!records.slice(group.start, group.end + 1).some(isResponse)) continue;
    for (let at = group.start; at <= group.end; at++) mandatory.add(at);
    rounds--;
  }
  for (const pin of pins) {
    const index = records.indexOf(pin);
    if (index >= 0) mandatory.add(index);
  }
  const requiredGroups = new Set<number>();
  for (const [index, group] of groups.entries()) {
    for (let at = group.start; at <= group.end; at++) {
      if (mandatory.has(at)) { requiredGroups.add(index); break; }
    }
  }
  const history = (group: Group): ContextRecord[] => records.slice(group.start, group.end + 1).filter((record) => !prefix(record));
  const pinTokens = estimateMessagesTokens(supplied.filter((record) => !prefix(record)));
  const protectedTokens = pinTokens + [...requiredGroups].reduce((sum, index) => sum + estimateMessagesTokens(history(groups[index])), 0);
  const selected = new Set(requiredGroups);
  let historyTokens = protectedTokens;
  for (let index = groups.length - 1; index >= 0; index--) {
    if (selected.has(index)) continue;
    const cost = estimateMessagesTokens(history(groups[index]));
    if (historyTokens + cost > options.maxHistoryTokens) break;
    selected.add(index);
    historyTokens += cost;
  }
  const messages = groups.flatMap((group, index) => selected.has(index)
    ? records.slice(group.start, group.end + 1) : []);
  const omittedRecords = records.length - messages.length;
  messages.push(...supplied);
  return { messages, omittedRecords, historyTokens, protectedTokens, projected: omittedRecords > 0 };
}
