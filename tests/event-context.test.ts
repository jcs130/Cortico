import {it,expect} from 'vitest';
import {stageSupervisorView} from '../src/event-context.ts';
it('keeps display receipts separate from raw renderer and voice events',()=>{
  const event={protocol:'avatar-stage/1' as const,type:'avatar.action',at:2,data:{id:'a',kind:'presentation',status:'completed',command:{bones:'x'.repeat(5000)}}};
  const before=JSON.stringify(event),view=stageSupervisorView(event)!;
  expect(view.supervisor.length).toBeLessThan(300);expect(view.originalSha256).toHaveLength(64);
  expect(JSON.stringify(event)).toBe(before);
  expect(stageSupervisorView({...event,data:{...event.data,status:'failed',error:'device lost'}})).toBeNull();
  expect(stageSupervisorView({...event,data:{...event.data,status:'cancelled',reason:'playback interrupted'}})).toBeNull();
  expect(stageSupervisorView({...event,type:'avatar.voice'})).toBeNull();
  expect(stageSupervisorView({...event,type:'avatar.speech.submitted'})).toBeNull();
});
