/** Bounded lexical retrieval of exact-identity audience evidence; the journal remains authoritative. */
import { SOCIAL_REVIEW_LIMITS, type SocialMemoryReview, type SocialReviewEntry } from './social-memory-review.ts';

export const VIEWER_CONVERSATION_RECALL_LIMITS = {
  entries: 3, textChars: 800, scanBytes: 1024 * 1024, scanPages: 16, chunkBytes: 64 * 1024,
  lineBytes: 128 * 1024, identities: 64, queriesPerIdentity: 2, deferredEntries: 16, queryChars: 300,
};
type AudienceEntry = Extract<SocialReviewEntry, { kind: 'audience' }>;
type Journal = Pick<SocialMemoryReview, 'stateInfo' | 'journalPageInfo' | 'journalRead'>;
interface Candidate { seq: number; entry: AudienceEntry; score: number; }
interface Scan { page: number; offset: number; carry: Buffer; oversized: boolean; }
interface RecallState {
  cursor: number; atMs: number; seenSeq: number; history: Scan; refresh: Scan | null; refreshUntil: number;
  refreshFloor: { page: number; bytes: number } | null;
  recent: Candidate[]; matches: Candidate[]; deferred: Candidate[]; deferredOverflow: boolean;
  complete: boolean; damaged: boolean; tail: { page: number; bytes: number; modifiedAtMs: number } | null;
}
export interface ViewerConversationRecallRequest {
  source: string; senderKey: string; beforeCursor: number; beforeAt: string; query?: string;
}
export interface ViewerConversationRecallResult {
  entries: AudienceEntry[]; text: string; searchComplete: boolean; truncated: boolean;
  scannedBytes: number; scannedPages: number;
}
const identityPart = (value: string): boolean => value.length <= 128 && /^[a-zA-Z0-9_.-]+$/.test(value) && value !== '.' && value !== '..';
const time = (value: string): number => Date.parse(value);
const order = (a: Candidate, b: Candidate): number => time(b.entry.at) - time(a.entry.at) || b.entry.cursor - a.entry.cursor || b.seq - a.seq;
const safeText = (value: string): string => value.replace(/[\r\n\u0000-\u001f]+/g, ' ');

/** Chinese bigrams and Latin words are literal matching units, not semantic judgments. */
function terms(query: string): string[] {
  const found = new Set<string>();
  for (const match of query.toLowerCase().matchAll(/\p{Script=Han}+|[a-z0-9_]+/gu)) {
    const word = match[0];
    if (/^\p{Script=Han}/u.test(word)) {
      const chars = [...word];
      if (chars.length === 1) found.add(word);
      else for (let i = 0; i + 1 < chars.length; i++) found.add(chars[i] + chars[i + 1]);
    } else found.add(word);
  }
  return [...found];
}
function score(text: string, query: readonly string[]): number {
  const words = new Set(text.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
  const lower = text.toLowerCase();
  return query.reduce((sum, term) => sum + (/\p{Script=Han}/u.test(term) ? Number(lower.includes(term)) : Number(words.has(term))), 0);
}
function keep(items: Candidate[], next: Candidate, ranked: boolean): Candidate[] {
  const all = items.filter(item => item.seq !== next.seq); all.push(next);
  all.sort(ranked ? (a, b) => b.score - a.score || order(a, b) : order);
  return all.slice(0, VIEWER_CONVERSATION_RECALL_LIMITS.entries);
}

export class ViewerConversationRecall {
  private readonly cache = new Map<string, Map<string, RecallState>>();
  constructor(private readonly journal: Journal) {}

  recall(request: ViewerConversationRecallRequest): ViewerConversationRecallResult {
    if (!identityPart(request.source) || !identityPart(request.senderKey) || !Number.isSafeInteger(request.beforeCursor)
      || request.beforeCursor < 0 || !Number.isFinite(time(request.beforeAt))
      || request.query !== undefined && (typeof request.query !== 'string' || request.query.length > VIEWER_CONVERSATION_RECALL_LIMITS.queryChars)) {
      throw new RangeError('Recall needs an exact source/senderKey and a valid cursor/time boundary.');
    }
    const tokens = terms(request.query ?? ''), key = `${request.source}/${request.senderKey}`, queryKey = tokens.join('\0');
    let queries = this.cache.get(key);
    if (!queries) {
      queries = new Map(); this.cache.set(key, queries);
      if (this.cache.size > VIEWER_CONVERSATION_RECALL_LIMITS.identities) this.cache.delete(this.cache.keys().next().value!);
    } else { this.cache.delete(key); this.cache.set(key, queries); }
    const seq = this.journal.stateInfo().lastSeq;
    let state = queries.get(queryKey);
    const previousTail = state?.tail;
    const info = previousTail ? this.journal.journalPageInfo(previousTail.page) : null;
    const rewritten = previousTail && (!info || info.bytes < previousTail.bytes
      || info.bytes === previousTail.bytes && info.modifiedAtMs !== previousTail.modifiedAtMs);
    if (!state || rewritten || seq < state.seenSeq || request.beforeCursor < state.cursor || time(request.beforeAt) < state.atMs
      || state.deferredOverflow && (request.beforeCursor > state.cursor || time(request.beforeAt) > state.atMs)) {
      const scan = this.newScan(seq);
      state = { cursor: request.beforeCursor, atMs: time(request.beforeAt), seenSeq: seq, history: scan,
        refresh: null, refreshUntil: 0, refreshFloor: null, recent: [], matches: [], deferred: [], deferredOverflow: false,
        complete: scan.page < 0, damaged: false, tail: this.tailInfo(seq) };
      queries.set(queryKey, state);
    }
    queries.delete(queryKey); queries.set(queryKey, state);
    if (queries.size > VIEWER_CONVERSATION_RECALL_LIMITS.queriesPerIdentity) queries.delete(queries.keys().next().value!);
    state.cursor = request.beforeCursor; state.atMs = time(request.beforeAt);
    const qualifies = (entry: AudienceEntry): boolean => entry.cursor < request.beforeCursor && time(entry.at) <= state.atMs;
    for (const item of state.deferred.filter(item => qualifies(item.entry))) this.accept(state, item);
    state.deferred = state.deferred.filter(item => !qualifies(item.entry));
    if (seq > state.seenSeq && !state.refresh) {
      state.refresh = this.newScan(seq); state.refreshUntil = state.seenSeq;
      state.refreshFloor = state.tail;
      state.seenSeq = seq; state.tail = this.tailInfo(seq);
    }
    const pages = new Set<number>(); let bytes = 0;
    const consume = (raw: unknown): void => {
      if (!raw || typeof raw !== 'object') { state.damaged = true; return; }
      const row = raw as { seq?: unknown; entry?: unknown };
      if (!Number.isSafeInteger(row.seq) || !row.entry || typeof row.entry !== 'object') { state.damaged = true; return; }
      if (Number(row.seq) > state.seenSeq) return;
      const entry = row.entry as AudienceEntry;
      if (entry.kind !== 'audience' || entry.source !== request.source || entry.senderKey !== request.senderKey) return;
      if (!Number.isSafeInteger(entry.cursor) || !Number.isFinite(time(entry.at)) || typeof entry.text !== 'string'
        || typeof entry.uname !== 'string' || ![`${request.source}.danmaku`, `${request.source}.chat`].includes(entry.type)) { state.damaged = true; return; }
      const item = { seq: Number(row.seq), entry, score: score(entry.text, tokens) };
      if (qualifies(entry)) this.accept(state, item);
      else if (!state.deferred.some(held => held.seq === item.seq)) {
        state.deferred.push(item);
        if (state.deferred.length > VIEWER_CONVERSATION_RECALL_LIMITS.deferredEntries) {
          state.deferredOverflow = true; state.deferred.shift();
        }
      }
    };
    while (bytes < VIEWER_CONVERSATION_RECALL_LIMITS.scanBytes) {
      const scan = state.refresh ?? (state.complete ? null : state.history);
      if (!scan || scan.page < 0) { if (!state.refresh) state.complete = true; break; }
      if (!pages.has(scan.page) && pages.size >= VIEWER_CONVERSATION_RECALL_LIMITS.scanPages) break;
      pages.add(scan.page);
      const floor = state.refresh && state.refreshFloor?.page === scan.page ? state.refreshFloor.bytes : 0;
      if (state.refresh && state.refreshFloor && (scan.page < state.refreshFloor.page || scan.offset <= floor)) {
        state.refresh = null; continue;
      }
      if (scan.offset === 0) {
        this.previousPage(scan, state); continue;
      }
      const length = Math.min(scan.offset - floor, VIEWER_CONVERSATION_RECALL_LIMITS.chunkBytes,
        VIEWER_CONVERSATION_RECALL_LIMITS.scanBytes - bytes);
      const start = scan.offset - length;
      const chunk = this.journal.journalRead(scan.page, start, length); bytes += chunk.length;
      if (chunk.length !== length) { state.damaged = true; break; }
      const joined = Buffer.concat([chunk, scan.carry]);
      const completeStart = start === 0 || state.refresh !== null && start === floor;
      const boundary = !completeStart ? joined.indexOf(10) : -1;
      const body = !completeStart ? boundary >= 0 ? joined.subarray(boundary + 1) : Buffer.alloc(0) : joined;
      const lines = body.toString('utf8').split('\n');
      let refreshFinished = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        if (scan.oversized && i === 0) { state.damaged = true; continue; }
        try {
          const row = JSON.parse(lines[i]) as { seq?: number };
          if (state.refresh && row.seq !== undefined && row.seq <= state.refreshUntil) { refreshFinished = true; break; }
          consume(row);
        } catch { state.damaged = true; }
      }
      if (refreshFinished) { state.refresh = null; continue; }
      const carry = !completeStart ? boundary >= 0 ? joined.subarray(0, boundary) : joined : Buffer.alloc(0);
      if (carry.length > VIEWER_CONVERSATION_RECALL_LIMITS.lineBytes) { scan.oversized = true; scan.carry = Buffer.alloc(0); state.damaged = true; }
      else { scan.carry = carry; if (boundary >= 0 || completeStart) scan.oversized = false; }
      scan.offset = start;
      if (state.refresh && scan.offset === floor && state.refreshFloor?.page === scan.page) { state.refresh = null; continue; }
      if (scan.offset === 0) {
        if (state.refresh) this.previousPage(scan, state);
        else if (!tokens.length && state.recent.length >= VIEWER_CONVERSATION_RECALL_LIMITS.entries) state.complete = true;
        else this.previousPage(scan, state);
      }
      // Without a topic the three latest identity-matched entries satisfy the request.
      if (!state.refresh && !tokens.length && state.recent.length >= VIEWER_CONVERSATION_RECALL_LIMITS.entries) { state.complete = true; break; }
    }
    if (state.history.page < 0) state.complete = true;
    let selected = tokens.length && state.matches.length ? [...state.matches.slice(0, 2)] : [];
    for (const item of state.recent) if (selected.length < VIEWER_CONVERSATION_RECALL_LIMITS.entries && !selected.some(row => row.seq === item.seq)) selected.push(item);
    selected.sort(order);
    const searchComplete = state.complete && state.refresh === null && seq <= state.seenSeq && !state.damaged;
    const header = `[观众原文检索 ${request.source}/${request.senderKey}；本地词法匹配，不代表理解或完整对话]`;
    const status = state.damaged ? '部分证据行无法读取；结果不完整。'
      : !searchComplete ? '检索预算内未读完；同条件再次查询会继续旧页。' : '';
    const topic = tokens.length && !state.matches.length ? '关键词未命中；若列出记录，仅为近期原文。' : '';
    const notes = [header, status, topic].filter(Boolean);
    if (!selected.length) notes.push(searchComplete ? '无旧记录。' : '已检索部分未找到旧记录。');
    const prefixes = selected.map(item => `${new Date(time(item.entry.at)).toISOString()} #${item.entry.cursor} ${safeText(item.entry.uname).slice(0, 48)}：`);
    const cap = VIEWER_CONVERSATION_RECALL_LIMITS.textChars, suffix = '\n[原文节选；其余未展开]';
    const available = cap - notes.join('\n').length - prefixes.reduce((sum, prefix) => sum + prefix.length, 0)
      - selected.length - suffix.length;
    const quoteChars = selected.length ? Math.max(0, Math.floor(available / selected.length)) : 0;
    let truncated = false;
    const lines = selected.map((item, index) => {
      const quote = safeText(item.entry.text);
      truncated ||= quote.length > quoteChars || safeText(item.entry.uname).length > 48;
      return prefixes[index] + quote.slice(0, quoteChars);
    });
    const text = [notes.join('\n'), ...lines].join('\n') + (truncated ? suffix : '');
    return { entries: selected.map(item => item.entry), text, searchComplete, truncated, scannedBytes: bytes, scannedPages: pages.size };
  }

  private accept(state: RecallState, item: Candidate): void {
    state.recent = keep(state.recent, item, false);
    if (item.score > 0) state.matches = keep(state.matches, item, true);
  }
  private newScan(seq: number): Scan {
    const page = seq ? Math.floor((seq - 1) / SOCIAL_REVIEW_LIMITS.journalEntries) : -1;
    return { page, offset: page < 0 ? 0 : this.journal.journalPageInfo(page)?.bytes ?? 0, carry: Buffer.alloc(0), oversized: false };
  }
  private tailInfo(seq: number): RecallState['tail'] {
    const page = seq ? Math.floor((seq - 1) / SOCIAL_REVIEW_LIMITS.journalEntries) : -1;
    const info = page < 0 ? null : this.journal.journalPageInfo(page);
    return info ? { page, ...info } : null;
  }
  private previousPage(scan: Scan, state: RecallState): void {
    scan.page--; scan.carry = Buffer.alloc(0); scan.oversized = false;
    scan.offset = scan.page < 0 ? 0 : this.journal.journalPageInfo(scan.page)?.bytes ?? 0;
    if (scan.page < 0 && state.refresh) state.refresh = null;
  }
}
