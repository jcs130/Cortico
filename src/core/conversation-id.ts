import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const validConversationId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value);

/** The context owner retains this identity across requests and retries. */
export function createConversationId(agentId?: string): string {
  if (agentId !== undefined && !/^[a-zA-Z0-9_.-]{1,96}$/.test(agentId)) throw new TypeError('Invalid agent namespace');
  return agentId ? `${agentId}:${randomUUID()}` : `cortico-${randomUUID()}`;
}

/** A deployment retains its namespace when moved or restarted; existing conversation IDs stay intact. */
export function loadAgentId(dataDir: string, deploymentDir: string): string {
  const file = join(dataDir, 'agent-identity.json');
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved?.version !== 1 || typeof saved.agent_id !== 'string' || !/^[a-zA-Z0-9_.-]{1,96}$/.test(saved.agent_id))
      throw new Error('Invalid agent identity metadata');
    return saved.agent_id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const label = basename(deploymentDir).replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'agent';
  const id = `${label}-${randomUUID().slice(0, 8)}`;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, agent_id: id }) + '\n', { encoding: 'utf8', flag: 'wx' });
  return id;
}

/** A fork's identity is durable before its first request, even if execution ends without a response. */
export function createPersistedConversationId(dataDir: string, agentId: string, owner: { role: string; sessionId: string }): string {
  const conversationId = createConversationId(agentId);
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(join(dataDir, 'conversation-identities.jsonl'), JSON.stringify({ version: 1,
    agentId, conversationId, role: owner.role, sessionId: owner.sessionId, createdAt: new Date().toISOString(),
  }) + '\n', 'utf8');
  return conversationId;
}
