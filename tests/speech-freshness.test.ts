import { expect, it } from 'vitest';
import { checkSpeechFreshness } from '../src/speech-freshness.ts';
import { validateToolInput } from '../src/core/schema.ts';
import { TOOL_DEFINITIONS } from '../src/tools.ts';

const now = Date.parse('2026-10-25T14:05:20Z') / 1000;
it('validates both advertised timestamp forms in the standalone tool schema', () => {
  const schema = TOOL_DEFINITIONS.find(t=>t.name==='avatar_voice')!.parameters;
  for (const observed_at of [now, '2026-10-25T14:05:16Z'])
    expect(()=>validateToolInput(schema,{action:'speak',text:'Hello.',observed_at})).not.toThrow();
  for (const observed_at of [false, null, {}, []])
    expect(()=>validateToolInput(schema,{action:'speak',text:'Hello.',observed_at})).toThrow();
});
it('accepts copied source timestamps without requiring model epoch arithmetic', () => {
  for (const observed_at of ['2026-10-25T14:05:16.307Z', '2026-10-25T22:05:16.307+08:00', now - 4])
    expect(() => checkSpeechFreshness({ action: 'speak', observed_at }, 15, now)).not.toThrow();
});
it('preserves stale/future rejection and never repairs fabricated or ambiguous timestamps', () => {
  for (const observed_at of [1761401105, 1792965048, now * 1000, now - 16, now + 2,
    '2025-10-25T22:05:16+08:00', '2026-10-25T22:05:16', '22:05:16', '2026-10-25',
    '2026-02-30T14:05:16Z', '2026-10-25T24:00:00Z', String(now), undefined, null]) {
    const args = { action: 'speak', observed_at };
    expect(() => checkSpeechFreshness(args, 15, now)).toThrow('stale_speech_observation');
    expect(args.observed_at).toBe(observed_at);
  }
  expect(() => checkSpeechFreshness({ action: 'status' }, 15, now)).not.toThrow();
  expect(() => checkSpeechFreshness({ action: 'speak' }, 0, now)).not.toThrow();
});
