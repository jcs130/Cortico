import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
const { readDependency, startDependency, dependencyEnvironment } = createRequire(import.meta.url)('./audio-dependency.cjs');

test('optional dependency preserves existing hosts and refuses uninstalled paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cormy-audio-dependency-'));
  try {
    assert.equal(readDependency(directory), null);
    writeFileSync(join(directory, 'audio-host.json'), JSON.stringify({ speechFloor: { node: 'node', guardian: 'guardian.mjs' } }));
    assert.throws(() => readDependency(directory), /explicit installed/);
    const guardian = join(directory, 'fixture.mjs'); writeFileSync(guardian, '');
    writeFileSync(join(directory, 'audio-host.json'), JSON.stringify({ speechFloor: { node: process.execPath, guardian } }));
    assert.deepEqual(readDependency(directory), { node: process.execPath, guardian });
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('cormy-audio-dependency-'));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('starts only a hidden guardian tied to this audio host and waits for readiness', async () => {
  const calls = []; let checks = 0;
  const child = new EventEmitter(); child.pid = 123; child.unref = () => {};
  const result = await startDependency({ node: process.execPath, guardian: join(tmpdir(), 'guardian.mjs') }, {
    ownerPid: 456, spawnImpl: (...args) => { calls.push(args); return child; },
    check: async () => ++checks === 3, wait: async () => {},
  });
  assert.deepEqual(result, { ready: true, guardianPid: 123 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], [join(tmpdir(), 'guardian.mjs'), '--owner-pid=456']);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(calls[0][2].stdio, 'ignore');
  assert.equal(calls[0][2].env.LITELLM_API_KEY, undefined);
});

test('an unavailable dependency remains explicit and never bypasses the playback floor', async () => {
  const child = new EventEmitter(); child.pid = 123; child.unref = () => {};
  const result = await startDependency({ node: process.execPath, guardian: join(tmpdir(), 'guardian.mjs') }, {
    spawnImpl: () => child, check: async () => false, wait: async () => {}, attempts: 2,
  });
  assert.deepEqual(result, { ready: false, guardianPid: 123 });
  assert.deepEqual(dependencyEnvironment({ PATH: 'node', LITELLM_API_KEY: 'private', TTS_TOKEN: 'private' }), { PATH: 'node' });
});
