/** Synchronous workspace tools use content revisions to reject stale background writes. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ToolDef } from 'cortico/core/types.ts';
import type { GitWorkspaceMemory } from '../../cormini/persona/memory.ts';
import { MemoryNoteProvenance, type NoteObservation } from './note-provenance.ts';

const FILE_WRITES = new Set(['write_file', 'edit_file', 'append_file', 'delete_file', 'save_blob']);
export function dreamWorkspaceTools(tools: readonly ToolDef[]): ToolDef[] {
  return tools.filter(tool => FILE_WRITES.has(tool.name) || (tool.tags.includes('read')
    && !tool.tags.some(tag => tag === 'write' || tag === 'flow' || tag === 'act' || tag === 'speak')));
}

export class DreamMemory {
  private readonly observed = new Map<string, string | null>();
  private readonly written = new Map<string, string | null>();
  private readonly pinned = new Map<string, string | null>();
  private mutated = false;
  private readonly currentNotes = new Map<string, NoteObservation>();
  private readonly provenance: MemoryNoteProvenance;

  constructor(private readonly memory: GitWorkspaceMemory, private readonly signal: AbortSignal) {
    this.provenance = new MemoryNoteProvenance(memory);
  }

  trackCurrentNote(path: string, observation: NoteObservation): void {
    this.currentNotes.set(this.path(path), observation);
  }

  get hasWrites(): boolean { return this.mutated; }

  private path(path: string): string {
    const absolute = this.memory.resolveSafe(path);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  }

  private revision(path: string): string | null {
    try { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** Seed versions read by the owner while constructing this task. */
  observe(path: string): void {
    const file = this.path(path);
    this.observed.set(file, this.revision(file));
  }

  /** Current-state notes cannot merge a newer writer's state from this task's captured history. */
  pin(path: string): void {
    const file = this.path(path);
    if (this.pinned.has(file)) return;
    const revision = this.revision(file);
    this.observed.set(file, revision);
    this.pinned.set(file, revision);
  }

  ownsCurrent(path: string): boolean {
    const file = this.path(path);
    return this.written.has(file) && this.written.get(file) === this.revision(file);
  }

  tools(tools: readonly ToolDef[]): ToolDef[] {
    return dreamWorkspaceTools(tools).map(tool => ({ ...tool, handler: async (args, ctx) => {
      this.signal.throwIfAborted();
      const read = tool.name === 'read_file';
      const write = tool.tags.includes('write');
      if (!read && !write) return tool.handler(args, ctx);
      let file: string;
      let before: string | null;
      try { file = this.path(String(args.path ?? '')); before = this.revision(file); }
      catch (error) {
        if (!write) return tool.handler(args, ctx);
        return { failed: true as const, text: `[memory failed] ${String(error)}；未写入。` };
      }
      if (write && this.pinned.has(file) && this.pinned.get(file) !== before) {
        return { failed: true as const,
          text: `[memory conflict] ${String(args.path)} 已由其他线程更新；本任务捕获的经历不能覆写较新的近期状态，重新读取也不解除此限制。请保留现有短笺，把本次有证据的经历存入场次记录或在结论中注明观察截止时间。未写入。` };
      }
      const observation = this.currentNotes.get(file);
      if (write && observation) {
        const conflict = this.provenance.conflict(String(args.path), observation);
        if (conflict) return { failed: true as const, text: `[memory conflict] ${conflict} 未写入。` };
      }
      if (write && before !== null && !this.observed.has(file)) {
        return { failed: true as const,
          text: `[memory conflict] ${String(args.path)} 尚未读取当前版本；先 read_file，再决定如何合并。未写入。` };
      }
      if (write && this.observed.has(file) && this.observed.get(file) !== before) {
        return { failed: true as const,
          text: `[memory conflict] ${String(args.path)} 在本任务读取后已改变；先 read_file 核对新内容，再决定如何合并。未写入。` };
      }
      // Workspace handlers perform their file operation before their first await.
      // Keep that revision even when a foreground write happens during Git commit.
      const operation = tool.handler(args, ctx);
      const after = this.revision(file);
      if (read) this.observed.set(file, before);
      if (write && after !== before) {
        this.mutated = true;
        this.observed.set(file, after);
        this.written.set(file, after);
        if (this.pinned.has(file)) this.pinned.set(file, after);
        if (observation && after !== null) this.provenance.stamp(String(args.path), observation);
      }
      return operation;
    } }));
  }
}
