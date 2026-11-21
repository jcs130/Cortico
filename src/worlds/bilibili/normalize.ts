/** 将原始 cmd 转换为事件、累加计数或最新读数；不处理的命令返回 null。计数与读数由 World 聚合后随批次投递。 */
import type { TriggerMode } from '../../core/types.ts';
import { giftFrameData } from './gift-frame.ts';
import { pbFromBase64, pbInt, pbText } from './protobuf.ts';

export interface LiveEvent {
  kind: 'event';

  type: string;
  trigger: TriggerMode;
  text: string;
  senderKey?: string;
  meta?: Record<string, unknown>;
  coalesce?: LiveEventCoalescing;
}

type LiveEventCoalescing =
  | { kind: 'danmaku'; key: string; body: string }
  /** yuan 为 null 时金额未知，合并正文省略金额。 */
  | { kind: 'gift'; key: string; gift: string; num: number; yuan: number | null };

/** 期间累加的次数 */
export type CountField = 'enter' | 'like' | 'freeGift';
/** 当前值,只留最新 */
export type GaugeField = 'watched' | 'online' | 'popularity' | 'fans' | 'likeTotal';

interface LiveCount {
  kind: 'count';
  field: CountField;
  by: number;
}

interface LiveGauge {
  kind: 'gauge';
  field: GaugeField;
  value: number;
}

export type Normalized = LiveEvent | LiveCount | LiveGauge;

/** 开播和下播共用同一元数据契约。 */
export function liveRoomStateMeta(living: boolean, via: 'websocket' | 'poll') {
  return { liveRoomState: { schemaVersion: 1 as const, living, via } };
}

/** 1 元 = 1000 金瓜子 */
const COIN_PER_YUAN = 1000;

const IGNORED = new Set([
  'COMBO_SEND',
  'COMBO_END',
  'NOTICE_MSG',
  'SYS_MSG',
  'WIDGET_BANNER',
  'RECOMMEND_CARD',
  'GOTO_BUY_FLOW',
  'STOP_LIVE_ROOM_LIST',
  'HOT_ROOM_NOTIFY',
  'POPULAR_RANK_CHANGED',
  'ONLINE_RANK_V3',
  'ONLINE_RANK_TOP3',
  'UNIVERSAL_ASR_TEXT',
  'DM_INTERACTION',
  'LOG_IN_NOTICE',
  'ENTRY_EFFECT_MUST_RECEIVE',
]);

export interface NormalizeOptions {
  /** 礼物提到 flush 的门槛(元) */
  giftFlushYuan: number;
  /** 解析或金额换算告警，由调用方记录日志。 */
  warn?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * GUARD_BUY 金额的合理区间（元）。data.price 的单位尚未实证，换算结果超出区间时省略金额；单位需以真实原帧和平台逐笔金额核对。
 */
const GUARD_YUAN_MIN = 1;
const GUARD_YUAN_MAX = 30000;

export function normalize(msg: Record<string, unknown>, opts: NormalizeOptions): Normalized | null {

  const cmd = String(msg.cmd ?? '').split(':')[0];
  if (IGNORED.has(cmd)) return null;
  const data = obj(msg.data);

  switch (cmd) {
    case 'DANMU_MSG':
    case 'DANMU_MSG_MIRROR':
      return danmaku(msg);

    case 'SUPER_CHAT_MESSAGE': {
      const user = obj(data.user_info);
      const uid = audienceUid(data);
      const uname = str(user.uname) || '某位观众';
      const yuan = num(data.price);
      return {
        kind: 'event',
        type: 'bilibili.superchat',
        trigger: 'flush',
        text: `[醒目留言 ¥${yuan}|${uname}] ${str(data.message)}`,
        senderKey: senderKeyOf(uid),
        meta: {
          uid,
          uname,
          yuan,
          messageId: data.id,
          avatarUrl: imageUrl(user.face),
          guardLevel: num(user.guard_level),
          isAdmin: bool(user.manager),
        },
      };
    }

    case 'SUPER_CHAT_MESSAGE_DELETE':
      return {
        kind: 'event',
        type: 'bilibili.superchat-del',
        trigger: 'piggyback',
        text: '[醒目留言被删除]',
        meta: { ids: data.ids },
      };

    case 'GUARD_BUY': {
      const uid = audienceUid(data);
      const uname = str(data.username) || '某位观众';
      const gift = str(data.gift_name) || '大航海';
      const n = num(data.num) || 1;

      const price = num(data.price);
      const yuan = price / COIN_PER_YUAN;
      const yuanKnown = price > 0 && yuan >= GUARD_YUAN_MIN && yuan <= GUARD_YUAN_MAX;
      if (price > 0 && !yuanKnown) {
        opts.warn?.('GUARD_BUY price 换算越界,金额不入账', { price, yuan });
      }
      const guardLevel = num(data.guard_level);
      return {
        kind: 'event',
        type: 'bilibili.guard',
        trigger: 'flush',
        text: yuanKnown
          ? `[上舰 ¥${trim(yuan)}|${uname}] 开通了 ${gift}×${n}`
          : `[上舰|${uname}] 开通了 ${gift}×${n}`,
        senderKey: senderKeyOf(uid),
        meta: {
          uid,
          uname,
          gift,
          num: n,
          ...(yuanKnown ? { yuan } : {}),
          ...(guardLevel > 0 ? { guardLevel } : {}),
        },
      };
    }

    // 仅在帧明确表示续费时使用续费文案；缺失角色或等级时省略对应元数据。
    case 'USER_TOAST_MSG': {
      const sender = obj(data.sender_uinfo);
      const base = obj(sender.base);
      const uid = audienceUid(data);
      const uname = str(data.username) || str(base.name) || '某位观众';
      const role = str(data.role_name);
      const guardLevel = num(data.guard_level) || num(sender.guard_level);
      const renew = str(data.toast_msg).includes('续费');
      return guardToast({ uid, uname, role, guardLevel, renew, face: base.face });
    }

    case 'USER_TOAST_MSG_V2': {

      const sender = obj(data.sender_uinfo);
      const base = obj(sender.base);
      const guard = obj(data.guard_info);
      const uid = audienceUid(data);
      const uname = str(base.name) || '某位观众';
      const role = str(guard.role_name);
      const guardLevel = num(guard.guard_level);
      const renew = str(data.toast_msg).includes('续费');
      return guardToast({ uid, uname, role, guardLevel, renew, face: base.face });
    }

    case 'SEND_GIFT':
    case 'SEND_GIFT_V2': {

      const frame = giftFrameData(data, opts.warn);
      const sender = obj(frame.sender_uinfo);
      const base = obj(sender.base);
      const uid = audienceUid(frame);
      const uname = str(frame.uname) || str(base.name) || '某位观众';
      const gift = str(frame.giftName) || str(frame.gift_name) || '礼物';
      const n = num(frame.num) || 1;
      const coinType = str(frame.coin_type);

      if (coinType && coinType !== 'gold') return { kind: 'count', field: 'freeGift', by: n };
      const totalCoin = num(frame.total_coin);

      const yuanKnown = coinType === 'gold' && totalCoin > 0;
      const yuan = totalCoin / COIN_PER_YUAN;
      if (!yuanKnown) {
        opts.warn?.('礼物帧读不出金额,按未知金额成事件', { cmd, gift, uname, coinType });
      }
      const guardLevel = num(frame.guard_level);
      const tid = str(frame.tid);
      return {
        kind: 'event',
        type: 'bilibili.gift',

        trigger: yuanKnown && yuan >= opts.giftFlushYuan ? 'flush' : 'debounce',
        text: yuanKnown
          ? `[礼物 ¥${trim(yuan)}|${uname}] ${gift}×${n}`
          : `[礼物|${uname}] ${gift}×${n}`,
        senderKey: senderKeyOf(uid),
        meta: {
          uid,
          uname,
          gift,
          num: n,
          ...(yuanKnown ? { yuan } : {}),
          avatarUrl: imageUrl(base.face),
          guardLevel,
          isAdmin: bool(frame.is_admin),
          ...(tid ? { tid } : {}),
        },
        coalesce: {
          kind: 'gift',
          // 未知金额与已知金额分别归并。
          key: JSON.stringify([gift, yuanKnown ? unitCoinKey(totalCoin, n) : '金额未知']),
          gift,
          num: n,
          yuan: yuanKnown ? yuan : null,
        },
      };
    }

    case 'ENTRY_EFFECT': {
      // 进场特效的 copy_writing 形如 "欢迎舰长 <%昵称%> 进入直播间"
      const line = str(data.copy_writing).replace(/<%|%>/g, '').trim();
      if (!line) return null;
      const uid = audienceUid(data);
      const triggerTime = num(data.trigger_time);
      return {
        kind: 'event',
        type: 'bilibili.enter-guard',
        trigger: 'debounce',
        text: `[进场] ${line}`,
        senderKey: senderKeyOf(uid),
        meta: {
          uid,
          sourceCommand: cmd,
          ...(triggerTime > 0 ? { sourceTriggerTime: triggerTime } : {}),
          ...(bool(data.mock_effect) ? { mockEffect: true } : {}),
        },
      };
    }

    case 'INTERACT_WORD':
    case 'INTERACT_WORD_V2':
      return interaction(cmd, data, opts);

    case 'LIKE_INFO_V3_CLICK':
      return { kind: 'count', field: 'like', by: 1 };

    case 'LIKE_INFO_V3_UPDATE':
      return { kind: 'gauge', field: 'likeTotal', value: num(data.click_count) };

    case 'WATCHED_CHANGE':
      return { kind: 'gauge', field: 'watched', value: num(data.num) };

    case 'ONLINE_RANK_COUNT':
      return { kind: 'gauge', field: 'online', value: num(data.count) };

    case 'POPULARITY_CHANGE':
      return { kind: 'gauge', field: 'popularity', value: num(data.popularity) };

    case 'ROOM_REAL_TIME_MESSAGE_UPDATE':
      return { kind: 'gauge', field: 'fans', value: num(data.fans) };

    case 'LIVE':
      return {
        kind: 'event',
        type: 'bilibili.room',
        trigger: 'flush',
        text: '[直播间] 平台已推送开播指令:直播画面已对观众可见',
        meta: liveRoomStateMeta(true, 'websocket'),
      };

    case 'PREPARING':
      return {
        kind: 'event',
        type: 'bilibili.room',
        trigger: 'flush',
        text: '[直播间] 平台已推送下播指令:直播已结束,观众已经看不到直播画面;'
          + '此后的弹幕来自仍留在房间页的人,不代表直播还在进行',
        meta: liveRoomStateMeta(false, 'websocket'),
      };

    case 'ROOM_CHANGE': {
      const title = typeof data.title === 'string' ? data.title : undefined;
      const area = typeof data.area_name === 'string' ? data.area_name : undefined;
      const areaId = positiveInteger(data.area_id);
      const parentArea = typeof data.parent_area_name === 'string' ? data.parent_area_name : undefined;
      const parentAreaId = positiveInteger(data.parent_area_id);
      const details = [
        title === undefined ? undefined : `标题「${title}」`,
        area === undefined ? undefined : `分区「${area}」`,
      ].filter(Boolean);
      return {
        kind: 'event',
        type: 'bilibili.room',
        trigger: 'debounce',
        text: details.length ? `[直播间] 房间资料更新，${details.join('，')}` : '[直播间] 平台报告房间资料有更新',
        meta: {
          sourceCommand: cmd,
          ...(title !== undefined ? { title } : {}),
          ...(area !== undefined ? { area } : {}),
          ...(areaId !== undefined ? { areaId } : {}),
          ...(parentArea !== undefined ? { parentArea } : {}),
          ...(parentAreaId !== undefined ? { parentAreaId } : {}),
        },
      };
    }

    case 'ROOM_SILENT_ON': {
      const mode = data.type === 'level' || data.type === 'medal' || data.type === 'member' ? data.type : undefined;
      const level = mode === 'level' || mode === 'medal' ? positiveInteger(data.level) : undefined;
      const rule = mode === 'level' ? '按用户等级限制弹幕'
        : mode === 'medal' ? '按粉丝勋章等级限制弹幕'
          : mode === 'member' ? '已开启全员禁言' : '已开启弹幕限制，平台未提供可识别的规则';
      return {
        kind: 'event', type: 'bilibili.room', trigger: 'flush',
        text: `[直播间] ${rule}${level === undefined ? '' : `，要求等级 ${level}`}`,
        meta: { sourceCommand: cmd, roomChatRestriction: {
          enabled: true, ...(mode === undefined ? {} : { mode }), ...(level === undefined ? {} : { level }),
        } },
      };
    }

    case 'ROOM_SILENT_OFF':
      return {
        kind: 'event', type: 'bilibili.room', trigger: 'flush', text: '[直播间] 已解除房间弹幕限制',
        meta: { sourceCommand: cmd, roomChatRestriction: { enabled: false } },
      };

    case 'ROOM_BLOCK_MSG': {
      const uname = str(data.uname) || str(msg.uname) || '某位观众';
      const nestedUid = blockTargetUid(data.uid);
      const envelopeUid = blockTargetUid(msg.uid);
      const conflict = nestedUid !== undefined && envelopeUid !== undefined && nestedUid !== envelopeUid;
      const targetUid = conflict ? undefined : nestedUid ?? envelopeUid;
      return {
        kind: 'event',
        type: 'bilibili.block',
        trigger: 'debounce',
        text: `[房管] ${uname} 被禁言`,
        meta: { sourceCommand: cmd, uname, ...(targetUid === undefined ? {} : { targetUid }) },
      };
    }

    case 'WARNING':
      return {
        kind: 'event',
        type: 'bilibili.warning',
        trigger: 'flush',
        text: `[平台警告] ${str(msg.msg) || '直播间收到一条超管警告'}`,
        meta: { sourceCommand: cmd },
      };

    case 'CUT_OFF':
      return {
        kind: 'event',
        type: 'bilibili.warning',
        trigger: 'flush',
        text: `[直播被切断] ${str(msg.msg) || '直播已被平台切断'}`,
        meta: { sourceCommand: cmd },
      };

    default:
      return null;
  }
}

/** 弹幕字段：正文 info[1]，发言人 info[2][0..1]，粉丝牌 info[3]，大航海等级 info[7]。uid 为 0 时不提供稳定身份键。 */
function danmaku(msg: Record<string, unknown>): LiveEvent | null {
  const info = Array.isArray(msg.info) ? (msg.info as unknown[]) : null;
  if (!info) return null;
  const text = str(info[1]).trim();
  if (!text) return null;
  const sender = Array.isArray(info[2]) ? (info[2] as unknown[]) : [];
  const uid = num(sender[0]);
  const uname = str(sender[1]) || '某位观众';
  const medal = Array.isArray(info[3]) ? (info[3] as unknown[]) : [];
  const userLevel = Array.isArray(info[4]) ? (info[4] as unknown[]) : [];
  const rich = obj(Array.isArray(info[0]) ? (info[0] as unknown[])[15] : undefined);
  const richUser = obj(rich.user);
  const richBase = obj(richUser.base);
  const guardLevel = num(info[7]);
  const badge = guardLevel > 0 ? '·舰长' : '';
  return {
    kind: 'event',
    type: 'bilibili.danmaku',
    trigger: 'debounce',
    text: `[弹幕|${uname}${badge}] ${text}`,
    senderKey: senderKeyOf(uid),
    meta: {
      uid,
      uname,
      guardLevel,
      isAdmin: bool(sender[2]),
      vip: bool(sender[3]),
      svip: bool(sender[4]),
      rank: num(sender[5]),
      nameColor: str(sender[7]),
      userLevel: num(userLevel[0]),
      avatarUrl: imageUrl(richBase.face),
      medal: medal.length
        ? {
            level: num(medal[0]),
            name: str(medal[1]),
            anchorName: str(medal[2]),
            roomId: num(medal[3]),
            color: num(medal[4]),
          }
        : null,
      body: text,
    },
    coalesce: { kind: 'danmaku', key: text, body: text },
  };
}

function guardToast(fields: {
  uid: number;
  uname: string;
  role: string;
  guardLevel: number;
  renew: boolean;
  face: unknown;
}): LiveEvent {
  const { uid, uname, role, guardLevel, renew } = fields;
  const roleText = role || '大航海';
  return {
    kind: 'event',
    type: 'bilibili.guard-renew',
    trigger: 'debounce',
    text: renew ? `[续费|${uname}] 续费了 ${roleText}` : `[上舰|${uname}] 上了 ${roleText}`,
    senderKey: senderKeyOf(uid),
    meta: {
      uid,
      uname,
      ...(role ? { role } : {}),
      ...(guardLevel > 0 ? { guardLevel } : {}),
      ...(renew ? { renew: true } : {}),
      avatarUrl: imageUrl(fields.face),
    },
  };
}

function senderKeyOf(uid: number): string | undefined {
  return uid > 0 ? String(uid) : undefined;
}

/** 付费事件的 uid 在不同 cmd 版本中所处层级不同。 */
function audienceUid(data: Record<string, unknown>): number {
  const values = [
    num(data.uid),
    num(obj(data.user_info).uid),
    num(obj(data.sender_uinfo).uid),
  ];
  return values.find((value) => value > 0) ?? 0;
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** ROOM_BLOCK_MSG 的 uid 有十进制字符串与数字两种平台形状。 */
function blockTargetUid(value: unknown): number | undefined {
  return positiveInteger(typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value);
}

/** V2 field mapping: xfgryujk/blivedm, models/pb.py InteractWordV2 (not an official schema). */
function interaction(cmd: string, data: Record<string, unknown>, opts: NormalizeOptions): Normalized | null {
  const fields = cmd === 'INTERACT_WORD_V2' ? pbFromBase64(data.pb) : null;
  if (cmd === 'INTERACT_WORD_V2' && !fields) {
    opts.warn?.('INTERACT_WORD_V2 无法解析，不计作进场');
    return null;
  }
  const uid = fields ? pbInt(fields, 1) ?? 0 : audienceUid(data);
  const uname = fields ? pbText(fields, 2) : str(data.uname);
  const msgType = fields ? pbInt(fields, 5) : num(data.msg_type);
  const timestamp = fields ? pbInt(fields, 7) : num(data.timestamp);
  const triggerTime = !fields && msgType === 1 ? num(data.trigger_time) : 0;
  if (msgType !== 1 && msgType !== 2 && msgType !== 3) return null;
  if (msgType === 1 && !uname && !senderKeyOf(uid)) return { kind: 'count', field: 'enter', by: 1 };
  const label = msgType === 1 ? '进场' : msgType === 2 ? '关注' : '分享';
  const action = msgType === 1 ? '进入了直播间' : msgType === 2 ? '关注了主播' : '分享了直播间';
  return { kind: 'event', type: msgType === 1 ? 'bilibili.enter' : 'bilibili.interaction', trigger: 'debounce',
    text: `[${label}|${uname || '某位观众'}] ${action}`, senderKey: senderKeyOf(uid),
    meta: { uid, uname, msgType, socialScope: 'live-room', sourceCommand: cmd,
      ...(triggerTime > 0 ? { sourceTriggerTime: triggerTime } : {}),
      ...(timestamp ? { sourceTimestamp: timestamp } : {}) } };
}

function bool(v: unknown): boolean {
  return v === true || v === 1;
}

function imageUrl(v: unknown): string {
  const raw = str(v);
  if (raw.startsWith('//')) return `https:${raw}`;
  return /^https?:\/\//i.test(raw) ? raw : '';
}

function unitCoinKey(totalCoin: number, count: number): string {
  let a = Math.abs(Math.round(totalCoin));
  let b = Math.abs(Math.round(count));
  const numerator = Math.round(totalCoin);
  const denominator = Math.round(count);
  while (b !== 0) [a, b] = [b, a % b];
  const divisor = a || 1;
  return `${numerator / divisor}/${denominator / divisor}`;
}

function trim(yuan: number): string {
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
}
