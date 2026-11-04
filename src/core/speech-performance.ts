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

export interface ResolvedSpeechPerformance {
  requested?: SpeechPerformance;
  applied?: SpeechPerformance;
  actions: string[];
  warnings: string[];
}

/** Unavailable optional cues do not invalidate speech. No substitute cue is inferred. */
export function resolveSpeechPerformance(
  cue: SpeechPerformance | undefined,
  expressions: readonly string[],
  clips: readonly string[],
): ResolvedSpeechPerformance {
  if (!cue) return { actions: [], warnings: [] };
  const applied: SpeechPerformance = {}, warnings: string[] = [];
  const expression = cue.expression ?? cue.emotion;
  if (expression && expressions.includes(expression)) {
    if (cue.expression) applied.expression = cue.expression;
    if (cue.emotion) applied.emotion = cue.emotion;
  } else if (expression) {
    warnings.push(cue.expression
      ? `Unavailable expression omitted: ${cue.expression}`
      : `Emotion retained as intent only: ${cue.emotion}`);
  }
  if (cue.bodyClip) {
    if (clips.includes(cue.bodyClip)) applied.bodyClip = cue.bodyClip;
    else warnings.push(`Unavailable body clip omitted: ${cue.bodyClip}`);
  }
  return {
    requested: { ...cue },
    applied: Object.keys(applied).length ? applied : undefined,
    actions: performanceActions(applied, expressions, clips),
    warnings,
  };
}
