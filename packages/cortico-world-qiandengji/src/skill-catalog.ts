import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface CatalogFile {
  version: 1;
  server: string;
  updatedAt: string;
  entries: Record<string, string>;
  spells?: Record<string, SpellRecord>;
  directory?: DirectoryObservation;
}

interface SpellSummary {
  id: string;
  name: string;
  category: string;
  mana: number;
  cooldownMs: number;
  command: string;
}

interface SpellRecord {
  item: SpellSummary;
  detail?: Record<string, unknown>;
  observedAt?: string;
  detailAt?: string;
}

interface DirectoryObservation {
  pages: number;
  total: number;
  pageItems: Record<string, string[]>;
  updatedAt: string;
}

export const SKILL_ENTRY = '千灯纪有技能系统。游戏命令入口 /mycli help；法术目录 /mycli spells list 1，按 MC_SPELL_NEXT 翻页；单项 /mycli spells explain <ID>，缓存用 mymc_skills。通过 mymc_do 的 chat 步骤发送命令，施法用 mymc_cast 并带齐参数。';

function directoryHeader(value: unknown): { page: number; pages: number; total: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || !Number.isSafeInteger(row.page) || !Number.isSafeInteger(row.pages)
    || !Number.isSafeInteger(row.total)) return null;
  const { page, pages, total } = row as { page: number; pages: number; total: number };
  return page >= 1 && pages >= page && total >= 0 && pages <= Math.max(1, total)
    ? { page, pages, total } : null;
}

const LEGACY_HEADINGS = /^(?:可用咏唱|战斗咏唱|探索咏唱|可学习|新技能|技能精进|探矿术\(prospect\)|探矿类型)$/;

function spellSummary(value: unknown): SpellSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!/^[a-z][a-z0-9_]*$/.test(String(row.id ?? ''))
    || typeof row.name !== 'string' || typeof row.category !== 'string'
    || typeof row.command !== 'string' || !row.command.startsWith('/mycli cast ')
    || typeof row.mana !== 'number' || !Number.isFinite(row.mana)
    || typeof row.cooldownMs !== 'number' || !Number.isFinite(row.cooldownMs)) return null;
  return {
    id: row.id as string, name: row.name, category: row.category,
    mana: row.mana, cooldownMs: row.cooldownMs, command: row.command,
  };
}

/** The server's own skill listings, kept as observations rather than inferred abilities. */
export class SkillCatalog {
  private readonly file: string | null;
  private readonly server: string;
  private readonly entries = new Map<string, string>();
  private readonly spells = new Map<string, SpellRecord>();
  private updatedAt = '';
  private readonly hadPreviousCatalog: boolean;
  private firstObservationAtMs: number | null = null;
  private directory: DirectoryObservation | null = null;
  private activePage: number | null = null;
  private refreshBaseline: string[] | null = null;
  private refreshChanged = false;

  constructor(server: string, dataDir?: string) {
    this.server = server;
    this.file = dataDir ? join(dataDir, 'mymc-skills.json') : null;
    if (this.file && existsSync(this.file)) {
      try {
        const saved = JSON.parse(readFileSync(this.file, 'utf8')) as CatalogFile;
        if (saved.version === 1 && saved.server === server && saved.entries
          && typeof saved.entries === 'object') {
          for (const [heading, line] of Object.entries(saved.entries)) {
            if (LEGACY_HEADINGS.test(heading) && typeof line === 'string') this.entries.set(heading, line);
          }
          for (const value of Object.values(saved.spells ?? {})) {
            const item = spellSummary(value?.item);
            if (item) this.spells.set(item.id, {
              item,
              ...(value.detail && typeof value.detail === 'object' && !Array.isArray(value.detail)
                ? { detail: value.detail } : {}),
              observedAt: value.observedAt ?? saved.updatedAt,
              ...(value.detail ? { detailAt: value.detailAt ?? saved.updatedAt } : {}),
            });
          }
          this.updatedAt = saved.updatedAt;
          const directory = saved.directory;
          if (directory && directoryHeader({ schemaVersion: 1, page: 1, ...directory })
            && directory.pageItems && typeof directory.pageItems === 'object'
            && Object.entries(directory.pageItems).every(([page, ids]) =>
              /^[1-9][0-9]*$/.test(page) && Number(page) <= directory.pages
              && Array.isArray(ids) && ids.every((id) => typeof id === 'string' && this.spells.has(id)))) {
            this.directory = directory;
          }
        }
      } catch { /* A damaged observation ledger is replaced by the next server listing. */ }
    }
    this.hadPreviousCatalog = this.entries.size > 0 || this.spells.size > 0;
  }

  observe(text: string, at: string): string | null {
    const line = /^\[MC (?:系统|插件)\] (.+)$/.exec(text)?.[1]?.trim();
    if (!line) return null;
    const list = /^MC_SPELL_LIST\s+(\{.*\})$/.exec(line);
    if (list) {
      try {
        const header = directoryHeader(JSON.parse(list[1]));
        if (!header) return null;
        if (header.page === 1 || !this.directory
          || header.pages !== this.directory.pages || header.total !== this.directory.total) {
          this.refreshBaseline = [...this.spells.keys()].sort();
          this.refreshChanged = false;
          this.directory = { pages: header.pages, total: header.total, pageItems: {}, updatedAt: at };
        }
        this.activePage = header.page;
        this.directory.pageItems[header.page] = [];
        this.directory.updatedAt = at;
        const notice = this.finishDirectory();
        this.save();
        return notice;
      } catch { return null; }
    }
    const structured = /^MC_SPELL_(ITEM|DETAIL)\s+(\{.*\})$/.exec(line);
    if (structured) {
      try {
        const parsed = JSON.parse(structured[2]) as unknown;
        const item = spellSummary(parsed);
        if (!item) return null;
        const previous = this.spells.get(item.id);
        const changed = previous !== undefined && JSON.stringify(previous.item) !== JSON.stringify(item);
        const detail = structured[1] === 'DETAIL' && parsed && typeof parsed === 'object'
          ? parsed as Record<string, unknown> : changed ? undefined : previous?.detail;
        const detailChanged = previous?.detail !== undefined && detail !== undefined
          && JSON.stringify(previous.detail) !== JSON.stringify(detail);
        this.spells.set(item.id, { item, observedAt: at,
          ...(detail ? { detail, detailAt: structured[1] === 'DETAIL' ? at : previous?.detailAt } : {}) });
        this.updatedAt = at;
        const atMs = Date.parse(at) || Date.now();
        this.firstObservationAtMs ??= atMs;
        let notice: string | null = null;
        if (structured[1] === 'ITEM' && this.directory && this.activePage !== null) {
          const ids = this.directory.pageItems[this.activePage];
          if (!ids.includes(item.id)) ids.push(item.id);
          this.directory.updatedAt = at;
          this.refreshChanged ||= changed;
          notice = this.finishDirectory();
        } else if (changed || detailChanged || (!previous
          && (this.hadPreviousCatalog || atMs - this.firstObservationAtMs >= 30_000))) {
          notice = item.name;
        }
        this.save();
        return notice;
      } catch { /* Ignore malformed protocol lines; never treat them as instructions. */ }
      return null;
    }
    const heading = /^([^：:]{2,30})[：:]/.exec(line)?.[1]?.trim();
    if (!heading || !LEGACY_HEADINGS.test(heading)) return null;
    if (this.entries.get(heading) === line) return null;
    const atMs = Date.parse(at) || Date.now();
    this.firstObservationAtMs ??= atMs;
    const existed = this.entries.has(heading);
    this.entries.set(heading, line);
    this.updatedAt = at;
    this.save();
    // 初次登录会连发整份目录；把这段当基线，之后出现的新标题也要通知。
    return this.hadPreviousCatalog || existed || atMs - this.firstObservationAtMs >= 30_000
      ? heading : null;
  }

  private directoryIds(): string[] {
    return [...new Set(Object.values(this.directory?.pageItems ?? {}).flat())].sort();
  }

  private directoryComplete(): boolean {
    return this.directory !== null
      && Object.keys(this.directory.pageItems).length === this.directory.pages
      && this.directoryIds().length === this.directory.total;
  }

  /** Only a complete listing can prove that a previously observed skill was removed. */
  private finishDirectory(): string | null {
    if (!this.directoryComplete()) return null;
    const ids = this.directoryIds();
    const keep = new Set(ids);
    for (const id of this.spells.keys()) if (!keep.has(id)) this.spells.delete(id);
    const changed = this.refreshBaseline !== null
      && this.refreshBaseline.length > 0
      && (this.refreshChanged || JSON.stringify(this.refreshBaseline) !== JSON.stringify(ids));
    this.refreshBaseline = null;
    this.activePage = null;
    return changed ? '分页目录' : null;
  }

  compactIndex(): string {
    const groups = new Map<string, string[]>();
    for (const { item } of this.spells.values()) {
      const names = groups.get(item.category) ?? [];
      names.push(`${item.id}:${item.name}`);
      groups.set(item.category, names);
    }
    const progress = this.directory
      ? `已收到 ${Object.keys(this.directory.pageItems).length}/${this.directory.pages} 页、`
        + `${this.directoryIds().length}/${this.directory.total} 项；${this.directoryComplete() ? '本次目录完整' : '本次目录未完整'}`
      : '尚未核验分页目录是否完整';
    let missingPage = 1;
    if (this.directory) {
      while (this.directory.pageItems[missingPage] !== undefined) missingPage++;
      if (missingPage > this.directory.pages) missingPage = 1;
    }
    return `${SKILL_ENTRY}\n[技能目录观察] ${progress}；缓存 ${this.spells.size} 项，最近 ${this.updatedAt || '尚无观测'}。`
      + (!this.directoryComplete() ? `补查 /mycli spells list ${missingPage}。` : '')
      + (groups.size ? '\n' + [...groups].map(([category, names]) => `${category}：${names.join('、')}`).join('\n') : '')
      + '\n目录说明可查询的技能；本人是否已学会、当前魔力及剩余冷却看实时状态，效果与前提按单项说明读取。';
  }

  /** Only explicit required argument placeholders in an observed command imply a minimum. */
  requiredArgumentCount(id: string): number | null {
    const command = this.spells.get(id.trim().toLowerCase())?.item.command;
    return command === undefined ? null : [...command.matchAll(/(?:^|\s)<[^<>]+>(?=\s|$)/g)].length;
  }

  /** A finite limit requires an observed command with only single-value placeholders. */
  maximumArgumentCount(id: string): number | null {
    const key = id.trim().toLowerCase();
    const command = this.spells.get(key)?.item.command;
    const prefix = `/mycli cast ${key}`;
    if (command === prefix) return 0;
    if (!command?.startsWith(`${prefix} `)) return null;
    let remaining = command.slice(prefix.length).trim();
    if (/\.\.\.|…/.test(remaining)) return null;
    let count = 0;
    while (remaining) {
      const token = /^(?:<[^<>\[\]]+>|\[(?:<[^<>\[\]]+>|[^\s<>\[\]]+)\])(?:\s+|$)/.exec(remaining);
      if (!token) return null;
      count++;
      remaining = remaining.slice(token[0].length);
    }
    return count;
  }

  readout(id?: string): string {
    if (id) {
      const record = this.spells.get(id.trim().toLowerCase());
      if (!record) return `[千灯纪法术] 尚未缓存 ${id}。发送 /mycli spells explain ${id} 后再读；以服务端当次回执为准。`;
      return `[千灯纪法术] ${record.item.name} (${record.item.id})，简表观测 ${record.observedAt ?? this.updatedAt}。\n`
        + (record.detail
          ? `说明观测 ${record.detailAt ?? this.updatedAt}\nMC_SPELL_DETAIL ${JSON.stringify(record.detail)}`
          : `MC_SPELL_ITEM ${JSON.stringify(record.item)}\n完整说明请发送 /mycli spells explain ${record.item.id}。`);
    }
    if (this.spells.size === 0 && this.entries.size === 0) {
      return '[千灯纪技能] 尚未收到服务端技能目录。可发送 /mycli spells list 1，再按 MC_SPELL_NEXT 翻页；单项说明用 /mycli spells explain <ID>。';
    }
    const spellLines = [...this.spells.values()].map(({ item }) =>
      `${item.id} ${item.name} [${item.category}] 魔力${item.mana} 冷却${item.cooldownMs}ms ${item.command}`);
    return `[千灯纪技能] 服务端 ${this.server}。\n${this.compactIndex()}\n单项完整说明用 mymc_skills {"id":"..."} 或 /mycli spells explain <ID>。\n`
      + [...spellLines, ...this.entries.values()].join('\n');
  }

  private save(): void {
    if (!this.file) return;
    try {
      writeFileSync(this.file, JSON.stringify({
        version: 1, server: this.server, updatedAt: this.updatedAt,
        entries: Object.fromEntries(this.entries),
        spells: Object.fromEntries(this.spells),
        ...(this.directory ? { directory: this.directory } : {}),
      } satisfies CatalogFile), 'utf8');
    } catch { /* The live observation remains available until this World stops. */ }
  }
}
