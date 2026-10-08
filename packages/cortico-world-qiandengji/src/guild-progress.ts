/** Latest server-authored commission state and completion evidence. */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface CurrentCommission {
  name: string | null;
  at: string;
  progress?: number;
  required?: number;
  acceptance?: { text: string; at: string };
  exactId?: { value: string; at: string };
}
interface CompletedCommission { name: string; at: string; evidence: 'delivery' | 'board' }
interface GuildSnapshot {
  current: CurrentCommission | null;
  completed: CompletedCommission[];
  lastDeliveryAt: string | null;
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

const commissionName = (text: string): string => text.split(' · ')[0].trim();

function validSnapshot(value: unknown): value is GuildSnapshot {
  if (!value || typeof value !== 'object') return false;
  const state = value as GuildSnapshot;
  return (state.current === null || !!state.current && timestamp(state.current.at)
    && (state.current.name === null || typeof state.current.name === 'string')
    && [state.current.progress, state.current.required].every(n => n === undefined || Number.isSafeInteger(n) && n >= 0)
    && (state.current.acceptance === undefined || !!state.current.acceptance
      && typeof state.current.acceptance.text === 'string' && timestamp(state.current.acceptance.at))
    && (state.current.exactId === undefined || !!state.current.exactId
      && typeof state.current.exactId.value === 'string' && timestamp(state.current.exactId.at)))
    && Array.isArray(state.completed) && state.completed.every(item => item && typeof item.name === 'string'
      && timestamp(item.at) && (item.evidence === 'delivery' || item.evidence === 'board'))
    && (state.lastDeliveryAt === null || timestamp(state.lastDeliveryAt));
}

export class GuildProgress {
  private state: GuildSnapshot = { current: null, completed: [], lastDeliveryAt: null };
  private readonly file: string | null;

  constructor(private readonly server: string, dataDir?: string) {
    this.file = dataDir ? join(dataDir, 'mymc-guild-progress.json') : null;
    if (!this.file || !existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (saved.version === 1 && saved.server === server && validSnapshot(saved.state)) this.state = saved.state;
    } catch { /* New server observations replace an unreadable cache. */ }
  }

  observe(text: string, at: string): boolean {
    if (!text.startsWith('[MC 系统] ') || !timestamp(at)) return false;
    const line = text.slice('[MC 系统] '.length).trim();
    const accepted = /^已接公会委托：([^。；]+)[。；]/.exec(line);
    const progress = /^正在进行：(.+?)\s*\[(\d+)\/(\d+)\]/.exec(line)
      ?? /^还需完成「(.+?)」[：:]\s*(\d+)\/(\d+)\s*$/.exec(line);
    const activeListing = /^(\S+)\s+(.+?)\s+·\s+.*\[in_progress\](?:\s+·.*)?$/.exec(line);
    const completed = /^\S+\s+(.+?)\s+·\s+.+\[[^\]]*今日已完成\]$/.exec(line);
    const delivered = /^委托交付成功[！!]/.test(line);
    const none = line === '当前没有在办的委托。';
    if (!accepted && !progress && !completed && !delivered && !none && !activeListing) return false;

    if (completed) this.complete(completed[1], at, 'board');
    const current = this.state.current;
    if ((accepted || progress || delivered || none) && (!current || Date.parse(at) >= Date.parse(current.at))) {
      if (delivered) {
        if (current?.name) this.complete(current.name, at, 'delivery');
        this.state.lastDeliveryAt = at;
        this.state.current = { name: null, at };
      } else if (none) this.state.current = { name: null, at };
      else if (progress) this.state.current = {
        ...(current?.name && commissionName(current.name) === commissionName(progress[1]) ? current : {}),
        name: commissionName(progress[1]), progress: Number(progress[2]), required: Number(progress[3]), at,
      };
      else this.state.current = { name: commissionName(accepted![1]), at,
        acceptance: { text: line.length > 1_200 ? line.slice(0, 1_200) + '…[后续未展开，查原始接单回执]' : line, at } };
    }
    if (activeListing && this.state.current?.name
      && commissionName(this.state.current.name) === commissionName(activeListing[2])
      && Date.parse(at) >= Date.parse(this.state.current.at)
      && (!this.state.current.exactId || Date.parse(at) >= Date.parse(this.state.current.exactId.at))) {
      this.state.current.exactId = { value: activeListing[1], at };
    }
    this.save();
    return true;
  }

  facts(): string {
    const lines: string[] = [];
    const current = this.state.current;
    if (current) lines.push(`[公会委托服务端观察 ${current.at}] ${current.name
      ? `在办：${commissionName(current.name)}${current.progress === undefined ? '；进度尚未回读' : ` [${current.progress}/${current.required}]`}`
      : '当前没有在办的委托'}。`);
    if (current?.exactId) lines.push(`${current.exactId.at} 在办看板确认精确ID：${current.exactId.value}。`);
    if (current?.acceptance) lines.push(`${current.acceptance.at} 服务端接单及验收要求原文：${current.acceptance.text}`);
    if (this.state.lastDeliveryAt) lines.push(`最近交付成功回执：${this.state.lastDeliveryAt}。`);
    for (const item of this.state.completed.slice(-6).reverse()) {
      lines.push(`${item.at} 服务端${item.evidence === 'delivery' ? '确认交付' : '看板列为今日已完成'}：${item.name}。`);
    }
    return lines.join('\n');
  }

  private complete(name: string, at: string, evidence: CompletedCommission['evidence']): void {
    const previous = this.state.completed.find(item => item.name === name);
    if (previous && Date.parse(previous.at) >= Date.parse(at)) return;
    this.state.completed = [...this.state.completed.filter(item => item.name !== name), { name, at, evidence }]
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-24);
  }

  private save(): void {
    if (!this.file) return;
    const temporary = `${this.file}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, server: this.server, state: this.state }), 'utf8');
      renameSync(temporary, this.file);
    } catch { /* Current observations remain available in this process. */ }
  }
}
