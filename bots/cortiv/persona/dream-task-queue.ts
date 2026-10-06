/** Background tasks have one lifetime budget across queueing, retries and generation. */
export class DreamTaskStoppedError extends Error {
  constructor() { super('后台整理已停止'); this.name = 'DreamTaskStoppedError'; }
}
export class DreamTaskTimeoutError extends Error {
  constructor() { super('后台整理超过总耗时上限'); this.name = 'DreamTaskTimeoutError'; }
}

export interface DreamTaskOptions {
  timeoutMs: number;
  maxPendingTasks: number;
  label?: string;
  onError(error: unknown): void;
}
export interface DreamTaskInfo { id: number; label: string; queuedAt: string; deadlineAt: string; }
export interface DreamTaskState {
  enabled: boolean;
  currentTask: DreamTaskInfo | null;
  queuedTasks: DreamTaskInfo[];
  lastOutcome: (DreamTaskInfo & {
    status: 'completed' | 'failed' | 'cancelled' | 'timedout'; finishedAt: string; error: string | null;
  }) | null;
}
interface Task {
  run(signal: AbortSignal): Promise<void>;
  options: DreamTaskOptions;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  info: DreamTaskInfo;
}

/** Abort also settles waits when an upstream client ignores cancellation. */
export function dreamAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(signal.reason); };
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export function dreamDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class DreamTaskQueue {
  private enabled = true;
  private active: Task | null = null;
  private readonly pending: Task[] = [];
  private sequence = 0;
  private lastOutcome: DreamTaskState['lastOutcome'] = null;

  state(): DreamTaskState {
    return { enabled: this.enabled, currentTask: this.active ? { ...this.active.info } : null,
      queuedTasks: this.pending.map(task => ({ ...task.info })),
      lastOutcome: this.lastOutcome ? { ...this.lastOutcome } : null };
  }

  start(): void { this.enabled = true; this.pump(); }

  stop(): void {
    this.enabled = false;
    const error = new DreamTaskStoppedError();
    for (const task of [...this.pending]) task.controller.abort(error);
    this.active?.controller.abort(error);
  }

  enqueue(run: Task['run'], options: DreamTaskOptions): boolean {
    if (!this.enabled || (this.active && this.pending.length >= options.maxPendingTasks)) return false;
    const controller = new AbortController();
    const now = Date.now();
    const task: Task = { run, options, controller,
      info: { id: ++this.sequence, label: options.label ?? '', queuedAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + options.timeoutMs).toISOString() },
      timer: setTimeout(() => controller.abort(new DreamTaskTimeoutError()), options.timeoutMs) };
    task.timer.unref?.();
    controller.signal.addEventListener('abort', () => {
      const index = this.pending.indexOf(task);
      if (index < 0) return;
      this.pending.splice(index, 1);
      clearTimeout(task.timer);
      this.finish(task, controller.signal.reason);
      options.onError(controller.signal.reason);
    }, { once: true });
    this.pending.push(task);
    this.pump();
    return true;
  }

  private pump(): void {
    if (!this.enabled || this.active || !this.pending.length) return;
    const task = this.pending.shift()!;
    this.active = task;
    void Promise.resolve().then(async () => {
      task.controller.signal.throwIfAborted();
      await dreamAbortable(task.run(task.controller.signal), task.controller.signal);
      this.finish(task);
    }).catch(error => { this.finish(task, error); task.options.onError(error); }).finally(() => {
      clearTimeout(task.timer);
      if (this.active === task) this.active = null;
      this.pump();
    });
  }

  private finish(task: Task, error?: unknown): void {
    this.lastOutcome = { ...task.info, finishedAt: new Date().toISOString(),
      status: error === undefined ? 'completed' : error instanceof DreamTaskStoppedError ? 'cancelled'
        : error instanceof DreamTaskTimeoutError ? 'timedout' : 'failed',
      error: error === undefined ? null : String(error) };
  }
}
