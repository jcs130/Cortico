// Optional local speech-floor dependency. The original desktop page still owns playback.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function readDependency(directory = __dirname) {
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(directory, 'audio-host.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const value = config.speechFloor;
  if (!value || !['node', 'guardian'].every(key => typeof value[key] === 'string' && path.isAbsolute(value[key]) && fs.statSync(value[key]).isFile()))
    throw Error('Speech floor requires explicit installed Node and guardian paths');
  return { node: value.node, guardian: value.guardian };
}

function dependencyEnvironment(env = process.env) {
  const keep = new Set(['systemroot', 'windir', 'path', 'pathext', 'temp', 'tmp', 'userprofile', 'localappdata', 'appdata']);
  return Object.fromEntries(Object.entries(env).filter(([key]) => keep.has(key.toLowerCase())));
}

async function checkCoordinator() {
  try {
    const response = await fetch('http://127.0.0.1:18580/v1/status', { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const value = await response.json();
    return !!value && Object.hasOwn(value, 'active') && Array.isArray(value.queue) && Array.isArray(value.clients) && typeof value.stalled === 'boolean';
  } catch { return false; }
}

async function startDependency(value, {
  ownerPid = process.pid, spawnImpl = spawn, check = checkCoordinator,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 30,
  onError = error => console.error('[audio-host] Speech floor guardian: ' + (error.code || error.message)),
} = {}) {
  const child = spawnImpl(value.node, [value.guardian, '--owner-pid=' + ownerPid], {
    cwd: path.dirname(value.guardian), detached: true, windowsHide: true,
    stdio: 'ignore', env: dependencyEnvironment(),
  });
  let startError;
  child.once('error', error => { startError = error; onError(error); });
  child.unref();
  for (let i = 0; i < attempts && !startError; i++) {
    if (await check()) return { ready: true, guardianPid: child.pid };
    await wait(200);
  }
  // Keep the page and guardian alive so recovery can be observed. Its existing
  // floor adapter continues waiting/failing explicitly; it never plays ungated.
  return { ready: false, guardianPid: child.pid ?? null };
}

module.exports = { readDependency, dependencyEnvironment, startDependency };
