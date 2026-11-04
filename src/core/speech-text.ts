/** Explicit, backend-independent spoken forms. Empty by default; display/chat text is untouched. */
export type SpeechPronunciations = Record<string, string>;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function validatePronunciations(value: SpeechPronunciations = {}): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 64)
    throw Error("Speech pronunciations require an object with at most 64 entries");
  for (const [name, spoken] of Object.entries(value)) {
    if (!name.trim() || name.length > 80 || /[<>\[\]\r\n\x00-\x1f]/u.test(name)
      || typeof spoken !== "string" || !spoken.trim() || spoken.length > 120
      || /[<>\[\]\r\n\x00-\x1f]/u.test(spoken))
      throw Error("Speech pronunciations must map names to plain spoken words, without markup");
  }
  return Object.keys(value).sort((a, b) => b.length - a.length);
}

/** Latin names next to Chinese text match, but a different longer username does not. */
export function termPattern(term: string): string {
  const before = /^[A-Za-z0-9_]/.test(term) ? "(?<![A-Za-z0-9_])" : "";
  const after = /[A-Za-z0-9_]$/.test(term) ? "(?![A-Za-z0-9_])" : "";
  return before + escape(term) + after;
}

/** Keep existing backend controls atomic; never copy point events into another request. */
export const SPEECH_MARKUP = String.raw`(?:<\|phoneme_start\|>[^<>]*<\|phoneme_end\|>)+|<\|speaker:\d+\|>|\[[^\]\r\n]{1,120}\]|<(whisper|emphasis|soft|fast|slow|stress|forceful)>[\s\S]*?<\/\1>`;

export function spokenText(text: string, dictionary: SpeechPronunciations = {}): string {
  const terms = validatePronunciations(dictionary);
  if (!terms.length) return text;
  // Preserve supplied control syntax, replacing only literal words outside it.
  const names = new RegExp(terms.map(termPattern).join("|"), "gu");
  const markup = new RegExp(SPEECH_MARKUP, "gu");
  let result = "", offset = 0;
  for (const m of text.matchAll(markup)) {
    result += text.slice(offset, m.index).replace(names, name => dictionary[name]) + m[0];
    offset = m.index! + m[0].length;
  }
  return result + text.slice(offset).replace(names, name => dictionary[name]);
}
