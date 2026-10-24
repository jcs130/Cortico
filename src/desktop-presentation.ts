import type { PresentationScene } from './core/performance-director.ts';
import { commentarySpeechText } from './core/commentary.ts';
import { performanceActions, speechPerformance } from './core/speech-performance.ts';

const PROTOCOL = 'desktop-presentation/v1';
export interface DesktopPresentationConfig { mode: 'stage' | 'desktop-text' | 'desktop-audio'; url: string }
type Word = { id: string; kind: 'motion' | 'expression'; about: Record<string, string>; seconds: number;
  presentation?: {key:string; auto:boolean; tags:string[]} };
export type DesktopState = {
  protocol: string; ready: boolean; revision: number; busy: boolean; foreground: string | null;
  vocabulary: Word[]; recent: Array<Record<string, unknown>>;
  media?: { protocol: string; enabled: boolean; ready: boolean; foreground: string | null; recent: Record<string, any>[] };
};
/** Explicit optional display transport. Never calls a speech backend or another World/Persona object. */
export class DesktopPresentation {
  private state: DesktopState | null = null;
  private readonly ownedIds = new Set<string>();
  constructor(private readonly config: () => DesktopPresentationConfig,
    private readonly signal: AbortSignal, private readonly fetchImpl: typeof fetch = fetch) {}
  enabled() { return this.config().mode !== 'stage'; }
  textOnly() { return this.config().mode === 'desktop-text'; }
  audioEnabled() { return this.config().mode === 'desktop-audio'; }
  media() { return this.state?.media; }
  performanceCatalog() {
    return { expressions: this.state?.vocabulary.filter(w => w.kind === 'expression').map(w => w.id) ?? [],
      bodyClips: this.state?.vocabulary.filter(w => w.kind === 'motion').map(w => w.id) ?? [],
      synchronizedTo: this.audioEnabled() ? 'audio-playback' : 'caption', voiceEmotionControl: false };
  }
  performanceActions(raw: unknown) {
    const catalog = this.performanceCatalog();
    return performanceActions(speechPerformance(raw), catalog.expressions, catalog.bodyClips);
  }
  private endpoint() {
    const url = new URL(this.config().url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash)
      throw Error('Desktop presentation requires an explicit loopback HTTP URL');
    url.pathname = '/api/presentation';
    return url;
  }
  async request(command?: Record<string, unknown>) {
    const r = await this.fetchImpl(this.endpoint(), {
      ...(command ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol: PROTOCOL, ...command }) } : {}),
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(2000)]), redirect: 'error',
    });
    if (!r.ok) throw Error('Desktop presentation HTTP ' + r.status);
    return await r.json() as Record<string, any>;
  }
  async upload(bytes: Uint8Array, signal: AbortSignal) {
    const url = this.endpoint(); url.pathname += '/audio';
    const r = await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: Buffer.from(bytes),
      signal: AbortSignal.any([this.signal, signal, AbortSignal.timeout(15000)]), redirect: 'error' });
    if (!r.ok) throw Error('Desktop audio upload HTTP ' + r.status);
    return await r.json() as { assetId: string; sha256: string };
  }
  async refresh(): Promise<Record<string, any>> {
    const s = await this.request();
    if (s.protocol !== PROTOCOL || !Array.isArray(s.vocabulary) || !Array.isArray(s.recent)
      || typeof s.revision !== 'number') throw Error('Unsupported desktop presentation response');
    this.state = s as DesktopState;
    return { presentationReady: s.ready === true, stopped: !s.ready, audioOwner: false,
      foreground: s.busy ? s.foreground ?? 'desktop-busy' : null, audioRevision: s.revision,
      voice: { configured: false, textFormat: 'plain' }, textReady: s.ready === true };
  }
  scene(foreground = this.state?.foreground): PresentationScene {
    return { foreground, busy:this.state?.busy ?? true, cueVersion:this.state?.revision, activeAvatar: this.state ? { id: 'desktop-current-figure',
      capabilities: { expressions: this.state.vocabulary.filter(w => w.kind === 'expression').map(w => w.id),
        animationCatalog: this.state.vocabulary.filter(w => w.kind === 'motion').map(w => ({
          bodyClip: w.id, key:w.presentation?.key ?? w.id,
          description: w.about.en ?? Object.values(w.about)[0] ?? w.id,
          auto: w.presentation?.auto ?? true, tags:w.presentation?.tags ?? [],
        })) } } : null };
  }
  async react(args: Record<string, unknown>, requestId: string) {
    await this.refresh();
    const actions = [...Object.keys((args.expressionWeights ?? {}) as object),
      ...(typeof args.bodyClip === 'string' ? [args.bodyClip] : [])];
    if (!actions.length) return {accepted:true, id:requestId, skipped:true};
    return this.request({action:'react',source:'avatar-stage',requestId,actions,
      evidence:args.evidence,ifIdleRevision:args.ifIdleRevision});
  }
  async speak(args: Record<string, unknown>, requestId: string): Promise<Record<string, any>> {
    if (args.action === 'status') {
      await this.refresh();
      return { output: 'desktop-text', audio: false, presentation: this.state, performance: this.performanceCatalog(), textFormat: 'plain',
        writingGuide: 'Write literal natural dialogue. No vocal tags. Bubble receipt is separate from display completion. Use pet_act with the current desktop figure vocabulary for manual gestures.' };
    }
    if (args.action === 'interrupt') {
      await this.refresh();
      const receipts = [];
      for (const r of this.state!.recent.filter(r => ['queued', 'shown'].includes(String(r.status)) && r.source === 'avatar-stage'))
        receipts.push(await this.request({ action: 'cancel', id: r.id }));
      await this.refresh();
      return { accepted: true, audio: false, receipts };
    }
    if (args.action !== 'speak') return { accepted: false, reason: 'Text presentation does not select or start a speech service' };
    const text = typeof args.text === 'string' ? commentarySpeechText(args.text) : '';
    if (args.performance !== undefined) await this.refresh();
    const actions = this.performanceActions(args.performance);
    const result = await this.request({ action: 'say', source: 'avatar-stage', requestId, text,
      ...(actions.length ? {actions} : {}),
      ...(args.ifIdleRevision !== undefined ? { ifIdleRevision: args.ifIdleRevision } : {}),
      ...(args.evidence !== undefined ? { evidence: args.evidence } : {}) });
    if (result.accepted === true && typeof result.id === 'string') this.ownedIds.add(result.id);
    while (this.ownedIds.size > 64) this.ownedIds.delete(this.ownedIds.values().next().value!);
    await this.refresh();
    return result;
  }
  async attach(args: Record<string, unknown>) {
    await this.refresh();
    if (this.state?.foreground !== args.audioActionId)
      return { accepted: false, reason: 'Desktop presentation is no longer current' };
    const actions = [...Object.keys((args.expressionWeights ?? {}) as object),
      ...(typeof args.bodyClip === 'string' ? [args.bodyClip] : [])];
    if (!actions.length) return { accepted: true, id: args.audioActionId, audio: false };
    return this.request({ action: 'act', id: args.audioActionId, actions });
  }
  async stop() {
    if (!this.enabled() || !this.ownedIds.size) return;
    try {
      await this.refresh();
      for (const r of this.state!.recent) if (this.ownedIds.has(String(r.id)) && ['queued', 'shown'].includes(String(r.status)))
        await this.request({ action: 'cancel', id: r.id });
    } finally { this.ownedIds.clear(); }
  }
}
