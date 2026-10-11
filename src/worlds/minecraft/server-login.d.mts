import type { EventEmitter } from 'node:events';
export function readProtectedCredential(file: string): Promise<Buffer>;
export function installServerLogin(bot: EventEmitter & { chat(text: string): void }, options: {
  server: string; username: string; configFile?: string;
  readCredential?(file: string): Promise<Buffer>;
  report?(status: { status: string; username: string; server: string }): void;
}): { stop(): void; status(): { stage: string; attempted: boolean } };
