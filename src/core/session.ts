/** Session context is append-only between lifecycle resets. */
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createConversationId, validConversationId } from './conversation-id.ts';
import type { ContextRecord } from '../protocol/open-responses/context.ts';
import { ContextLog, type ContextLoadRepair } from '../protocol/open-responses/context-log.ts';
import { estimateMessagesTokens } from './util.ts';


export class SessionLog {
  private readonly context: ContextLog;
  private readonly identityFile: string;
  private identity: string | null = null;
  get records(): readonly ContextRecord[] { return this.context.records; }
  private appendListeners: Array<(msg: ContextRecord, index: number) => void> = [];
  private resetListeners: Array<(messages: ContextRecord[]) => void> = [];

  /** stamp:入库时刻的来源(config 时区的 ISO);不给则消息不带 ts */
  constructor(
    dataDir: string,
    fileName = 'session-main.jsonl',
    stamp?: () => string,
    private readonly agentId?: string,
  ) {
    this.context = new ContextLog(join(dataDir, fileName), stamp);
    this.identityFile = join(dataDir, `${fileName}.metadata.json`);
  }

  /** Stored beside the context; prefix reloads, handoffs and process restarts retain it. */
  get conversationId(): string {
    if (this.identity) return this.identity;
    try {
      const saved = JSON.parse(readFileSync(this.identityFile, 'utf8'));
      if (saved?.version !== 1 || !validConversationId(saved.session_id)) throw new Error('Invalid session identity metadata');
      return this.identity = saved.session_id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return this.saveIdentity(createConversationId(this.agentId));
  }

  private saveIdentity(id: string): string {
    mkdirSync(dirname(this.identityFile), { recursive: true });
    const tmp = `${this.identityFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, session_id: id }) + '\n', 'utf8');
    renameSync(tmp, this.identityFile);
    return this.identity = id;
  }

  /** Explicitly starting a new context also starts a new gateway session. */
  startConversation(messages: readonly ContextRecord[]): void {
    this.reset(messages);
    this.saveIdentity(createConversationId(this.agentId));
  }

  /** 每次 append 后通知 Web 调试监听器;监听器异常与会话写入隔离。 */
  onAppend(cb: (msg: ContextRecord, index: number) => void): void {
    this.appendListeners.push(cb);
  }

  /** 截断/重置后回调(整个数组被替换) */
  onReset(cb: (messages: ContextRecord[]) => void): void {
    this.resetListeners.push(cb);
  }

  append(msg: ContextRecord): void {
    this.context.append(msg);
    const stored = this.records[this.records.length - 1];
    for (const cb of this.appendListeners) {
      try { cb(stored, this.records.length - 1); } catch { /* 观察者异常不影响主流程 */ }
    }
  }

  /** 返回对未写完末行的修复；其他损坏行抛错。 */
  load(): ContextLoadRepair | null { return this.context.load(); }

  /** 整体替换：先写临时文件，再 rename 覆盖目标文件。 */
  reset(messages: readonly ContextRecord[]): void {
    this.context.reset(messages);
    for (const cb of this.resetListeners) {
      try { cb([...this.records]); } catch { /* 观察者异常不影响主流程 */ }
    }
  }

  estTokens(): number {
    return estimateMessagesTokens(this.records);
  }


}
