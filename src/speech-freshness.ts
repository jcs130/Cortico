/** Generic admission check for speech grounded in a live observation. */
export function observationSeconds(value: unknown): number {
  if (typeof value === 'number') return value;
  // Copy the source time verbatim. Never guess a timezone, year or seconds/milliseconds unit.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(0); calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return NaN;
  return Date.parse(value) / 1000;
}

export const RECENT_SPEECH_MAX_AGE_SECONDS = 300;
export function checkSpeechFreshness(args: Record<string, unknown>, maxAgeSeconds = 0, now = Date.now()/1000) {
  if (args.action !== 'speak') return;
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) throw Error('Invalid speech observation age policy');
  if (args.evidence_mode !== undefined && !['current', 'recent', 'dialogue'].includes(String(args.evidence_mode)))
    throw Error('Invalid speech evidence mode');
  if (args.evidence_mode === 'dialogue') {
    if (args.observed_at !== undefined || args.observed_event !== undefined)
      throw Error('Dialogue cannot carry observation evidence; use current or recent for factual observation claims');
    return;
  }
  if (args.observed_event !== undefined) throw Error('Speech event evidence must be resolved by the host before admission');
  // Dialogue and creative speech need no observation clock. A supplied source
  // clock remains authoritative and is never replaced with the submission time.
  if (args.observed_at === undefined) {
    if (args.evidence_mode === 'recent') throw Error('Recent event speech requires the original observation timestamp');
    return;
  }
  const at = observationSeconds(args.observed_at);
  const limit = args.evidence_mode === 'recent' ? RECENT_SPEECH_MAX_AGE_SECONDS : (maxAgeSeconds || 15);
  if (!Number.isFinite(at) || at > now+1 || now-at > limit)
    throw Error('stale_speech_observation: speech was not submitted. '
      + (Number.isFinite(at) ? `Observation age ${Math.round((now-at)*10)/10}s; ${args.evidence_mode??'current'} limit ${limit}s. ` : 'Invalid source timestamp. ')
      + 'Copy captured_at or the source event/sample timestamp verbatim as ISO 8601 with timezone or existing Unix seconds. '
      + 'Do not refresh an old timestamp or delete it to repeat the same claim. '
      + (Number.isFinite(at)&&at<=now&&now-at<=RECENT_SPEECH_MAX_AGE_SECONDS
        ? 'To recount this event as something that just happened, keep observed_at unchanged and use evidence_mode:"recent" (300s); phrase the text as a past event, not current state. '
        : '')
      + 'For current-state claims read fresh evidence; otherwise reply without that observation claim.');
}

/** Resolve an event identity, never a model-generated replacement for its clock. */
export function resolveSpeechEvidence(args: Record<string, unknown>, get: (cursor: number) => {source: string; ts: string} | undefined) {
  if (args.action !== 'speak' || args.observed_event === undefined) return {...args};
  const ref = args.observed_event as {source?: unknown; cursor?: unknown} | null;
  if (!ref || typeof ref.source !== 'string' || !ref.source || !Number.isSafeInteger(ref.cursor) || Number(ref.cursor) < 0)
    throw Error('Invalid speech event reference: copy source and cursor from the original event');
  if (args.evidence_mode === 'dialogue') throw Error('Dialogue cannot carry observation evidence');
  const event = get(Number(ref.cursor));
  if (!event || event.source !== ref.source || !Number.isFinite(observationSeconds(event.ts)))
    throw Error('Speech source event is unavailable or belongs to a different source');
  if (args.observed_at !== undefined && observationSeconds(args.observed_at) !== observationSeconds(event.ts))
    throw Error('Speech timestamp conflicts with its source event');
  const {observed_event, ...normalized} = args;
  return {...normalized, observed_at:event.ts};
}
