import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionLog } from '../../src/core/session.ts';
import { runForkLoop } from '../../src/core/fork.ts';
import { observeModel } from '../../src/core/model-observer.ts';
import { createResponse } from '../../src/protocol/open-responses/index.ts';
import { message } from '../../src/protocol/open-responses/context.ts';
import type { GenerateOptions, ResponseClient } from '../../src/core/generation.ts';
import { nullLogger } from '../../src/core/util.ts';
import { makeTmpDir } from './helpers.ts';
import { createPersistedConversationId, loadAgentId } from '../../src/core/conversation-id.ts';

const dirs: ReturnType<typeof makeTmpDir>[] = [];
const temporary = () => { const tmp = makeTmpDir(); dirs.push(tmp); return tmp.dir; };
afterEach(() => { for (const tmp of dirs.splice(0)) tmp.cleanup(); });

describe('context-owned gateway sessions', () => {
  it('persists unique agent namespaces and retains legacy session IDs during adoption', () => {
    const dir = temporary();
    const agent = loadAgentId(dir, '/deployments/operator');
    expect(loadAgentId(dir, '/moved/operator')).toBe(agent);
    expect(loadAgentId(temporary(), '/deployments/operator')).not.toBe(agent);
    const legacy = new SessionLog(dir).conversationId;
    const adopted = new SessionLog(dir, 'session-main.jsonl', undefined, agent);
    expect(adopted.conversationId).toBe(legacy);
    adopted.startConversation([message('user', 'new conversation')]);
    expect(adopted.conversationId.startsWith(`${agent}:`)).toBe(true);
    expect(new SessionLog(dir, 'session-main.jsonl', undefined, agent).conversationId).toBe(adopted.conversationId);
    expect(new SessionLog(dir, 'branch.jsonl', undefined, agent).conversationId).not.toBe(adopted.conversationId);
  });
  it('restores identities with historical contexts and retains them across prefix replacement', () => {
    const dir = temporary();
    const session = new SessionLog(dir);
    session.append(message('user', 'history'));
    const id = session.conversationId;
    session.reset([message('system', 'updated prefix'), ...session.records]);
    const restored = new SessionLog(dir);
    restored.load();
    expect(restored.conversationId).toBe(id);
    expect(id).toMatch(/^cortico-[a-f0-9-]{36}$/);
    expect(readFileSync(join(dir, 'session-main.jsonl.metadata.json'), 'utf8')).toContain(id);
    expect(JSON.stringify(restored.records)).not.toContain(id);
    expect(new SessionLog(dir, 'other-history.jsonl').conversationId).not.toBe(id);
    expect(new SessionLog(temporary()).conversationId).not.toBe(id);
    restored.startConversation([message('user', 'new history')]);
    expect(restored.conversationId).not.toBe(id);
    expect(new SessionLog(dir).conversationId).toBe(restored.conversationId);
  });

  it('reports corrupt metadata instead of silently assigning another identity to the history', () => {
    const dir = temporary();
    writeFileSync(join(dir, 'session-main.jsonl.metadata.json'), '{bad-json');
    expect(() => new SessionLog(dir).conversationId).toThrow();
    expect(readFileSync(join(dir, 'session-main.jsonl.metadata.json'), 'utf8')).toBe('{bad-json');
  });

  it('retains one identity through actual fork tool rounds and isolates another fork of the same role', async () => {
    const dir = temporary(), agentId = loadAgentId(dir, '/deployment/fixture');
    const ids: string[] = [];
    let calls = 0, toolRuns = 0;
    const client: ResponseClient = { async respond(request, options: GenerateOptions = {}) {
      ids.push(options.conversationId!);
      const response = { ...createResponse(`response-${++calls}`, { model: request.model }), status: 'completed' as const };
      if (calls % 2) response.output.push({ type: 'function_call', id: `item-${calls}`, call_id: `call-${calls}`,
        name: 'inspect', arguments: '{}', status: 'completed' });
      return { response, origin: { instance: 'fixture', module: 'fixture', model: request.model!, compatibilityDomain: 'fixture' }, attempts: [] };
    } };
    for (let task = 0; task < 2; task++) {
      const conversationId = createPersistedConversationId(dir, agentId, { role: 'review', sessionId: `review-${task}` });
      expect(readFileSync(join(dir, 'conversation-identities.jsonl'), 'utf8')).toContain(conversationId);
      await runForkLoop({ id: 'review', llm: observeModel(client, () => {}), spec: { model: 'fixture-model', thinking: false },
        agentId, conversationId,
        messages: [message('user', 'inspect')], maxRounds: 2, log: nullLogger(),
        tools: [{ name: 'inspect', description: 'Read the fixture', parameters: { type: 'object' }, tags: ['read'],
          handler: async () => { toolRuns++; return 'observed'; } }] });
    }
    expect(toolRuns).toBe(2);
    expect(ids).toHaveLength(4);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBe(ids[3]);
    expect(ids[0]).not.toBe(ids[2]);
    const saved = readFileSync(join(dir, 'conversation-identities.jsonl'), 'utf8');
    expect(saved.trim().split('\n').map(line => JSON.parse(line).conversationId)).toEqual([ids[0], ids[2]]);
    expect(saved).not.toContain('inspect');
  });
});
