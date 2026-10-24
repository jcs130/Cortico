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
import { DesktopPresentation } from "./desktop-presentation.ts";
import { DesktopReplySpeech, REPLY_SPEECH_DEFAULTS } from './desktop-reply-speech.ts';
import { DesktopAudioRenderer } from './desktop-audio.ts';
import { randomUUID } from 'node:crypto';
import { checkSpeechFreshness } from './speech-freshness.ts';
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
  private director: PerformanceDirector | null = null;
  private presentation: DesktopPresentation | null = null;
  private replySpeech:DesktopReplySpeech|null=null;
  private desktopAudio: DesktopAudioRenderer | null = null;
  private async speak(args: Record<string, unknown>, requestId: string, signal?: AbortSignal) {
    checkSpeechFreshness(args, this.cfg().speechObservationMaxAgeSeconds ?? 0);
    args = { ...args }; delete args.observed_at;
    if (this.presentation?.enabled() && (args.action === 'status' || args.performance !== undefined)) {
      await this.presentation.refresh();
      if (args.performance !== undefined) this.presentation.performanceActions(args.performance);
    }
    if (this.presentation?.textOnly()) {
      if (args.action === 'speak' && !requestId.startsWith('avatar-commentary-')) this.commentary?.event({
        protocol: 'avatar-stage/1', type: 'avatar.speech.submitted', at: Date.now(), data: { text: args.text, requestId },
      });
      const result = await this.presentation.speak(args, requestId);
      if (result.accepted && !result.duplicate && typeof result.id === 'string' && args.action === 'speak' && args.performance === undefined)
        void this.director?.direct(result.id, String(result.text ?? args.text), 'speaking');
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
    if (epoch === this.epoch && this.director && !this.presentation?.audioEnabled()) {
      if (
        event.type === "avatar.speech.submitted" &&
        event.data.performance === undefined &&
        typeof event.data.actionId === "string" &&
        typeof event.data.text === "string"
      )
        void this.director
          .direct(event.data.actionId, event.data.text, "speaking")
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
            meta: { stage: event },
          },
          {
            trigger:
              event.type !== "avatar.voice" &&
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
      ...(decl.name === 'avatar_voice' ? {dispatchLane:'avatar.voice'} : {}),
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
          const text = JSON.stringify(result);
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
      await local.start();
      lifetime.signal.throwIfAborted();
      this.presentation = new DesktopPresentation(() => ({ mode: this.cfg().presentation?.mode ?? 'stage',
        url: this.cfg().presentation?.url ?? '' }), lifetime.signal);
      if (this.presentation.audioEnabled()) {
        this.desktopAudio = new DesktopAudioRenderer({
          stageUrl: () => config.remoteUrl || this.server!.url, display: this.presentation, signal: lifetime.signal,
          admitted: (id, text, mode) => { void this.director?.direct(id, text, mode); },
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
        observe:event=>{this.replySpeech?.observe(event);this.director?.observe(event);},
        tick:()=>this.director?.tick(),
      });
      this.commentary.start(host);
      this.director = new PerformanceDirector({
        config: () => ({ ...DIRECTOR_DEFAULTS, ...this.cfg().director }),
        decide: (host as WorldHost & { decisions?: DecisionPort }).decisions,
        state: () =>
          this.presentation?.enabled() ? this.presentation.scene(this.desktopAudio?.foreground ?? undefined) : (this.server
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
      `[桌宠文字演出] avatar_voice 现在只显示文字气泡，不合成语音。手动动作使用 pet_act 和桌宠当前动作词表；自动快选择只采用实际安装的动作。\n${this.commentary?.facts() ?? ''}` };
    const state = this.server?.stage.status() ?? this.client?.status();
    if (!state) return null;
    const textFormat = (state.voice as { textFormat?: string } | undefined)?.textFormat ?? "plain";
    return {
      // Empty coverage retains all original events in host history.
      snapshotTypes: [],
      text:
        `[演出现场] ${state.audioOwner ? "音频输出已连接" : "没有已启用的音频输出"}；` +
        `${state.foreground ? "音频队列忙碌" : "音频队列空闲"}。已连接不等于台词已播放。\n${this.commentary?.facts() ?? ""}` +
        `\n[语音文本契约] ${textFormat}；按语音状态的 writingGuide 和按需编写指南起草。` +
        '\n[联合演出] avatar_voice speak 可同时传 performance={emotion,expression,bodyClip}，由本地脚本随这句音频调度，无需再推理或等待 actionId；可与游戏工具同一回复输出。status.performance 给出当前可用名称。emotion 不代表语音服务支持情绪控制。' +
        (this.presentation?.audioEnabled() ? '\n[桌宠音频] avatar_voice 的 performance 使用桌宠词表；avatar_control 骨骼指令属于演出室。' : '') +
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
    voice: { url: "", model: "", voice: "", textFormat: "plain" },
    presentation: { mode: 'stage', url: '' },
    commentary: { ...COMMENTARY_DEFAULTS },
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
