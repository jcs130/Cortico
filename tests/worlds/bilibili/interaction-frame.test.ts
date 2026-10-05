import { describe, expect, it } from 'vitest';
import { interactionFrameData } from '../../../src/worlds/bilibili/interaction-frame.ts';

function varint(value: bigint | number): Buffer {
  let remaining = BigInt(value);
  const bytes: number[] = [];
  do {
    const low = Number(remaining & 127n);
    remaining >>= 7n;
    bytes.push(low | (remaining > 0n ? 128 : 0));
  } while (remaining > 0n);
  return Buffer.from(bytes);
}

function integer(field: number, value: bigint | number): Buffer {
  return Buffer.concat([varint(field << 3), varint(value)]);
}

function bytes(field: number, value: string | Buffer): Buffer {
  const body = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([varint((field << 3) | 2), varint(body.length), body]);
}

function interactionPb(fields: { uid?: number | bigint; uname?: string; type?: number; timestamp?: number; avatar?: string }): string {
  const chunks: Buffer[] = [];
  if (fields.uid !== undefined) chunks.push(integer(1, fields.uid));
  if (fields.uname !== undefined) chunks.push(bytes(2, fields.uname));
  if (fields.type !== undefined) chunks.push(integer(5, fields.type));
  if (fields.timestamp !== undefined) chunks.push(integer(7, fields.timestamp));
  if (fields.avatar) {
    const base = bytes(2, fields.avatar);
    const user = bytes(2, base);
    chunks.push(bytes(22, user));
  }
  return Buffer.concat(chunks).toString('base64');
}

describe('交互原帧', () => {
  it.each([1, 2, 3] as const)('V1/V2 对类型 %s 的身份、昵称、头像、时间产生一致读数', (type) => {
    const common = { uid: 42, uname: '访客甲', timestamp: 1234567890 };
    const v1 = interactionFrameData('INTERACT_WORD', {
      ...common, msg_type: type, uinfo: { base: { face: '//i.example/avatar.jpg' } },
    });
    const v2 = interactionFrameData('INTERACT_WORD_V2', {
      pb: interactionPb({ ...common, type, avatar: '//i.example/avatar.jpg' }),
    });
    expect(v2).toEqual(v1);
    expect(v2).toEqual({ uid: common.uid, uname: common.uname, timestampSec: common.timestamp, messageType: type, avatarUrl: 'https://i.example/avatar.jpg' });
  });

  it('匿名和越界 uid 不生成稳定身份；同名不能补 uid', () => {
    for (const uid of [0, 9007199254740992n]) {
      expect(interactionFrameData('INTERACT_WORD_V2', { pb: interactionPb({ uid, uname: '访客甲', type: 1 }) }))
        .toMatchObject({ uid: 0, uname: '访客甲', messageType: 1 });
    }
    expect(interactionFrameData('INTERACT_WORD', { uid: '42', uname: '访客甲', msg_type: 1 }))
      .toMatchObject({ uid: 0 });
  });

  it('缺失与新增交互类型不猜成进场，JSON 附带字段不覆盖 protobuf', () => {
    for (const type of [undefined, 0, 4, 6, 99]) {
      expect(interactionFrameData('INTERACT_WORD_V2', { pb: interactionPb({ type, uid: 42 }), msg_type: 1 }))
        .toBeNull();
    }
    expect(interactionFrameData('INTERACT_WORD', { uid: 42, msg_type: '1' })).toBeNull();
  });

  it('有效但未支持的交互类型中性忽略，只有类型缺失或损坏才告警', () => {
    const warnings: string[] = [];
    const warn = (message: string): void => { warnings.push(message); };
    for (const type of [0, 4, 5, 6, 99]) {
      expect(interactionFrameData('INTERACT_WORD', { uid: 42, msg_type: type }, warn)).toBeNull();
      expect(interactionFrameData('INTERACT_WORD_V2', { pb: interactionPb({ uid: 42, type }) }, warn)).toBeNull();
    }
    expect(warnings).toEqual([]);
    expect(interactionFrameData('INTERACT_WORD', { uid: 42 }, warn)).toBeNull();
    expect(interactionFrameData('INTERACT_WORD_V2', { pb: interactionPb({ uid: 42 }) }, warn)).toBeNull();
    expect(interactionFrameData('INTERACT_WORD_V2', {}, warn)).toBeNull();
    expect(warnings).toHaveLength(3);
  });

  it('截断 protobuf、缺失字节、不合法名字不污染身份', () => {
    expect(interactionFrameData('INTERACT_WORD_V2', {})).toBeNull();
    expect(interactionFrameData('INTERACT_WORD_V2', { pb: Buffer.from([18, 8, 1]).toString('base64') })).toBeNull();
    const raw = Buffer.concat([integer(1, 42), bytes(2, Buffer.from([255])), integer(5, 1)]);
    expect(interactionFrameData('INTERACT_WORD_V2', { pb: raw.toString('base64') }))
      .toMatchObject({ uid: 42, uname: '' });
  });

  it('遵守 protobuf 单值字段的最后一次读数；未知字段保持独立', () => {
    const raw = Buffer.concat([
      integer(1, 42), bytes(2, '访客甲'), integer(5, 1), integer(6, 3), integer(1, 0), integer(5, 3),
    ]);
    expect(interactionFrameData('INTERACT_WORD_V2', { pb: raw.toString('base64') }))
      .toMatchObject({ uid: 0, uname: '访客甲', messageType: 3 });
  });
});
