/** Explicit model-authored cues; this module never infers emotion or rewrites speech. */
export interface SpeechPerformance {
  emotion?: string;
  expression?: string;
  bodyClip?: string;
}
export function speechPerformance(raw: unknown): SpeechPerformance | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid speech performance');
  const result: SpeechPerformance = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!['emotion', 'expression', 'bodyClip'].includes(key) || typeof value !== 'string'
      || !value.trim() || value.length > 100) throw Error('Invalid speech performance field');
    result[key as keyof SpeechPerformance] = value;
  }
  if (!Object.keys(result).length) throw Error('Speech performance requires an emotion, expression or bodyClip');
  return result;
}
export function performanceActions(cue: SpeechPerformance | undefined, expressions: readonly string[], clips: readonly string[]) {
  if (!cue) return [];
  // Emotion can be retained as intent alongside an explicit facial expression.
  // Without that override it must itself be an installed expression id.
  const expression = cue.expression ?? cue.emotion;
  if (expression && !expressions.includes(expression)) throw Error('Speech performance expression is unavailable: ' + expression);
  if (cue.bodyClip && !clips.includes(cue.bodyClip)) throw Error('Speech performance bodyClip is unavailable: ' + cue.bodyClip);
  return [...(expression ? [expression] : []), ...(cue.bodyClip ? [cue.bodyClip] : [])];
}
