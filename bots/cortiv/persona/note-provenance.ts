/** Note observation time is separate from file modification time and bound to its content revision. */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { relative } from 'node:path';
import type { ToolDef } from 'cortico/core/types.ts';
import type { GitWorkspaceMemory } from '../../cormini/persona/memory.ts';

export const NOTE_PROVENANCE_DIR = '.note-provenance';
export interface NoteObservation {
  observedUntilAt: string | null;
  source: string;
  worldFactsSampledAt?: string;
}
interface NoteProvenance extends NoteObservation {
  schemaVersion: 1;
  contentRevision: string;
  recordedAt: string;
}
const revision = (text: string): string => createHash('sha256').update(text).digest('hex');
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

export class MemoryNoteProvenance {
  constructor(private readonly memory: GitWorkspaceMemory) {}

  readFile(path: string): string {
    const body = this.memory.readFile(path);
    return `${this.describe(path)}\n${body}`;
  }

  private sidecar(path: string): string {
    const rel = relative(this.memory.memoryDir, this.memory.resolveSafe(path)).replace(/\\/g, '/');
    return `${NOTE_PROVENANCE_DIR}/${revision(process.platform === 'win32' ? rel.toLowerCase() : rel)}.json`;
  }

  observation(path: string): NoteProvenance | null {
    try {
      const value = JSON.parse(this.memory.readFile(this.sidecar(path))) as NoteProvenance;
      if (value.schemaVersion !== 1 || !timestamp(value.recordedAt)
        || (value.observedUntilAt !== null && !timestamp(value.observedUntilAt))
        || (value.worldFactsSampledAt !== undefined && !timestamp(value.worldFactsSampledAt))
        || typeof value.source !== 'string' || value.contentRevision !== revision(this.memory.readFile(path))) return null;
      return value;
    } catch { return null; }
  }

  stamp(path: string, observation: NoteObservation): void {
    if (observation.observedUntilAt !== null && !timestamp(observation.observedUntilAt)) throw new Error('Invalid note observation timestamp');
    if (observation.worldFactsSampledAt !== undefined && !timestamp(observation.worldFactsSampledAt)) throw new Error('Invalid World fact sampling timestamp');
    const value: NoteProvenance = { ...observation, schemaVersion: 1,
      contentRevision: revision(this.memory.readFile(path)), recordedAt: new Date().toISOString() };
    this.memory.writeFileAtomic(this.sidecar(path), JSON.stringify(value) + '\n');
  }

  conflict(path: string, observation: NoteObservation): string | null {
    const current = this.observation(path);
    if (!current?.observedUntilAt) return null;
    if (!observation.observedUntilAt || Date.parse(observation.observedUntilAt) < Date.parse(current.observedUntilAt)) {
      return `${path} 的现有摘要依据观察截止 ${current.observedUntilAt}；本任务观察截止 ${observation.observedUntilAt ?? '未记录'}，不能覆写较新的近期状态。可把有证据的旧经历写入历史记录。`;
    }
    return null;
  }

  describe(path: string): string {
    try {
      const modifiedAt = statSync(this.memory.resolveSafe(path)).mtime.toISOString();
      const observation = this.observation(path);
      const origin = observation
        ? `记录观察截止 ${observation.observedUntilAt ?? '未记录'}；整理写入于 ${observation.recordedAt}`
          + (observation.worldFactsSampledAt ? `；World 事实另采样于 ${observation.worldFactsSampledAt}` : '')
          + `；依据 ${observation.source}`
        : '没有与本版正文绑定的观察时间；事实时间须查正文或原始回执';
      return `[记忆来源 ${path}；文件修改于 ${modifiedAt}；${origin}。修改时间不代表事实发生时间，当前状态与较新回执对账。]`;
    } catch { return ''; }
  }

  readTool(tool: ToolDef): ToolDef {
    return { ...tool,
      description: tool.description + ' Memory reads include file modification time and available observation provenance; modification time does not establish when a fact occurred.',
      handler: async (args, ctx) => {
        const result = await tool.handler(args, ctx);
        if (typeof result !== 'string' || result.startsWith('[not found]')) return result;
        const annotation = this.describe(String(args.path ?? ''));
        return annotation ? `${annotation}\n${result}` : result;
      } };
  }
}
