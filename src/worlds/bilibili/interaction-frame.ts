/** INTERACT_WORD 的 JSON 与 V2 protobuf 归一化。字段布局依据 blivedm/models/pb.py，未知交互类型不推断语义。 */
import { pbFromBase64, pbInt, pbSub, pbText } from './protobuf.ts';

export interface InteractionFrame {
  messageType: 1 | 2 | 3;
  uid: number;
  uname: string;
  avatarUrl: string;
  timestampSec?: number;
}

type InteractionFrameWarn = (message: string, data?: Record<string, unknown>) => void;

/** V2 顶层 1=uid、2=uname、5=msg_type、7=秒时间戳；22.2.2=头像。 */
export function interactionFrameData(
  cmd: 'INTERACT_WORD' | 'INTERACT_WORD_V2',
  data: Record<string, unknown>,
  warn?: InteractionFrameWarn,
): InteractionFrame | null {
  let messageType: unknown;
  let uid: unknown;
  let uname: unknown;
  let timestamp: unknown;
  let face: unknown;
  if (cmd === 'INTERACT_WORD_V2') {
    const fields = pbFromBase64(data.pb);
    if (!fields) {
      warn?.('INTERACT_WORD_V2 无有效 protobuf', { cmd });
      return null;
    }
    messageType = pbInt(fields, 5);
    uid = pbInt(fields, 1);
    uname = pbText(fields, 2);
    timestamp = pbInt(fields, 7);
    face = pbText(pbSub(pbSub(fields, 22), 2), 2);
  } else {
    messageType = data.msg_type;
    uid = data.uid;
    uname = data.uname;
    timestamp = data.timestamp;
    face = object(object(data.uinfo).base).face;
  }
  if (messageType !== 1 && messageType !== 2 && messageType !== 3) {
    if (!safeInteger(messageType) || messageType < 0) {
      warn?.('直播间交互缺少有效类型，未生成进场事件', { cmd, messageType });
    }
    return null;
  }
  const numericUid = safeInteger(uid) && uid > 0 ? uid : 0;
  const numericTimestamp = safeInteger(timestamp) && timestamp > 0 ? timestamp : undefined;
  const avatar = typeof face === 'string' ? face : '';
  return {
    messageType,
    uid: numericUid,
    uname: typeof uname === 'string' ? uname.trim() : '',
    avatarUrl: avatar.startsWith('//') ? `https:${avatar}` : /^https?:\/\//i.test(avatar) ? avatar : '',
    ...(numericTimestamp === undefined ? {} : { timestampSec: numericTimestamp }),
  };
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
