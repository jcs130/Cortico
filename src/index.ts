import type { WorldDefinition } from "cortico/world.ts";
import type {
  World,
  WorldHost,
  ToolDef,
  WorldWebUiDecl,
} from "cortico/core/types.ts";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { normalizeConfig } from "./core/config.ts";
import { AvatarStageServer } from "./server.ts";
import { AvatarStageClient } from "./sdk.ts";
import { TOOL_DEFINITIONS, WORLD_DESCRIPTION } from "./tools.ts";
import type { WorldConfig, StageEvent } from "./core/types.ts";
import { COMMENTARY_DEFAULTS } from "./core/commentary.ts";
import { CommentaryController } from "./commentary-controller.ts";
import { AudienceProgressSpeaker, AUDIENCE_PROGRESS_DEFAULTS, normalizeAudienceProgress } from './core/audience-progress.ts';
import { DesktopPresentation } from "./desktop-presentation.ts";
import { DesktopReplySpeech, REPLY_SPEECH_DEFAULTS } from './desktop-reply-speech.ts';
import { DesktopAudioRenderer } from './desktop-audio.ts';
import { randomUUID } from 'node:crypto';
import { stageSupervisorView } from './event-context.ts';
import { AutoMusic, AUTO_MUSIC_DEFAULTS } from './core/auto-music.ts';
import { checkSpeechFreshness, resolveSpeechEvidence } from './speech-freshness.ts';
import { speechPerformance } from './core/speech-performance.ts';
import {
  PerformanceDirector,
  DIRECTOR_DEFAULTS,
  type DecisionPort,
  type PresentationScene,
} from "./core/performance-director.ts";
export class AvatarStageWorld implements World {
  readonly id = "avatar-stage";
  private host: WorldHost | null = null;
  private lifetime: AbortController | null = null;
  private epoch = 0;
  private server: AvatarStageServer | null = null;
  private client: AvatarStageClient | null = null;
  private commentary: CommentaryController | null = null;
  private audienceSpeaker: AudienceProgressSpeaker | null = null;
  private autoMusic: AutoMusic | null = null;
  /** Optional current activity input; presentation never takes ownership of the game body. */
  publishPerformanceActivity(value: unknown): void { this.autoMusic?.observe(value); }
  /** Optional host presentation port. Does not inspect model reasoning or perform game actions. */
  async publishAudienceProgress(value: unknown): Promise<void> {
    if (!this.lifetime || this.lifetime.signal.aborted || !this.cfg().audienceProgress?.enabled) return;
    const row = normalizeAudienceProgress(value); if (!row) return;
    if (this.server) this.server.stage.publishAudienceProgress(row);
    else await this.client?.publishAudienceProgress(row, this.lifetime.signal);
    this.audienceSpeaker?.observe(row);
  }
  private director: PerformanceDirector | null = null;
  private presentation: DesktopPresentation | null = null;
  private replySpeech:DesktopReplySpeech|null=null;
  private desktopAudio: DesktopAudioRenderer | null = null;
  private async speak(args: Record<string, unknown>, requestId: string, signal?: AbortSignal) {
    args = resolveSpeechEvidence(args, cursor => this.host?.store?.get(cursor));
    checkSpeechFreshness(args, this.cfg().speechObservationMaxAgeSeconds ?? 0);
    args = { ...args };
    if (args.performance !== undefined) speechPerformance(args.performance);
    if (this.presentation?.enabled() && args.action === 'status') {
      await this.presentation.refresh();
    }
    if (this.presentation?.textOnly()) {
      if (args.action === 'speak' && !requestId.startsWith('avatar-commentary-')) this.commentary?.event({
        protocol: 'avatar-stage/1', type: 'avatar.speech.submitted', at: Date.now(), data: { text: args.text, requestId },
      });
      const result = await this.presentation.speak(args, requestId);
      if (result.accepted && !result.duplicate && args.action === 'speak' && typeof args.text === 'string')
        this.audienceSpeaker?.noteSpeech(args.text);
      if (result.accepted && !result.duplicate && typeof result.id === 'string' && args.action === 'speak')
        void this.director?.direct(result.id, String(result.text ?? args.text), 'speaking', result.appliedPerformance);
      return result;
    }
    if (!this.client && !this.server) throw Error('3D stage is not started');
    const result = await (this.client ?? this.server!).call('avatar_voice', args, requestId, signal);
    return args.action === 'status' && this.presentation?.enabled()
      ? {...result, performance: this.presentation.performanceCatalog()} : result;
  }
  constructor(private readonly cfg: () => WorldConfig) {}
  private report(event: StageEvent, epoch: number) {
    if (epoch === this.epoch) this.commentary?.event(event);
    if (epoch === this.epoch && event.type === 'avatar.speech.submitted' && typeof event.data.text === 'string')
      this.audienceSpeaker?.noteSpeech(event.data.text, event.at);
    if (epoch === this.epoch && this.director && !this.presentation?.audioEnabled()) {
      if (
        event.type === "avatar.speech.submitted" &&
        typeof event.data.actionId === "string" &&
        typeof event.data.text === "string"
      )
        void this.director
          .direct(event.data.actionId, event.data.text, "speaking", event.data.appliedPerformance as import('./core/speech-performance.ts').SpeechPerformance | undefined)
          .catch((error) =>
            this.host?.log.warn("演出选择未完成", { error: String(error) }),
          );
      if (
        event.type === "avatar.action" &&
        event.data.kind === "music-play" &&
        event.data.status === "playing"
      ) {
        const command = event.data.command as Record<string, unknown>;
        void this.director
          .direct(
            String(event.data.id),
            "Song title metadata only, mood unknown: " +
              String(command.title ?? ""),
            "singing",
          )
          .catch((error) =>
            this.host?.log.warn("演出选择未完成", { error: String(error) }),
          );
      }
    }
    if (
      epoch === this.epoch &&
      !this.lifetime?.signal.aborted &&
      event.type.startsWith("avatar.")
    )
      void this.host
        ?.pushEvent(
          {
            ts: new Date(event.at).toISOString(),
            source: this.id,
            type: event.type,
            origin: "external",
            senderKey: this.id,
            text: JSON.stringify(event.data),
            meta: { stage: event, requestContext: stageSupervisorView(event) },
          },
          {
            trigger:
              event.type !== "avatar.voice" &&
              !(event.type === 'avatar.action' && ['speech', 'presentation'].includes(String(event.data.kind))
                && ['completed', 'cancelled'].includes(String(event.data.status))) &&
              [
                "completed",
                "failed",
                "cancelled",
                "ready",
                "review",
                "ended",
              ].includes(String(event.data.status ?? event.data.state))
                ? "flush"
                : "piggyback",
          },
        )
        .catch(() => {});
  }
  tools(): ToolDef[] {
    return TOOL_DEFINITIONS.map((decl) => ({
      ...decl,
      ...(decl.name === 'avatar_voice' ? {dispatchLane:'avatar.voice',
        description:decl.description+((this.cfg().speechObservationMaxAgeSeconds??0)>0
          ?` For claims about a current observation, provide observed_at copied from actual source evidence, at most ${this.cfg().speechObservationMaxAgeSeconds} seconds old. Ordinary conversation, greetings and creative speech do not require an observation timestamp. A supplied invalid or stale timestamp is rejected; do not remove it to repeat the same claim.`:'')} : {}),
      tags: [...decl.tags],
      handler: async (args, ctx) => {
        try {
          if (!this.lifetime) throw Error("3D stage is not started");
          const signal = AbortSignal.any([
            this.lifetime.signal,
            ...(ctx.signal ? [ctx.signal] : []),
          ]);
          signal.throwIfAborted();
          if (decl.name === 'avatar_voice') {
            const result = await this.speak(args, ctx.callId ?? randomUUID(), signal);
            return result.accepted === false ? { text: JSON.stringify(result), failed: true } : JSON.stringify(result);
          }
          if (decl.name === 'avatar_control' && this.presentation?.enabled()) {
            const result = args.action === 'direct' && this.desktopAudio
              ? await this.desktopAudio.attach(args)
              : await this.presentation.control(args, ctx.callId ?? randomUUID());
            return result.accepted === false ? {text:JSON.stringify(result),failed:true} : JSON.stringify(result);
          }
          if (decl.name === 'avatar_query' && this.presentation?.enabled() && args.action === 'action'
            && /^(caption-|display-move)/.test(String(args.actionId))) {
            return JSON.stringify(await this.presentation.control({...args,action:'result'},ctx.callId??randomUUID()));
          }
          if (decl.name === 'avatar_motion' && this.presentation?.enabled() && args.action === 'play') {
            return {failed:true,text:JSON.stringify({accepted:false,reason:'Generated motion must be installed in the displayed figure before desktop playback. Use avatar_control status for installed clips; preview remains in the stage preview page.'})};
          }
          if (decl.name === "avatar_music" && args.action === "import") {
            const artifact = this.host?.blob(String(args.reference_handle));
            if (!artifact || artifact.mime !== "audio/wav")
              throw Error("Import requires a host-resolved audio/wav artifact");
            const metadata = {
              title: String(args.title ?? ""),
              instrumental: args.instrumental === true,
            };
            if (this.client)
              return JSON.stringify(
                await this.client.importMusic(artifact.bytes, metadata, signal),
              );
            if (this.server)
              return JSON.stringify(
                await this.server.importMusic(artifact.bytes, metadata, signal),
              );
            throw Error("3D stage is not started");
          }
          const result = this.client
            ? await this.client.call(
                decl.name,
                args,
                ctx.callId ?? undefined,
                signal,
              )
            : this.server
              ? await this.server.call(
                  decl.name,
                  args,
                  ctx.callId ?? undefined,
                  signal,
                )
              : null;
          if (!result) throw Error("3D stage is not started");
          const text = JSON.stringify(decl.name === 'avatar_query' && this.presentation?.enabled()
            && ['status','history'].includes(String(args.action))
            ? {...result, presentation:await this.presentation.control({action:args.action},ctx.callId??randomUUID())}
            : result);
          return result.accepted === false ? { text, failed: true } : text;
        } catch (e) {
          return {
            text: JSON.stringify({
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            }),
            failed: true,
          };
        }
      },
    })) as ToolDef[];
  }
  async start(host: WorldHost) {
    if (this.lifetime) throw Error("3D stage is already started");
    const lifetime = new AbortController(),
      epoch = ++this.epoch;
    this.lifetime = lifetime;
    this.host = host;
    const startedAt = performance.now();
    const progress = (phase: string) => host.log?.emit('info', '演出启动阶段', {
      event: 'avatar-stage.startup', data: { phase, elapsedMs: Math.round(performance.now() - startedAt) },
    });
    let local: AvatarStageClient | AvatarStageServer | null = null;
    try {
      const config = this.cfg();
      local = config.remoteUrl
        ? new AvatarStageClient(config.remoteUrl, (event) =>
            this.report(event, epoch),
          )
        : new AvatarStageServer(config, (event) => this.report(event, epoch));
      if (local instanceof AvatarStageClient) this.client = local;
      else this.server = local;
      if (local instanceof AvatarStageServer) await local.start(progress);
      else { progress('remote-stage'); await local.start(); }
      lifetime.signal.throwIfAborted();
      this.presentation = new DesktopPresentation(() => ({ mode: this.cfg().presentation?.mode ?? 'stage',
        url: this.cfg().presentation?.url ?? '' }), lifetime.signal);
      if (this.presentation.audioEnabled()) {
        progress('desktop-audio');
        this.desktopAudio = new DesktopAudioRenderer({
          stageUrl: () => config.remoteUrl || this.server!.url, display: this.presentation, signal: lifetime.signal,
          admitted: (id, text, mode, authored) => { void this.director?.direct(id, text, mode, authored); },
          log: error => this.host?.log.warn('桌宠音频呈现未确认', { error }),
        });
        await this.desktopAudio.start();
      }
      this.commentary = new CommentaryController({
        config: this.cfg,
        state: async () =>
          this.presentation?.textOnly() ? this.presentation.refresh() : this.server
            ? this.server.stage.status()
            : this.client!.call("avatar_query", { action: "status" }),
        speak: async (args, requestId) =>
          this.speak(args, requestId, lifetime.signal),
        observe:event=>{this.replySpeech?.observe(event);this.director?.observe(event);this.audienceSpeaker?.observeEvent(event);},
        tick:()=>{ this.director?.tick(); this.audienceSpeaker?.tick(); void this.autoMusic?.tick(); },
      });
      this.commentary.start(host);
      this.autoMusic = new AutoMusic({
        config: () => ({...AUTO_MUSIC_DEFAULTS, ...this.cfg().autoMusic}),
        state: () => this.commentary?.presentationState() ?? null,
        tracks: async () => {
          const result = await (this.client ?? this.server!).call('avatar_query', {action:'music'});
          return Array.isArray(result.tracks) ? result.tracks as {id:string;instrumental?:boolean}[] : [];
        },
        play: (args, requestId) => (this.client ?? this.server!).call('avatar_music', args, requestId, lifetime.signal),
        log: data => this.host?.log.emit('info','主动唱歌触发',{event:'auto-music-trigger',data}),
      });
      this.audienceSpeaker = new AudienceProgressSpeaker({
        config: () => ({ ...AUDIENCE_PROGRESS_DEFAULTS, ...this.cfg().audienceProgress }),
        decide: (host as WorldHost & { decisions?: DecisionPort }).decisions,
        state: () => this.commentary?.presentationState() ?? null,
        speak: (text, revision, requestId, at) => this.speak({ action: 'speak', text,
          ifIdleRevision: revision, observed_at: at }, requestId, lifetime.signal),
        log: data => this.host?.log.emit('info', '公开复盘动态播报', { event: 'audience-progress-speech', data }),
      });
      this.director = new PerformanceDirector({
        config: () => ({ ...DIRECTOR_DEFAULTS, ...this.cfg().director }),
        decide: (host as WorldHost & { decisions?: DecisionPort }).decisions,
        state: () =>
          this.presentation?.enabled() ? this.presentation.scene(this.desktopAudio?.foreground ?? undefined, this.server?.stage.status() as PresentationScene | undefined) : (this.server
            ? this.server.stage.status()
            : this.client!.status()) as PresentationScene,
        attach: async (args, requestId) =>
          this.desktopAudio ? this.desktopAudio.attach(args) : this.presentation?.enabled() ? this.presentation.attach(args) : this.server
            ? this.server.call(
                "avatar_control",
                args,
                requestId,
                lifetime.signal,
              )
            : this.client!.call(
                "avatar_control",
                args,
                requestId,
                lifetime.signal,
              ),
        react:(args,requestId)=>this.presentation?.enabled()
          ? this.presentation.react(args,requestId) : Promise.resolve({accepted:false,reason:'Silent reaction output is unavailable'}),
        log: (data) =>
          this.host?.log.emit("info", "演出快选择", {
            event: "performance-decision",
            data,
          }),
      });
      this.replySpeech=new DesktopReplySpeech({config:()=>({...REPLY_SPEECH_DEFAULTS,...this.cfg().replySpeech}),
        speak:(text,requestId)=>this.speak({action:'speak',text},requestId,lifetime.signal),
        log:data=>this.host?.log.emit('info','桌面回复语音提交',{event:'desktop-reply-speech',data})});
      progress('world-ready');
    } catch (error) {
      await this.desktopAudio?.stop(); this.desktopAudio = null;
      await local?.stop();
      if (this.lifetime === lifetime) {
        this.host = null;
        this.lifetime = null;
        this.client = null;
        this.server = null;
      }
      throw error;
    }
  }
  async stop() {
    this.autoMusic?.stop(); this.autoMusic = null;
    this.audienceSpeaker?.stop(); this.audienceSpeaker = null;
    this.director?.stop();
    this.replySpeech?.stop();this.replySpeech=null;
    this.director = null;
    await this.desktopAudio?.stop(); this.desktopAudio = null;
    await this.presentation?.stop().catch(error => this.host?.log.warn('文字演出取消未确认', { error: String(error) }));
    this.presentation = null;
    this.commentary?.stop();
    this.commentary = null;
    const client = this.client,
      server = this.server,
      lifetime = this.lifetime;
    ++this.epoch;
    this.host = null;
    this.lifetime = null;
    this.client = null;
    this.server = null;
    lifetime?.abort(new Error("3D stage stopped"));
    await Promise.all([client?.stop(), server?.stop()]);
  }
  envPromptVars() {
    return {};
  }
  /** Optional current-fact surface used by supporting Personas. */
  requestFacts() {
    if (this.presentation?.textOnly()) return { snapshotTypes: [], text:
      `[桌宠文字演出] avatar_voice 现在只显示文字气泡，不合成语音。avatar_control 查询并控制当前显示形象的动作、表情与移动；自动快选择只采用实际安装的动作。\n${this.commentary?.facts() ?? ''}` };
    const state = this.server?.stage.status() ?? this.client?.status();
    if (!state) return null;
    const textFormat = (state.voice as { textFormat?: string } | undefined)?.textFormat ?? "plain";
    return {
      // Empty coverage retains all original events in host history.
      snapshotTypes: [],
      text:
        `[演出现场] ${state.audioOwner ? "音频输出已连接" : "没有已启用的音频输出"}；` +
        `${state.foreground ? "音频队列忙碌" : "音频队列空闲"}。已连接不等于台词已播放。\n${this.commentary?.facts() ?? ""}` +
        ((state.voice as any)?.busyPolicy==='preserve'?'\n[连续发言] 当前一句继续播放，最多保留一句等待中的前台台词；自动解说只在空隙提交。等待有独立到期回执，不阻塞游戏行动，不重复提交同一台词。只有明确需要打断时才interrupt。':'') +
        `\n[语音文本契约] ${textFormat}；按语音状态的 writingGuide 和按需编写指南起草。` +
        '\n[联合演出] avatar_voice speak 可同时传 performance={emotion,expression,bodyClip}，与你这句音频同步，无需再推理或等待 actionId；可与游戏工具同一回复输出。status.performance 给出当前可用名称。emotion 不代表语音服务支持情绪控制。' +
        (this.presentation?.audioEnabled() ? '\n[桌面演出] avatar_voice 与 avatar_control 统一使用当前显示形象；先查 status 获取实际支持的表情、动作和移动。' : '') +
        (this.director?.status().enabled
          ? `\n[演出快选择] ${this.director.status().hostDecisionAvailable ? "可用，随台词并行选择已安装的表情和动作" : "宿主未提供决策接口，仍可显式选动作"}。`
          : ""),
    };
  }
  webUi(): WorldWebUiDecl {
    return {
      label: "3D 演出室",
      config: [
        {
          id: "avatar-voice",
          owner: "world:avatar-stage",
          schema: {
            type: "object",
            title: "语音文本",
            properties: {
              "worlds.avatar-stage.presentation.mode": {
                type: 'string', enum: ['stage', 'desktop-text', 'desktop-audio'], title: '演出输出 / Presentation output',
                description: 'stage 使用演出室页面；desktop-text 显示桌宠文字；desktop-audio 通过桌宠播放现有语音和歌曲。 / stage uses its page; desktop-text shows bubbles; desktop-audio plays existing speech and songs through the desktop.',
              },
              "worlds.avatar-stage.presentation.url": {
                type: 'string', title: '桌宠本机地址 / Desktop loopback URL',
                description: 'desktop-text 的显式本机地址，例如 http://127.0.0.1:18446。 / Explicit loopback desktop server URL.',
              },
              "worlds.avatar-stage.voice.textFormat": {
                type: "string", enum: ["plain", "drama-3"], "x-hot": false,
                title: "所选服务的台词格式",
                description: "plain 为自然口语；drama-3 允许方括号声音指令。需与实际后端一致，保存后重启生效。",
              },
              "worlds.avatar-stage.voice.busyPolicy": {
                type:'string',enum:['replace','preserve'],'x-hot':false,title:'新台词遇到正在播放的音频',
                description:'preserve 保留当前一句，并允许一条人工或主人格台词待播；满额时明确拒绝。replace 用新台词打断。显式 interrupt 始终可打断。',
              },
              'worlds.avatar-stage.voice.pendingTimeoutMs': { type: 'integer', minimum: 1000, maximum: 300000,
                title: '台词待播超时（毫秒）', description: '默认 60000。仅延长排队等待；事实观察时间仍按原来源校验。' },
              'worlds.avatar-stage.voice.synthesisTimeoutMs': { type: 'integer', minimum: 1000, maximum: 300000,
                title: '语音合成超时（毫秒）', description: '默认 90000。与台词待播时间、事实有效期分别计算。' },
              'worlds.avatar-stage.voice.rendererStartTimeoutMs': { type: 'integer', minimum: 1000, maximum: 300000, 'x-hot': false,
                title: '合成完成后的实际起声等待（毫秒）', description: '默认 15000。仅在播放设备持续连接且已消费合成流时采用；共享音频队列可按实测等待配置。等待不冒充起声，失联或未消费仍按短超时处理。' },
              'worlds.avatar-stage.voice.extraBody': { type: 'object', 'x-hot': false,
                title: 'TTS 后端附加参数', description: '仅添加所选服务真实支持的 JSON 参数；不能覆盖台词、模型、音色和 WAV 格式。' },
              'worlds.avatar-stage.voice.synthesisTransport': { type: 'string', enum: ['wav','pcm-sse','drama-rs-wav'], 'x-hot': false,
                title: 'TTS 上游传输', description: 'pcm-sse 使用 PCM SSE；drama-rs-wav 使用原生 /v1/speak 流式 WAV，先检查健康与音色目录，保留原始音频和请求日志。两者均整条台词一次请求、关闭客户端分段；drama-rs 的全文完成状态为未知。' },
              'worlds.avatar-stage.voice.pcmSampleRate': { type: 'integer', minimum: 8000, maximum: 192000, 'x-hot': false,
                title: '原生 PCM 采样率', description: '须与实际后端的单声道 PCM16 一致，不能根据参考音频采样率猜测。' },
              'worlds.avatar-stage.voice.requireWavCompletion': { type: 'boolean', 'x-hot': false,
                title: '要求 WAV 完成凭据', description: '启用时必须有 X-Speech-Stop: complete；有截断标记的 WAV 始终失败，不能仅凭 HTTP 200 认定完整。' },
              'worlds.avatar-stage.voice.segmentMaxChars': { type: 'integer', minimum: 0, maximum: 160, 'x-hot': false,
                title: '短句合成字符预算', description: '0 关闭；启用时为 8–160。优先按分句、完整词与已配置名字分段，合并过短句子，不在固定字符位置切词。串行合成后发送一个 WAV 流，保留原播放回执。' },
              'worlds.avatar-stage.voice.pronunciations': { type: 'object', 'x-hot': false,
                title: '名字读法', description: '名字到自然口语读法的显式词典。只影响最终 TTS 输入，不修改气泡、聊天、记忆或 LLM 原文；不接受音素/说话人/动作标记。同名映射也可只保护名字不被切开。需按实际音色试听。' },
              'worlds.avatar-stage.voice.writingGuides': { type: 'object', 'x-hot': false,
                title: '各音色台词契约', description: '按需通过语音状态读取后端实际支持的格式；不是隐藏的改写调用。' },
              "worlds.avatar-stage.speechObservationMaxAgeSeconds": {
                type: 'number', minimum: 0, title: '带来源时间的口播有效期（秒）',
                description: '仅限制 current 当前状态的观察年龄；0 沿用 15 秒。recent 回顾事件使用原时间戳，最长 300 秒，不声称旧位置或血量仍是现状。普通聊天无需观察时间。',
              },
            },
          },
        },
        {
          id: "avatar-commentary",
          owner: "world:avatar-stage",
          schema: {
            type: "object",
            title: "可选游戏解说",
            properties: {
              "worlds.avatar-stage.commentary.enabled": {
                type: "boolean",
                title: "启用空闲游戏解说",
              },
              'worlds.avatar-stage.audienceProgress.enabled': { type: 'boolean', title: '显示公开思考动态', 'x-hot': true,
                description: '只接收宿主明确公开的主题和阶段，不读取内部推理或聊天历史。' },
              'worlds.avatar-stage.audienceProgress.speechEnabled': { type: 'boolean', title: '简短播报思考动态', 'x-hot': true,
                description: '系统一根据公开短摘要选择播报、仅显示或跳过；声音忙碌、过期或判断超时则不播报，不排队。' },
              'worlds.avatar-stage.audienceProgress.minSpeechGapSec': { type: 'number', minimum: 0, title: '思考动态播报间隔（秒）', 'x-hot': true },
              'worlds.avatar-stage.audienceProgress.provider': { type: 'string', title: '动态播报决策供应商', 'x-hot': true,
                description: '留空使用宿主已配置的系统一，不启动额外聊天模型。' },
              'worlds.avatar-stage.audienceProgress.timeoutMs': { type: 'number', minimum: 100, maximum: 5000,
                title: '动态播报决策超时（毫秒）', 'x-hot': true },
              "worlds.avatar-stage.commentary.idleSec": {
                type: "number",
                title: "空闲后起草（秒）",
                minimum: 1,
              },
              "worlds.avatar-stage.commentary.retrySec": {
                type: "number",
                title: "下一次起草间隔（秒）",
                minimum: 1,
              },
              "worlds.avatar-stage.commentary.factAgeSec": {
                type: "number",
                title: "现场材料有效期（秒）",
                minimum: 1,
              },
              "worlds.avatar-stage.commentary.sources": {
                type: "string",
                title: "素材来源 World ID",
              },
              "worlds.avatar-stage.commentary.style": {
                type: "string",
                title: "解说口吻",
              },
              "worlds.avatar-stage.commentary.hostStatusUrl": {
                type: "string",
                title: "宿主运行状态 URL",
              },
              "worlds.avatar-stage.director.enabled": {
                type: "boolean",
                title: "按台词自动选择表情与动作",
              },
              "worlds.avatar-stage.director.provider": {
                type: "string",
                title: "宿主决策连接名（留空沿用系统一）",
              },
              "worlds.avatar-stage.director.timeoutMs": {
                type: "number",
                title: "演出选择等待上限（毫秒）",
                minimum: 1,
                maximum: 60000,
              },
              'worlds.avatar-stage.director.reactionSources': {type:'string',title:'无声反应来源 World（空格分隔）'},
              'worlds.avatar-stage.replySpeech.enabled': {type:'boolean',title:'朗读桌面文字回复'},
              'worlds.avatar-stage.replySpeech.sources': {type:'string',title:'文字回复来源 World（空格分隔）'},
            },
          },
        },
      ],
      links: [
        {
          label: "人物与演出",
          href:
            this.client?.url ??
            this.server?.url ??
            `http://127.0.0.1:${this.cfg().port}`,
        },
        {
          label: "OBS 透明播出",
          href:
            (this.client?.url ??
              this.server?.url ??
              `http://127.0.0.1:${this.cfg().port}`) + "/?obs=1",
        },
      ],
      promptDocs: [
        {
          key: "worlds.avatar-stage.speech-writing",
          title: "语音文本编写",
          description: "按当前 TTS 文本契约编写台词、Drama3 演绎与本地端口限制",
          path: fileURLToPath(
            new URL("../docs/speech-writing.md", import.meta.url),
          ),
        },
        {
          key: "worlds.avatar-stage.env",
          title: "3D 演出能力",
          description: "动作、语音和音乐的真实执行边界",
          role: "envPrompt",
          path: fileURLToPath(new URL("./prompt.md", import.meta.url)),
        },
      ],
    };
  }
}
const definition: WorldDefinition<WorldConfig> = {
  id: "avatar-stage",
  label: "3D 演出室",
  describe: WORLD_DESCRIPTION,
  defaults: () => ({
    enabled: false,
    speechObservationMaxAgeSeconds: 0,
    remoteUrl: "",
    port: 0,
    dataDir: "",
    avatars: [],
    voice: { url: "", model: "", voice: "", textFormat: "plain", busyPolicy:"replace", pendingTimeoutMs:60000, synthesisTimeoutMs:90000, rendererStartTimeoutMs:15000, extraBody:{}, synthesisTransport:'wav', pcmSampleRate:44100, requireWavCompletion:false, segmentMaxChars:0, pronunciations:{}, writingGuides:{} },
    presentation: { mode: 'stage', url: '' },
    commentary: { ...COMMENTARY_DEFAULTS },
    autoMusic: { ...AUTO_MUSIC_DEFAULTS },
    audienceProgress: { ...AUDIENCE_PROGRESS_DEFAULTS },
    director: { ...DIRECTOR_DEFAULTS },
    replySpeech: { ...REPLY_SPEECH_DEFAULTS },
    music: { directory: "", generationUrl: "" },
  }),
  create: (ctx) =>
    new AvatarStageWorld(() => ({
      ...ctx.cfg,
      ...normalizeConfig(
        {
          ...ctx.cfg,
          dataDir: ctx.cfg.dataDir || join(ctx.dataDir, "avatar-stage"),
        },
        ctx.botDir,
      ),
    })),
};
export default definition;
