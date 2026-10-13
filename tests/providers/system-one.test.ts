import { afterEach, expect, it, vi } from 'vitest';
import { requestDecision } from '../../src/providers/system-one/native.ts';
import module from '../../src/providers/system-one/index.ts';

const input = { state: { pending: 3 }, questions: { route: { type: 'choice' as const, instructions: 'Select the route.', criteria: { now: 'Act now', later: 'Wait' } } } };
const answer = { type: 'choice', choice: 'now', confidence: .6, probabilities: { now: .8, later: .2 } };
const options = { baseUrl: 'https://decision.test/v1/', model: 'classifier', apiKey: 'test-credential' };
afterEach(() => vi.unstubAllGlobals());
it('uses the native endpoint and bearer auth, preserves probabilities and nullable usage', async () => {
  let sent!: RequestInit, url = '';
  const fetchImpl = vi.fn(async (target, init) => { url = String(target); sent = init!; return new Response(JSON.stringify({ model: 'classifier-version', answers: { route: answer }, usage: { input_tokens: 20, output_tokens: 4 } })); });
  const value = await requestDecision({ ...options, fetchImpl }, input, { conversationId: 'test-session' });
  expect(url).toBe('https://decision.test/v1/systemone');
  expect(new Headers(sent.headers).get('authorization')).toBe('Bearer test-credential');
  expect(new Headers(sent.headers).get('x-litellm-session-id')).toBe('test-session');
  expect(JSON.parse(String(sent.body))).toEqual({ model: 'classifier', ...input });
  expect(value.answers.route).toEqual({ choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities, choiceProbability: .8 });
  expect(value.usage).toEqual({ input_tokens: 20, output_tokens: 4, cached_input_tokens: null });
});
it.each([{}, { route: { ...answer, probabilities: { now: .8 } } }, { route: { ...answer, choice: 'missing' } }, { route: { ...answer, confidence: .1 } }])('rejects incomplete or inconsistent typed answers', async answers => {
  await expect(requestDecision({ ...options, fetchImpl: async () => new Response(JSON.stringify({ answers })) }, input)).rejects.toThrow('Invalid decision');
});
it('does not retry HTTP errors or expose their response content', async () => {
  const fetchImpl = vi.fn(async () => new Response('private upstream detail', { status: 429 }));
  await expect(requestDecision({ ...options, fetchImpl }, input)).rejects.toThrow('Decision HTTP 429');
  expect(fetchImpl).toHaveBeenCalledOnce();
});
it('does not copy malformed upstream content into an error', async () => {
  await expect(requestDecision({ ...options, fetchImpl: async () => new Response('private malformed content') }, input))
    .rejects.toThrow(/^Invalid decision response\.$/);
});
it('keeps the current model when the registry reuses the same transport instance', async () => {
  let current = { kind: module.id, baseUrl: options.baseUrl, spec: { model: 'one', thinking: false } };
  const client = module.create('Choice', current, { currentEntry: () => current, secret: () => '' } as any);
  const sent: any[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ answers: { route: answer } })); });
  await client.decide(input, {}); current = { ...current, spec: { model: 'two', thinking: false } }; await client.decide(input, {});
  expect(sent.map(body => body.model)).toEqual(['one', 'two']);
});
