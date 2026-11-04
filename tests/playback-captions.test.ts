import { expect, it } from 'vitest';
// @ts-expect-error browser module
import { PlaybackCaptionState, installPlaybackCaptions } from '../web/playback-captions.js';
const action = (id = 'speech-1', status = 'playing', patch = {}) => ({ id, kind: 'speech', status,
  avatarId: 'avatar', updatedAt: '2026-10-30T01:00:00Z', command: { text: '可米在这里。', scope: 'broadcast' }, ...patch });
const snapshot = (actions: any[], active = 'avatar') => ({ activeAvatar: { id: active }, actions });
it('does not caption queued or synthesized audio and follows the real action ID', () => {
  const s = new PlaybackCaptionState({ broadcast: true });
  s.snapshot(snapshot([action('a', 'queued', { evidence: { status: 'transport-complete' } })]));
  expect(s.current).toBeNull();
  s.receive({ type: 'avatar.action', data: action('a') });
  expect(s.current).toEqual({ id: 'a', text: '可米在这里。' });
});
it.each(['completed', 'failed', 'cancelled'])('clears %s audio and rejects a stale playing replay', status => {
  const s = new PlaybackCaptionState();s.receive({ type: 'avatar.action', data: action() });
  s.receive({ type: 'avatar.action', data: action('speech-1', status) });
  expect(s.current).toBeNull();s.receive({ type: 'avatar.action', data: action() });expect(s.current).toBeNull();
});
it('does not clear the current line when the previous line ends late', () => {
  const s = new PlaybackCaptionState();s.receive({ type: 'avatar.action', data: action('a') });
  s.receive({ type: 'avatar.action', data: action('b') });
  s.receive({ type: 'avatar.action', data: action('a', 'completed') });expect(s.current.id).toBe('b');
});
it('uses the native numeric update timestamp when multiple playing receipts overlap', () => {
  const s = new PlaybackCaptionState();
  s.snapshot(snapshot([action('new', 'playing', { updatedAt: 1793296179861 }),
    action('old', 'playing', { updatedAt: 1793296093430 })]));expect(s.current.id).toBe('new');
});
it('rejects an in-flight stale snapshot and recovers playback when a display is opened midway', () => {
  const s = new PlaybackCaptionState();const version = s.revision;
  s.receive({ type: 'avatar.action', data: action('new') });
  expect(s.snapshot(snapshot([action('old')]), version)).toBe(false);expect(s.current.id).toBe('new');
  const reopened = new PlaybackCaptionState();reopened.snapshot(snapshot([action('new')]));expect(reopened.current.id).toBe('new');
});
it('filters preview, other avatars and music; voice cancellation clears without a new request', () => {
  const s = new PlaybackCaptionState({ broadcast: true });
  s.snapshot(snapshot([action('preview', 'playing', { command: { text: 'private', scope: 'preview' } }),
    action('other', 'playing', { avatarId: 'other' }), action('song', 'playing', { kind: 'music-play' })]));
  expect(s.current).toBeNull();s.receive({ type: 'avatar.action', data: action() });
  s.receive({ type: 'audio.cut', data: {} });expect(s.current).toBeNull();
  s.receive({ type: 'avatar.action', data: action() });expect(s.current).toBeNull();
});
it('removes the old avatar or ended snapshot and bounds terminal history', () => {
  const s = new PlaybackCaptionState();s.snapshot(snapshot([action()]));
  s.snapshot(snapshot([], 'another'));expect(s.current).toBeNull();
  for(let i=0;i<1000;i++)s.receive({ type: 'avatar.action', data: action(String(i), 'completed') });
  expect(s.closed.size).toBe(128);
});
it('uses textContent, exposes caption ID and cleans the presentation on page hide', () => {
  const classes = new Set(), nodes: any[] = [], handlers: Record<string, () => void> = {};
  const document = { createElement: () => ({ dataset: {}, setAttribute() {}, remove() { nodes.pop(); } }),
    body: { append(node: any) { nodes.push(node); }, classList: { toggle(k: string, yes: boolean) { yes ? classes.add(k) : classes.delete(k); } } } };
  const window = { addEventListener(name: string, f: () => void) { handlers[name] = f; } };
  const ui = installPlaybackCaptions({ document, window });
  ui.receive({ type: 'avatar.action', data: action('safe', 'playing', { command: { text: '<img src=x onerror=alert(1)>' } }) });
  expect(nodes[0].textContent).toBe('<img src=x onerror=alert(1)>');expect(nodes[0].dataset.actionId).toBe('safe');
  expect(classes.has('has-speech-caption')).toBe(true);handlers.pagehide();expect(nodes).toHaveLength(0);expect(classes.size).toBe(0);
});
