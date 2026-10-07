/** Bounded excerpts of explicitly configured Memory sources; source text retains its own meaning. */
import type { GitWorkspaceMemory } from '../../cormini/persona/memory.ts';
import { MemoryNoteProvenance } from './note-provenance.ts';

export const MEMORY_INDEX_MAX_CHARS = 4_000;
export const MEMORY_INDEX_MAX_FILES = 8;
const MAX_ENTRIES = 16;

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + '…' : text;
}

/** Line numbers point into the original file; clipping does not assign or change project status. */
function outline(body: string, maxChars: number): string {
  if (!body.trim()) return clip('[文件为空；没有可展示的原文。]', maxChars);
  const lines = body.split(/\r?\n/);
  const first = lines.findIndex(line => line.trim());
  const entries = lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    return index === first || /^ {0,3}#{1,6}\s|^(?:[-*+] |\d+[.)] )/.test(line)
      ? [`L${index + 1}: ${line.trim()}`] : [];
  });
  // Plain prose also gets a reading window after its title.
  if (entries.length < 2) {
    for (let index = first + 1; index < lines.length && entries.length < MAX_ENTRIES; index++) {
      if (lines[index].trim()) entries.push(`L${index + 1}: ${lines[index].trim()}`);
    }
  }
  const selected = entries.length <= MAX_ENTRIES ? entries
    : Array.from({ length: MAX_ENTRIES }, (_, index) => entries[Math.round(index * (entries.length - 1) / (MAX_ENTRIES - 1))]);
  const notice = '\n[原文节选；未展示的内容及完整状态用 read_file 按行展开，Ln 对应 offset:n。]';
  const budget = Math.max(0, maxChars - notice.length - Math.max(0, selected.length - 1));
  const cap = selected.length ? Math.floor(budget / selected.length) : 0;
  return clip(selected.map(entry => clip(entry, cap)).join('\n') + notice, maxChars);
}

export function memoryIndex(memory: GitWorkspaceMemory, configuredFiles: string): string {
  const paths = [...new Set(configuredFiles.split('\n').map(path => path.trim()).filter(Boolean))];
  if (!paths.length) return '';
  const files = paths.slice(0, MEMORY_INDEX_MAX_FILES);
  const header = '[长期记忆索引] 独立于近期短笺的已配置入口。以下是原文意向和历史线索，未列出或文件不可读不证明目标已完成或取消；当前读数与结果核对较新的 World 事实和回执。\n';
  const overflow = paths.length > files.length ? `\n[另有 ${paths.length - files.length} 个配置入口超过本次 ${MEMORY_INDEX_MAX_FILES} 份的上限，未展开。]` : '';
  const budget = Math.floor((MEMORY_INDEX_MAX_CHARS - header.length - overflow.length - files.length * 2) / files.length);
  const provenance = new MemoryNoteProvenance(memory);
  const excerpts = files.map(path => {
    const title = `【${clip(path, 240)}；read_file 读取全文】\n`;
    try {
      const body = memory.readFile(path);
      const source = clip(provenance.describe(path), Math.min(260, budget - title.length - 80));
      return title + source + '\n' + outline(body, budget - title.length - source.length - 1);
    } catch {
      return clip(title + '[文件不可读；需要核对入口或检索原记录，旧节选仅作历史线索。]', budget);
    }
  });
  return header + excerpts.join('\n\n') + overflow;
}
