import type { EventEnvelope } from '../../../src/core/types.ts';

const reviewReasons = new Set(['death', 'flee', 'timeout', 'stuck']);

/** Only structured observations from the matching World can open this review. */
export function combatReviewEvidence(events: readonly EventEnvelope[], afterCursor: number):
  { event: EventEnvelope; receipt: Record<string, unknown> } | undefined {
  return events.flatMap((event) => {
    if (event.origin !== 'external' || event.contextDelivery === 'archive-only' || event.cursor <= afterCursor
      || !((event.source === 'minecraft' && event.type === 'minecraft.combat')
        || (event.source === 'mymc' && event.type === 'mymc.combat'))) return [];
    const receipt = event.meta?.receipt;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return [];
    const r = receipt as Record<string, unknown>;
    if (!Number.isSafeInteger(r.id) || Number(r.id) < 1 || !Number.isSafeInteger(r.tacticRevision)
      || typeof r.reason !== 'string' || !reviewReasons.has(r.reason)
      || typeof r.startedAt !== 'string' || !Number.isFinite(Date.parse(r.startedAt))
      || typeof r.endedAt !== 'string' || !Number.isFinite(Date.parse(r.endedAt))
      || !Array.isArray(r.casts)) return [];
    return [{ event, receipt: r }];
  }).at(-1);
}

export const COMBAT_REFLECTION_ADVICE =
  '这条结束原因是观察，不自动等于战败或策略错误。先保证当前身体安全，按回执编号展开完整战斗记录，'
  + '核对当时装备、敌人、命中、血量、法力、冷却、施法回音与战术版本；区分有效撤退、执行缺陷和前提错误。'
  + '你有权自主调整已有装备、战术规则和工作区方法。选择有证据支持的一项修改，读回实际配置或装备，'
  + '再用下一次适用场景的真实结果检验；保留原版本和回滚入口。新方法先标待验证，记录时间、来源、适用条件、'
  + '实际修改及对照回执，在方法索引留入口；没有再执行和结果对照就不能声称已经改善。';
