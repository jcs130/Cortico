/** AgentFriend's private duration reply bounds the most recent local flight request. */
import type { Bot } from 'mineflayer';
import { setFlightExpiry } from './flight.ts';
import { observeViewerCastCommands, viewerCastCommand, viewerCastResult } from './viewer-cast.ts';

export function watchAgentFriendFlight(bot: Bot): () => void {
  let sentAt: number | null = null;
  const reset = (): void => { sentAt = null; };
  const detachCommands = observeViewerCastCommands(bot, text => {
    sentAt = viewerCastCommand(text)?.id === 'flight' ? Date.now() : null;
  });
  const message = (value: { toString(): string }, position: string): void => {
    if (position !== 'system' || sentAt === null) return;
    const elapsed = Date.now() - sentAt;
    if (elapsed < 0 || elapsed > 3_000) { reset(); return; }
    const text = value.toString().trim();
    const result = viewerCastResult(text, 'flight');
    if (result?.phase === 'failed') { reset(); return; }
    const duration = /^[✦\s]*飞行术持续\s*(\d+(?:\.\d+)?)\s*秒[；;]/u.exec(text);
    if (!duration || result?.phase !== 'succeeded') return;
    const expiresAt = sentAt + Number(duration[1]) * 1_000;
    reset();
    // Sending precedes server execution; this deadline never adds reply latency to the grant.
    if (Number.isSafeInteger(expiresAt)) setFlightExpiry(bot, expiresAt);
  };
  const dispose = (): void => {
    reset(); detachCommands();
    bot.off('message', message); bot.off('respawn', reset); bot.off('death', reset); bot.off('end', dispose);
  };
  bot.on('message', message); bot.on('respawn', reset); bot.on('death', reset); bot.on('end', dispose);
  return dispose;
}
