import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorkspaceMemory } from '../../bots/cormini/persona/memory.ts';
import { workspaceTools } from '../../bots/cormini/persona/workspaceTools.ts';
import { MemoryNoteProvenance } from '../../bots/cortiv/persona/note-provenance.ts';
import { DreamMemory } from '../../bots/cortiv/persona/dream-memory.ts';
import { nullLogger } from '../../src/core/util.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'note-provenance-')); dirs.push(dir);
  const memory = new GitWorkspaceMemory({ memoryDir: dir });
  const provenance = new MemoryNoteProvenance(memory);
  const tools = workspaceTools({ memory, writeGuard: () => null, readOverride: () => null, prefixResidentFiles: () => [] });
  return { dir, memory, provenance, tools };
}
const ctx = { role: 'dream', log: nullLogger() };
const oldAt = '2026-08-01T10:00:00Z';
const newAt = '2026-08-01T11:00:00Z';

describe('Memory note observation provenance', () => {
  it('distinguishes file modification, captured observation and later World sampling', () => {
    const r = rig(); r.memory.writeFileAtomic('recent.md', '旧观察里仍在整理物品');
    r.provenance.stamp('recent.md', { observedUntilAt: oldAt, worldFactsSampledAt: newAt, source: 'record 21-37' });
    const modified = new Date('2026-08-02T00:00:00Z');
    utimesSync(join(r.dir, 'recent.md'), modified, modified);
    const header = r.provenance.describe('./recent.md');
    expect(header).toContain(`文件修改于 ${modified.toISOString()}`);
    expect(header).toContain(`记录观察截止 ${oldAt}`);
    expect(header).toContain(`World 事实另采样于 ${newAt}`);
    expect(header).toContain('修改时间不代表事实发生时间');
  });

  it('never gives an undated legacy note an observation time and invalidates stale metadata after edits', () => {
    const r = rig(); r.memory.writeFileAtomic('note.md', '曾经见过一组物品');
    expect(r.provenance.describe('note.md')).toContain('没有与本版正文绑定的观察时间');
    r.provenance.stamp('note.md', { observedUntilAt: oldAt, source: 'event 17' });
    r.memory.writeFileAtomic('note.md', '新内容，未注明观察时间');
    expect(r.provenance.observation('note.md')).toBeNull();
    expect(r.provenance.describe('note.md')).not.toContain('event 17');
  });

  it('adds provenance to paged reads without changing line offsets or note contents', async () => {
    const r = rig(); r.memory.writeFileAtomic('note.md', '过去\n现在\n');
    const reader = r.provenance.readTool(r.tools.find(tool => tool.name === 'read_file')!);
    const page = await reader.handler({ path: 'note.md', offset: 2, limit: 1 }, ctx);
    expect(page).toContain('[note.md 第 2-2 行,共 2 行]\n现在');
    expect(page).toContain('没有与本版正文绑定的观察时间');
    expect(r.memory.readFile('note.md')).toBe('过去\n现在\n');
    expect(await reader.handler({ path: 'missing.md' }, ctx)).toBe('[not found] missing.md');
  });

  it('rejects older or undated captured history even when it starts after a newer summary was written', async () => {
    const r = rig(); r.memory.writeFileAtomic('recent.md', '较新目标已完成');
    r.provenance.stamp('recent.md', { observedUntilAt: newAt, source: 'new receipts' });
    for (const observedUntilAt of [oldAt, null]) {
      const access = new DreamMemory(r.memory, new AbortController().signal);
      access.pin('recent.md'); access.trackCurrentNote('recent.md', { observedUntilAt, source: 'captured older receipts' });
      const result = await access.tools(r.tools).find(tool => tool.name === 'write_file')!.handler(
        { path: 'recent.md', content: '旧方案尚未完成' }, ctx);
      expect(result).toMatchObject({ failed: true });
      expect(r.memory.readFile('recent.md')).toBe('较新目标已完成');
      expect(access.hasWrites).toBe(false);
    }
  });

  it('binds a newer successful summary to its real capture time and preserves independent historical writes', async () => {
    const r = rig(); r.memory.writeFileAtomic('recent.md', '旧状态');
    r.provenance.stamp('recent.md', { observedUntilAt: oldAt, source: 'old receipt' });
    const access = new DreamMemory(r.memory, new AbortController().signal);
    access.pin('recent.md'); access.trackCurrentNote('recent.md', { observedUntilAt: newAt, source: 'new receipt' });
    const tools = access.tools(r.tools);
    await tools.find(tool => tool.name === 'write_file')!.handler({ path: './recent.md', content: '新状态' }, ctx);
    expect(r.provenance.observation('recent.md')).toMatchObject({ observedUntilAt: newAt, source: 'new receipt' });
    expect(access.ownsCurrent('recent.md')).toBe(true);
    await tools.find(tool => tool.name === 'write_file')!.handler({ path: 'history.md', content: '有日期的旧经历' }, ctx);
    expect(r.memory.readFile('history.md')).toBe('有日期的旧经历');
    expect(r.provenance.observation('history.md')).toBeNull();
  });
});
