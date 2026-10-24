import {expect,it} from 'vitest';
import {resolveSpeechPerformance} from '../src/core/speech-performance.ts';

it('keeps authored intent while resolving only installed cues',()=>{
  const requested={emotion:'curious',expression:'happy',bodyClip:'missing'};
  const r=resolveSpeechPerformance(requested,['happy'],[]);
  expect(r.requested).toEqual(requested);
  expect(r.actions).toEqual(['happy']);
  expect(r.applied).toEqual({emotion:'curious',expression:'happy'});
  expect(r.warnings).toHaveLength(1);
});

it('never substitutes an emotion for an explicitly unavailable expression',()=>{
  const r=resolveSpeechPerformance({emotion:'happy',expression:'missing',bodyClip:'wave'},['happy'],['wave']);
  expect(r.applied).toEqual({bodyClip:'wave'});
  expect(r.actions).toEqual(['wave']);
  expect(r.warnings).toHaveLength(1);
});

it('does not manufacture a display action from unknown emotion',()=>{
  const r=resolveSpeechPerformance({emotion:'curious'},['happy'],[]);
  expect(r.applied).toBeUndefined();
  expect(r.actions).toEqual([]);
  expect(r.requested).toEqual({emotion:'curious'});
  expect(r.warnings).toHaveLength(1);
});
