import type { PresentationScene } from './core/performance-director.ts';
import { commentarySpeechText } from './core/commentary.ts';
import { resolveSpeechPerformance, speechPerformance, type ResolvedSpeechPerformance } from './core/speech-performance.ts';

const PROTOCOL = 'desktop-presentation/v1';
export interface DesktopPresentationConfig { mode: 'stage' | 'desktop-text' | 'desktop-audio'; url: string }
type Word = { id: string; kind: 'motion' | 'expression'; about: Record<string, string>; seconds: number;
  presentation?: {key:string; auto:boolean; tags:string[]} };
export type DesktopState = {
  protocol: string; ready: boolean; revision: number; busy: boolean; foreground: string | null;
  vocabulary: Word[]; recent: Array<Record<string, unknown>>;
  moves?: unknown[]; movement?: Array<Record<string, unknown>>;
  media?: { protocol: string; enabled: boolean; ready: boolean; streaming?: boolean; foreground: string | null; recent: Record<string, any>[] };
};
/** Explicit optional display transport. Never calls a speech backend or another World/Persona object. */
export class DesktopPresentation {
  private state: DesktopState | null = null;
  private readonly ownedIds = new Set<string>();
  private readonly authored = new Map<string, ResolvedSpeechPerformance>();
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
  resolvePerformance(raw: unknown) {
    const catalog = this.performanceCatalog();
    return resolveSpeechPerformance(speechPerformance(raw), catalog.expressions, catalog.bodyClips);
  }
  /** Resolve display ids against the actual Stage catalogue, never invent a clip. */
  stageCue(actions: readonly string[], capabilities: {expressions?:string[];animationCatalog?:{bodyClip:string}[]},
    weights:Record<string,number> = {}) {
    const expressionWeights:Record<string,number> = {};
    let bodyClip:string|undefined;
    for(const id of actions) {
      const word=this.state?.vocabulary.find(w=>w.id===id);if(!word)continue;
      if(word.kind==='expression') {
        const matches=(capabilities.expressions??[]).filter(name=>name===id || name.replace(/-/g,'').toLowerCase()===id.replace(/-/g,'').toLowerCase());
        if(matches.length===1)expressionWeights[matches[0]]=weights[id]??.8;
      } else {
        const key=word.presentation?.key;
        bodyClip=(capabilities.animationCatalog??[]).find(c=>c.bodyClip===id || (key && (c.bodyClip===key || c.bodyClip==='vrma:'+key)))?.bodyClip;
      }
    }
    return {expressionWeights,...(bodyClip?{bodyClip}:{})};
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
  async reserveStream(signal: AbortSignal) {
    const url = this.endpoint(); url.pathname += '/audio-stream';
    const r = await this.fetchImpl(url, { method: 'POST', signal: AbortSignal.any([this.signal, signal, AbortSignal.timeout(2000)]), redirect: 'error' });
    if (!r.ok) throw Error('Desktop stream reservation HTTP ' + r.status);
    return await r.json() as { assetId: string; streaming: true };
  }
  async uploadStream(assetId: string, body: ReadableStream<Uint8Array>, signal: AbortSignal) {
    const url = this.endpoint(); url.pathname += '/audio-stream/' + encodeURIComponent(assetId);
    const options = { method: 'POST', headers: { 'content-type': 'audio/wav' }, body, duplex: 'half',
      signal: AbortSignal.any([this.signal, signal]), redirect: 'error' as const };
    const r = await this.fetchImpl(url, options);
    if (!r.ok) throw Error('Desktop stream upload HTTP ' + r.status);
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
  scene(foreground = this.state?.foreground, stage?:PresentationScene): PresentationScene {
    return { foreground, busy:this.state?.busy ?? true, cueVersion:this.state?.revision, activeAvatar: this.state ? { id: 'desktop-current-figure',
      capabilities: { expressions: this.state.vocabulary.filter(w => w.kind === 'expression').map(w => w.id),
        animationCatalog: this.state.vocabulary.filter(w => w.kind === 'motion').map(w => {
          const key=w.presentation?.key ?? w.id;
          const installed=stage?.activeAvatar?.capabilities.animationCatalog?.find(c=>c.bodyClip===w.id||c.bodyClip===key||c.bodyClip==='vrma:'+key);
          return {
          bodyClip: w.id, key:w.presentation?.key ?? w.id,
          description: w.about.en ?? Object.values(w.about)[0] ?? w.id,
          auto: (w.presentation?.auto ?? true) && (stage===undefined || installed?.auto===true), tags:w.presentation?.tags ?? [],
        };}) } } : null };
  }
  async control(args: Record<string, unknown>, requestId: string) {
    await this.refresh();
    const state = this.state!;
    if (args.action === 'status') return { output:'desktop', ...this.performanceCatalog(),
      controls:['perform','direct','move','cancel','result','history'], rawBones:false, generatedMotionPlayback:false,
      defaultMoves:['left','center','right','cursor'], moves:state.moves ?? [], recent:state.recent, movement:state.movement ?? [] };
    if (args.action === 'history') return { actions:[...state.recent,...(state.movement??[])] };
    if (args.action === 'result') return [...state.recent,...(state.movement??[])].find(r=>r.id===args.actionId) ?? {accepted:false,reason:'Unknown desktop action'};
    if (args.action === 'cancel') return this.request({action:String(args.actionId).startsWith('display-move')?'cancel-move':'cancel',id:args.actionId});
    if (args.action === 'move') return this.request({action:'move',source:'avatar-stage',requestId,to:args.to,run:args.run,params:args.params});
    if (args.action !== 'perform') return {accepted:false,reason:'Use desktop status for supported presentation controls'};
    if (args.bones !== undefined || args.scope === 'preview') return {accepted:false,reason:'Desktop presentation accepts installed motion/expression ids; raw bones and preview are unavailable'};
    const actions = [args.expression, args.bodyClip ?? args.gesture].filter((v):v is string=>typeof v==='string');
    if (!actions.length || actions.some(id=>!state.vocabulary.some(w=>w.id===id))) return {accepted:false,reason:'Use exact installed desktop expression and motion ids from status'};
    return this.request({action:'perform',source:'avatar-stage',requestId,actions});
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
        writingGuide: 'Write literal natural dialogue. No vocal tags. Bubble receipt is separate from display completion. Use avatar_control status, then installed expression/motion ids or a declared move for manual performance.' };
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
    const resolved = this.resolvePerformance(args.performance);
    const {actions, warnings, requested, applied} = resolved;
    const result = await this.request({ action: 'say', source: 'avatar-stage', requestId, text,
      ...(actions.length ? {actions} : {}),
      ...(args.ifIdleRevision !== undefined ? { ifIdleRevision: args.ifIdleRevision } : {}),
      ...(args.evidence !== undefined ? { evidence: args.evidence } : {}) });
    if (result.accepted === true && typeof result.id === 'string') {this.ownedIds.add(result.id);this.authored.set(result.id,resolved);}
    while (this.ownedIds.size > 64) {const id=this.ownedIds.values().next().value!;this.ownedIds.delete(id);this.authored.delete(id);}
    await this.refresh();
    return {...result, requestedPerformance: requested, appliedPerformance: applied, presentationWarnings: warnings};
  }
  async attach(args: Record<string, unknown>) {
    await this.refresh();
    if (this.state?.foreground !== args.audioActionId)
      return { accepted: false, reason: 'Desktop presentation is no longer current' };
    const original=this.authored.get(String(args.audioActionId)), own=original?.applied;
    const actions = [...new Set([...(original?.actions ?? []),
      ...(own?.expression || own?.emotion ? [] : Object.keys((args.expressionWeights ?? {}) as object)),
      ...(own?.bodyClip || typeof args.bodyClip !== 'string' ? [] : [args.bodyClip])])];
    if (!actions.length) return { accepted: true, id: args.audioActionId, audio: false };
    return this.request({ action: 'act', id: args.audioActionId, actions });
  }
  async stop() {
    if (!this.enabled() || !this.ownedIds.size) return;
    try {
      await this.refresh();
      for (const r of this.state!.recent) if (this.ownedIds.has(String(r.id)) && ['queued', 'shown'].includes(String(r.status)))
        await this.request({ action: 'cancel', id: r.id });
    } finally { this.ownedIds.clear(); this.authored.clear(); }
  }
}
