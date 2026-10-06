/* Show timed speech captions inside the game view. */
(() => {
  const frame = document.getElementById('corti-speech-bubble');
  if (!frame) return;
  const ports = [7792, 7793, 7794, 7795, 7796];
  const speaker = '__VIEWER_SPEAKER_NAME__';
  let activePort = null;

  async function overlayAt(port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/overlay`, {
        cache: 'no-store', signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) return false;
      const html = await response.text();
      return html.includes('id="bubbles"') && html.includes('/overlay/app.js');
    } catch { return false; }
  }

  async function connect() {
    if (activePort !== null && await overlayAt(activePort)) return;
    frame.hidden = true;
    frame.removeAttribute('src');
    activePort = null;
    for (const port of ports) {
      if (!await overlayAt(port)) continue;
      activePort = port;
      frame.src = `http://127.0.0.1:${port}/overlay?subtitles=1&cues=0&danmaku=0&ingame=1&speaker=${encodeURIComponent(speaker)}`;
      frame.hidden = false;
      return;
    }
  }

  void connect();
  const check = setInterval(() => { void connect(); }, 20_000);
  window.addEventListener('pagehide', () => clearInterval(check), { once: true });
})();
