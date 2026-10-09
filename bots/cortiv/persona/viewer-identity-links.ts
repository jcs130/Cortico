/** Explicit, evidence-bearing links; names and nearby events never create a link. */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const VIEWER_IDENTITY_LINKS_FILE = 'social/identity-links.json';
const MAX_BYTES = 64_000;

interface Account { source: string; id: string }
interface IdentityLink {
  accounts: Account[];
  confirmedAt: string;
  evidence: { kind: 'operator-confirmation'; reference: string };
}

export class ViewerIdentityLinks {
  private stamp = '';
  private links: IdentityLink[] = [];
  private error = '';

  constructor(private readonly memoryDir: string) {}

  note(source: string, id: string): string {
    this.load();
    if (this.error) return `[身份关联未验证] ${VIEWER_IDENTITY_LINKS_FILE}：${this.error}`;
    const matches = this.links.filter(link => link.accounts.some(account => account.source === source && account.id === id));
    if (!matches.length) return '';
    const link = matches[0];
    // Conflicting membership for any account invalidates the whole matching link.
    if (matches.length !== 1 || link.accounts.some(account => this.links.filter(other => other.accounts
      .some(candidate => candidate.source === account.source && candidate.id === account.id)).length !== 1)) {
      return `[身份关联冲突] ${source}/${id} 的关联不是唯一，核对 ${VIEWER_IDENTITY_LINKS_FILE}；暂不合并。`;
    }
    return `[已确认同一人] ${link.accounts.map(account => `${account.source}/${account.id}`).join(' ↔ ')}；`
      + `操作员确认于 ${link.confirmedAt}；证据=${link.evidence.reference}（${VIEWER_IDENTITY_LINKS_FILE}）。`
      + '发言仍按各自账号和时间核对；关联不证明当前在线、在附近或任何点歌/帮忙已完成。';
  }

  private load(): void {
    const path = join(this.memoryDir, VIEWER_IDENTITY_LINKS_FILE);
    try {
      const stat = statSync(path);
      const stamp = `${stat.mtimeMs}/${stat.size}`;
      if (stamp === this.stamp) return;
      this.stamp = stamp;
      this.links = [];
      this.error = '';
      if (stat.size > MAX_BYTES) throw new Error('超过 64KB 读取上限');
      const data = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion?: unknown; links?: unknown };
      if (data.schemaVersion !== 1 || !Array.isArray(data.links)) throw new Error('格式或版本错误');
      for (const raw of data.links) {
        const link = raw as IdentityLink;
        if (!link || !Array.isArray(link.accounts) || link.accounts.length < 2 || link.accounts.length > 8
          || typeof link.confirmedAt !== 'string' || !Number.isFinite(Date.parse(link.confirmedAt))
          || link.evidence?.kind !== 'operator-confirmation' || typeof link.evidence.reference !== 'string'
          || !link.evidence.reference.trim() || link.evidence.reference.length > 240
          || link.accounts.some(account => !account || !segment(account.source) || !segment(account.id))
          || new Set(link.accounts.map(account => `${account.source}/${account.id}`)).size !== link.accounts.length) {
          throw new Error('关联缺少有效账号、确认时间或操作员证据');
        }
        this.links.push(link);
      }
    } catch (error) {
      this.links = [];
      this.error = (error as NodeJS.ErrnoException).code === 'ENOENT' ? '' : String(error);
      // A deleted registry must not leave a previously loaded binding active.
      this.stamp = '';
    }
  }
}

function segment(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160
    && value.trim() === value && !/[\\/\n\r\0]/.test(value) && value !== '.' && value !== '..';
}
