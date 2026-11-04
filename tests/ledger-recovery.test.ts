import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fault = vi.hoisted(() => ({ append: 0, rename: 0 }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      if (fault.append-- > 0)
        throw Object.assign(new Error("temporary audit lock"), {
          code: "EBUSY",
          syscall: "open",
        });
      return actual.appendFile(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fault.rename-- > 0)
        throw Object.assign(new Error("temporary snapshot lock"), {
          code: "EPERM",
          syscall: "rename",
        });
      return actual.rename(...args);
    },
  };
});
import { ActionLedger } from "../src/core/ledger.ts";
const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "stage-ledger-recovery-"));
  dirs.push(dir);
  const ledger = new ActionLedger(dir);
  await ledger.start();
  const { record } = await ledger.submit("same-request", "speech", "cormy", {
    text: "Hello",
  });
  return { dir, ledger, id: record.id };
}
afterEach(async () => {
  fault.append = 0;
  fault.rename = 0;
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
it("retries a transient open failure without duplicating the original receipt", async () => {
  const r = await fixture();
  fault.append = 1;
  await r.ledger.update(r.id, "playing", { device: "started" });
  expect(r.ledger.result(r.id).status).toBe("playing");
  const events = (await readFile(join(r.dir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.filter((e) => e.type === "receipt")).toHaveLength(1);
  await r.ledger.close();
});
it("keeps failed end evidence uncommitted and recovers the queue on the original receipt retry", async () => {
  const r = await fixture();
  await r.ledger.update(r.id, "playing", { device: "started" });
  fault.append = 5;
  await expect(
    r.ledger.update(r.id, "completed", { device: "ended" }),
  ).rejects.toThrow("audit lock");
  expect(r.ledger.result(r.id).status).toBe("playing");
  fault.append = 0;
  await r.ledger.update(r.id, "completed", { device: "ended" });
  await r.ledger.note(r.id, { reconciled: true });
  expect(r.ledger.result(r.id)).toMatchObject({
    status: "completed",
    evidence: { device: "ended" },
  });
  expect(
    JSON.parse(await readFile(join(r.dir, "actions.json"), "utf8"))[0].status,
  ).toBe("completed");
  await r.ledger.close();
});
it("repairs a snapshot failed after audit without losing or replaying the terminal", async () => {
  const r = await fixture();
  fault.rename = 5;
  await expect(
    r.ledger.update(r.id, "completed", { device: "ended" }),
  ).rejects.toThrow("snapshot lock");
  fault.rename = 0;
  await r.ledger.update(r.id, "completed", { device: "duplicate ended" });
  expect(
    JSON.parse(await readFile(join(r.dir, "actions.json"), "utf8"))[0],
  ).toMatchObject({ status: "completed", evidence: { device: "ended" } });
  expect(
    (
      await r.ledger.submit("same-request", "speech", "cormy", {
        text: "Hello",
      })
    ).reused,
  ).toBe(true);
  expect(r.ledger.actions.size).toBe(1);
  await r.ledger.close();
});
it("serializes duplicate admission and preserves terminal state against a late playing update", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stage-ledger-recovery-"));
  dirs.push(dir);
  const ledger = new ActionLedger(dir);
  await ledger.start();
  const pair = await Promise.all([
    ledger.submit("id", "speech", "cormy", {}),
    ledger.submit("id", "speech", "cormy", {}),
  ]);
  expect(pair[0].record.id).toBe(pair[1].record.id);
  await Promise.all([
    ledger.update(pair[0].record.id, "completed", { device: "ended" }),
    ledger.update(pair[0].record.id, "playing", { late: true }),
  ]);
  expect(ledger.result(pair[0].record.id).status).toBe("completed");
  await ledger.close();
});
