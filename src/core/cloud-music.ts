/** Read-only generation archive plus explicit local adoption. All provider I/O moved to AIGC. */
import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { wavInfo } from "./wav.ts";
import { id, type CloudMusicConfig } from "./types.ts";
interface Row {
  jobId: string;
  state: string;
  input: Record<string, unknown>;
  trackId?: string;
  remoteId?: string;
  sha256?: string;
  approved?: boolean;
  [key: string]: unknown;
}
export class CloudMusicProvider {
  private rows: Row[] = [];
  constructor(
    _config: CloudMusicConfig | undefined,
    private readonly directory: string,
  ) {}
  async start() {
    try {
      this.rows = JSON.parse(
        await readFile(join(this.directory, "jobs.json"), "utf8"),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  private find(jobId: string) {
    const row = this.rows.find((r) => r.jobId === id(jobId));
    if (!row) throw Error("Unknown archived song");
    return row;
  }
  private public(row: Row): Record<string, unknown> {
    return {
      jobId: row.jobId,
      state: row.state,
      trackId: row.trackId,
      providerRequestId: row.remoteId,
      historical: true,
      currentRemoteState: "unknown",
      generationOwner: "cortico-world-aigc",
      contentApproved: row.approved === true,
    };
  }
  async generate(): Promise<Record<string, unknown>> {
    throw Error(
      "capability_moved: use cortico-world-aigc for music generation",
    );
  }
  async job(jobId: string, cancel = false): Promise<Record<string, unknown>> {
    if (cancel)
      throw Error("Archived stage cannot cancel a migrated provider job");
    return this.public(this.find(jobId));
  }
  async review(
    jobId: string,
    approve: boolean,
  ): Promise<Record<string, unknown>> {
    const row = this.find(jobId);
    if (row.state !== "review")
      throw Error("Archived song is not awaiting adoption");
    await this.track(row.trackId!, true);
    row.approved = approve;
    row.state = approve ? "ready" : "rejected";
    const path = join(this.directory, "jobs.json");
    await writeFile(path + ".tmp", JSON.stringify(this.rows));
    await rename(path + ".tmp", path);
    return this.public(row);
  }
  async track(trackId: string, preview = false) {
    const row = this.rows.find((r) => r.trackId === id(trackId));
    if (!row || (row.state !== "ready" && !(preview && row.state === "review")))
      throw Error("Archived cloud song is not adopted or previewable");
    id(row.jobId);
    const path = join(this.directory, row.jobId, "song.wav"),
      bytes = await readFile(path);
    if (createHash("sha256").update(bytes).digest("hex") !== row.sha256)
      throw Error("Archived song integrity failure");
    return {
      path,
      info: wavInfo(bytes),
      track: {
        id: row.trackId!,
        title: String(row.input.title),
        wavFile: "song.wav",
        instrumental: row.input.instrumental === true,
        aiGenerated: true,
        contentApproved: row.approved === true,
        audioValidated: true,
      },
    };
  }
  list() {
    return this.rows
      .filter((r) => r.state === "ready")
      .map((r) => ({
        id: r.trackId!,
        title: String(r.input.title),
        aiGenerated: true,
        instrumental: r.input.instrumental === true,
      }));
  }
  hasArchive() {
    return this.rows.length > 0;
  }
  stop() {}
}
