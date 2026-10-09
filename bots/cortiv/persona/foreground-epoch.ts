/** Persona-local request epochs retain history prefixes and optionally replace current-state suffixes. */
import { createHash, type Hash } from 'node:crypto';
import { estimateMessagesTokens } from 'cortico/core/util.ts';
import { fixPairing, validatePairing } from 'cortico/core/truncate.ts';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { HANDOFF_NOTE_TYPE } from '../../cormini/persona/handoffNote.ts';
import { projectForeground, type ForegroundProjection } from './foreground-context.ts';

export interface ForegroundEpochOptions {
  maxHistoryTokens: number;
  /** Automatic reading advice takes effect at the next compaction; configured budgets still rebuild immediately. */
  adaptiveMaxHistoryTokens?: number;
  minRecentRounds: number;
  /** Current pins form a replaceable suffix; append retains the legacy replay policy. */
  pinMode?: 'append' | 'current';
  coveredSnapshots?: readonly { source: string; type: string }[];
  coveredCheckpoints?: readonly string[];
}

/** A factory may excerpt old records before projecting; source identity still uses the raw ledger. */
export type ForegroundEpochProjector = (
  records: readonly ContextRecord[], options: ForegroundEpochOptions, pins: readonly ContextRecord[],
) => ForegroundProjection;

export type ForegroundEpochAppender = (
  records: readonly ContextRecord[], options: ForegroundEpochOptions,
) => ContextRecord[];

export type ForegroundEpochReason = 'initial' | 'reset' | 'source_changed' | 'options_changed'
  | 'handoff' | 'history_budget' | 'pairing' | 'append' | 'unchanged';

export interface ForegroundEpochProjection extends ForegroundProjection {
  /** History budget used when building this epoch. */
  maxHistoryTokens: number;
  epoch: number;
  rebuilt: boolean;
  rebuildReason: ForegroundEpochReason;
  appendedRecords: number;
  appendedPins: number;
  /** Approximate history limit for the next compaction; irreducible protected records get room to grow. */
  rebuildAtHistoryTokens: number;
}

interface EpochState {
  maxHistoryTokens: number;
  source: string[];
  optionsKey: string;
  activePins: Set<string>;
  base: ContextRecord[];
  protectedBaseTokens: number;
  tail: ContextRecord[];
  view: ForegroundProjection;
  rebuildAtHistoryTokens: number;
}

function isPrefix(record: ContextRecord): boolean {
  return record.context.head === true || (record.item.type === 'message'
    && (record.item.role === 'system' || record.item.role === 'developer'));
}

/** Stream large strings/media into a digest instead of serializing a second large JSON payload. */
function hashValue(hash: Hash, value: unknown): void {
  if (typeof value === 'string') { hash.update(`s${value.length}:`); hash.update(value); return; }
  if (value === null) { hash.update('null;'); return; }
  if (ArrayBuffer.isView(value)) {
    hash.update(`binary:${value.byteLength}:`);
    hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return;
  }
  if (Array.isArray(value)) {
    hash.update('[');
    for (const part of value) hashValue(hash, part);
    hash.update(']');
    return;
  }
  if (typeof value === 'object') {
    hash.update('{');
    for (const key of Object.keys(value as object).sort()) {
      hashValue(hash, key);
      hashValue(hash, (value as Record<string, unknown>)[key]);
    }
    hash.update('}');
    return;
  }
  hash.update(`${typeof value}:${String(value)};`);
}

function fingerprint(value: unknown): string {
  const hash = createHash('sha256');
  hashValue(hash, value);
  return hash.digest('hex');
}

/** Pins are recreated by callers: generated record IDs and metadata timestamps do not change their body. */
function pinFingerprint(record: ContextRecord): string {
  const { id: _id, ...item } = record.item;
  const { ts: _ts, ...context } = record.context;
  return fingerprint({ version: record.version, item, context });
}

function optionsKey(options: ForegroundEpochOptions, notice?: ContextRecord): string {
  return fingerprint({
    maxHistoryTokens: options.maxHistoryTokens,
    adaptive: options.adaptiveMaxHistoryTokens !== undefined,
    minRecentRounds: options.minRecentRounds,
    pinMode: options.pinMode ?? 'append',
    coveredSnapshots: [...new Set((options.coveredSnapshots ?? [])
      .map(({ source, type }) => JSON.stringify([source, type])))].sort(),
    coveredCheckpoints: [...new Set(options.coveredCheckpoints ?? [])].sort(),
    notice: notice ? pinFingerprint(notice) : null,
  });
}

function historyTokens(records: readonly ContextRecord[]): number {
  return estimateMessagesTokens(records.filter((record) => !isPrefix(record)));
}

function uniquePins(pins: readonly ContextRecord[]): { records: ContextRecord[]; keys: Set<string> } {
  const keys = new Set<string>();
  const records: ContextRecord[] = [];
  for (const pin of pins) {
    const key = pinFingerprint(pin);
    if (keys.has(key)) continue;
    keys.add(key);
    records.push(pin);
  }
  return { records, keys };
}

/**
 * Holds request copies only. The authoritative session remains complete and is never mutated.
 * Current pins can occupy a replaceable suffix after the stable history prefix.
 * reset() is required when switching to a full expand_context request or changing session identity.
 */
export class ForegroundEpoch {
  private current: EpochState | null = null;
  private epoch = 0;
  private resetPending = false;

  constructor(
    private readonly project: ForegroundEpochProjector = projectForeground,
    private readonly prepareAppend: ForegroundEpochAppender = records => [...records],
  ) {}

  reset(): void {
    this.current = null;
    this.resetPending = true;
  }

  prepare(
    records: readonly ContextRecord[], options: ForegroundEpochOptions,
    pins: readonly ContextRecord[] = [], notice?: ContextRecord,
  ): ForegroundEpochProjection {
    if (!Number.isFinite(options.maxHistoryTokens) || options.maxHistoryTokens <= 0
      || (options.adaptiveMaxHistoryTokens !== undefined
        && (!Number.isFinite(options.adaptiveMaxHistoryTokens) || options.adaptiveMaxHistoryTokens <= 0))
      || !Number.isFinite(options.minRecentRounds) || options.minRecentRounds < 0) {
      throw new RangeError('Foreground epoch requires a positive history budget and nonnegative recent rounds.');
    }
    const source = records.map(fingerprint);
    const key = optionsKey(options, notice);
    const supplied = uniquePins(pins);
    const sourceSet = new Set(source);
    const previous = this.current;
    const external = supplied.records.filter(record => !sourceSet.has(fingerprint(record)));
    const oldPins = new Map(previous?.tail.map(record => [pinFingerprint(record), record]) ?? []);
    const tailPins = external.map(record => oldPins.get(pinFingerprint(record)) ?? record);
    const appendable = previous !== null && source.length >= previous.source.length
      && previous.source.every((part, index) => source[index] === part);
    const delta = appendable ? records.slice(previous.source.length) : [];
    const oldSource = new Set(previous?.source ?? []);
    const introduced = previous ? records.filter((_, index) => !oldSource.has(source[index])) : [];
    const changedPins = previous ? supplied.records.filter((pin) => !previous.activePins.has(pinFingerprint(pin))) : [];
    const currentPins = options.pinMode === 'current';
    let reason: ForegroundEpochReason = previous ? 'unchanged' : this.resetPending ? 'reset' : 'initial';
    if (previous && !appendable) reason = 'source_changed';
    else if (previous && previous.optionsKey !== key) reason = 'options_changed';
    else if (previous && delta.some((record) => isPrefix(record)
      || record.context.frame?.events.some((event) => event.source === 'persona' && event.type === HANDOFF_NOTE_TYPE))) {
      reason = 'handoff';
    }

    if (previous && reason === 'unchanged') {
      const appended = [...this.prepareAppend(delta, { ...options, maxHistoryTokens: previous.maxHistoryTokens }),
        ...(currentPins ? [] : changedPins)];
      const base = [...previous.base, ...appended];
      const next = currentPins ? [...base, ...tailPins] : base;
      const tokens = historyTokens(next);
      if (validatePairing(next).length) reason = 'pairing';
      else if (tokens > previous.rebuildAtHistoryTokens) reason = 'history_budget';
      else {
        this.current = {
          ...previous, source, activePins: supplied.keys, base, tail: structuredClone(tailPins),
          protectedBaseTokens: previous.protectedBaseTokens + historyTokens(appended),
          view: {
            ...previous.view, messages: structuredClone(next), historyTokens: tokens,
            protectedTokens: previous.protectedBaseTokens + historyTokens(appended)
              + (currentPins ? historyTokens(tailPins) : 0),
          },
        };
        return this.result(false, appended.length || changedPins.length ? 'append' : 'unchanged', delta.length, changedPins.length);
      }
    }

    // Rotation must not discard newly delivered or rewritten records, even when a prefix/body edit
    // makes the source cease to be an extension. Identity includes content, not only generated IDs.
    // The projector retains these by original identity and closes their complete response/tool group.
    const maxHistoryTokens = options.adaptiveMaxHistoryTokens ?? options.maxHistoryTokens;
    const candidate = this.project(records, { ...options, maxHistoryTokens }, [...supplied.records, ...introduced]);
    const externalPins = new Set(external.map(fingerprint));
    const base = fixPairing(currentPins
      ? candidate.messages.filter(record => !externalPins.has(fingerprint(record))) : candidate.messages);
    const messages = currentPins ? [...base, ...tailPins] : base;
    let noticeInserted = false;
    if (notice && !messages.some((entry) => pinFingerprint(entry) === pinFingerprint(notice))) {
      let index = 0;
      while (index < messages.length && isPrefix(messages[index])) index++;
      base.splice(index, 0, notice);
      if (messages !== base) messages.splice(index, 0, notice);
      noticeInserted = true;
    }
    const tokens = historyTokens(messages);
    const protectedTokens = candidate.protectedTokens
      + (noticeInserted && notice && !isPrefix(notice) ? historyTokens([notice]) : 0);
    const altered = messages.length !== records.length
      || messages.some((entry, index) => fingerprint(entry) !== source[index]);
    this.epoch++;
    this.resetPending = false;
    this.current = {
      source, optionsKey: key, maxHistoryTokens, activePins: supplied.keys, base: structuredClone(base), tail: structuredClone(tailPins),
      protectedBaseTokens: protectedTokens - (currentPins ? historyTokens(tailPins) : 0),
      view: { ...candidate, messages: structuredClone(messages), historyTokens: tokens,
        protectedTokens, projected: candidate.projected || altered },
      // Mandatory input can already exceed 2x the soft budget; repeated identical cold builds help nobody.
      rebuildAtHistoryTokens: Math.max(maxHistoryTokens * 2, tokens + maxHistoryTokens),
    };
    return this.result(true, reason, 0, 0);
  }

  private result(
    rebuilt: boolean, rebuildReason: ForegroundEpochReason, appendedRecords: number, appendedPins: number,
  ): ForegroundEpochProjection {
    const current = this.current!;
    return {
      ...current.view, messages: structuredClone(current.view.messages), epoch: this.epoch,
      maxHistoryTokens: current.maxHistoryTokens,
      rebuilt, rebuildReason, appendedRecords, appendedPins,
      rebuildAtHistoryTokens: current.rebuildAtHistoryTokens,
    };
  }
}
