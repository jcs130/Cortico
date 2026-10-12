/** Actor identity and conversation scope from World chat metadata. Event text is never an identity key. */
import type { EventEnvelope } from 'cortico/core/types.ts';

export interface SocialMessageIdentity {
  senderKey: string;
  uname: string;
  body: string;
  conversation?: string;
}

export function isSocialChatType(source: string, type: string): boolean {
  return [`${source}.danmaku`, `${source}.chat`, `${source}.superchat`].includes(type) || type === 'qq.message';
}

export function isSocialConversation(value: unknown): value is string {
  return typeof value === 'string' && /^(private|group):[1-9]\d{0,14}$/.test(value);
}

export function socialMessageIdentity(event: EventEnvelope): SocialMessageIdentity | null {
  if (!event.senderKey || !isSocialChatType(event.source, event.type)) return null;
  const body = typeof event.meta?.body === 'string' ? event.meta.body : event.text;
  if (event.type !== 'qq.message') return { senderKey: event.senderKey.trim(), body,
    uname: typeof event.meta?.uname === 'string' ? event.meta.uname.trim() : '' };

  const rawUser = event.meta?.user;
  if (event.meta?.channel !== 'qq' || typeof rawUser !== 'number' && typeof rawUser !== 'string'
    || !/^[1-9]\d{0,14}$/.test(String(rawUser)) || !Number.isSafeInteger(Number(rawUser))) return null;
  const senderKey = String(rawUser), conversation = event.meta?.conv;
  if (!isSocialConversation(conversation) || ![senderKey, conversation].includes(event.senderKey)
    || conversation.startsWith('private:') && conversation !== `private:${senderKey}`) return null;
  const label = typeof event.meta?.uname === 'string' ? event.meta.uname : event.meta?.sender;
  return { senderKey, conversation, body, uname: typeof label === 'string' && label.trim() ? label.trim() : senderKey };
}
