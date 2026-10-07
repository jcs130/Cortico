/** Server-authored trial limits and durable full-clear observations. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TrialStatus {
  maxFloor: number;
  lastFloor: number | null;
  lastOutcome: string | null;
  globalActive: boolean;
  participant: boolean;
}

export function parseTrialStatus(text: string): TrialStatus | null {
  const marker = 'MC_DUNGEON status ';
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const fields = new Map<string, string>();
  for (const field of text.slice(start + marker.length).split(/\s+/)) {
    const separator = field.indexOf('=');
    if (separator > 0) fields.set(field.slice(0, separator), field.slice(separator + 1));
  }
  const maxFloor = Number(fields.get('maxFloor'));
  if (!Number.isSafeInteger(maxFloor) || maxFloor < 1) return null;
  const lastFloorValue = Number(fields.get('lastFloor'));
  return {
    maxFloor,
    lastFloor: Number.isSafeInteger(lastFloorValue) && lastFloorValue >= 1 ? lastFloorValue : null,
    lastOutcome: fields.get('lastOutcome') ?? null,
    globalActive: fields.get('globalActive') === 'true',
    participant: fields.get('participant') === 'true',
  };
}

/** Numeric floor objectives require an observed cap, so a model cannot invent L16 after a 15-floor clear. */
export function trialGoalLimitNote(args: Record<string, unknown>, status: TrialStatus | null,
  clear: TrialFullClear | null = null): string | null {
  const add = args.add;
  if (!add || typeof add !== 'object' || Array.isArray(add)) return null;
  const goal = add as Record<string, unknown>;
  const target = [goal.target, goal.text].filter((part): part is string => typeof part === 'string').join(' ');
  if (!/(?:试炼|arena|tower)/i.test(target)) return null;
  const floor = /(?:\bL\s*|第\s*)(\d+)\s*(?:\+|层)?/i.exec(target);
  const wanted = floor ? Number(floor[1]) : null;
  if (wanted !== null && Number.isSafeInteger(wanted) && wanted > 0) {
    if (!status) return `目标写了试炼塔 L${wanted}，但还没有本次连接的服务端楼层上限。先在游戏聊天发 /mycli arena status，按回执 maxFloor 再挂目标`;
    if (wanted > status.maxFloor) {
      const cleared = status.lastOutcome === 'won' && status.lastFloor !== null
        ? `；上次已通关 L${status.lastFloor}` : '';
      return `服务端回执 maxFloor=${status.maxFloor}${cleared}，当前没有 L${wanted}。改选现有楼层的具体任务，或探索公会、地下城等其他玩法；等服务端扩层后重新查询`;
    }
  }
  if (clear && status && clear.maxFloor >= status.maxFloor
    && /(?:全通|通关|纪录|记录|破关|冲击|冲\s*L\s*\d+)/i.test(target)
    && !/(?:重刷|刷奖励|重复挑战|再打一遍)/.test(target)) {
    return `已有 ${clear.at} 的第 ${clear.floor}/${clear.maxFloor} 层全通回执。最近一次试炼可能失败，但不会撤销历史通关。若想重复刷奖励，请明确改为刷奖励目标；否则改选地下城、公会、收纳等任务`;
  }
  return null;
}

export interface TrialFullClear { floor: number; maxFloor: number; at: string }
interface TrialProgressFile { version: 1; server: string; clear: TrialFullClear | null; lastRunEndedAt?: string | null }

/** Keeps achievement evidence across reconnects; latest-run status can be overwritten by an aborted run. */
export class TrialProgress {
  status: TrialStatus | null = null;
  clear: TrialFullClear | null = null;
  lastRunEndedAt: string | null = null;
  private readonly file: string | null;

  constructor(private readonly server: string, dataDir?: string) {
    this.file = dataDir ? join(dataDir, 'mymc-trial-progress.json') : null;
    let foreignLedger = false;
    if (this.file && existsSync(this.file)) {
      try {
        const saved = JSON.parse(readFileSync(this.file, 'utf8')) as TrialProgressFile;
        foreignLedger = saved.version === 1 && saved.server !== server;
        if (saved.version === 1 && saved.server === server) {
          if (validClear(saved.clear)) this.clear = saved.clear;
          if (saved.lastRunEndedAt && Number.isFinite(Date.parse(saved.lastRunEndedAt))) {
            this.lastRunEndedAt = saved.lastRunEndedAt;
          }
        }
      } catch { /* Recover from the event ledger below. */ }
    }
    if ((!this.clear || !this.lastRunEndedAt) && dataDir && !foreignLedger) this.recover(join(dataDir, 'runs'));
  }

  observe(text: string, at: string): void {
    if (/^\[MC 系统\] 队伍离开本层超过 \d+ 秒/.test(text)) this.recordEnd(at);
    const status = parseTrialStatus(text);
    if (status) {
      this.status = status;
      if (status.lastOutcome === 'won' && status.lastFloor === status.maxFloor
        && (!this.clear || status.maxFloor > this.clear.maxFloor)) {
        this.record({ floor: status.maxFloor, maxFloor: status.maxFloor, at });
      }
    }
    const line = /第\s*(\d+)\s*\/\s*(\d+)\s*层已通关/.exec(text);
    if (line && Number(line[1]) === Number(line[2])) {
      this.record({ floor: Number(line[1]), maxFloor: Number(line[2]), at });
      this.recordEnd(at);
    }
  }

  private record(clear: TrialFullClear): void {
    if (!validClear(clear)) return;
    if (this.clear && (clear.maxFloor < this.clear.maxFloor
      || (clear.maxFloor === this.clear.maxFloor && Date.parse(clear.at) <= Date.parse(this.clear.at)))) return;
    this.clear = clear;
    this.save();
  }

  private recordEnd(at: string): void {
    if (!Number.isFinite(Date.parse(at)) || (this.lastRunEndedAt && Date.parse(at) <= Date.parse(this.lastRunEndedAt))) return;
    this.lastRunEndedAt = at;
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    try { writeFileSync(this.file, JSON.stringify({
      version: 1, server: this.server, clear: this.clear, lastRunEndedAt: this.lastRunEndedAt,
    } satisfies TrialProgressFile), 'utf8'); }
    catch { /* In-memory evidence still protects this run. */ }
  }

  private recover(runsDir: string): void {
    if (!existsSync(runsDir)) return;
    let names: string[];
    try { names = readdirSync(runsDir).filter((name) => name.startsWith('r-')).sort().reverse().slice(0, 30); }
    catch { return; }
    for (const kind of ['ended', 'clear', 'status'] as const) {
      if (kind === 'ended' && this.lastRunEndedAt) continue;
      if (kind !== 'ended' && this.clear) continue;
      let found = false;
      for (const name of names) {
        try {
          const lines = readFileSync(join(runsDir, name, 'events.jsonl'), 'utf8').split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (kind === 'ended' ? !line.includes('队伍离开本层超过')
              : kind === 'clear' ? !line.includes('层已通关') : !line.includes('lastOutcome=won')) continue;
            const event = JSON.parse(line) as { type?: string; text?: string; ts?: string };
            if (event.type !== 'mymc.chat' || !event.text || !event.ts) continue;
            this.observe(event.text, event.ts);
            if (kind === 'ended' ? !!this.lastRunEndedAt : !!this.clear) { found = true; break; }
          }
        } catch { /* An incomplete run does not invalidate other run ledgers. */ }
        if (found) break;
      }
    }
  }
}

function validClear(value: TrialFullClear | null | undefined): value is TrialFullClear {
  return !!value && Number.isSafeInteger(value.floor) && value.floor > 0
    && value.floor === value.maxFloor && Number.isFinite(Date.parse(value.at));
}
