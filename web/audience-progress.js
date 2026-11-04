/** Small live card. It never consumes a reasoning delta or controls playback. */
export function installAudienceProgress({ document, window, now = Date.now }) {
  const card = document.createElement('section'); card.className = 'audience-progress'; card.hidden = true;
  card.setAttribute('aria-live', 'polite');
  const topic = document.createElement('strong'), text = document.createElement('p');
  card.append(topic, text); document.body.append(card);
  let latest = null;
  const render = () => {
    card.hidden = !latest || Date.parse(latest.expiresAt) <= now();
    if (!card.hidden) { topic.textContent = '思考动态 · ' + latest.topic; text.textContent = latest.text; }
  };
  const update = value => {
    if (!value) { render(); return; }
    if (value.schema !== 'audience-progress/v1' || !Number.isFinite(Date.parse(value.at))
      || !Number.isFinite(Date.parse(value.expiresAt)) || typeof value.topic !== 'string' || typeof value.text !== 'string') return;
    if (latest && Date.parse(value.at) < Date.parse(latest.at)) return;
    latest = value; render();
  };
  const timer = window.setInterval(render, 1000);
  const dispose = () => { window.clearInterval(timer); card.remove(); };
  window.addEventListener('pagehide', dispose, { once: true });
  return { update, clear: () => { latest = null; render(); }, dispose };
}
