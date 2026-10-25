/** Generic admission check for speech grounded in a live observation. */
function observationSeconds(value: unknown): number {
  if (typeof value === 'number') return value;
  // Copy the source time verbatim. Never guess a timezone, year or seconds/milliseconds unit.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(0); calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return NaN;
  return Date.parse(value) / 1000;
}

export function checkSpeechFreshness(args: Record<string, unknown>, maxAgeSeconds = 0, now = Date.now()/1000) {
  if (args.action !== 'speak') return;
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) throw Error('Invalid speech observation age policy');
  // Dialogue and creative speech need no observation clock. A supplied source
  // clock remains authoritative and is never replaced with the submission time.
  if (args.observed_at === undefined) return;
  const at = observationSeconds(args.observed_at);
  if (!Number.isFinite(at) || at > now+1 || now-at > (maxAgeSeconds || 15))
    throw Error('stale_speech_observation: the supplied observation time is invalid or expired; speech was not submitted. Copy captured_at or the source event/sample timestamp verbatim as an ISO 8601 string including timezone, or use its existing Unix seconds. Do not replace old evidence with the current time or remove a stale timestamp to repeat the same claim. Read fresh evidence, describe it as history, or reply without making that live observation claim.');
}
