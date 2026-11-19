import { join } from 'node:path';
import { describeTools, type WorldDefinition } from '../../world.ts';
import { type BilibiliConfigSection, BILIBILI_DEFAULTS } from './config.ts';
import { BilibiliWorld, bilibiliToolDecls } from './world.ts';

export const BILIBILI: WorldDefinition<BilibiliConfigSection> = {
  id: 'bilibili',
  label: 'B 站直播间',
  defaults: () => structuredClone(BILIBILI_DEFAULTS),
  create: (ctx) => {
    const { cfg } = ctx;
    return new BilibiliWorld({
      roomId: cfg.roomId,
      sessdata: cfg.sessdata,
      onSessdata: (sessdata) => ctx.persist({ sessdata }),
      giftFlushYuan: () => cfg.giftFlushYuan,
      coalesceWindowMs: () => cfg.coalesceWindowMs,
      coalesceMaxItems: () => cfg.coalesceMaxItems,
      audienceOnlineRankOn: () => cfg.audienceOnlineRankOn,
      audienceOnlineRankOff: () => cfg.audienceOnlineRankOff,
      audienceReleaseHoldSec: () => cfg.audienceReleaseHoldSec,
      audienceSignalFreshSec: () => cfg.audienceSignalFreshSec,
      audienceActiveStaleHoldSec: () => cfg.audienceActiveStaleHoldSec,
      audienceEventLineBudget: () => cfg.audienceEventLineBudget,
      audienceEventTokenBudget: () => cfg.audienceEventTokenBudget,
      audienceImportantShare: () => cfg.audienceImportantShare,
      audienceLedgerFile: join(ctx.dataDir, 'bilibili-audience', 'ledger.json'),
      overlay: cfg.overlay,
      agentNoticeMaxChars: () => cfg.overlay.agentNoticeMaxChars,
      agentNoticeFile: join(ctx.dataDir, 'bilibili-overlay', 'agent-notice.json'),
      maxQueuedVideos: () => cfg.overlay.maxQueuedVideos,
      videoQueueFile: join(ctx.dataDir, 'bilibili-overlay', 'video-queue.json'),
      overlayAssetDir: join(ctx.dataDir, 'bilibili-overlay', 'assets'),
      onOverlayConfig: (overlay) => ctx.persist({ overlay: { design: overlay.design } }),
      timezone: ctx.timezone,
    });
  },
  describe: {
    tools: describeTools(bilibiliToolDecls(
      BILIBILI_DEFAULTS.overlay.agentNoticeMaxChars,
      BILIBILI_DEFAULTS.overlay.maxQueuedVideos,
    ), {
      bilibili_set_announcement: {
        zh: '改写直播画面叠加层上的公告板文字。',
        en: 'Rewrites the announcement board text on the stream overlay.',
      },
      bilibili_update_video_queue: {
        zh: '改写直播画面上的视频排队列表:加入、移除、调整顺序或清空。',
        en: 'Edits the video queue list on the stream overlay: add, remove, reorder or clear.',
      },
    }),
    events: [
      {
        type: 'bilibili.danmaku',
        description: { zh: '观众发的弹幕;短时间内的相同弹幕合成一条。', en: 'A viewer chat message; identical messages within a short window are merged.' },
        trigger: 'debounce',
      },
      {
        type: 'bilibili.superchat',
        description: { zh: '醒目留言(付费留言),带金额。', en: 'A Super Chat (paid message) with its amount.' },
        trigger: 'flush',
      },
      {
        type: 'bilibili.superchat-del',
        description: { zh: '一条醒目留言被删除。', en: 'A Super Chat was deleted.' },
        trigger: 'piggyback',
      },
      {
        type: 'bilibili.gift',
        description: {
          zh: '观众送了付费礼物;金额达到配置的阈值时立即投递,否则合批。',
          en: 'A viewer sent a paid gift; delivered at once when the amount reaches the configured threshold, otherwise batched.',
        },
      },
      {
        type: 'bilibili.guard',
        description: { zh: '观众开通大航海(舰长、提督、总督)的购买记录。', en: 'A viewer bought a guard membership (captain, admiral or governor).' },
        trigger: 'flush',
      },
      {
        type: 'bilibili.guard-renew',
        description: { zh: '直播间横幅里的上舰或续费通知。', en: 'The room banner announcing a new or renewed guard membership.' },
        trigger: 'debounce',
      },
      {
        type: 'bilibili.enter',
        description: { zh: '平台报告观众进场，保留可获得的昵称和账号；刷新或重连也可能触发。', en: 'A reported viewer entry with available name and identity; refreshes and reconnections may also trigger it.' },
        trigger: 'debounce',
      },
      {
        type: 'bilibili.interaction',
        description: { zh: '观众关注主播或分享直播间，保留交互类型和可获得的身份。', en: 'A viewer followed or shared the room, retaining the interaction type and available identity.' },
        trigger: 'debounce',
      },
      {
        type: 'bilibili.enter-guard',
        description: { zh: '舰长等大航海成员进入直播间。', en: 'A guard member entered the room.' },
        trigger: 'debounce',
      },
      {
        type: 'bilibili.room',
        description: {
          zh: '开播、下播、标题或分区变更、全员禁言开关。',
          en: 'The stream went live or offline, the title or category changed, or room-wide mute was switched.',
        },
      },
      {
        type: 'bilibili.block',
        description: { zh: '房管禁言了一位观众。', en: 'A moderator muted a viewer.' },
        trigger: 'debounce',
      },
      {
        type: 'bilibili.warning',
        description: { zh: '平台超管警告,或直播被平台切断。', en: 'A platform warning, or the platform cut off the stream.' },
        trigger: 'flush',
      },
      {
        type: 'bilibili.feed',
        description: { zh: '弹幕接入中断了一段时间,或中断后恢复。', en: 'The chat feed has been down for a while, or came back after an outage.' },
      },
      {
        type: 'bilibili.audience',
        description: {
          zh: '本次窗口内的进场、点赞、免费礼物计数及收到的人数读数；随下一批事件送达，发送后重新计数。',
          en: 'Entry, like and free-gift counts plus received audience gauges for this interval; counters reset after delivery.',
        },
        trigger: 'piggyback',
      },
    ],
  },
};
