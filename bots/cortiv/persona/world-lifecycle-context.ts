/** Current assembly state survives context compaction and Persona restarts. */
import type { World, WorldLifecycleEvent } from 'cortico/core/types.ts';

export const WORLD_LIFECYCLE_STATE_KEY = 'cortiv.worldLifecycle';

interface WorldState {
  id: string;
  label: string;
  mounted: boolean;
  visible?: boolean;
  observedAt: string;
  source: 'assembly' | 'lifecycle';
}

export class WorldLifecycleContext {
  private readonly states = new Map<string, WorldState>();

  restore(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id
        || typeof entry.label !== 'string' || typeof entry.mounted !== 'boolean'
        || (entry.visible !== undefined && typeof entry.visible !== 'boolean')
        || typeof entry.observedAt !== 'string' || !Number.isFinite(Date.parse(entry.observedAt))
        || (entry.source !== 'assembly' && entry.source !== 'lifecycle')) continue;
      this.states.set(entry.id, { id: entry.id, label: entry.label, mounted: entry.mounted,
        ...(entry.visible === undefined ? {} : { visible: entry.visible }),
        observedAt: entry.observedAt, source: entry.source });
    }
  }

  /** The mounted array is authoritative even when a prior process missed a lifecycle notification. */
  sync(worlds: readonly World[]): boolean {
    const mounted = new Set(worlds.map(world => world.id));
    let changed = false;
    for (const id of new Set([...this.states.keys(), ...mounted])) {
      const previous = this.states.get(id);
      if (previous?.mounted === mounted.has(id)) continue;
      this.states.set(id, { ...previous, id, label: previous?.label ?? id, mounted: mounted.has(id),
        observedAt: new Date().toISOString(), source: 'assembly' });
      changed = true;
    }
    return changed;
  }

  observe(event: WorldLifecycleEvent, worlds: readonly World[]): void {
    this.sync(worlds);
    const previous = this.states.get(event.id);
    this.states.set(event.id, { ...previous, id: event.id, label: event.label,
      mounted: worlds.some(world => world.id === event.id),
      ...(event.kind === 'visibility' ? { visible: event.visible } : {}),
      observedAt: new Date().toISOString(), source: 'lifecycle' });
  }

  snapshot(): WorldState[] {
    return [...this.states.values()].sort((a, b) => a.id.localeCompare(b.id)).map(state => ({ ...state }));
  }

  text(): string {
    const rows = this.snapshot().sort((a, b) => Number(a.mounted) - Number(b.mounted) || a.id.localeCompare(b.id));
    if (!rows.length) return '';
    return '[World 当前运行状态]\n本轮已挂载 World（完整清单）：'
      + (rows.filter(state => state.mounted).map(state => state.id).join('、') || '无')
      + '；清单之外当前未挂载。\n' + rows.map(state =>
      `${state.label} (${state.id})：${state.mounted ? '已挂载' : '未挂载'}${state.visible === undefined ? ''
        : state.visible ? '，对你可见' : '，对你隐藏，事件不再投递'}；${state.source === 'lifecycle' ? '生命周期通知' : '装配清单核对'} ${state.observedAt}`
    ).join('\n') + '\n未挂载 World 的旧位置、库存和任务回执仅供历史参考，当前不能通过它观察或行动。'
      + '停用本身不表示任务失败、卡顿或完成；按操作员安排保留待续目标。已挂载也不证明外部连接正常或任务已完成，仍需现场回执。';
  }
}
