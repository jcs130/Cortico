import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorkspaceMemory } from '../../bots/cormini/persona/memory.ts';
import { workspaceTools } from '../../bots/cormini/persona/workspaceTools.ts';
import { memoryIndex, MEMORY_INDEX_MAX_CHARS, MEMORY_INDEX_MAX_FILES } from '../../bots/cortiv/persona/memory-index.ts';
import { nullLogger } from '../../src/core/util.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rig() {
  const memoryDir = mkdtempSync(join(tmpdir(), 'memory-index-')); dirs.push(memoryDir);
  return new GitWorkspaceMemory({ memoryDir });
}

describe('configured foreground Memory indexes', () => {
  it('reserves independent space for later sources and later project headings without changing either file', () => {
    const memory = rig();
    const large = '# 当前项目\n- 前期准备：' + '原始材料描述'.repeat(10000)
      + '\n- 桥面工程：待验收，详情 designs/bridge.md。\n- 自主探索：入口地图需核验。';
    const preferences = '# 生活意向\n- 结交同伴：尊重对方意愿。';
    memory.writeFileAtomic('goals/projects.md', large);
    memory.writeFileAtomic('goals/preferences.md', preferences);
    const view = memoryIndex(memory, 'goals/projects.md\ngoals/preferences.md');
    expect(view.length).toBeLessThanOrEqual(MEMORY_INDEX_MAX_CHARS);
    expect(view).toContain('桥面工程');
    expect(view).toContain('自主探索');
    expect(view).toContain('结交同伴');
    expect(view).toContain('designs/bridge.md');
    expect(view).toContain('没有与本版正文绑定的观察时间');
    expect(memory.readFile('goals/projects.md')).toBe(large);
    expect(memory.readFile('goals/preferences.md')).toBe(preferences);
  });

  it('uses original line numbers that read_file can expand and retains source status verbatim', async () => {
    const memory = rig();
    memory.writeFileAtomic('goals/projects.md', '# 项目\n\n- 桥：已取消，原因是选址变更。\n\n## 仍未验收\n- 外墙：需要确认防雨。\n');
    const view = memoryIndex(memory, 'goals/projects.md');
    expect(view).toContain('L3: - 桥：已取消，原因是选址变更。');
    expect(view).toContain('L6: - 外墙：需要确认防雨。');
    const tools = workspaceTools({ memory, writeGuard: () => null, readOverride: () => null, prefixResidentFiles: () => [] });
    const page = await tools.find(tool => tool.name === 'read_file')!.handler({ path: 'goals/projects.md', offset: 6, limit: 1 }, { role: 'main', log: nullLogger() });
    expect(page).toContain('第 6-6 行');
    expect(page).toContain('- 外墙：需要确认防雨。');
  });

  it('bounds many sources, reports unreadable and empty entries, and never reads outside Memory', () => {
    const memory = rig();
    memory.writeFileAtomic('empty.md', '');
    const paths = ['empty.md', '../outside.md', ...Array.from({ length: MEMORY_INDEX_MAX_FILES + 4 }, (_, i) => `missing-${i}.md`)];
    const view = memoryIndex(memory, paths.join('\n'));
    expect(view.length).toBeLessThanOrEqual(MEMORY_INDEX_MAX_CHARS);
    expect(view).toContain('文件为空');
    expect(view).toContain('文件不可读');
    expect(view).toContain(`超过本次 ${MEMORY_INDEX_MAX_FILES} 份的上限`);
    expect(view).toContain('不证明目标已完成或取消');
    expect(memoryIndex(memory, '')).toBe('');
    expect(memoryIndex(memory, 'empty.md\nempty.md').match(/【empty.md/g)).toHaveLength(1);
  });
});
