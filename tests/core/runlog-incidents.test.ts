import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIpcLogger, emitLogNote, type LogNote } from '../../src/core/ipc-logger.ts';
import { Runlog } from '../../src/core/util.ts';

describe('跨进程异常快照', () => {
  it('子进程的非 error 卡住事件也带任务号落盘并保存此前上下文', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortico-incident-'));
    try {
      const incidents = join(dir, 'incidents');
      const runlog = new Runlog(join(dir, 'log.jsonl'), {
        run: 'r-test', incidentsDir: incidents, console: false,
        levels: () => ({ file: 'info', console: 'error', areas: '' }),
      });
      runlog.logger('core.loop').emit('info', '任务已投递', { event: 'deliver', task: 7, round: 12 });
      const notes: LogNote[] = [];
      const child = createIpcLogger((note) => notes.push(note), 'path');
      child.emit('debug', '门前卡住', {
        event: 'reset', task: 7, round: 12, incident: true,
        data: { position: { x: -490, y: 69, z: -434 }, doors: [{ x: -490, y: 69, z: -435, open: false }] },
      });
      expect(notes[0].incident).toBe(true);
      expect(notes[0].pid).toBe(process.pid);
      emitLogNote(runlog.logger('worlds.mymc'), notes[0], 'Asia/Shanghai');
      const saved = JSON.parse(readFileSync(join(incidents, readdirSync(incidents)[0]), 'utf8'));
      expect(saved.record).toMatchObject({
        area: 'worlds.mymc.path', event: 'reset', task: 7, round: 12, incident: true,
        pid: process.pid,
        data: { position: { x: -490, y: 69, z: -434 } },
      });
      expect(saved.recent).toEqual([expect.objectContaining({ event: 'deliver', task: 7 })]);
      expect(readFileSync(join(dir, 'log.jsonl'), 'utf8')).toContain('门前卡住');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
