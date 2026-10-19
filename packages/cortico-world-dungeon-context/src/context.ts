/** World-owned observations and immutable receipt archives. This module does not plan or own personal Memory. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolCallContext, ToolDef, ToolOutcome, World, WorldHost, WorldRequestFacts } from 'cortico/core/types.ts';

export interface DungeonContextOptions {
  dataDir: string;
  /** Deployment identity digest; credentials themselves must never be returned or stored. */
  scope(): string | null;
  now?: () => number;
}
interface Observation {
  schemaVersion: 1;
  reference: string;
  scope: string;
  observedAt: string;
  epoch: string;
  tool: string;
  args: Record<string, unknown>;
  outcome: Pick<ToolOutcome, 'text' | 'failed'>;
}
interface Ticket { generation: number; epoch: string; scope: string | null; mutates: boolean; }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const STATE_TTL_MS = 60_000;
const RECEIPT_CONTEXT_TTL_MS = 15 * 60_000;
const RECEIPT_PARTS = 10;
const READ_ACTIONS: Record<string, readonly string[]> = {
  dungeon_look: ['status', 'inventory', 'item', 'profile', 'world', 'history', 'rules'],
  dungeon_life: ['areas', 'recipes', 'shop'],
  dungeon_raid: ['list', 'detail', 'map', 'status'],
  dungeon_board: ['list', 'read'],
  dungeon_trade: ['offers'],
  dungeon_home: ['view', 'catalog', 'guestbook'],
  dungeon_photo: ['album', 'view', 'list'],
  dungeon_battle: ['status'],
};
function mutates(tool: string, args: Record<string, unknown>): boolean {
  if (tool === 'dungeon_chat') return false;
  if (tool === 'dungeon_trade' && args.action === 'give' && args.confirm !== true) return false;
  return !READ_ACTIONS[tool]?.includes(String(args.action));
}
function stateKey(tool: string, args: Record<string, unknown>): string | null {
  if (tool !== 'dungeon_look') return null;
  if (args.action === 'status' || args.action === 'inventory') return args.action;
  return args.action === 'rules' && args.topic === 'myclass' ? 'rules-myclass' : null;
}
function excerpt(value: string, limit: number, reference: string): string {
  return value.length <= limit ? value : value.slice(0, limit)
    + `\n[原文未展开；dungeon_evidence read reference=${JSON.stringify(reference)} 分页读取。]`;
}

export class DungeonObservations {
  private active = false;
  private epoch = '';
  private scopeId: string | null = null;
  private generation = 0;
  private inFlight = 0;
  private readonly states = new Map<string, Observation>();
  private readonly recent = new Map<string, Observation>();
  private readonly receipts: Observation[] = [];
  private invalidated = '尚未收到本次连接的角色读数。';
  private readonly now: () => number;
  constructor(private readonly options: DungeonContextOptions) { this.now = options.now ?? Date.now; }
  start(): void { this.active = true; this.reset(); }
  stop(): void { this.active = false; this.reset(); }
  private reset(): void {
    this.epoch = randomUUID(); this.generation++; this.inFlight = 0;
    this.states.clear(); this.receipts.length = 0; this.recent.clear();
    this.scopeId = this.options.scope();
    this.invalidated = '本次连接还没有可用读数；历史档案不自动恢复为当前事实。';
  }
  private syncScope(): void { if (this.scopeId !== this.options.scope()) this.reset(); }
  begin(tool: string, args: Record<string, unknown>): Ticket {
    this.syncScope();
    const changed = mutates(tool, args);
    if (changed) { this.generation++; this.inFlight++; this.invalidate(`${tool}/${String(args.action)} 已发起，旧资源读数失效；生效情况查原始回执及后续状态。`); }
    return { generation: this.generation, epoch: this.epoch, scope: this.scopeId, mutates: changed };
  }
  event(type: string): void {
    if (type === 'dungeon.chat' || type === 'dungeon.board') return;
    this.generation++;
    this.invalidate(`收到 ${type}；旧角色读数失效，按需重新查询。`);
  }
  private invalidate(reason: string): void { this.states.clear(); this.invalidated = reason; }
  record(ticket: Ticket, tool: string, args: Record<string, unknown>, value: string | ToolOutcome, call: ToolCallContext): void {
    this.syncScope();
    if (!ticket.scope) return;
    const row: Observation = { schemaVersion: 1, reference: call.callId ?? `local:${randomUUID()}`,
      scope: ticket.scope, observedAt: new Date(this.now()).toISOString(), epoch: ticket.epoch, tool,
      args: structuredClone(args), outcome: typeof value === 'string' ? { text: value }
        : { text: value.text, ...(value.failed ? { failed: true } : {}) } };
    // World data archive, separate from the Persona's workspace and with no credentials or inferred state.
    if (this.options.dataDir) {
      try {
        const dir = join(this.options.dataDir, hash(row.scope)); mkdirSync(dir, { recursive: true });
        const file = join(dir, hash(row.reference) + '.json');
        if (!existsSync(file)) writeFileSync(file, JSON.stringify(row), { flag: 'wx' });
      } catch (error) { call.log.warn('Dungeon receipt archive unavailable; original tool result retained', { error: String(error) }); }
    }
    if (row.scope !== this.scopeId) return;
    this.recent.set(row.reference, row);
    if (this.recent.size > 128) this.recent.delete(this.recent.keys().next().value!);
    if (!this.active || ticket.epoch !== this.epoch) return;
    if (ticket.mutates) this.inFlight = Math.max(0, this.inFlight - 1);
    const key = stateKey(tool, args);
    if (key && !row.outcome.failed && ticket.generation === this.generation && this.inFlight === 0)
      this.states.set(key, row);
    if (tool !== 'dungeon_look' && tool !== 'dungeon_chat' && !READ_ACTIONS[tool]?.includes(String(args.action))) {
      this.receipts.push(row); if (this.receipts.length > RECEIPT_PARTS) this.receipts.shift();
    }
  }
  fail(ticket: Ticket): void {
    if (ticket.epoch !== this.epoch) return;
    if (ticket.mutates) this.inFlight = Math.max(0, this.inFlight - 1);
    this.generation++; this.invalidate('调用未取得回执，实际效果未知；先查状态和账本，不自动重投。');
  }
  facts(): WorldRequestFacts | null {
    this.syncScope(); if (!this.active || !this.scopeId) return null;
    const parts: Array<{ key: string; text: string }> = [{ key: 'scope', text:
      `[Dungeon 已观察事实；scope=${this.scopeId}；仅来自实际回执。]\n`
      + '意图、交易约定和实际转移分别核对；原料卖家或来历本身不构成委托。缺少读数表示未知，不表示零。' }];
    for (const key of ['status', 'inventory', 'rules-myclass']) {
      const row = this.states.get(key);
      const valid = row && this.now() - Date.parse(row.observedAt) < STATE_TTL_MS;
      parts.push({ key: `state/${key}`, text: valid ? excerpt(row.outcome.text, 1100, row.reference) : '' });
      parts.push({ key: `source/${key}`, text: valid ? `${key} 原始读数：${row.observedAt}；reference=${row.reference}`
        : `${key}：当前读数未知。${row ? '读数已过期。' : this.invalidated}` });
    }
    for (let i = 0; i < RECEIPT_PARTS; i++) {
      const candidate = this.receipts[i];
      const row = candidate && this.now() - Date.parse(candidate.observedAt) < RECEIPT_CONTEXT_TTL_MS ? candidate : null;
      parts.push({ key: `receipt/${i}`, text: row ? `[原始动作回执；${row.observedAt}；reference=${row.reference}]\n`
        + `${row.tool} ${excerpt(JSON.stringify(row.args), 300, row.reference)}\n${excerpt(row.outcome.text, 400, row.reference)}` : '' });
    }
    parts.push({ key: 'archive', text: 'dungeon_evidence list 查看已归档入口；read reference 分页核对原文。动作受理、工具建议或他人的感谢不证明自己的目标已完成。' });
    return { text: parts.map(x => x.text).filter(Boolean).join('\n\n'), parts, snapshotTypes: [] };
  }
  evidence(args: Record<string, unknown>): string {
    this.syncScope();
    if (args.action === 'list') return JSON.stringify({ historical: true, scope: this.scopeId,
      observations: [...this.recent.values()].slice(-20).map(({ reference, observedAt, tool, args: original }) => ({ reference, observedAt, tool, action: original.action })) });
    if (args.action !== 'read' || typeof args.reference !== 'string' || !args.reference.trim() || args.reference.length > 300)
      throw new Error('read requires an exact reference from observed facts or list');
    let row = this.recent.get(args.reference);
    if (!row && this.scopeId && this.options.dataDir) {
      try { row = JSON.parse(readFileSync(join(this.options.dataDir, hash(this.scopeId), hash(args.reference) + '.json'), 'utf8')) as Observation; } catch { /* A missing archive is not evidence of absence. */ }
    }
    if (!row || row.scope !== this.scopeId || row.reference !== args.reference) return JSON.stringify({ historical: true, found: false, message: '本 scope 未找到该原文；不证明动作未发生或目标未完成。' });
    const offset = args.offset ?? 0, limit = args.limit ?? 4000;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 8000)
      throw new Error('offset must be nonnegative and limit must be 1..8000 characters');
    const body = JSON.stringify(row, null, 2), end = Number(offset) + Number(limit);
    return JSON.stringify({ historical: true, reference: row.reference, observedAt: row.observedAt,
      totalChars: body.length, offset, nextOffset: end < body.length ? end : null, text: body.slice(Number(offset), end) });
  }
}

/** Delegates all execution to the original World. Cached facts never start requests or model calls. */
export function withDungeonContext<T extends World>(world: T, options: DungeonContextOptions): T {
  const observations = new DungeonObservations(options);
  const evidence: ToolDef = { name: 'dungeon_evidence', description: 'Read dated original Dungeon receipts. This local archive performs no network call and cannot prove current state or completion.', tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['list', 'read'] }, reference: { type: 'string', maxLength: 300 },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 8000 } } },
    handler: async args => observations.evidence(args) };
  return new Proxy(world, { get(target, key) {
    if (key === 'requestFacts' || key === 'verifiedFacts') return () => key === 'requestFacts' ? observations.facts() : observations.facts()?.text ?? null;
    if (key === 'tools') return () => [...target.tools().map(tool => ({ ...tool,
      handler: async (args: Record<string, unknown>, call: ToolCallContext) => {
        const ticket = observations.begin(tool.name, args);
        try { const result = await tool.handler(args, call); observations.record(ticket, tool.name, args, result, call); return result; }
        catch (error) { observations.fail(ticket); throw error; }
      } })), evidence];
    if (key === 'start') return async (host: WorldHost) => {
      observations.start();
      const wrapped = new Proxy(host, { get(value, property) {
        if (property === 'pushEvent') return (event: Parameters<WorldHost['pushEvent']>[0], opts?: Parameters<WorldHost['pushEvent']>[1]) => {
          observations.event(event.type); return value.pushEvent(event, opts);
        };
        const member = Reflect.get(value, property, value); return typeof member === 'function' ? member.bind(value) : member;
      } });
      try { await target.start(wrapped); } catch (error) { observations.stop(); throw error; }
    };
    if (key === 'stop') return async () => { observations.stop(); await target.stop(); };
    const member = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
}
