import { playSpeech } from './speech.js';

/** Stage-owned audio device for a desktop presentation surface. No synthesis or decision logic in the surface. */
export function createMediaPlayer({ send, onMouth, onText, onActions, onEnd, context = () => new AudioContext(), fetchAudio = fetch }) {
  let ctx, current = null;
  const audio = () => ctx ??= context();
  function terminal(job, state, error) {
    if (job.terminal) return;
    job.terminal = true;
    send({ t: 'media-receipt', id: job.id, state, audioTimeMs: job.started === undefined ? 0 : Math.max(0, (audio().currentTime - job.started) * 1000),
      ...(error ? { error: String(error).slice(0, 240) } : {}) });
    if (current === job) { current = null; onMouth(0, false, job.kind); onEnd(job.id); }
  }
  function started(job) {
    if (current !== job || job.terminal || job.abort.signal.aborted) return;
    job.started = audio().currentTime;
    send({ t: 'media-receipt', id: job.id, state: 'playing', audioTimeMs: 0 });
    if (job.kind === 'speech' && job.showText !== false) onText(job.id, job.text ?? '');
    if (job.actions.length) onActions(job.actions);
  }
  function cancel(id) {
    const job = current; if (!job || (id && job.id !== id)) return;
    job.abort.abort(); job.audioSource?.stop(); job.audioSource?.disconnect(); job.gain?.disconnect();
    terminal(job, 'cancelled', 'Playback cancelled');
  }
  return {
    async play(command) {
      cancel();
      const job = { ...command, actions: [], abort: new AbortController(), terminal: false };
      current = job;
      try {
        const c = audio(); await c.resume();
        if (c.state !== 'running') throw Error('Enable page audio before playback');
        if (job.abort.signal.aborted) return;
        if (job.kind === 'speech') {
          await playSpeech({ url: job.url, context: c, signal: job.abort.signal, fetchAudio, volume: job.volume ?? 1,
            onStart: () => started(job), onEnd: () => terminal(job, 'completed'),
            onLevel: level => { if (current === job) onMouth(level, true, 'speech'); },
            onStats: stats => { job.stats = stats; } });
        } else {
          const response = await fetchAudio(job.url, { signal: job.abort.signal });
          if (!response.ok) throw Error('Music HTTP ' + response.status);
          const buffer = await c.decodeAudioData(await response.arrayBuffer());
          if (job.abort.signal.aborted) return;
          const source = c.createBufferSource(), gain = c.createGain();
          job.audioSource = source; job.gain = gain; source.buffer = buffer; source.connect(gain); gain.gain.value = job.volume ?? 1; gain.connect(c.destination);
          source.onended = () => { source.disconnect(); gain.disconnect(); if (!job.abort.signal.aborted) terminal(job, 'completed'); };
          source.start(); started(job);
        }
      } catch (e) { if (!job.abort.signal.aborted) terminal(job, 'failed', e.message); }
    },
    cancel,
    act(id, actions) { if (current?.id === id) { current.actions = actions; if (current.started !== undefined) onActions(actions); } },
    manual() { if (current) current.actions = []; },
    active: () => current?.id ?? null,
    sample() {
      const job = current; if (!job || job.started === undefined) return null;
      const audioTimeMs = Math.max(0, (audio().currentTime - job.started) * 1000);
      if (job.kind === 'music') {
        const line = job.cues?.lyrics?.find(l => audioTimeMs >= l.atMs && audioTimeMs < l.endMs);
        onText(job.id, line?.text ?? '');
        const mouth = job.cues?.mouthSource === 'vocal' ? job.cues.envelope.samples[Math.floor(audioTimeMs / job.cues.envelope.stepMs)] ?? 0
          : job.cues?.mouthSource === 'timed-lyrics' && line?.text?.trim() ? .22 + .14 * Math.sin(audioTimeMs * .025) : 0;
        onMouth(mouth, true, 'music');
      }
      return { id: job.id, audioTimeMs };
    },
  };
}
