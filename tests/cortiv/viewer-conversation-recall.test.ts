import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialMemoryReview, type SocialReviewEntry } from '../../bots/cortiv/persona/social-memory-review.ts';
import { ViewerConversationRecall, VIEWER_CONVERSATION_RECALL_LIMITS } from '../../bots/cortiv/persona/viewer-conversation-recall.ts';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const at = '2026-01-02T21:00:00Z';
const row = (cursor: number, text = `记录${cursor}`, senderKey = '42', source = 'stream'): SocialReviewEntry => ({
  kind: 'audience', source, senderKey, at, uname: '同名观众', cursor, type: `${source}.danmaku`, text,
});
const request = (patch: Partial<Parameters<ViewerConversationRecall['recall']>[0]> = {}) => ({
  source: 'stream', senderKey: '42', beforeCursor: 1_000_000, beforeAt: at, ...patch,
});
function fixture(entries: SocialReviewEntry[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'viewer-recall-')); dirs.push(dir);
  const journal = new SocialMemoryReview(dir);
  const cutoffAt = entries.map(entry => entry.at).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? at;
  for (let offset = 0; offset < entries.length;) {
    let batch = entries.slice(offset, offset + 100);
    while (Buffer.byteLength(JSON.stringify({ auditId: `batch-${offset}`, cutoffAt, entries: batch }), 'utf8') > 64_000) batch = batch.slice(0, Math.ceil(batch.length / 2));
    journal.importHistory({ auditId: `batch-${offset}`, cutoffAt, entries: batch }, tool => tool === 'native_voice');
    offset += batch.length;
  }
  return { dir, journal, recall: new ViewerConversationRecall(journal) };
}
function append(journal: SocialMemoryReview, cursor: number, text: string, senderKey = '42') {
  journal.observe([{ cursor, ts: at, origin: 'external', source: 'stream', senderKey,
    type: 'stream.danmaku', text, meta: { uname: '同名观众', body: text } }]);
}

describe('bounded exact-identity audience recall', () => {
  it('returns prior audience evidence, excludes the current cursor and future time, and never pairs speech', () => {
    const { recall } = fixture([row(1, '昨晚我请你造玻璃房'),
      { kind: 'speech', at, tool: 'native_voice', script: '我答应了', receipt: '拒绝', failed: true },
      row(2, '现在这条'), { ...row(3, '未来这条'), at: '2026-01-03T00:00:00Z' }]);
    const out = recall.recall(request({ beforeCursor: 2 }));
    expect(out.entries.map(entry => entry.cursor)).toEqual([1]);
    expect(out.text).toContain('#1');
    expect(out.text).not.toContain('我答应了');
    expect(out.text).not.toContain('现在这条');
    expect(out.text).not.toContain('未来这条');
    expect(out.searchComplete).toBe(true);
  });

  it('keeps identical names and numeric keys on other platforms separate', () => {
    const { recall } = fixture([row(1, '这位要面包', '42'), row(2, '另一位要剑', '43'), row(3, '另一平台要鱼', '42', 'other')]);
    expect(recall.recall(request()).entries.map(entry => entry.text)).toEqual(['这位要面包']);
    expect(recall.recall(request({ senderKey: '43' })).entries.map(entry => entry.text)).toEqual(['另一位要剑']);
  });

  it('rebuilds from already reviewed journal evidence after process restart', () => {
    const { dir, journal } = fixture([row(1, '明天再来')]);
    journal.acknowledge(journal.nextPage()!);
    const recovered = new ViewerConversationRecall(new SocialMemoryReview(dir));
    expect(recovered.recall(request()).text).toContain('明天再来');
    expect(new SocialMemoryReview(dir).stateInfo().committedSeq).toBe(1);
  });

  it('uses literal Chinese bigrams and complete English words with finite recent evidence', () => {
    const { recall } = fixture([row(1, '我喜欢玻璃屋顶'), row(2, '昨天推过 cart'), row(3, '聊过 art 和花园'),
      row(4, '今晚想听歌'), row(5, '今天又来')]);
    const chinese = recall.recall(request({ query: '玻璃' }));
    expect(chinese.entries.some(entry => entry.cursor === 1)).toBe(true);
    const english = recall.recall(request({ query: 'art' }));
    expect(english.entries.some(entry => entry.cursor === 3)).toBe(true);
    expect(english.entries.some(entry => entry.cursor === 2)).toBe(false);
    expect(english.text).toContain('本地词法匹配');
    expect(english.entries.length).toBeLessThanOrEqual(VIEWER_CONVERSATION_RECALL_LIMITS.entries);
  });

  it('labels an unmatched topic without inventing a fact or silently substituting an answer', () => {
    const { recall } = fixture([row(1, '明天来看房子')]);
    const out = recall.recall(request({ query: '骑龙' }));
    expect(out.text).toContain('关键词未命中');
    expect(out.text).toContain('仅为近期原文');
    expect(out.entries[0].text).toBe('明天来看房子');
    expect(recall.recall(request({ senderKey: 'missing' })).text).toContain('无旧记录');
  });

  it('updates appended evidence incrementally and releases a previously current message on the next boundary', () => {
    const { journal, recall } = fixture(Array.from({ length: 400 }, (_, i) => row(i + 1, `原文${i + 1}`)));
    const read = vi.spyOn(journal, 'journalRead');
    const first = recall.recall(request({ beforeCursor: 400 }));
    expect(first.entries[0].cursor).toBe(399);
    const oldBytes = first.scannedBytes;
    read.mockClear();
    append(journal, 401, '刚来的新消息');
    const updated = recall.recall(request({ beforeCursor: 401 }));
    expect(updated.entries[0].cursor).toBe(400);
    expect(updated.entries.some(entry => entry.cursor === 401)).toBe(false);
    expect(updated.scannedBytes).toBeLessThan(oldBytes);
    expect(read).toHaveBeenCalledTimes(1);
    const unchanged = recall.recall(request({ beforeCursor: 401 }));
    expect(unchanged.scannedBytes).toBe(0);
  });

  it('finds a sparse identity in old pages with bounded progressive search instead of only a global tail', () => {
    const records = [row(1, '我说过玻璃窗')];
    for (let i = 2; i <= 2300; i++) records.push(row(i, '路过', 'other'));
    const { recall } = fixture(records);
    const first = recall.recall(request({ query: '玻璃' }));
    expect(first.searchComplete).toBe(false);
    expect(first.entries).toEqual([]);
    expect(first.text).toContain('未读完');
    expect(first.text).not.toContain('\n无旧记录。');
    expect(first.scannedPages).toBeLessThanOrEqual(VIEWER_CONVERSATION_RECALL_LIMITS.scanPages);
    expect(first.scannedBytes).toBeLessThanOrEqual(VIEWER_CONVERSATION_RECALL_LIMITS.scanBytes);
    const second = recall.recall(request({ query: '玻璃' }));
    expect(second.entries[0].cursor).toBe(1);
    expect(second.searchComplete).toBe(true);
  });

  it('keeps the text including provenance and truncation mark within the hard character limit', () => {
    const { recall } = fixture([row(1, '甲'.repeat(2000)), row(2, '乙'.repeat(2000)), row(3, '丙'.repeat(2000))]);
    const out = recall.recall(request());
    expect(out.text.length).toBeLessThanOrEqual(VIEWER_CONVERSATION_RECALL_LIMITS.textChars);
    expect(out.truncated).toBe(true);
    expect(out.text).toContain('原文节选');
    expect(out.text).toContain('#1');
    expect(out.text).toContain('#2');
    expect(out.text).toContain('#3');
    expect(out.entries).toHaveLength(VIEWER_CONVERSATION_RECALL_LIMITS.entries);
  });

  it('enforces the byte budget across UTF-8 chunk boundaries and continues a large page without dropping old rows', () => {
    const records = [row(1, '以前聊过玻璃')];
    for (let i = 2; i <= 240; i++) records.push(row(i, '汉'.repeat(2000), 'other'));
    const { recall } = fixture(records);
    const first = recall.recall(request({ query: '玻璃' }));
    expect(first.searchComplete).toBe(false);
    expect(first.scannedBytes).toBeLessThanOrEqual(VIEWER_CONVERSATION_RECALL_LIMITS.scanBytes);
    expect(first.scannedPages).toBeLessThan(VIEWER_CONVERSATION_RECALL_LIMITS.scanPages);
    const second = recall.recall(request({ query: '玻璃' }));
    expect(second.searchComplete).toBe(true);
    expect(second.entries[0].cursor).toBe(1);
  });

  it('refreshes a new page without rescanning the previous pages and preserves a topic search continuation', () => {
    const records = [row(1, '老话题玻璃')];
    for (let i = 2; i <= 2304; i++) records.push(row(i, '路过', 'other'));
    const { journal, recall } = fixture(records);
    const first = recall.recall(request({ query: '玻璃' }));
    expect(first.searchComplete).toBe(false);
    append(journal, 2305, '新话题钓鱼');
    const second = recall.recall(request({ query: '玻璃' }));
    expect(second.searchComplete).toBe(true);
    expect(second.entries.some(entry => entry.cursor === 1)).toBe(true);
    expect(second.entries.some(entry => entry.cursor === 2305)).toBe(true);
    expect(second.scannedPages).toBeLessThan(first.scannedPages);
  });

  it('restarts an evicted identity search with an explicit partial result', () => {
    const records = [row(1, '玻璃')];
    for (let i = 2; i <= 2200; i++) records.push(row(i, '路过', 'other'));
    const { recall } = fixture(records);
    expect(recall.recall(request()).searchComplete).toBe(false);
    for (let i = 0; i <= VIEWER_CONVERSATION_RECALL_LIMITS.identities; i++) recall.recall(request({ senderKey: `visitor${i}` }));
    const again = recall.recall(request());
    expect(again.searchComplete).toBe(false);
    expect(again.text).toContain('未读完');
  });

  it('rejects invalid identity/boundary inputs without modifying the journal watermark', () => {
    const { journal, recall } = fixture([row(1)]);
    const before = journal.stateInfo();
    expect(() => recall.recall(request({ senderKey: '../42' }))).toThrow();
    expect(() => recall.recall(request({ beforeCursor: Number.NaN }))).toThrow();
    expect(() => recall.recall(request({ beforeAt: 'invalid' }))).toThrow();
    expect(journal.stateInfo()).toEqual(before);
  });

  it('resets cached results when either the cursor or observation time upper bound shrinks', () => {
    const records = [row(1, '早先的话'), { ...row(2, '后来的话'), at: '2026-01-02T22:00:00Z' }];
    const { recall } = fixture(records);
    expect(recall.recall(request({ beforeAt: '2026-01-02T23:00:00Z' })).entries).toHaveLength(2);
    expect(recall.recall(request({ beforeCursor: 2, beforeAt: '2026-01-02T23:00:00Z' })).entries.map(entry => entry.cursor)).toEqual([1]);
    expect(recall.recall(request({ beforeAt: '2026-01-02T23:00:00Z' })).entries).toHaveLength(2);
    expect(recall.recall(request({ beforeAt: at })).entries.map(entry => entry.cursor)).toEqual([1]);
  });
});
