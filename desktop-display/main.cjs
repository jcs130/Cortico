const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { readFileSync, mkdirSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');

const settings = JSON.parse(readFileSync(join(__dirname, 'settings.json'), 'utf8'));
app.setName('可米桌面形象');
mkdirSync(settings.dataDir, { recursive: true });
app.setPath('userData', settings.dataDir);
const log = (value) => appendFileSync(join(settings.dataDir, 'display.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.showInactive();
    }
  });
  const origin = `http://127.0.0.1:${settings.port}`;
  let baseline = new Set(), loaded = false;
  let stage = null;
  async function readStage() {
    try {
      const response = await fetch(settings.stageUrl + '/api/state', { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw Error('Stage HTTP ' + response.status);
      const value = await response.json();
      const a = value.activeAvatar;
      stage = { at: new Date().toISOString(), avatarId: a?.id, avatarSha256: a?.sha256,
        renderers: (value.renderers || []).map(({ sessionId, role, surface, status, frames, avatarId, avatarSha256 }) =>
          ({ sessionId, role, surface, status, frames, avatarId, avatarSha256 })), audioOwner: value.audioOwner };
    } catch (error) {
      stage = { at: new Date().toISOString(), error: error.message };
    }
  }
  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${settings.port}` || req.method !== 'GET') {
      res.writeHead(403).end(); return;
    }
    res.setHeader('Cache-Control', 'no-store');
    const path = new URL(req.url, origin).pathname;
    if (path === '/api/status') {
      const windows = BrowserWindow.getAllWindows().map(win => ({ visible: win.isVisible(), bounds: win.getBounds(), title: win.getTitle(), url: win.webContents.getURL() }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ pid: process.pid, mode: 'desktop-display', backend: 'avatar-stage', desktopPetWorldLoaded: false,
        loaded, windows, stage, newRenderers: stage?.renderers?.filter(r => !baseline.has(r.sessionId)) || [],
        gpuInferenceStarted: false, hostReloaded: false, modelChanged: false }));
    } else if (path === '/' || path === '/pet') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'self'; frame-src ${settings.stageUrl}; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:` });
      res.end(readFileSync(join(__dirname, 'pet.html'), 'utf8').replaceAll('__STAGE_URL__', settings.stageUrl));
    } else res.writeHead(404).end();
  });
  (async () => {
    await readStage();
    if (stage.error) throw Error(stage.error);
    baseline = new Set(stage.renderers.map(r => r.sessionId));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(settings.port, '127.0.0.1', resolve); });
    const { runPetHost } = require(join(__dirname, 'official', 'host', 'electron-main.cjs'));
    runPetHost({ url: origin + '/pet', parentPid: 0 });
    app.on('browser-window-created', (_event, win) => {
      win.webContents.on('did-finish-load', () => { loaded = true; win.setTitle('可米桌面形象'); log({ event: 'loaded', url: win.webContents.getURL() }); });
      win.webContents.on('render-process-gone', (_e, detail) => log({ event: 'renderer-exited', reason: detail.reason }));
    });
    const timer = setInterval(() => void readStage(), 5000);
    app.once('will-quit', () => { clearInterval(timer); server.close(); log({ event: 'closed' }); });
    log({ event: 'started', pid: process.pid, stageUrl: settings.stageUrl });
  })().catch(error => { log({ event: 'failed', error: error.message }); app.quit(); });
}
