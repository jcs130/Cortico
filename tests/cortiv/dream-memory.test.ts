import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorkspaceMemory } from '../../bots/cormini/persona/memory.ts';
import { workspaceTools } from '../../bots/cormini/persona/workspaceTools.ts';
import { saveBlobTool } from '../../bots/cormini/persona/blobs.ts';
import { DreamMemory } from '../../bots/cortiv/persona/dream-memory.ts';
import { DreamContext, DREAM_DEFAULTS } from '../../bots/cortiv/persona/dream-context.ts';
import type { ToolDef, ToolOutcome } from '../../src/core/types.ts';
import { nullLogger } from '../../src/core/util.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const ctx = { role: 'dream', log: nullLogger() };
function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'dream-memory-')); dirs.push(dir);
  const memory = new GitWorkspaceMemory({ memoryDir: dir });
  const controller = new AbortController();
  const access = new DreamMemory(memory, controller.signal);
  const tools = workspaceTools({ memory, writeGuard: () => null, readOverride: () => null, prefixResidentFiles: () => [] });
  const run = async (name: string, args: Record<string, unknown>): Promise<string | ToolOutcome> => access.tools(tools).find(tool => tool.name === name)!.handler(args, ctx);
  return { dir, memory, controller, access, tools, run };
}
function conflict(result: string | ToolOutcome): void {
  expect(typeof result).toBe('object');
  expect((result as ToolOutcome).failed).toBe(true);
  expect((result as ToolOutcome).text).toContain('memory conflict');
}

describe('background Memory versions', () => {
  it('keeps a pinned current-state note after another writer advances it, even after a fresh read', async () => {
    const r = rig(); r.memory.writeFileAtomic('recent.md', '捕获时的状态');
    r.access.pin('recent.md');
    await r.run('write_file', { path: 'recent.md', content: '后台补充的状态' });
    await r.run('append_file', { path: 'recent.md', content: '同一任务补充' });
    expect(r.memory.readFile('recent.md')).toBe('后台补充的状态\n同一任务补充');
    r.memory.writeFileAtomic('recent.md', '前台新的位置与进度');
    await r.run('read_file', { path: './recent.md' });
    r.access.pin('recent.md');
    for (const [name, args] of [
      ['write_file', { content: '旧材料重写' }], ['edit_file', { old_string: '前台新的位置与进度', new_string: '旧状态' }],
      ['append_file', { content: '旧状态补充' }], ['delete_file', {}],
    ] as Array<[string, Record<string, unknown>]>) conflict(await r.run(name, { path: 'recent.md', ...args }));
    expect(r.memory.readFile('recent.md')).toBe('前台新的位置与进度');
    expect(r.access.ownsCurrent('recent.md')).toBe(false);
    const next = new DreamMemory(r.memory, new AbortController().signal);
    next.pin('recent.md');
    await next.tools(r.tools).find(tool => tool.name === 'append_file')!.handler(
      { path: 'recent.md', content: '新任务捕获的经历' }, ctx);
    expect(r.memory.readFile('recent.md')).toBe('前台新的位置与进度\n新任务捕获的经历');
  });

  it('requires an observed version before rewriting existing files and allows new files', async () => {
    const r = rig(); r.memory.writeFileAtomic('note.md', '前台新事实');
    conflict(await r.run('write_file', { path: 'note.md', content: '旧整理' }));
    expect(r.memory.readFile('note.md')).toBe('前台新事实');
    expect(r.access.hasWrites).toBe(false);
    expect(await r.run('write_file', { path: 'new.md', content: '新记录' })).toContain('[written]');
    expect(r.memory.readFile('new.md')).toBe('新记录');
    expect(r.access.hasWrites).toBe(true);
  });

  it('rejects stale rewrite, edit, append and delete; a fresh read permits a merged write', async () => {
    const r = rig(); r.memory.writeFileAtomic('note.md', '原记录');
    await r.run('read_file', { path: 'note.md' });
    r.memory.writeFileAtomic('note.md', '前台更新');
    for (const [name, args] of [
      ['write_file', { content: '旧记录' }], ['edit_file', { old_string: '前台更新', new_string: '被覆写' }],
      ['append_file', { content: '旧整理' }], ['delete_file', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      conflict(await r.run(name, { path: 'note.md', ...args }));
    }
    expect(r.memory.readFile('note.md')).toBe('前台更新');
    expect(r.access.hasWrites).toBe(false);
    await r.run('read_file', { path: './note.md' });
    await r.run('append_file', { path: 'note.md', content: '合并补充' });
    expect(r.memory.readFile('note.md')).toBe('前台更新\n合并补充');
    expect(r.access.ownsCurrent('note.md')).toBe(true);
  });

  it('does not adopt a foreground version arriving while the background Git commit awaits', async () => {
    const r = rig(); r.memory.writeFileAtomic('note.md', '原记录');
    const base = r.tools.find(tool => tool.name === 'append_file')!;
    let release!: () => void;
    const committed: ToolDef = { ...base, handler: async (args, context) => {
      const result = base.handler(args, context);
      await new Promise<void>(resolve => { release = resolve; });
      return result;
    } };
    await r.run('read_file', { path: 'note.md' });
    const writing = r.access.tools([committed])[0].handler({ path: 'note.md', content: '后台补充' }, ctx);
    expect(r.memory.readFile('note.md')).toBe('原记录\n后台补充');
    r.memory.writeFileAtomic('note.md', '更新的前台记录');
    release(); await writing;
    expect(r.access.ownsCurrent('note.md')).toBe(false);
    conflict(await r.run('append_file', { path: 'note.md', content: '再追加' }));
    expect(r.memory.readFile('note.md')).toBe('更新的前台记录');
  });

  it('tracks successful edits and deletions of the observed version', async () => {
    const r = rig(); r.memory.writeFileAtomic('note.md', '原记录');
    await r.run('read_file', { path: 'note.md' });
    await r.run('edit_file', { path: 'note.md', old_string: '原记录', new_string: '已核对的记录' });
    expect(r.memory.readFile('note.md')).toBe('已核对的记录');
    expect(r.access.ownsCurrent('note.md')).toBe(true);
    await r.run('delete_file', { path: 'note.md' });
    expect(r.memory.listDir()).not.toContain('note.md');
    expect(r.access.hasWrites).toBe(true);
    expect(r.access.ownsCurrent('note.md')).toBe(true);
  });

  it('keeps the revision of the first paged read until the caller asks for a fresh read', async () => {
    const r = rig(); r.memory.writeFileAtomic('note.md', '旧记录'.repeat(1000));
    const reading = new DreamContext({ ...DREAM_DEFAULTS, maxReadTokensPerRound: 200 }, r.access.tools(r.tools),
      { file: 'archive', append: text => r.memory.appendFile('archive', text) }, nullLogger());
    const reader = reading.tools.find(tool => tool.name === 'read_file')!;
    const page = await reader.handler({ path: 'note.md' }, ctx) as ToolOutcome;
    const cursor = /readCursor=([^\]]+)/.exec(page.text)![1];
    r.memory.writeFileAtomic('note.md', '前台更新');
    reading.prepareRequest({ round: 1, messages: [] });
    await reader.handler({ path: 'note.md', readCursor: cursor }, ctx);
    conflict(await r.run('append_file', { path: 'note.md', content: '追加' }));
    reading.prepareRequest({ round: 2, messages: [] });
    await reader.handler({ path: 'note.md' }, ctx);
    await r.run('append_file', { path: 'note.md', content: '追加' });
    expect(r.memory.readFile('note.md')).toBe('前台更新\n追加');
  });

  it('guards binary saves and never falls through to an unguarded mutation on invalid paths', async () => {
    const r = rig(); r.memory.blobs.put('blobs/a.bin', new Uint8Array([1]), 'application/octet-stream');
    const save = saveBlobTool({ blobs: r.memory.blobs, core: () => ({ blob: () => ({ bytes: new Uint8Array([2]), mime: 'application/octet-stream' }) }) as never });
    const guarded = r.access.tools([save])[0];
    conflict(await guarded.handler({ path: 'blobs/a.bin', handle: 'log:test' }, ctx));
    await r.run('read_file', { path: 'blobs/a.bin' });
    await guarded.handler({ path: 'blobs/a.bin', handle: 'log:test' }, ctx);
    expect([...readFileSync(join(r.dir, 'blobs/a.bin'))]).toEqual([2]);
    expect(r.access.hasWrites).toBe(true);
    const invalid = await guarded.handler({ path: '../escape.bin', handle: 'log:test' }, ctx) as ToolOutcome;
    expect(invalid.failed).toBe(true);
  });

  it('drops non-file write and flow tools and blocks every late mutation after cancellation', async () => {
    const r = rig();
    const foreign = (name: string, tag: 'write' | 'flow'): ToolDef => ({ name, description: '', tags: [tag],
      parameters: { type: 'object' }, handler: async () => { throw new Error('must not execute'); } });
    expect(r.access.tools([foreign('pending_work', 'write'), foreign('expand_context', 'flow')])).toEqual([]);
    r.controller.abort(new Error('stopped'));
    await expect(r.run('write_file', { path: 'late.md', content: '迟到' })).rejects.toThrow('stopped');
    expect(r.memory.listDir()).not.toContain('late.md');
    expect(r.access.hasWrites).toBe(false);
  });
});
