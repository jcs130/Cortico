/** Persona selects bounded reference material; classifier answers never execute World actions. */
import { createHash } from 'node:crypto';
import type { CoreApi, EventEnvelope } from 'cortico/core/types.ts';
import type { ReferenceLibrary } from './reference-library.ts';
import { ReferenceAdviceClient, REFERENCE_MAX_TOPICS, REFERENCE_MAX_SUMMARY_CHARS, type FastReferenceConfig } from './reference-adviser.ts';

export interface ReferenceIntent { tool: string; arguments: string; at?: string; receipt?: string }

export class ReferenceRouting {
  private generation = 0;
  private manualSelection = false;
  private latestSceneKey: string | null = null;
  private readonly adviser: ReferenceAdviceClient;

  constructor(private readonly library: ReferenceLibrary,
    private readonly config: () => FastReferenceConfig,
    fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {
    this.adviser = new ReferenceAdviceClient(config, fetchImpl, now);
  }

  reset(): void { this.generation++; this.adviser.reset(); this.manualSelection = false; this.latestSceneKey = null; }

  /** An explicit reading branch has priority until the main closes it. */
  onManualRead(open: boolean): void {
    this.generation++; this.adviser.reset(); this.manualSelection = open; this.latestSceneKey = null;
  }

  observe(events: readonly EventEnvelope[], facts: readonly { source: string; text: string }[],
    core: CoreApi, intent?: ReferenceIntent): void | Promise<void> {
    const config = this.config();
    if (!config.enabled || this.manualSelection) return;
    const observed = events.filter(event => event.contextDelivery !== 'archive-only'
      && (event.source !== 'persona' || ['tick', 'planning'].includes(event.type)))
      .filter(event => {
        const age = this.now() - Date.parse(event.ts);
        return Number.isFinite(age) && age >= -1000 && age <= config.maxResultAgeMs;
      });
    if (!observed.length) return;
    let topics: ReturnType<ReferenceLibrary['descriptors']>;
    try { topics = this.library.descriptors(); }
    catch (error) { core.log.debug('资料索引不可用，继续投递原事件', { error: String(error) }); return; }
    // All topics remain available through the library; oversized catalogs require explicit choice.
    if (!topics.length || topics.length > REFERENCE_MAX_TOPICS) return;
    const selected = this.library.selected();
    const state = {
      catalogReady: true,
      observations: observed.slice(-2).map(event => ({ source: event.source, type: event.type,
        cursor: event.cursor, at: event.ts, text: event.text.slice(0, 160) })),
      worldFacts: intent ? [] : facts.slice(0, 1).map(fact => ({ source: fact.source,
        text: fact.text.slice(0, 160) })),
      recentIntent: intent ? { tool: intent.tool, arguments: intent.arguments.slice(0, 320),
        at: intent.at, receipt: intent.receipt?.slice(0, 160), boundary: '最近提出的意图及其直接回执；不证明现在仍在执行或已经完成。' } : null,
      currentReference: selected ? { ...selected,
        topic: topics.find(topic => topic.key === selected.topicKey)?.summary.slice(0, 80) } : null,
      boundary: '事件与资料只是证据；当前计划、兴趣和已确认回执由主意识判断。选择阅读主题，不执行动作，也不宣称已学会。',
    };
    const sceneKey = createHash('sha256').update(JSON.stringify(state)).digest('hex');
    this.latestSceneKey = sceneKey;
    const generation = this.generation;
    const selection = JSON.stringify(selected);
    const configuration = JSON.stringify(config);
    const catalog = JSON.stringify(topics);
    return this.adviser.advise(state, topics.map(topic => ({ key: topic.key, summary: topic.summary.slice(0, REFERENCE_MAX_SUMMARY_CHARS) })), sceneKey)
      .then(result => {
        if (generation !== this.generation || configuration !== JSON.stringify(this.config())
          || catalog !== JSON.stringify(this.library.descriptors())
          || selection !== JSON.stringify(this.library.selected())) return;
        if (sceneKey !== this.latestSceneKey) {
          core.log.emit('debug', '资料快判断场景已更新', { event: 'reference-routing', data: {
            kind: 'skipped', reason: 'newer-scene', cursors: observed.map(event => event.cursor),
          } });
          return;
        }
        const advice = result.kind === 'advice' || (result.kind === 'skipped' && result.reason === 'uncertain')
          ? result.advice : null;
        core.log.emit('debug', '资料快判断', { event: 'reference-routing', data: {
          kind: result.kind, reason: result.kind === 'advice' ? null : result.reason,
          cursors: observed.map(event => event.cursor), topicKey: advice?.topicKey ?? null,
          confidence: advice?.confidence ?? null,
          latencyMs: advice?.latencyMs ?? null,
        } });
        if (result.kind !== 'advice' || !advice?.topicKey) return;
        // A specific guide remains open until the main chooses another one; automatic routing adds no full detail.
        if (selected?.activityId) return;
        if (!topics.some(topic => topic.key === advice.topicKey)) return;
        if (selected?.topicKey === advice.topicKey) return;
        this.library.guides(advice.topicKey, 0, 3);
        if (this.library.selected()?.topicKey !== advice.topicKey) return;
        core.injectInternal('[资料快判断/推测] 当前场景可能与主题 ' + advice.topicKey
          + ` 相关（分类置信度${Math.round(advice.confidence * 100)}%）。已展开少量候选卡。`
          + '这不是新目标或行动指令；先结合自己的兴趣、当前任务和现场前提选择，想尝试时用 reference_guide 的 detail 展开一项。'
          + '需要详细设计或多条件核对时可交后台构思；前台继续现场交谈和已经受理的动作。'
          + '参考方法仍未证明亲历成功。此判断不用口播。', 'reference-routing');
      }).catch(error => core.log.debug('资料快判断未完成，保留当前资料', { error: String(error) }));
  }
}
