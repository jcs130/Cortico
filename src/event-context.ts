import {createHash} from 'node:crypto';
import type {StageEvent} from './core/types.ts';

/** Optional host request view; original events still feed renderers, deduplication and the archive. */
export function stageSupervisorView(event: StageEvent) {
  const data=event.data;
  if(event.type!=='avatar.action' || !['accepted','queued','running','playing','completed'].includes(String(data.status))
    || data.error || data.failure) return null;
  const command=data.command && typeof data.command==='object' ? data.command as Record<string,unknown> : {};
  const summary=JSON.stringify({id:data.id,kind:data.kind,status:data.status,requestId:data.requestId,
    actionId:data.actionId,at:event.at,text:command.text,title:command.title,
    outcome:'presentation receipt only; not game progress or proof of audibility'});
  const original=JSON.stringify(data);
  if(summary.length>2000 || summary.length>=original.length)return null;
  return {protocol:'event-context-view/v1',originalSha256:createHash('sha256').update(original).digest('hex'),supervisor:summary};
}
