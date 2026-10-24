import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  appendFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ActionRecord } from "./types.ts";
export class ActionLedger {
  readonly actions = new Map<string, ActionRecord>();
  private writing = Promise.resolve();
  constructor(private readonly directory: string) {}
  async start() {
    await mkdir(this.directory, { recursive: true });
    let loaded: ActionRecord[] = [];
    try {
      loaded = JSON.parse(
        await readFile(join(this.directory, "actions.json"), "utf8"),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    for (const row of loaded) {
      if (["queued", "playing"].includes(row.status)) {
        row.status = "failed";
        row.evidence = {
          reason:
            "Stage restarted before execution was reconciled; not replayed",
        };
      }
      this.actions.set(row.id, row);
    }
    await this.save();
  }
  async submit(
    requestId: string,
    kind: string,
    avatarId: string | null,
    command: Record<string, unknown>,
  ) {
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
    const old = [...this.actions.values()].find(
      (a) => a.requestId === requestId,
    );
    if (old) {
      if (old.key !== key) throw Error("Request id belongs to another action");
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
    this.actions.set(record.id, record);
    await this.audit({ type: "request", record });
    await this.save();
    return { record, reused: false };
  }
  async update(
    actionId: string,
    status: ActionRecord["status"],
    evidence: Record<string, unknown>,
  ) {
    const row = this.actions.get(actionId);
    if (!row) throw Error("Unknown action");
    const ignored = ["completed", "failed", "cancelled"].includes(row.status);
    if (!ignored) {
      row.status = status;
      row.updatedAt = Date.now();
      row.evidence = evidence;
    }
    await this.audit({ type: "receipt", actionId, status, evidence, ignored });
    if (!ignored) await this.save();
    return row;
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
    return this.audit({ type: "transport", actionId, evidence });
  }
  private audit(value: unknown) {
    const operation = () =>
      appendFile(
        join(this.directory, "events.jsonl"),
        JSON.stringify({ at: Date.now(), ...(value as object) }) + "\n",
      );
    this.writing = this.writing.then(operation);
    return this.writing;
  }
  private save() {
    const operation = async () => {
      const file = join(this.directory, "actions.json");
      await writeFile(
        file + ".tmp",
        JSON.stringify([...this.actions.values()]),
      );
      await rename(file + ".tmp", file);
    };
    this.writing = this.writing.then(operation);
    return this.writing;
  }
  async close() {
    await this.writing;
  }
}
