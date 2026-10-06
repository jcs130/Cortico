/** Provider-scoped background requests yield to foreground batches without committing partial output. */
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const FOREGROUND_YIELD = new Error('Generation yielded to foreground');

export interface BackgroundGenerationLease {
  signal: AbortSignal;
  yielded(): boolean;
  release(): void;
}

interface Resource {
  foreground: number;
  active: { controller: AbortController } | null;
  waiting: Array<() => void>;
}

export class GenerationScheduler {
  private readonly resources = new Map<string, Resource>();
  private readonly shutdown = new AbortController();

  get signal(): AbortSignal { return this.shutdown.signal; }

  private resource(key: string): Resource {
    let value = this.resources.get(key);
    if (!value) {
      value = { foreground: 0, active: null, waiting: [] };
      this.resources.set(key, value);
    }
    return value;
  }

  foreground(key: string): () => void {
    const value = this.resource(key);
    value.foreground++;
    value.active?.controller.abort(FOREGROUND_YIELD);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      value.foreground--;
      this.wake(value);
    };
  }

  async background(key: string, signal: AbortSignal, waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<BackgroundGenerationLease> {
    const value = this.resource(key);
    const waitingSignal = AbortSignal.any([signal, this.shutdown.signal, AbortSignal.timeout(waitTimeoutMs)]);
    waitingSignal.throwIfAborted();
    return new Promise<BackgroundGenerationLease>((resolve, reject) => {
      const remove = (): void => {
        waitingSignal.removeEventListener('abort', onAbort);
        const index = value.waiting.indexOf(acquire);
        if (index >= 0) value.waiting.splice(index, 1);
      };
      const onAbort = (): void => {
        remove();
        reject(waitingSignal.reason);
        this.wake(value);
      };
      const acquire = (): void => {
        if (value.foreground || value.active || value.waiting[0] !== acquire) return;
        remove();
        const active = { controller: new AbortController() };
        value.active = active;
        resolve({
          signal: AbortSignal.any([signal, this.shutdown.signal, active.controller.signal]),
          yielded: () => active.controller.signal.reason === FOREGROUND_YIELD,
          release: () => {
            if (value.active !== active) return;
            value.active = null;
            this.wake(value);
          },
        });
      };
      value.waiting.push(acquire);
      waitingSignal.addEventListener('abort', onAbort, { once: true });
      acquire();
    });
  }

  private wake(value: Resource): void {
    if (!value.foreground && !value.active) value.waiting[0]?.();
  }

  stop(): void {
    if (!this.shutdown.signal.aborted) this.shutdown.abort(new Error('Core stopped'));
  }
}
