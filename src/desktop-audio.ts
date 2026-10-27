import { randomUUID } from 'node:crypto';
import type { DesktopPresentation } from './desktop-presentation.ts';
import type { StageEvent } from './core/types.ts';
import { AvatarStageClient } from './sdk.ts';
import { wavInfo } from './core/wav.ts';

/** Optional audio device adapter over the public stage and desktop HTTP protocols. */
export class DesktopAudioRenderer {
  private readonly sessionId = 'desktop-' + randomUUID();
  private binding: { avatarId: string; avatarSha256: string } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private live: { stageId: string; desktopId?: string; abort: AbortController; reported?: string; durationMs?: number; performanceCue?: Record<string, unknown> } | null = null;
  private texts = new Map<string, string>();
  private alreadyCaptioned = new Set<string>();
  private stopped = false;
  private lastError = '';
  private client: AvatarStageClient | null = null;
  constructor(private readonly ports: {
    stageUrl(): string; display: DesktopPresentation; signal: AbortSignal;
    admitted(id: string, text: string, kind: 'speaking' | 'singing'): void;
    log(error: string): void;
  }) {}
  get foreground() { return this.live?.stageId ?? null; }
  private async stage(path: string, body?: Record<string, unknown>, signal = this.ports.signal) {
    const r = await fetch(new URL(path, this.ports.stageUrl()), { redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!r.ok) throw Error('Stage audio renderer HTTP ' + r.status);
    return await r.json() as Record<string, any>;
  }
  private receipt(status: string, eventId?: string, detail: Record<string, unknown> = {}) {
    return this.stage('/api/receipt', { ...this.binding, sessionId: this.sessionId, role: 'broadcast', surface: 'desktop',
      renderer: 'audio-only', status, ...(eventId ? { eventId } : {}), ...detail });
  }
  async start() {
    this.client = new AvatarStageClient(this.ports.stageUrl(), event => this.event(event), { rendererEvents: true });
    await this.client.start();
    await this.poll();
    this.timer = setInterval(() => void this.poll(), 750); this.timer.unref();
  }
  private async poll() {
    if (this.polling || this.stopped || this.ports.signal.aborted || !this.ports.display.audioEnabled()) return;
    this.polling = true;
    try {
      await this.ports.display.refresh();
      const media = this.ports.display.media();
      if (!media?.enabled || !media.ready || media.protocol !== 'desktop-media/v1') {
        await this.cancel();
        if (this.binding) await this.stage('/api/audio-release', { sessionId: this.sessionId });
        this.binding = null; return;
      }
      const state = await this.stage('/api/state');
      if (!state.activeAvatar || state.stopped) return;
      if (this.binding?.avatarSha256 !== state.activeAvatar.sha256) await this.cancel();
      this.binding = { avatarId: state.activeAvatar.id, avatarSha256: state.activeAvatar.sha256 };
      await this.receipt('heartbeat');
      if (!state.audioOwner) await this.stage('/api/audio-owner', { sessionId: this.sessionId });
      else if (state.audioOwner !== this.sessionId) { await this.cancel(); return; }
      const current = this.live;
      if (!current?.desktopId) return;
      const row = media.recent.find(r => r.id === current.desktopId);
      if (!row || row.state === 'queued' || row.state === current.reported) return;
      if (row.state === 'playing') {
        await this.receipt('playing', current.stageId, { audioTimeMs: row.audioTimeMs ?? 0, durationMs: current.durationMs,
          desktopMediaId: row.id, desktopStartedAt: row.startedAt, ...(current.performanceCue ? {performanceCue: current.performanceCue} : {}) });
        current.reported = row.state;
      } else if (['completed', 'failed', 'cancelled'].includes(row.state)) {
        // A single sample can span a whole short clip. The desktop receipt retains its real start transition.
        if (row.state === 'completed' && current.reported !== 'playing') {
          if (typeof row.startedAt !== 'number') throw Error('Desktop completion lacks playback start evidence');
          await this.receipt('playing', current.stageId, { desktopMediaId: row.id, desktopStartedAt: row.startedAt });
        }
        await this.receipt(row.state === 'completed' ? 'ended' : 'failed', current.stageId,
          { audioTimeMs: row.audioTimeMs ?? 0, desktopMediaId: row.id, ...(current.performanceCue ? {performanceCue: current.performanceCue} : {}), ...(row.error ? { error: row.error } : {}) });
        if (this.live === current) this.live = null;
      }
      this.lastError = '';
    } catch (error) { if (String(error) !== this.lastError) { this.lastError = String(error); this.ports.log(this.lastError); } }
    finally { this.polling = false; }
  }
  event(event: StageEvent) {
    if (!this.ports.display.audioEnabled() || this.stopped) return;
    if (event.type === 'stream.disconnected') { void this.cancel(); return; }
    if (event.type === 'avatar.speech.submitted') {
      this.texts.set(String(event.data.actionId), String(event.data.text));
      if(String(event.data.requestId).startsWith('desktop-reply:'))this.alreadyCaptioned.add(String(event.data.actionId));
      while (this.texts.size > 64) {const key=this.texts.keys().next().value!;this.texts.delete(key);this.alreadyCaptioned.delete(key);}
    }
    if (event.type === 'audio.cut' && (!event.data.eventId || this.live?.stageId === event.data.eventId)) void this.cancel();
    if (event.type === 'command' && event.data.targetSession === this.sessionId && ['speech', 'music'].includes(String(event.data.kind)))
      void this.play(event.data);
  }
  private async play(command: Record<string, unknown>) {
    if (this.stopped || this.ports.signal.aborted) return;
    const previous = this.live;
    const current = { stageId: String(command.eventId), abort: new AbortController(), desktopId: undefined as string | undefined, reported: undefined as string | undefined, durationMs: undefined as number | undefined, performanceCue: undefined as Record<string, unknown> | undefined };
    this.live = current;
    if (previous) {
      previous.abort.abort();
      await this.ports.display.request({ action: 'cancel-audio', source: 'avatar-stage', requestId: previous.stageId }).catch(() => {});
    }
    if (this.live !== current) return;
    const signal = AbortSignal.any([current.abort.signal, this.ports.signal, AbortSignal.timeout(180000)]);
    try {
      // Optional gesture discovery must not delay TTS or audio playback. It is
      // revision-fenced below and never owns the speech transport/body task.
      const performance = (async () => {
        if (command.performance !== undefined) await this.ports.display.refresh();
        return this.ports.display.resolvePerformance(command.performance);
      })().then(value => ({value}), error => ({error}));
      const audioUrl = new URL(String(command.url), this.ports.stageUrl());
      if (audioUrl.origin !== new URL(this.ports.stageUrl()).origin || !/^\/audio\/(speech|music)\/[^/]+$/.test(audioUrl.pathname)) throw Error('Unexpected stage audio URL');
      audioUrl.searchParams.set('sessionId', this.sessionId);
      const response = await fetch(audioUrl, { signal, redirect: 'error' });
      if (!response.ok || !response.body) throw Error('Stage audio download HTTP ' + response.status);
      let asset: { assetId: string };
      if (command.kind === 'speech' && this.ports.display.media()?.streaming) {
        asset = await this.ports.display.reserveStream(signal);
        // Upload and playback share one bounded stream. The renderer can start
        // as soon as PCM arrives; completion below is transport, not playback.
        void this.ports.display.uploadStream(asset.assetId, response.body, signal).catch(async error => {
          if (this.live === current && !signal.aborted) {
            await this.receipt('failed', current.stageId, { error: String(error).slice(0, 240) }).catch(() => {});
            await this.cancel();
          }
        });
      } else {
        const parts: Uint8Array[] = []; let size = 0;
        for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
          size += part.length; if (size > 256 * 1024 * 1024) throw Error('Stage audio exceeds desktop capacity'); parts.push(part);
        }
        signal.throwIfAborted();
        const bytes = Buffer.concat(parts); current.durationMs = wavInfo(bytes).durationMs;
        asset = await this.ports.display.upload(bytes, signal);
      }
      let cues: unknown;
      if (command.kind === 'music') {
        const url = new URL(String(command.cues), this.ports.stageUrl());
        if (url.origin !== audioUrl.origin || !/^\/audio\/cues\/[^/]+$/.test(url.pathname)) throw Error('Unexpected stage cue URL');
        url.searchParams.set('sessionId', this.sessionId);
        const r = await fetch(url, { signal, redirect: 'error' }); if (!r.ok) throw Error('Stage song cues HTTP ' + r.status); cues = await r.json();
      }
      signal.throwIfAborted();
      const result = await this.ports.display.request({ action: 'play-audio', source: 'avatar-stage', requestId: current.stageId,
        ...asset, kind: command.kind, text: this.texts.get(current.stageId) ?? '', title: String(command.title ?? ''),
        ...(this.alreadyCaptioned.has(current.stageId) ? {showText:false} : {}),
        volume: command.volume ?? 1, ...(cues ? { cues } : {}) });
      signal.throwIfAborted();
      if (!result.accepted) throw Error(String(result.reason ?? 'Desktop audio was rejected'));
      current.desktopId = String(result.id);
      void performance.then(async outcome => {
        if (this.live !== current || signal.aborted) return;
        if ('error' in outcome) {
          current.performanceCue = {accepted:false,renderingConfirmed:false,warnings:['Presentation unavailable: '+String(outcome.error)]};
          return;
        }
        const {actions, warnings, requested} = outcome.value;
        if (requested) current.performanceCue = {accepted:false,actions,requestedPerformance:requested,warnings,renderingConfirmed:false};
        if (!actions.length) return;
        try {
          const cue = await this.ports.display.request({action:'act',id:current.desktopId,actions});
          if (!cue.accepted) throw Error(String(cue.reason ?? 'Desktop performance cue was rejected'));
          if (this.live === current && !signal.aborted) current.performanceCue = {...current.performanceCue,accepted:true};
        } catch (error) { warnings.push('Presentation was not admitted: '+String(error)); }
      });
      if (command.performance === undefined)
        this.ports.admitted(current.stageId, String(command.title ?? this.texts.get(current.stageId) ?? ''), command.kind === 'music' ? 'singing' : 'speaking');
    } catch (error) {
      if (!current.abort.signal.aborted && !this.ports.signal.aborted) {
        await this.receipt('failed', current.stageId, { error: String(error).slice(0, 240) }).catch(() => {});
        this.ports.log(String(error));
      }
      current.abort.abort();
      if (this.live === current) this.live = null;
      await this.ports.display.request({ action: 'cancel-audio', source: 'avatar-stage', requestId: current.stageId }).catch(() => {});
    }
  }
  async attach(args: Record<string, unknown>) {
    const current = this.live;
    if (!current?.desktopId || current.stageId !== args.audioActionId) return { accepted: false, reason: 'Desktop audio changed' };
    const actions = [...Object.keys((args.expressionWeights ?? {}) as object), ...(typeof args.bodyClip === 'string' ? [args.bodyClip] : [])];
    return this.ports.display.request({ action: 'act', id: current.desktopId, actions });
  }
  private async cancel() {
    const current = this.live; if (!current) return;
    this.live = null; current.abort.abort();
    await this.ports.display.request({ action: 'cancel-audio', source: 'avatar-stage', requestId: current.stageId }).catch(() => {});
  }
  async stop() {
    this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null;
    await this.cancel();
    if (this.binding) await this.stage('/api/audio-release', { sessionId: this.sessionId }).catch(() => {});
    this.binding = null;
    await this.client?.stop(); this.client = null;
  }
}
