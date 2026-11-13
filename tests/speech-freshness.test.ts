import { expect, it } from 'vitest';
import { checkSpeechFreshness, resolveSpeechEvidence } from '../src/speech-freshness.ts';
import { validateToolInput } from '../src/core/schema.ts';
import { TOOL_DEFINITIONS } from '../src/tools.ts';

const now = Date.parse('2026-10-25T14:05:20Z') / 1000;
it('resolves source identity without timezone arithmetic and retains age on later admission', () => {
  const source={source:'mymc',ts:'2026-10-25T22:04:50+08:00'};
  const get=(cursor:number)=>cursor===42?source:undefined;
  const args={action:'speak',evidence_mode:'recent',observed_event:{source:'mymc',cursor:42}};
  const normalized=resolveSpeechEvidence(args,get);
  expect(normalized).toEqual({action:'speak',evidence_mode:'recent',observed_at:source.ts});
  expect(args).not.toHaveProperty('observed_at');
  expect(()=>checkSpeechFreshness(normalized,15,now)).not.toThrow();
  expect(()=>checkSpeechFreshness(normalized,15,now+271)).toThrow('stale_speech');
  expect(()=>checkSpeechFreshness({...normalized,evidence_mode:'current'},15,now)).toThrow('stale_speech');
  for(const observed_event of [{source:'other-world',cursor:42},{source:'mymc',cursor:43},{source:'mymc',cursor:NaN}])
    expect(()=>resolveSpeechEvidence({...args,observed_event},get)).toThrow();
  expect(()=>resolveSpeechEvidence({...args,observed_at:'2026-10-25T22:04:50Z'},get)).toThrow('conflicts');
  expect(()=>checkSpeechFreshness(args,15,now)).toThrow('resolved by the host');
});
it('keeps explicit dialogue independent of observation expiry without permitting evidence removal by the adapter',()=>{
  expect(()=>checkSpeechFreshness({action:'speak',evidence_mode:'dialogue',text:'你好。'},15,now)).not.toThrow();
  for(const evidence of [{observed_at:now-30},{observed_event:{source:'mymc',cursor:42}}])
    expect(()=>checkSpeechFreshness({action:'speak',evidence_mode:'dialogue',...evidence},15,now)).toThrow('cannot carry');
});
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
    '2026-02-30T14:05:16Z', '2026-10-25T24:00:00Z', String(now), null]) {
    const args = { action: 'speak', observed_at };
    expect(() => checkSpeechFreshness(args, 15, now)).toThrow('stale_speech_observation');
    expect(args.observed_at).toBe(observed_at);
  }
  expect(() => checkSpeechFreshness({ action: 'status' }, 15, now)).not.toThrow();
  expect(() => checkSpeechFreshness({ action: 'speak' }, 0, now)).not.toThrow();
});
it('admits conversation without requiring an unrelated live observation', () => {
  for (const text of ['Hello, I can read your message.', 'Thanks for joining.', 'Let me tell you a story.']) {
    const args = { action: 'speak', text };
    expect(() => checkSpeechFreshness(args, 15, now)).not.toThrow();
    expect(args).not.toHaveProperty('observed_at');
  }
});
it('separates dated events from current claims while preserving their source clock', () => {
  const args = { action: 'speak', observed_at: now - 105, evidence_mode: 'recent' };
  expect(() => checkSpeechFreshness(args, 15, now)).not.toThrow();
  expect(args.observed_at).toBe(now - 105);
  expect(() => checkSpeechFreshness({ ...args, evidence_mode: 'current' }, 15, now)).toThrow('stale_speech');
  for (const observed_at of [now - 301, now + 2])
    expect(() => checkSpeechFreshness({ ...args, observed_at }, 15, now)).toThrow('stale_speech');
  expect(() => checkSpeechFreshness({ action: 'speak', evidence_mode: 'recent' }, 15, now)).toThrow('original observation');
  expect(() => checkSpeechFreshness({ ...args, evidence_mode: 'ignore' }, 15, now)).toThrow('Invalid speech evidence');
});
