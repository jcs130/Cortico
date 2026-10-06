/** Persona sleep review policy consumes World facts and waits for a successful native speech receipt. */
import type { CoreApi, EventEnvelope, ToolOutcome } from 'cortico/core/types.ts';
import { spokenText } from './recent-speech.ts';

export interface SleepReviewConfig {
  enabled: boolean;
  /** Newline-separated event types supplied by the configured Worlds. */
  eventTypes: string;
}
export const SLEEP_REVIEW_DEFAULTS: SleepReviewConfig = { enabled: false, eventTypes: '' };
const STATE_KEY = 'sleepReview';

interface ReviewEvidence {
  source: string;
  world: string;
  dimension: string | null;
  gameDay: number;
  timeOfDay: number;
  observedAt: string;
  phase: 'announcement' | 'ready';
}
interface ReviewState { days: Record<string, number>; pending: ReviewEvidence | null }

export class SleepReview {
  private readonly state: ReviewState;
  constructor(private readonly core: CoreApi, private readonly config: () => SleepReviewConfig) {
    const saved = core.personaState()[STATE_KEY] as Partial<ReviewState> | undefined;
    this.state = { days: saved?.days ?? {}, pending: saved?.pending ?? null };
  }

  observe(events: readonly EventEnvelope[]): string | null {
    const cfg = this.config();
    if (!cfg.enabled || this.state.pending) return null;
    const types = new Set(cfg.eventTypes.split(/\r?\n/).map(value => value.trim()).filter(Boolean));
    for (const event of events) {
      const meta = event.meta;
      if (event.origin !== 'external' || !types.has(event.type) || meta?.sleeping !== true) continue;
      const { world, dimension, gameDay, timeOfDay } = meta;
      if (typeof world !== 'string' || !world.trim() || typeof gameDay !== 'number'
        || !Number.isSafeInteger(gameDay) || gameDay < 0 || typeof timeOfDay !== 'number'
        || !Number.isFinite(timeOfDay) || timeOfDay < 12_000 || timeOfDay >= 24_000) continue;
      const key = JSON.stringify([event.source, world, typeof dimension === 'string' ? dimension : null]);
      if (this.state.days[key] === gameDay) continue;
      this.state.days[key] = gameDay;
      this.state.pending = { source: event.source, world, dimension: typeof dimension === 'string' ? dimension : null,
        gameDay, timeOfDay, observedAt: event.ts, phase: 'announcement' };
      this.save();
      return this.notice();
    }
    return null;
  }

  notice(): string | null {
    const pending = this.state.pending;
    if (!this.config().enabled || pending?.phase !== 'announcement') return null;
    return `[睡前回顾] ${pending.source} 在 ${pending.observedAt} 确认游戏第 ${pending.gameDay} 天夜间已成功躺上床。`
      + '先通过现有发言工具，用自己的语气跟观众自然说一句准备回顾今天的经历和收获，例如“忙了一天，让我想想今天做成了什么，又学会了什么。”不要每次照念同一句。'
      + '真实发言受理后，后台会整理已有记录；游戏、聊天和新事件照常进行。别把旧成果当成今天新发生，也别声称总结已完成。';
  }

  noteOutcome(ctx: { role: string; tool: string; args: Readonly<Record<string, unknown>>; outcome: Readonly<ToolOutcome> }): void {
    if (!this.config().enabled || this.state.pending?.phase !== 'announcement' || ctx.role !== 'main'
      || ctx.outcome.failed || !this.core.toolsTagged('speak').has(ctx.tool)) return;
    // A speech-tagged control or pose without text is not an announcement.
    if (!['script', 'text', 'message', 'content'].some(key => typeof ctx.args[key] === 'string'
      && (key === 'script' ? spokenText(String(ctx.args[key])) : String(ctx.args[key]).trim()))) return;
    this.state.pending.phase = 'ready';
    this.save();
  }

  takeReady(): string | null {
    const pending = this.state.pending;
    if (!this.config().enabled || pending?.phase !== 'ready') return null;
    this.state.pending = null;
    this.save();
    return `睡前回顾；${pending.source} 的 ${pending.world}${pending.dimension ? ` (${pending.dimension})` : ''}，游戏第 ${pending.gameDay} 天，`
      + `入睡观察于 ${pending.observedAt}；开场发言已受理，是否播放完以演出回执为准。`
      + '回顾这一游戏日做成的事、得到的东西、遇到的失败和学到的经验，再留少量下一次想尝试的方向。'
      + '当前快照可能仅覆盖最近一段；必要时核对已有笔记，不把跨日旧经历或未成功尝试当成今天的收获。';
  }

  private save(): void {
    this.core.personaState()[STATE_KEY] = this.state;
    this.core.savePersonaState();
  }
}
