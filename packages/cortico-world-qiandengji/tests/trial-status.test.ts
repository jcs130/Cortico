import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTrialStatus, TrialProgress, trialGoalLimitNote } from '../src/trial-status.ts';

describe('trial status limits', () => {
  const status = parseTrialStatus('[MC 系统] MC_DUNGEON status participant=true globalActive=true globalFloor=1 maxFloor=15 selfFloor=0 lastOutcome=won lastFloor=15 lastReason=cleared');

  it('reads the server cap and prior clear from the actual status receipt', () => {
    expect(status).toEqual({ maxFloor: 15, lastFloor: 15, lastOutcome: 'won', globalActive: true, participant: true });
    expect(parseTrialStatus('[MC 系统] 第 15/15 层已通关')).toBeNull();
  });

  it('refuses invented floors, then permits them if the server later expands', () => {
    const goal = { add: { target: '试炼塔L16+', text: '再冲 L16+' } };
    expect(trialGoalLimitNote(goal, null)).toContain('/mycli arena status');
    expect(trialGoalLimitNote(goal, status)).toContain('当前没有 L16');
    expect(trialGoalLimitNote({ add: { target: '试炼塔L15' } }, status)).toBeNull();
    expect(trialGoalLimitNote(goal, { ...status!, maxFloor: 20 })).toBeNull();
    expect(trialGoalLimitNote({ add: { target: '地下城第16层' } }, status)).toBeNull();
  });

  it('retains full clear across a later failed run and permits explicit reward farming', () => {
    const progress = new TrialProgress('server:25565:agent');
    progress.observe('[MC 系统] 第 15/15 层已通关！', '2026-10-02T12:14:59+08:00');
    progress.observe('[MC 系统] MC_DUNGEON status participant=false globalActive=false maxFloor=15 lastOutcome=failed lastFloor=1', '2026-10-02T12:24:49+08:00');
    expect(trialGoalLimitNote({ add: { target: '试炼塔L15全通' } }, progress.status, progress.clear)).toContain('不会撤销历史通关');
    expect(trialGoalLimitNote({ add: { target: '试炼塔L15刷奖励' } }, progress.status, progress.clear)).toBeNull();
    progress.observe('[MC 系统] MC_DUNGEON status participant=false globalActive=false maxFloor=15 lastOutcome=won lastFloor=15', '2026-10-02T12:29:00+08:00');
    expect(progress.clear?.at).toBe('2026-10-02T12:14:59+08:00');
    progress.observe('[MC 系统] 队伍离开本层超过 15 秒；已赢得的奖励保存在个人箱子里。', '2026-10-02T12:50:58+08:00');
    expect(progress.lastRunEndedAt).toBe('2026-10-02T12:50:58+08:00');
  });

  it('recovers a verified full-clear event from past runs and persists it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mymc-trial-'));
    try {
      const run = join(dir, 'runs', 'r-20261002-113514');
      mkdirSync(run, { recursive: true });
      writeFileSync(join(run, 'events.jsonl'), [
        JSON.stringify({ type: 'handoff-note', ts: '2026-10-02T12:15:00+08:00', text: '[MC 系统] 第 99/99 层已通关' }),
        JSON.stringify({ type: 'mymc.chat', ts: '2026-10-02T12:14:59+08:00', text: '[MC 系统] 第 15/15 层已通关！' }),
        JSON.stringify({ type: 'mymc.chat', ts: '2026-10-02T12:50:58+08:00', text: '[MC 系统] 队伍离开本层超过 15 秒；已赢得的奖励保存在个人箱子里。' }),
      ].join('\n'));
      const progress = new TrialProgress('server:25565:agent', dir);
      expect(progress.clear?.floor).toBe(15);
      expect(progress.clear?.at).toBe('2026-10-02T12:14:59+08:00');
      expect(progress.lastRunEndedAt).toBe('2026-10-02T12:50:58+08:00');
      expect(JSON.parse(readFileSync(join(dir, 'mymc-trial-progress.json'), 'utf8')).clear.floor).toBe(15);
      expect(new TrialProgress('other-server', dir).clear).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
