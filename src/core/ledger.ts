import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  appendFile,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import type { ActionRecord } from "./types.ts";
export class ActionLedger {
  readonly actions = new Map<string, ActionRecord>();
  private readonly requests = new Map<string, ActionRecord>();
  private writing = Promise.resolve();
  constructor(private readonly directory: string) {}
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    // Preserve the caller's error, but let a later receipt retry the journal.
    // One transient Windows file lock must not poison every future operation.
    const pending = this.writing.catch(() => {}).then(operation);
    this.writing = pending.then(() => {});
    void this.writing.catch(() => {});
    return pending;
  }
  async start(progress?: (phase: string) => void) {
    progress?.('ledger-snapshot');
    await mkdir(this.directory, { recursive: true });
    let loaded: ActionRecord[] = [];
    try {
      loaded = JSON.parse(
        await readFile(join(this.directory, "actions.json"), "utf8"),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    // The full snapshot is also a rollback/export format. Individual durable
    // receipts overlay it, so a busy renderer never rewrites the whole history.
    const records = new Map(loaded.map(row => [row.id, row]));
    await mkdir(join(this.directory, 'action-records'), { recursive: true });
    const files = (await readdir(join(this.directory, 'action-records')))
      .filter(file => /^[a-f0-9]{64}\.json$/.test(file));
    progress?.('ledger-receipts');
    // Receipts are independent immutable reads during restoration. Bound the
    // open files instead of making every cold-file latency block the next one.
    let next = 0, failed = false;
    const receipts: ActionRecord[] = new Array(files.length);
    const readers = await Promise.allSettled(Array.from({length: Math.min(8, files.length)}, async () => {
      while (!failed) {
        const index = next++;
        if (index >= files.length) return;
        const file = files[index];
        try {
          const row: ActionRecord = JSON.parse(await readFile(join(this.directory, 'action-records', file), 'utf8'));
          if (this.recordName(row.id) !== file) throw Error('Action record identity mismatch');
          receipts[index] = row;
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }));
    const failure = readers.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    // Preserve replay order for equal timestamps regardless of disk completion order.
    for (const row of receipts) {
      const old = records.get(row.id);
      if (!old || row.updatedAt > old.updatedAt) records.set(row.id, row);
    }
    loaded = [...records.values()].sort((a,b) => a.createdAt - b.createdAt);
    for (const row of loaded) {
      if (["queued", "playing"].includes(row.status)) {
        row.status = "failed";
        row.evidence = {
          reason:
            "Stage restarted before execution was reconciled; not replayed",
        };
        row.updatedAt = Date.now();
      }
      this.actions.set(row.id, row);
      this.requests.set(row.requestId, row);
    }
    progress?.('ledger-checkpoint');
    await this.enqueue(() => this.save());
  }
  async submit(
    requestId: string,
    kind: string,
    avatarId: string | null,
    command: Record<string, unknown>,
  ) {
    return this.enqueue(async () => {
      const canonical = (v: any): any =>
        Array.isArray(v)
          ? v.map(canonical)
          : v && typeof v === "object"
            ? Object.fromEntries(
                Object.keys(v)
                  .sort()
                  .map((k) => [k, canonical(v[k])]),
              )
            : v;
      const key = createHash("sha256")
        .update(JSON.stringify(canonical({ kind, avatarId, command })))
        .digest("hex");
      const old = this.requests.get(requestId);
      if (old) {
        if (old.key !== key)
          throw Error("Request id belongs to another action");
        await this.save(old);
        return { record: old, reused: true };
      }
      const now = Date.now(),
        record: ActionRecord = {
          id: randomUUID(),
          requestId,
          key,
          kind,
          avatarId,
          status: "queued",
          createdAt: now,
          updatedAt: now,
          command,
        };
      await this.audit({ type: "request", record });
      this.actions.set(record.id, record);
      this.requests.set(record.requestId, record);
      await this.save(record);
      return { record, reused: false };
    });
  }
  async update(
    actionId: string,
    status: ActionRecord["status"],
    evidence: Record<string, unknown>,
  ) {
    return this.enqueue(async () => {
      const row = this.actions.get(actionId);
      if (!row) throw Error("Unknown action");
      const ignored = ["completed", "failed", "cancelled"].includes(row.status);
      await this.audit({
        type: "receipt",
        actionId,
        status,
        evidence,
        ignored,
      });
      if (!ignored) {
        row.status = status;
        row.updatedAt = Date.now();
        row.evidence = evidence;
      }
      // Also repair a snapshot whose prior write failed after its audit append.
      await this.save(row);
      return row;
    });
  }
  result(id: string) {
    const row = this.actions.get(id);
    if (!row) throw Error("Unknown action");
    return structuredClone(row);
  }
  history(limit = 20) {
    return [...this.actions.values()]
      .slice(-limit)
      .reverse()
      .map((row) => structuredClone(row));
  }
  note(actionId: string, evidence: Record<string, unknown>) {
    return this.enqueue(() =>
      this.audit({ type: "transport", actionId, evidence }),
    );
  }
  private audit(value: unknown) {
    return this.retryBusy(() =>
      appendFile(
        join(this.directory, "events.jsonl"),
        JSON.stringify({ at: Date.now(), ...(value as object) }) + "\n",
      ),
    );
  }
  private recordName(id: string) { return createHash('sha256').update(id).digest('hex') + '.json'; }
  private save(row?: ActionRecord) {
    return this.retryBusy(async () => {
      const file = row ? join(this.directory, 'action-records', this.recordName(row.id)) : join(this.directory, "actions.json");
      await writeFile(
        file + ".tmp",
        JSON.stringify(row ?? [...this.actions.values()]),
        { flush: true },
      );
      await rename(file + ".tmp", file);
    });
  }
  private async retryBusy<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const e = error as NodeJS.ErrnoException;
        if (
          attempt >= 4 ||
          !["EBUSY", "EPERM", "EACCES"].includes(e.code ?? "") ||
          (e.syscall !== undefined && !["open", "rename"].includes(e.syscall))
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
  }
  async close() {
    await this.enqueue(() => this.save());
  }
}
