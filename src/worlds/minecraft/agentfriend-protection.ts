/** 千灯纪 AgentFriend 的单格保护预检。查询只针对实际拟挖/拟放的目标格。 */
import { Vec3 } from 'vec3';
export type ProtectAction = 'break' | 'place';
export type ProtectStatus = 'deny' | 'unknown' | 'allow_likely';
export interface ProtectCell { x: number; y: number; z: number }
export interface ProtectReply {
  action: ProtectAction;
  dimension: string;
  x: number; y: number; z: number;
  status: ProtectStatus;
  reason: string;
}

interface PathActionMove extends ProtectCell {
  toBreak: ProtectCell[];
  toPlace: Array<ProtectCell & { dx?: number; dy?: number; dz?: number; useOne?: boolean }>;
}

/** Keep the in-flight permission check while a changing path proposes other cells. */
export function selectHeldPathAction<T extends { key: string; querying: boolean }>(
  current: T | null, candidate: T,
): T {
  return current && (current.querying || current.key === candidate.key) ? current : candidate;
}

/**
 * pathfinder 在 path_update 事件返回后同一物理刻就可能开始挖掘。先截住第一处
 * 尚未获得 allow_likely 的改方块动作，只让已确认安全的前缀进入执行器。
 * 空前缀用当前位置的无动作节点占位，避免上游 goto 把空路径误判为完成。
 */
export function holdUnverifiedPathAction<T extends PathActionMove>(
  result: { path: T[] }, player: ProtectCell,
  verdict: (action: ProtectAction, cell: ProtectCell) => ProtectStatus | null,
): { action: ProtectAction; cell: ProtectCell; status: ProtectStatus | null; safePrefix: number } | null {
  for (let i = 0; i < result.path.length; i++) {
    const move = result.path[i];
    const actions: Array<{ action: ProtectAction; cell: ProtectCell }> = [
      ...(move.toBreak ?? []).map((cell) => ({ action: 'break' as const, cell })),
      ...(move.toPlace ?? []).filter((place) => !place.useOne).map((place) => ({
        action: 'place' as const,
        cell: { x: place.x + (place.dx ?? 0), y: place.y + (place.dy ?? 0), z: place.z + (place.dz ?? 0) },
      })),
    ];
    for (const action of actions) {
      const status = verdict(action.action, action.cell);
      if (status === 'allow_likely') continue;
      if (i === 0) {
        const hold = Object.assign(Object.create(Object.getPrototypeOf(move)) as T, move,
          { x: player.x, y: player.y, z: player.z, toBreak: [], toPlace: [] });
        result.path.splice(0, result.path.length, hold);
      } else {
        result.path.splice(i);
      }
      return { ...action, status, safePrefix: i };
    }
  }
  return null;
}

/** 多个邻近方块被拒或暂无法确认时，短时改走现有道路，避免 A* 逐格试探整座建筑。 */
export class NearbyProtectionBackoff {
  private denied: Array<{ key: string; dimension: string; at: ProtectCell; time: number }> = [];
  private anchor: (ProtectCell & { dimension: string; until: number }) | null = null;

  note(reply: ProtectReply, player: ProtectCell | undefined, now = Date.now()): boolean {
    if (reply.action !== 'break' || reply.status === 'allow_likely' || !player) return false;
    const dimension = normDimension(reply.dimension);
    this.denied = this.denied.filter((entry) => now - entry.time <= 20_000);
    const key = keyOf('break', dimension, reply);
    if (!this.denied.some((entry) => entry.key === key)) {
      this.denied.push({ key, dimension, at: reply, time: now });
    }
    if (this.active(player, dimension, now)) return false;
    const nearby = this.denied.filter((entry) => entry.dimension === dimension
      && Math.hypot(entry.at.x - player.x, entry.at.y - player.y, entry.at.z - player.z) <= 16);
    if (nearby.length < 3) return false;
    this.anchor = { x: player.x, y: player.y, z: player.z, dimension, until: now + 60_000 };
    this.denied = [];
    return true;
  }

  active(player: ProtectCell | undefined, dimension: string, now = Date.now()): boolean {
    const anchor = this.anchor;
    return !!(anchor && player && anchor.dimension === normDimension(dimension) && now < anchor.until
      && Math.hypot(anchor.x - player.x, anchor.y - player.y, anchor.z - player.z) <= 16);
  }
}

const CHANNEL = 'mcagent:protection';
const PREFIX = 'MC_PROTECT';
const TIMEOUT_MS = 4000;
const QUERY_GAP_MS = 1500;
const RATE_LIMIT_BACKOFF_MS = 5000;
const DENY_TTL_MS = 300_000;
const UNKNOWN_TTL_MS = 4000;
const ALLOW_TTL_MS = 15_000;
const normDimension = (s: string): string => s.replace(/^minecraft:/, '');
const keyOf = (action: ProtectAction, dimension: string, cell: ProtectCell): string =>
  `${action}|${normDimension(dimension)}|${cell.x},${cell.y},${cell.z}`;

/** 不把任意系统 JSON 当成保护回执；必须有 MC_PROTECT 前缀或指定插件通道。 */
export function parseProtectReply(raw: unknown, channel?: string): ProtectReply | null {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (raw instanceof Uint8Array) text = Buffer.from(raw).toString('utf8');
  else if (raw && typeof raw === 'object' && 'toString' in raw) text = String(raw);
  else return null;
  const start = channel === CHANNEL ? text.indexOf('{') : text.indexOf(PREFIX);
  if (start < 0) return null;
  const jsonStart = text.indexOf('{', start);
  if (jsonStart < 0) return null;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(text.slice(jsonStart)) as Record<string, unknown>; }
  catch { return null; }
  const action = obj.action;
  const status = obj.status;
  const dimension = obj.dimension ?? obj.world;
  if (typeof obj.dimension === 'string' && typeof obj.world === 'string'
    && normDimension(obj.dimension) !== normDimension(obj.world)) return null;
  const c = obj.coordinates && typeof obj.coordinates === 'object'
    ? obj.coordinates as Record<string, unknown> : obj;
  const x = Number(c.x), y = Number(c.y), z = Number(c.z);
  if ((action !== 'break' && action !== 'place')
    || (status !== 'deny' && status !== 'unknown' && status !== 'allow_likely')
    || typeof dimension !== 'string'
    || ![x, y, z].every(Number.isInteger)) return null;
  return { action, dimension: normDimension(dimension), x, y, z, status,
    reason: typeof obj.reason === 'string' ? obj.reason : '' };
}

interface ProtectBot {
  chat(text: string): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  entity?: { position: { x: number; y: number; z: number } };
  blockAt?(point: ProtectCell): unknown;
  _client?: { on(event: string, listener: (...args: any[]) => void): unknown };
}

export class AgentFriendProtection {
  private readonly cache = new Map<string, { reply: ProtectReply; until: number }>();
  private readonly inflight = new Map<string, Promise<ProtectReply>>();
  private chain: Promise<unknown> = Promise.resolve();
  private waiting: { key: string; resolve: (reply: ProtectReply) => void } | null = null;
  private nextCommandAt = 0;

  constructor(private readonly bot: ProtectBot, private readonly onReply?: (reply: ProtectReply) => void) {
    bot.on('message', (message: unknown, position: string) => {
      if (position !== 'system') return;
      this.accept(parseProtectReply(message));
    });
    bot._client?.on('custom_payload', (packet: { channel?: string; data?: unknown }) => {
      if (packet?.channel === CHANNEL) this.accept(parseProtectReply(packet.data, CHANNEL));
    });
  }

  private accept(reply: ProtectReply | null): void {
    if (!reply) return;
    const key = keyOf(reply.action, reply.dimension, reply);
    const ttl = reply.status === 'deny' ? DENY_TTL_MS
      : reply.status === 'unknown' ? UNKNOWN_TTL_MS : ALLOW_TTL_MS;
    this.cache.set(key, { reply, until: Date.now() + ttl });
    if (reply.status === 'unknown' && reply.reason.includes('rate_limited')) {
      this.nextCommandAt = Math.max(this.nextCommandAt, Date.now() + RATE_LIMIT_BACKOFF_MS);
    }
    if (this.cache.size > 1024) this.cache.delete(this.cache.keys().next().value!);
    this.onReply?.(reply);
    if (this.waiting?.key === key) this.waiting.resolve(reply);
  }

  verdict(action: ProtectAction, dimension: string, cell: ProtectCell): ProtectStatus | null {
    const entry = this.cache.get(keyOf(action, dimension, cell));
    return entry && entry.until > Date.now() ? entry.reply.status : null;
  }

  /** 路径试算只预取少量挖/放目标；真实操作仍走 fresh 检查。 */
  prefetch(action: ProtectAction, dimension: string, cell: ProtectCell): void {
    if (this.inflight.size >= 1 || this.verdict(action, dimension, cell) !== null) return;
    void this.check(action, dimension, cell).catch(() => undefined);
  }

  /** 执行前 fresh=true 再查一次；已明确拒绝的格子直接停，不刷同一命令。 */
  check(action: ProtectAction, dimension: string, cell: ProtectCell, fresh = false): Promise<ProtectReply> {
    const point = { x: Math.floor(cell.x), y: Math.floor(cell.y), z: Math.floor(cell.z) };
    const key = keyOf(action, dimension, point);
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now() && (cached.reply.status === 'deny' || !fresh)) {
      return Promise.resolve(cached.reply);
    }
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const task = this.chain.then(() => this.ask(action, dimension, point));
    this.chain = task.catch(() => undefined);
    this.inflight.set(key, task);
    void task.then(() => { if (this.inflight.get(key) === task) this.inflight.delete(key); },
      () => { if (this.inflight.get(key) === task) this.inflight.delete(key); });
    return task;
  }

  private async ask(action: ProtectAction, dimension: string, cell: ProtectCell): Promise<ProtectReply> {
    const delay = this.nextCommandAt - Date.now();
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    const pos = this.bot.entity?.position;
    const dist = pos ? Math.hypot(pos.x - cell.x, pos.y - cell.y, pos.z - cell.z) : Infinity;
    if (dist > 16 || this.bot.blockAt?.(new Vec3(cell.x, cell.y, cell.z)) == null) {
      const reply: ProtectReply = { action, dimension: normDimension(dimension), ...cell, status: 'unknown',
        reason: dist > 16 ? '目标超过服务端预检的 16 格范围' : '目标区块尚未加载' };
      this.accept(reply);
      return reply;
    }
    const key = keyOf(action, dimension, cell);
    this.nextCommandAt = Date.now() + QUERY_GAP_MS;
    return new Promise<ProtectReply>((resolve) => {
      let finished = false;
      const finish = (reply: ProtectReply) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (this.waiting?.key === key) this.waiting = null;
        resolve(reply);
      };
      const timer = setTimeout(() => {
        const reply: ProtectReply = { action, dimension: normDimension(dimension), ...cell,
          status: 'unknown', reason: '保护预检回执超时' };
        this.accept(reply);
        finish(reply);
      }, TIMEOUT_MS);
      this.waiting = { key, resolve: finish };
      try { this.bot.chat(`/mycli protect ${action} ${cell.x} ${cell.y} ${cell.z}`); }
      catch (error) { finish({ action, dimension: normDimension(dimension), ...cell,
        status: 'unknown', reason: `保护预检命令发送失败: ${String(error)}` }); }
    });
  }
}
