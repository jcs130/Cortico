/** Host intention bindings to versioned World observations. */
export interface WorldWorkReference {
  world: string;
  scope: { realm: string; account: string; agent: string };
  subject: string;
  instance: string;
  revision: number;
}
export interface WorldWorkState extends WorldWorkReference {
  status: 'active' | 'completed' | 'cancelled';
  observedAt: string;
  evidence: { source: 'server'; reference: string; text: string };
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
export function workReferenceOf(value: unknown): WorldWorkReference | null {
  if (!object(value) || !text(value.world, 80) || !object(value.scope)
    || ![value.scope.realm, value.scope.account, value.scope.agent, value.subject, value.instance].every(value => text(value))
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return null;
  return { world: value.world, scope: { realm: value.scope.realm as string, account: value.scope.account as string,
    agent: value.scope.agent as string }, subject: value.subject as string, instance: value.instance as string, revision: Number(value.revision) };
}
export function workReferenceKey(ref: WorldWorkReference): string {
  return JSON.stringify([ref.world, ref.scope.realm, ref.scope.account, ref.scope.agent, ref.subject, ref.instance]);
}
export function readWorldWorkStates(world: string, value: unknown): WorldWorkState[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    if (!object(row)) return [];
    const ref = workReferenceOf({ ...row, world });
    if (!ref || !['active', 'completed', 'cancelled'].includes(String(row.status))
      || !text(row.observedAt, 80) || !Number.isFinite(Date.parse(row.observedAt))
      || !object(row.evidence) || row.evidence.source !== 'server'
      || !text(row.evidence.reference, 2000) || !text(row.evidence.text, 12000)) return [];
    return [{ ...ref, status: row.status as WorldWorkState['status'], observedAt: row.observedAt,
      evidence: { source: 'server', reference: row.evidence.reference, text: row.evidence.text } }];
  });
}
export function matchingWorkState(ref: WorldWorkReference, states: readonly WorldWorkState[]): WorldWorkState | null {
  const candidates = states.filter(state => workReferenceKey(state) === workReferenceKey(ref) && state.revision >= ref.revision);
  const revision = Math.max(...candidates.map(state => state.revision));
  const latest = candidates.filter(state => state.revision === revision);
  return latest.length && latest.every(state => state.status === latest[0].status) ? latest[0] : null;
}
export const WORK_REFERENCE_SCHEMA = { type: 'object', additionalProperties: false,
  properties: { world: { type: 'string', minLength: 1, maxLength: 80 },
    scope: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['realm', 'account', 'agent'].map(key => [key, { type: 'string', minLength: 1, maxLength: 200 }])), required: ['realm', 'account', 'agent'] },
    subject: { type: 'string', minLength: 1, maxLength: 200 }, instance: { type: 'string', minLength: 1, maxLength: 200 },
    revision: { type: 'integer', minimum: 0 } }, required: ['world', 'scope', 'subject', 'instance', 'revision'] };
