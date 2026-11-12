import {expect,it} from 'vitest';
import {checkSpeechFreshness} from '../src/speech-freshness.ts';

it('offers recent-event recovery without changing the observation clock or accepting a stale current claim',()=>{
  const now=1794482700,observed_at=now-23;
  expect(()=>checkSpeechFreshness({action:'speak',observed_at,evidence_mode:'current'},15,now)).toThrow('age 23s; current limit 15s');
  expect(()=>checkSpeechFreshness({action:'speak',observed_at,evidence_mode:'current'},15,now)).toThrow('evidence_mode:"recent"');
  expect(()=>checkSpeechFreshness({action:'speak',observed_at,evidence_mode:'recent'},15,now)).not.toThrow();
  for(const at of [now-301,now+20,NaN]){
    try{checkSpeechFreshness({action:'speak',observed_at:at},15,now);throw Error('must reject');}
    catch(error){expect(String(error)).toContain('stale_speech_observation');expect(String(error)).not.toContain('use evidence_mode:"recent"');}
  }
});
