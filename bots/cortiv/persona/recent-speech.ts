import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';

export const RECENT_SPEECH_FILE = 'sessions/_speech.json';
const MAX_ENTRIES = 8;
const MAX_AGE_MS = 30 * 60_000;

interface SpeechEntry {
  callId: string;
  atMs: number;
  text: string;
  airedText?: string;
}

interface SpeechState {
  version: 1;
  entries: SpeechEntry[];
  lastAudienceAtMs: number;
}

export function spokenText(script: string): string {
  return script
    .replace(/【[^】]*】|<[^>]*>|\[[^\]]*\]/g, '')
    .replace(/\([^\s()@]{1,32}@(?:\d+(?:\.\d+)?|\.\d+)\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function lastQuestion(text: string): string | null {
  const marked = text.match(/[^。！？!?；;\n]*[？?]/g);
  if (marked?.length) return marked[marked.length - 1].trim();
  const unmarked = /(?:^|[。！；;\n])([^。！？!?；;\n]*(?:吗|呢))\s*$/.exec(text);
  return unmarked?.[1].trim() || null;
}

function emptyState(): SpeechState {
  return { version: 1, entries: [], lastAudienceAtMs: 0 };
}

function isSpeechEntry(value: unknown): value is SpeechEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.callId === 'string' && typeof row.atMs === 'number'
    && Number.isFinite(row.atMs) && typeof row.text === 'string'
    && (row.airedText === undefined || typeof row.airedText === 'string');
}

/** The Persona's recent accepted scripts, kept in Memory across session replacement. */
export class RecentSpeech {
  private readonly file: string;
  private state: SpeechState = emptyState();

  constructor(memoryDir: string) {
    this.file = join(memoryDir, RECENT_SPEECH_FILE);
    this.reload();
  }

  reload(): void {
    try {
      const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid recent speech');
      const stored = value as Record<string, unknown>;
      if (stored.version !== 1 || !Array.isArray(stored.entries)
        || !stored.entries.every(isSpeechEntry)
        || typeof stored.lastAudienceAtMs !== 'number'
        || !Number.isFinite(stored.lastAudienceAtMs)) throw new Error('invalid recent speech');
      this.state = {
        version: 1,
        entries: stored.entries.slice(-MAX_ENTRIES),
        lastAudienceAtMs: stored.lastAudienceAtMs,
      };
    } catch {
      this.state = emptyState();
    }
  }

  capture(snapshot: readonly ContextRecord[]): void {
    const receipts = new Map<string, string>();
    for (const row of snapshot) {
      if (row.item.type === 'function_call_output' && !row.context.head) {
        receipts.set(row.item.call_id, textOf(row));
      }
    }
    const calls = snapshot.filter((row) => row.item.type === 'function_call'
      && row.item.name === 'vtuber_act' && !row.context.head).slice(-MAX_ENTRIES);
    let changed = false;
    for (const row of calls) {
      const call = row.item;
      if (call.type !== 'function_call' || this.state.entries.some((entry) => entry.callId === call.call_id)) continue;
      const receipt = receipts.get(call.call_id) ?? '';
      if (!/^(?:已开演\(流式\)|已排入演出)/.test(receipt)) continue;
      let args: unknown;
      try { args = JSON.parse(call.arguments); } catch { continue; }
      if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
      const script = (args as Record<string, unknown>).script;
      if (typeof script !== 'string') continue;
      const text = spokenText(script);
      if (!text) continue;
      const atMs = Date.parse(row.context.ts ?? '') || Date.now();
      this.state.entries.push({ callId: call.call_id, atMs, text });
      this.state.entries = this.state.entries.slice(-MAX_ENTRIES);
      changed = true;
    }
    if (changed) this.save();
  }

  observe(events: readonly EventEnvelope[]): void {
    let changed = false;
    for (const event of events) {
      if (event.type === 'vtuber.act.outcome' && Array.isArray(event.meta?.outcomes)) {
        for (const outcome of event.meta.outcomes) {
          if (!outcome || typeof outcome !== 'object') continue;
          const row = outcome as Record<string, unknown>;
          if (typeof row.callId !== 'string' || typeof row.script !== 'string') continue;
          const entry = this.state.entries.find((item) => item.callId === row.callId);
          if (!entry) continue;
          const airedText = spokenText(row.script);
          if (entry.airedText !== airedText) { entry.airedText = airedText; changed = true; }
        }
      }
      if ((event.type === 'bilibili.danmaku' || event.type === 'vtuber.danmaku')
        && event.origin === 'external') {
        const atMs = Date.parse(event.ts);
        if (Number.isFinite(atMs) && atMs > this.state.lastAudienceAtMs) {
          const question = [...this.state.entries].reverse().find((entry) =>
            entry.airedText !== '' && lastQuestion(entry.airedText ?? entry.text));
          if (question && this.state.lastAudienceAtMs <= question.atMs && atMs > question.atMs) changed = true;
          this.state.lastAudienceAtMs = atMs;
        }
      }
    }
    if (changed) this.save();
  }

  note(nowMs = Date.now()): string {
    const entries = this.state.entries.filter((entry) => nowMs - entry.atMs < MAX_AGE_MS
      && nowMs >= entry.atMs && entry.airedText !== '');
    if (entries.length === 0) return '';
    const lines = entries.slice(-3).map((entry) => `- ${new Date(entry.atMs).toISOString()} 已提交：「${spokenText(entry.airedText ?? entry.text).slice(0, 100)}」`);
    const question = [...entries].reverse().map((entry) => ({
      text: lastQuestion(entry.airedText ?? entry.text), atMs: entry.atMs,
    })).find((candidate) => candidate.text);
    const focus = question
      ? `最近向观众提问：「${question.text!.slice(0, 140)}」。`
        + (this.state.lastAudienceAtMs <= question.atMs
          ? '此后暂无新弹幕记录；这句已问过，不要换词再问同一个问题。'
          : '此后有新弹幕；先核对是否已回答，别直接换词重问。')
      : '';
    return [
      '[memory] 最近交给演出的台词（受理回执不保证观众端听完）：',
      ...lines,
      focus,
      '这些是过去的发言证据，不是待念的稿子，也不证明其中说的打算已经执行。可回答新问题、继续行动；明确未播出或观众要求复述时可补说。',
    ].filter(Boolean).join('\n');
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state) + '\n', 'utf8');
    renameSync(temporary, this.file);
  }
}
