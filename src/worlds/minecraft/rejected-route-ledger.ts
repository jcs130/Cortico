import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { SkillCall } from './executor.ts';

const HOLD_MS = 15 * 60_000;
const MAX_RECORDS = 8;

type RejectedRoute = { key: string; steps: SkillCall[]; atMs: number };

function absolutePoint(step: SkillCall): [number, number, number] | null {
  if (!('at' in step)) return null;
  const at = step.at;
  return Array.isArray(at) && at.length === 3
    && at.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))
    ? at as [number, number, number] : null;
}

function sameWaterShaft(key: string, steps: readonly SkillCall[]): boolean {
  const cell = /^shaft-liquid:(-?\d+):(-?\d+):(-?\d+):(水|岩浆)$/.exec(key);
  if (!cell) return false;
  const [, sx, sy, sz] = cell;
  const [x, y, z] = [Number(sx), Number(sy), Number(sz)];
  const goto = steps.find((step) => step.skill === 'goto');
  const start = goto && absolutePoint(goto);
  if (!start || Math.hypot(start[0] - x, start[2] - z) > 4 || start[1] < y || start[1] > y + 10) return false;
  return steps.some((step) => step.skill === 'tunnel' && Array.isArray(step.at)
    && step.at.length === 3 && typeof step.at[1] === 'string'
    && /^~-\d+$/.test(step.at[1]) && start[1] + Number(step.at[1].slice(1)) <= y);
}

/** 只保存已经连续拒收且触发脱困的路线，重载 World 后也不把它当新路线再跑一遍。 */
export class RejectedRouteLedger {
  private records: RejectedRoute[] = [];

  constructor(private readonly path: string | null, now = Date.now()) {
    if (!path || !existsSync(path)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !('records' in parsed)
        || !Array.isArray(parsed.records)) return;
      this.records = parsed.records.filter((row: unknown): row is RejectedRoute => {
        if (!row || typeof row !== 'object') return false;
        const r = row as Partial<RejectedRoute>;
        return typeof r.key === 'string' && r.key.length <= 200
          && Array.isArray(r.steps) && r.steps.length <= 16
          && typeof r.atMs === 'number' && Number.isFinite(r.atMs)
          && r.atMs <= now && now - r.atMs < HOLD_MS;
      }).slice(-MAX_RECORDS);
    } catch { /* corrupt or older ledger: keep running with an empty guard */ }
  }

  match(steps: readonly SkillCall[], now = Date.now()): string | null {
    const signature = JSON.stringify(steps);
    return this.records.find((r) => now - r.atMs < HOLD_MS
      && (JSON.stringify(r.steps) === signature || sameWaterShaft(r.key, steps)))?.key ?? null;
  }

  record(key: string, steps: readonly SkillCall[], now = Date.now()): void {
    this.records = this.records.filter((r) => r.key !== key && now - r.atMs < HOLD_MS);
    this.records.push({ key, steps: [...steps], atMs: now });
    this.records = this.records.slice(-MAX_RECORDS);
    if (this.path) {
      try { writeFileSync(this.path, JSON.stringify({ version: 1, records: this.records })); }
      catch { /* no persistence available; current process still guards the route */ }
    }
  }
}
