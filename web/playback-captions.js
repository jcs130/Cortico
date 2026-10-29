/** Public speech only: an accepted or synthesized line is not yet a subtitle. */
export class PlaybackCaptionState {
  constructor({ broadcast = false } = {}) {
    this.broadcast = broadcast;
    this.revision = 0;
    this.current = null;
    this.avatarId = null;
    this.closed = new Set();
  }
  clear() { this.current = null; this.revision++; }
  terminal(id) {
    this.closed.add(id);
    if (this.closed.size > 128) this.closed.delete(this.closed.values().next().value);
    if (this.current?.id === id) this.current = null;
  }
  row(action) {
    if (!action || action.kind !== 'speech' || typeof action.id !== 'string') return;
    if (['completed', 'failed', 'cancelled'].includes(action.status)) { this.terminal(action.id); return; }
    if (action.status !== 'playing' || this.closed.has(action.id)) return;
    if (this.avatarId && action.avatarId !== this.avatarId) return;
    if (this.broadcast && action.command?.scope === 'preview') return;
    if (typeof action.command?.text !== 'string' || !action.command.text.trim()) return;
    this.current = { id: action.id, text: action.command.text };
  }
  snapshot(state, startedAtRevision = this.revision) {
    // A slow HTTP snapshot cannot overwrite a newer actual playback event.
    if (startedAtRevision !== this.revision) return false;
    const avatarId = state.activeAvatar?.id ?? null;
    if (avatarId !== this.avatarId) this.current = null;
    this.avatarId = avatarId;
    const rows = Array.isArray(state.actions) ? state.actions : [];
    for (const row of rows) if (['completed', 'failed', 'cancelled'].includes(row.status)) this.row(row);
    const playing = rows.filter(row => row.kind === 'speech' && row.status === 'playing')
      .sort((a, b) => (typeof a.updatedAt === 'number' ? a.updatedAt : Date.parse(a.updatedAt))
        - (typeof b.updatedAt === 'number' ? b.updatedAt : Date.parse(b.updatedAt)));
    for (const row of playing) this.row(row);
    if (!playing.some(row => row.id === this.current?.id)) this.current = null;
    return true;
  }
  receive(message) {
    if (message.type === 'avatar.action') { this.revision++; this.row(message.data); }
    if (message.type === 'audio.cut' && (!message.data?.eventId || message.data.eventId === this.current?.id)) {
      if (this.current) this.terminal(this.current.id);this.clear();
    }
    if (message.type === 'cancel' && message.data?.eventId === this.current?.id) { this.terminal(message.data.eventId);this.clear(); }
    if (message.type === 'command' && message.data?.kind === 'select') { if(this.current)this.terminal(this.current.id);this.clear(); }
  }
}

export function installPlaybackCaptions({ document, window, broadcast = false }) {
  const state = new PlaybackCaptionState({ broadcast });
  const caption = document.createElement('div');
  caption.id = 'speechCaption';caption.hidden = true;
  caption.setAttribute('role', 'status');caption.setAttribute('aria-live', 'polite');
  document.body.append(caption);
  const render = () => {
    caption.textContent = state.current?.text ?? '';
    caption.hidden = !state.current;
    if (state.current) caption.dataset.actionId = state.current.id;
    else delete caption.dataset.actionId;
    document.body.classList.toggle('has-speech-caption', !!state.current);
  };
  const dispose = () => { state.clear();render();caption.remove(); };
  window.addEventListener('pagehide', dispose, { once: true });
  return {
    get revision() { return state.revision; },
    snapshot(value, revision) { state.snapshot(value, revision);render(); },
    receive(value) { state.receive(value);render(); },
    clear() { state.clear();render(); },dispose,
  };
}
