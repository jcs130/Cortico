import { randomUUID } from 'node:crypto';

export const validConversationId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value);

/** The context owner retains this identity across requests and retries. */
export function createConversationId(): string { return `cortico-${randomUUID()}`; }
