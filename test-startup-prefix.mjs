import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshStartupPrefix } from './startup-prefix.mjs';

test('waits for the console and refreshes once without pausing, resuming or discarding history', async () => {
  const calls = []; let polls = 0;
  const transport = async (url, options) => {
    calls.push({ path: url.pathname, method: options.method ?? 'GET', body: options.body });
    if (url.pathname === '/api/runs') return ++polls === 1 ? new Response('', { status: 503 }) : Response.json({ current: 'fixture-run' });
    assert.equal(url.pathname, '/api/session/reload-prefix');
    return Response.json({ ok: true, result: 'Existing records retained' });
  };
  assert.deepEqual(await refreshStartupPrefix('http://127.0.0.1:7789', { timeoutMs: 1000, pollMs: 1, transport }), { refreshed: true });
  assert.deepEqual(calls.map(call => call.path), ['/api/runs', '/api/runs', '/api/session/reload-prefix']);
  assert.equal(calls.at(-1).method, 'POST'); assert.equal(calls.at(-1).body, '{}');
});

test('rejects nonlocal targets and never retries a prefix operation with an uncertain result', async () => {
  let posted = 0;
  await assert.rejects(refreshStartupPrefix('https://example.test'), /loopback/);
  await assert.rejects(refreshStartupPrefix('http://127.0.0.1:7789', { timeoutMs: 1000, transport: async url => {
    if (url.pathname === '/api/runs') return Response.json({ current: 'fixture-run' });
    posted++; throw new Error('transport interrupted');
  } }), /interrupted/);
  assert.equal(posted, 1);
});
