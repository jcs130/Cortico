import { randomUUID } from "node:crypto";
import { AvatarLibrary } from "./avatars.ts";
import { ActionLedger } from "./ledger.ts";
import { MotionProvider } from "./motion.ts";
import { MusicService } from "./music.ts";
import { VoiceService } from "./voice.ts";
import { speechPerformance, performanceActions } from './speech-performance.ts';
import {
  HUMAN_BONES,
  PROTOCOL,
  id,
  number,
  object,
  type StageConfig,
  type Emit,
  type RendererReceipt,
} from "./types.ts";
export class AvatarStage {
  readonly avatars = new AvatarLibrary();
  readonly ledger: ActionLedger;
  readonly motion: MotionProvider;
  readonly music: MusicService;
  readonly voice: VoiceService;
  private activeId: string | null = null;
  private stopped = true;
  private tick: ReturnType<typeof setInterval> | null = null;
  private sessions = new Map<
    string,
    { at: number; receipt: RendererReceipt }
  >();
  private owner: { sessionId: string; until: number } | null = null;
  private foreground: string | null = null;
  private audioRevision = 0;
  private ownedMotions = new Map<
    string,
    { avatarId: string; status: string }
  >();
  private checking = false;
  private lastMusicPoll = 0;
  private pendingTransitions = new Set<Promise<unknown>>();
  constructor(
    readonly config: StageConfig,
    private readonly sink: Emit = () => {},
  ) {
    this.ledger = new ActionLedger(config.dataDir);
    this.motion = new MotionProvider(() =>
      this.activeId ? this.avatars.get(this.activeId).preset : undefined,
    );
    this.music = new MusicService(() => config.music, config.dataDir);
    this.voice = new VoiceService(
      () => config.voice,
      config.dataDir,
      (actionId, status, data) => {
        this.retainTransition(this.ledger.note(actionId, { status, ...data }));
        this.emit("avatar.voice", { actionId, status, ...data });
        if (["failed", "cancelled"].includes(status)) {
          this.retainTransition(
            this.recordState(
              actionId,
              status as "failed" | "cancelled",
              data,
            ).then(() => {
              if (!this.stopped && this.foreground === actionId)
                this.cutAudio("voice-" + status);
            }),
          );
        }
      },
    );
  }
  private retainTransition(operation: Promise<unknown>) {
    const pending = operation.catch(() => {});
    this.pendingTransitions.add(pending);
    void pending.then(() => this.pendingTransitions.delete(pending));
  }
  private emit(type: string, data: Record<string, unknown>) {
    if (!this.stopped)
      this.sink({ protocol: PROTOCOL, type, at: Date.now(), data });
  }
  private async recordState(
    actionId: string,
    status: "queued" | "playing" | "completed" | "failed" | "cancelled",
    evidence: Record<string, unknown>,
  ) {
    const old = this.ledger.result(actionId);
    const record = await this.ledger.update(actionId, status, evidence);
    if (old.status !== record.status) this.emit("avatar.action", { ...record });
    return record;
  }
  async start() {
    if (!this.stopped) return;
    await this.avatars.load(this.config.avatars);
    this.activeId =
      this.config.defaultAvatar ?? this.avatars.list()[0]?.id ?? null;
    if (this.activeId) this.avatars.get(this.activeId);
    await this.ledger.start();
    await this.voice.start();
    await this.music.start();
    this.motion.start();
    this.stopped = false;
    this.tick = setInterval(() => void this.check(), 1000);
    this.tick.unref();
  }
  async query(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (args.action === "status") return this.status();
    if (args.action === "voice") return this.voice.status();
    if (args.action === "music")
      return {
        tracks: await this.music.list(),
        generationOwner: "cortico-world-aigc",
      };
    if (args.action === "action")
      return { ...this.ledger.result(id(args.actionId, "action id")) };
    if (args.action === "history")
      return {
        actions: this.ledger.history(
          args.limit === undefined
            ? 20
            : number(args.limit, 1, 100, "history limit"),
        ),
      };
    throw Error("Query tool accepts read actions only");
  }
  status() {
    const now = Date.now();
    for (const [key, value] of this.sessions)
      if (now - value.at > 10000) this.sessions.delete(key);
    if (this.owner && this.owner.until < now) this.owner = null;
    return {
      protocol: PROTOCOL,
      activeAvatar: this.activeId ? this.avatars.public(this.activeId) : null,
      avatars: this.avatars.list(),
      renderers: [...this.sessions.values()].map((s) => s.receipt),
      audioOwner: this.owner?.sessionId ?? null,
      foreground: this.foreground,
      audioRevision: this.audioRevision,
      voice: this.voice.status(),
      music: this.music.state(),
      actions: this.ledger.history(12),
      motionJobs: [...this.ownedMotions.entries()]
        .slice(-12)
        .map(([jobId, row]) => ({ jobId, ...row })),
      stopped: this.stopped,
    };
  }
  claimAudio(sessionId: string) {
    id(sessionId);
    this.status();
    const renderer = this.sessions.get(sessionId);
    if (!renderer || renderer.receipt.role !== "broadcast")
      throw Error("Audio requires a connected broadcast renderer");
    if (this.owner && this.owner.sessionId !== sessionId)
      throw Error("Another renderer owns the single audio output");
    this.owner = { sessionId, until: Date.now() + 10000 };
    return { ok: true, sessionId, leaseMs: 10000 };
  }
  audioAllowed(sessionId: string) {
    this.status();
    return !!this.owner && this.owner.sessionId === sessionId;
  }
  releaseAudio(sessionId: string) {
    if (this.owner?.sessionId !== sessionId) return { ok: false, reason: 'Audio belongs to another renderer' };
    this.cutAudio('renderer-released'); this.owner = null; this.sessions.delete(sessionId);
    return { ok: true };
  }
  musicPreviewAllowed(sessionId: string, trackId: string) {
    if (!this.audioAllowed(sessionId) || !this.foreground) return false;
    const action = this.ledger.result(this.foreground);
    return (
      ["queued", "playing"].includes(action.status) &&
      action.kind === "music-play" &&
      action.command.scope === "preview" &&
      action.command.targetSession === sessionId &&
      action.command.trackId === trackId
    );
  }
  private ensureAudio() {
    this.status();
    if (!this.owner)
      throw Error(
        "Enable audio in one broadcast renderer before requesting speech or singing",
      );
    return this.owner.sessionId;
  }
  private ensureActive() {
    if (this.stopped) throw Error("Stage is stopped");
    if (!this.activeId) throw Error("Install and select an avatar first");
    return this.avatars.get(this.activeId);
  }
  private async queue(
    kind: string,
    command: Record<string, unknown>,
    requestId: string,
  ) {
    if (this.stopped) throw Error("Stage is stopped");
    const { record, reused } = await this.ledger.submit(
      id(requestId, "request id"),
      kind,
      this.activeId,
      command,
    );
    if (this.stopped) {
      await this.ledger.update(record.id, "cancelled", {
        reason: "Stage stopped during admission",
      });
      return { ...record, reused };
    }
    if (!reused) {
      if (kind === "presentation")
        for (const old of this.ledger.actions.values())
          if (
            old.id !== record.id &&
            old.kind === kind &&
            ["queued", "playing"].includes(old.status)
          ) {
            await this.recordState(old.id, "cancelled", {
              reason: "Replaced presentation cue",
            });
            this.emit("cancel", { eventId: old.id });
          }
      if (["perform", "motion-play"].includes(kind))
        for (const old of this.ledger.actions.values())
          if (
            old.id !== record.id &&
            ["perform", "motion-play"].includes(old.kind) &&
            ["queued", "playing"].includes(old.status) &&
            old.command.scope === command.scope
          ) {
            await this.ledger.update(old.id, "cancelled", {
              reason: "Replaced by an explicit new body action",
            });
            this.emit("cancel", { eventId: old.id });
          }
      this.emit("command", {
        ...command,
        eventId: record.id,
        avatarId: this.activeId,
        expiresAt: Date.now() + 10000,
      });
    }
    return { ...record, reused };
  }
  async control(
    args: Record<string, unknown>,
    requestId: string = randomUUID(),
  ): Promise<Record<string, unknown>> {
    if (args.action === "status") return this.status();
    if (this.stopped) throw Error("Stage is stopped");
    if (args.action === "history")
      return {
        actions: this.ledger.history(
          args.limit === undefined
            ? 20
            : number(args.limit, 1, 100, "history limit"),
        ),
      };
    if (args.action === "result")
      return { ...this.ledger.result(id(args.actionId, "action id")) };
    if (args.action === "cancel") {
      const actionId = id(args.actionId, "action id");
      const result = await this.recordState(actionId, "cancelled", {
        reason: "Explicit cancellation",
      });
      if (this.foreground === actionId) this.cutAudio("explicit-cancellation");
      this.emit("cancel", { eventId: actionId });
      return { ...result };
    }
    if (args.action === "select") {
      const avatarId = id(args.avatarId, "avatar id");
      this.avatars.get(avatarId);
      const old = this.activeId;
      this.activeId = avatarId;
      try {
        const result = await this.queue(
          "select",
          {
            kind: "select",
            avatar: this.avatars.public(avatarId),
            scope: args.scope ?? "broadcast",
          },
          requestId,
        );
        if (!result.reused) this.cutAudio("avatar-changed");
        return result;
      } catch (e) {
        this.activeId = old;
        throw e;
      }
    }
    if (args.action === "direct") {
      const avatar = this.ensureActive(),
        audioId = id(args.audioActionId, "audio action id");
      const audio = this.ledger.result(audioId);
      if (
        this.foreground !== audioId ||
        !["speech", "music-play"].includes(audio.kind) ||
        !["queued", "playing"].includes(audio.status) ||
        audio.avatarId !== this.activeId
      )
        return {
          accepted: false,
          status: "skipped",
          reason: "The referenced audio is no longer current",
        };
      const weights =
        args.expressionWeights === undefined
          ? {}
          : object(args.expressionWeights);
      for (const [name, weight] of Object.entries(weights)) {
        if (!(avatar.capabilities.expressions as string[]).includes(name))
          throw Error("Presentation expression is unavailable");
        number(weight, 0, 1, "expression weight");
      }
      if (
        args.bodyClip !== undefined &&
        !(avatar.capabilities.clips as string[]).includes(String(args.bodyClip))
      )
        throw Error("Presentation clip is unavailable");
      const record = await this.queue(
        "presentation",
        {
          kind: "presentation",
          audioActionId: audioId,
          expressionWeights: weights,
          ...(args.bodyClip ? { bodyClip: args.bodyClip } : {}),
          scope: "broadcast",
        },
        requestId,
      );
      if (this.foreground !== audioId) {
        await this.recordState(String(record.id), "cancelled", {
          reason: "Audio changed during cue admission",
        });
        this.emit("cancel", { eventId: record.id });
        return { ...record, accepted: false, status: "cancelled" };
      }
      return { ...record, accepted: true };
    }
    if (args.action !== "perform") throw Error("Unknown avatar action");
    const active = this.ensureActive(),
      cap = active.capabilities;
    const command: Record<string, unknown> = {
      kind: "perform",
      scope: args.scope ?? "broadcast",
      durationMs:
        args.durationMs === undefined
          ? (active.motions?.clips[
              String(args.bodyClip ?? "").replace(/^vrma:/, "")
            ]?.duration ?? 2.5) * 1000
          : number(args.durationMs, 200, 10000, "duration"),
      intensity:
        args.intensity === undefined
          ? 1
          : number(args.intensity, 0, 1, "intensity"),
    };
    if (!["preview", "broadcast"].includes(String(command.scope)))
      throw Error("Invalid renderer scope");
    if (args.expression !== undefined) {
      if (!(cap.expressions as string[]).includes(String(args.expression)))
        throw Error("Expression is unavailable for this avatar");
      command.expression = args.expression;
    }
    if (args.gesture !== undefined) {
      if (
        !["wave", "nod", "bow", "cheer", "idle"].includes(String(args.gesture))
      )
        throw Error("Unknown gesture");
      const required =
        args.gesture === "wave"
          ? ["rightUpperArm", "rightLowerArm"]
          : args.gesture === "cheer"
            ? ["leftUpperArm", "rightUpperArm"]
            : args.gesture === "nod"
              ? ["head"]
              : args.gesture === "bow"
                ? ["spine"]
                : [];
      if (required.some((b) => !(cap.bones as string[]).includes(b)))
        throw Error("Gesture requires unavailable bones");
      command.gesture = args.gesture;
    }
    if (args.bodyClip !== undefined) {
      if (!(cap.clips as string[]).includes(String(args.bodyClip)))
        throw Error("Installed clip is unavailable for this avatar");
      command.bodyClip = args.bodyClip;
    }
    if (args.bones !== undefined) {
      const bones = object(args.bones);
      for (const [bone, angles] of Object.entries(bones)) {
        if (
          !(HUMAN_BONES as readonly string[]).includes(bone) ||
          !(cap.bones as string[]).includes(bone) ||
          !Array.isArray(angles) ||
          angles.length !== 3
        )
          throw Error("Unsupported humanoid bone");
        angles.forEach((v) => number(v, -75, 75, "bone angle"));
      }
      command.bones = bones;
    }
    return this.queue("perform", command, requestId);
  }
  async motionAction(
    args: Record<string, unknown>,
    requestId: string = randomUUID(),
  ): Promise<Record<string, unknown>> {
    this.ensureActive();
    if (args.action === "stop") {
      const cancelled = [];
      for (const action of this.ledger.actions.values())
        if (
          ["perform", "motion-play"].includes(action.kind) &&
          ["queued", "playing"].includes(action.status)
        ) {
          await this.recordState(action.id, "cancelled", {
            reason: "Explicit body stop",
          });
          cancelled.push(action.id);
        }
      this.emit("cancel", { allBody: true });
      return { ok: true, status: "stop-requested", cancelled };
    }
    if (["play", "preview"].includes(String(args.action))) {
      const clipId = id(args.clipId, "clip id");
      const { job } = await this.motion.clip(clipId);
      if (args.action === "play" && job.review !== "approved")
        throw Error("Preview and approve this candidate before broadcast");
      return this.queue(
        "motion-play",
        {
          kind: "motion",
          clipId,
          url: "/assets/generated-motions/" + encodeURIComponent(clipId),
          scope: args.action === "preview" ? "preview" : "broadcast",
        },
        requestId,
      );
    }
    const avatarId = this.activeId!;
    const result = await this.motion.call(args, requestId);
    if (args.action === "generate" && typeof result.id === "string")
      this.ownedMotions.set(result.id, {
        avatarId,
        status: String(result.status),
      });
    if (args.action === "cancel" && typeof result.id === "string") {
      this.ownedMotions.delete(result.id);
      this.emit("avatar.motion", result);
    }
    return result;
  }
  private cutAudio(reason: string) {
    this.audioRevision++;
    this.voice.interrupt(reason);
    if (this.foreground) {
      for (const row of this.ledger.actions.values())
        if (
          row.kind === "presentation" &&
          row.command.audioActionId === this.foreground &&
          ["queued", "playing"].includes(row.status)
        ) {
          this.retainTransition(
            this.recordState(row.id, "cancelled", { reason }),
          );
          this.emit("cancel", { eventId: row.id });
        }
      this.retainTransition(
        this.recordState(this.foreground, "cancelled", { reason }),
      );
      this.emit("audio.cut", { eventId: this.foreground });
      this.foreground = null;
    }
  }
  async voiceAction(
    args: Record<string, unknown>,
    requestId: string = randomUUID(),
  ): Promise<Record<string, unknown>> {
    if (args.action === "status") {
      const cap = this.activeId ? this.avatars.get(this.activeId).capabilities : null;
      return {...this.voice.status(), performance: { expressions: cap?.expressions ?? [],
        bodyClips: cap?.clips ?? [], synchronizedTo: 'audio-playback', voiceEmotionControl: false }};
    }
    if (args.action === "select") return this.voice.select(args.voice);
    if (args.action === "interrupt") {
      this.cutAudio("interrupted");
      return { ok: true, status: "interrupt-requested" };
    }
    if (args.action !== "speak") throw Error("Unknown voice action");
    const active = this.ensureActive();
    const sessionId = this.ensureAudio();
    const performance = speechPerformance(args.performance);
    const desktop = this.sessions.get(sessionId)?.receipt.renderer === 'audio-only';
    if (!desktop) performanceActions(performance, active.capabilities.expressions as string[], active.capabilities.clips as string[]);
    if (
      args.ifIdleRevision !== undefined &&
      (!Number.isSafeInteger(args.ifIdleRevision) ||
        Number(args.ifIdleRevision) < 0)
    )
      throw Error("Invalid audio revision");
    if (
      args.ifIdleRevision !== undefined &&
      (this.foreground || args.ifIdleRevision !== this.audioRevision)
    )
      return {
        accepted: false,
        status: "skipped",
        reason: "Audio foreground changed; draft was not submitted",
      };
    const ticket = ++this.audioRevision;
    const row = await this.ledger.submit(requestId, "speech", this.activeId, {
      text: args.text,
      voice: args.voice ?? this.voice.status().voice,
      ...(performance ? {performance} : {}),
    });
    if (row.reused) return { ...row.record, reused: true };
    if (
      this.stopped ||
      ticket !== this.audioRevision ||
      this.owner?.sessionId !== sessionId
    ) {
      const record = await this.ledger.update(row.record.id, "cancelled", {
        reason: "Speech superseded or output changed during admission",
      });
      return { ...record, accepted: false };
    }
    this.cutAudio("superseded");
    try {
      const stream = this.voice.queue(row.record.id, args.text, args.voice);
      this.foreground = row.record.id;
      if (performance && !desktop) {
        const expression = performance.expression ?? performance.emotion;
        await this.control({action: 'direct', audioActionId: row.record.id,
          expressionWeights: expression ? {[expression]: 1} : {},
          ...(performance.bodyClip ? {bodyClip: performance.bodyClip} : {})}, row.record.id + ':performance');
        if (this.foreground !== row.record.id || this.stopped) return {...this.ledger.result(row.record.id), accepted: false};
      }
      this.emit("avatar.speech.submitted", {
        actionId: row.record.id,
        requestId,
        text: args.text,
        voice: args.voice ?? this.voice.status().voice,
        ...(performance ? {performance} : {}),
      });
      this.emit("command", {
        kind: "speech",
        ...stream,
        eventId: row.record.id,
        targetSession: sessionId,
        scope: "broadcast",
        expiresAt: Date.now() + 10000,
        ...(performance ? {performance} : {}),
      });
      return { ...row.record, accepted: true, prebufferMs: 480 };
    } catch (e) {
      if (this.foreground === row.record.id) this.cutAudio('speech-admission-failed');
      await this.ledger.update(row.record.id, "failed", { error: String(e) });
      throw e;
    }
  }
  async musicAction(
    args: Record<string, unknown>,
    requestId: string = randomUUID(),
  ): Promise<Record<string, unknown>> {
    if (args.action === "status")
      return { ...this.music.state(), foreground: this.foreground };
    if (args.action === "list") return { tracks: await this.music.list() };
    if (this.stopped) throw Error("Stage is stopped");
    if (args.action === "generate")
      return { ...(await this.music.generate(args, requestId)) };
    if (args.action === "result" || args.action === "cancel")
      return this.music.job(id(args.jobId, "job id"), args.action === "cancel");
    if (args.action === "approve" || args.action === "reject")
      return this.music.review(
        id(args.jobId, "job id"),
        args.action === "approve",
      );
    if (args.action === "stop") {
      this.cutAudio("music-stopped");
      return { ok: true, status: "stop-requested" };
    }
    if (args.action !== "play" && args.action !== "preview")
      throw Error("Unknown music action");
    this.ensureActive();
    const preview = args.action === "preview";
    const sessionId = this.ensureAudio(),
      trackId = id(args.trackId, "track id");
    if (preview && this.sessions.get(sessionId)?.receipt.surface !== "control")
      throw Error(
        "Preview requires the control page to own audio; OBS preview playback is disabled",
      );
    const { track } = await this.music.track(trackId, preview);
    const cues = await this.music.cues(trackId, preview);
    const existing = [...this.ledger.actions.values()].find(
      (r) => r.requestId === requestId,
    );
    if (existing) {
      const expected = {
        kind: "music",
        trackId,
        title: track.title,
        url: "/audio/music/" + encodeURIComponent(trackId),
        cues: "/audio/cues/" + encodeURIComponent(trackId),
        mouthSource: cues.mouthSource,
        volume:
          args.volume === undefined
            ? 0.65
            : number(args.volume, 0, 1, "volume"),
        targetSession: sessionId,
        scope: preview ? "preview" : "broadcast",
      };
      return {
        ...(
          await this.ledger.submit(
            requestId,
            "music-play",
            this.activeId,
            expected,
          )
        ).record,
        reused: true,
      };
    }
    this.cutAudio("music-started");
    const record = await this.queue(
      "music-play",
      {
        kind: "music",
        trackId,
        title: track.title,
        url: "/audio/music/" + encodeURIComponent(trackId),
        cues: "/audio/cues/" + encodeURIComponent(trackId),
        mouthSource: cues.mouthSource,
        volume:
          args.volume === undefined
            ? 0.65
            : number(args.volume, 0, 1, "volume"),
        targetSession: sessionId,
        scope: preview ? "preview" : "broadcast",
      },
      requestId,
    );
    this.foreground = String(record.id);
    return record;
  }
  async receipt(input: Record<string, unknown>) {
    if (this.stopped) {
      if (
        typeof input.eventId === "string" &&
        this.ledger.actions.has(input.eventId)
      )
        await this.ledger.note(input.eventId, {
          ignoredAfterStop: true,
          ...input,
        });
      return { ok: true, ignored: true };
    }
    const r = input as unknown as RendererReceipt;
    id(r.sessionId);
    const avatar = this.avatars.get(id(r.avatarId));
    if (
      avatar.preset.sha256 !== r.avatarSha256 ||
      r.avatarId !== this.activeId ||
      !["preview", "broadcast"].includes(r.role) ||
      !["ready", "heartbeat", "applied", "playing", "ended", "failed"].includes(
        r.status,
      )
    )
      throw Error("Receipt does not match the active avatar");
    this.sessions.set(r.sessionId, { at: Date.now(), receipt: r });
    if (this.owner?.sessionId === r.sessionId)
      this.owner.until = Date.now() + 10000;
    if (r.eventId) {
      const previous = this.ledger.result(id(r.eventId));
      if (r.renderer === 'audio-only' && (!['speech', 'music-play'].includes(previous.kind)
        || r.status === 'applied')) throw Error('An audio-only renderer cannot confirm avatar or body execution');
      if (['speech', 'music-play'].includes(previous.kind) && r.status === 'applied')
        throw Error('Audio completion requires actual playback ended evidence');
      if (['speech', 'music-play'].includes(previous.kind) && previous.command.targetSession
        && previous.command.targetSession !== r.sessionId) throw Error('Audio receipt belongs to another target renderer');
      if (previous.avatarId !== this.activeId)
        throw Error("Receipt belongs to another avatar");
      const scope = previous.command.scope ?? "broadcast";
      if (scope === "preview" && r.role !== "preview")
        throw Error("Preview receipt scope mismatch");
      if (scope === "broadcast" && r.role === "preview") {
        await this.ledger.note(r.eventId, { previewOnly: true, ...input });
        return { ok: true, executionConfirmed: false };
      }
      if (
        ["speech", "music-play", "presentation"].includes(previous.kind) &&
        !this.audioAllowed(r.sessionId)
      )
        throw Error("Audio receipt from non-owner renderer");
      const status =
        r.status === "playing"
          ? "playing"
          : r.status === "failed"
            ? "failed"
            : ["applied", "ended"].includes(r.status)
              ? "completed"
              : null;
      if (status) {
        await this.recordState(r.eventId, status, { ...input });
        if (
          status === "playing" &&
          previous.kind === "motion-play" &&
          typeof previous.command.clipId === "string"
        ) {
          try {
            await this.motion.used(previous.command.clipId, r.eventId, r.role);
          } catch (e) {
            await this.ledger.note(r.eventId, {
              usageLedgerError: e instanceof Error ? e.message : String(e),
            });
          }
        }
        if (
          ["completed", "failed"].includes(status) &&
          this.foreground === r.eventId
        ) {
          this.voice.finish(r.eventId);
          this.foreground = null;
        }
      }
    }
    return { ok: true };
  }
  private async check() {
    if (this.stopped || this.checking) return;
    this.checking = true;
    try {
      this.status();
      for (const action of this.ledger.actions.values()) {
        const audioId =
          action.kind === "speech"
            ? action.id
            : action.kind === "presentation" &&
                typeof action.command.audioActionId === "string"
              ? action.command.audioActionId
              : null;
        const wait = audioId ? this.voice.playbackWait(audioId) : null;
        const synthesizing =
          wait?.synthesizing &&
          Date.now() < wait.deadline &&
          !!this.owner &&
          this.sessions.has(this.owner.sessionId);
        if (
          (action.status === "queued" &&
            !synthesizing &&
            Date.now() - (wait?.rendererSince ?? action.createdAt) > 15000) ||
          (action.status === "playing" &&
            typeof action.evidence?.sessionId === "string" &&
            !this.sessions.has(action.evidence.sessionId))
        ) {
          await this.recordState(action.id, "failed", {
            reason:
              "Renderer execution was not confirmed or its connection expired",
          });
          if (this.foreground === action.id)
            this.cutAudio("renderer-unavailable");
        }
      }
      for (const [jobId, state] of this.ownedMotions) {
        if (this.stopped) break;
        if (state.avatarId !== this.activeId) continue;
        if (["ready", "review", "failed", "cancelled"].includes(state.status))
          continue;
        try {
          const result = await this.motion.call(
            { action: "result", jobId },
            "poll-" + jobId,
          );
          if (this.stopped) break;
          state.status = String(result.status);
          if (["ready", "review", "failed", "cancelled"].includes(state.status))
            this.emit("avatar.motion", result);
        } catch {}
      }
      if (!this.stopped && Date.now() - this.lastMusicPoll >= 5000) {
        this.lastMusicPoll = Date.now();
        for (const job of this.music.state().jobs) {
          if (
            !job.jobId ||
            !["queued", "reviewing", "generating", "validating"].includes(
              job.state,
            )
          )
            continue;
          try {
            const previous = job.state,
              result = await this.music.job(job.jobId);
            if (!this.stopped && result.state !== previous)
              this.emit("avatar.music", result);
          } catch {}
        }
      }
    } finally {
      this.checking = false;
    }
  }
  async stop() {
    if (this.stopped) return;
    this.cutAudio("stage-stopped");
    this.voice.stop();
    this.stopped = true;
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    this.motion.stop();
    this.music.stop();
    for (const row of this.ledger.actions.values())
      if (["queued", "playing"].includes(row.status))
        await this.ledger.update(row.id, "cancelled", {
          reason: "Stage stopped",
        });
    while (this.pendingTransitions.size)
      await Promise.all([...this.pendingTransitions]);
    await this.ledger.close();
    this.sessions.clear();
    this.owner = null;
  }
}
