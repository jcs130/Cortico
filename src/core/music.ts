import {
  readFile,
  realpath,
  stat,
  mkdir,
  writeFile,
  rename,
  open,
} from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { wavInfo, vocalEnvelope } from "./wav.ts";
import { id, number, type MusicConfig } from "./types.ts";
import { CloudMusicProvider } from "./cloud-music.ts";
type Track = {
  id: string;
  title: string;
  wavFile: string;
  vocalFile?: string;
  lyricsFile?: string;
  instrumental?: boolean;
  aiGenerated?: boolean;
  contentApproved?: boolean;
  audioValidated?: boolean;
};
export class MusicService {
  private jobs = new Map<
    string,
    {
      requestId: string;
      request: unknown;
      jobId?: string;
      state: string;
      result?: Record<string, unknown>;
      provider?: "gateway" | "fal";
    }
  >();
  private abort = new AbortController();
  private cloud: CloudMusicProvider | null = null;
  private imports: Record<string, Track & { sha256: string }> = {};
  private writing = Promise.resolve();
  private infoCache = new Map<
    string,
    { stamp: string; info: ReturnType<typeof wavInfo> }
  >();
  constructor(
    private readonly config: () => MusicConfig | undefined,
    private readonly directory: string,
  ) {}
  async start() {
    this.abort = new AbortController();
    try {
      this.imports = JSON.parse(
        await readFile(join(this.directory, "aigc-imports.json"), "utf8"),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await mkdir(this.directory, { recursive: true });
    const cloudConfig = this.config()?.cloud;
    this.cloud = new CloudMusicProvider(
      cloudConfig,
      join(this.directory, "cloud-music"),
    );
    await this.cloud?.start();
    try {
      for (const row of JSON.parse(
        await readFile(join(this.directory, "music-jobs.json"), "utf8"),
      ))
        this.jobs.set(row.requestId, row);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  private async save() {
    this.writing = this.writing.then(async () => {
      const file = join(this.directory, "music-jobs.json");
      await writeFile(file + ".tmp", JSON.stringify([...this.jobs.values()]));
      await rename(file + ".tmp", file);
    });
    return this.writing;
  }
  async generate(
    _input: Record<string, unknown>,
    _requestId: string,
  ): Promise<Record<string, unknown>> {
    throw Error(
      "capability_moved: song generation is provided by cortico-world-aigc / aigc_create kind:music. Stage imports, previews and plays finished audio.",
    );
  }
  async job(jobId: string, cancel = false): Promise<Record<string, unknown>> {
    id(jobId);
    const row = [...this.jobs.values()].find((j) => j.jobId === jobId);
    if (!row) throw Error("Song job is not owned by this archived stage");
    if (cancel)
      throw Error(
        "capability_moved: stage cannot cancel migrated remote creation; reconcile the original provider id",
      );
    return row.provider === "fal"
      ? this.requireCloud().job(jobId)
      : { ...row.result, historical: true, currentRemoteState: "unknown" };
  }
  private requireCloud() {
    if (!this.cloud)
      throw Error("This song's cloud provider is not configured");
    return this.cloud;
  }
  async review(jobId: string, approve: boolean) {
    if (jobId.startsWith("aigc-")) {
      await this.track(jobId, true);
      this.imports[jobId].contentApproved = approve;
      await this.saveImports();
      return {
        jobId,
        trackId: jobId,
        state: approve ? "ready" : "rejected",
        contentApproved: approve,
      };
    }
    const row = [...this.jobs.values()].find((j) => j.jobId === jobId);
    if (!row || row.provider !== "fal")
      throw Error(
        "Only this World's cloud song candidates can be adopted here",
      );
    const result = await this.requireCloud().review(jobId, approve);
    row.state = String(result.state);
    row.result = result;
    await this.save();
    return result;
  }
  state() {
    return {
      generationConfigured: false,
      generationOwner: "cortico-world-aigc",
      jobs: [...this.jobs.values()].slice(-20),
      libraryConfigured: !!(
        this.config()?.directory ||
        this.cloud?.hasArchive() ||
        Object.keys(this.imports).length
      ),
    };
  }
  async asset(file: string) {
    if (!this.config()?.directory.trim())
      throw Error("Music library is not configured");
    const root = await realpath(this.config()?.directory ?? "");
    if (!file || isAbsolute(file) || file.includes("\0"))
      throw Error("Invalid music asset");
    const path = await realpath(resolve(root, file));
    const rel = relative(root, path);
    if (
      rel === ".." ||
      rel.startsWith("..\\") ||
      rel.startsWith("../") ||
      isAbsolute(rel)
    )
      throw Error("Music asset escapes its configured directory");
    return path;
  }
  private async catalog(): Promise<Track[]> {
    if (!this.config()?.directory) return [];
    let file: string;
    try {
      file = await this.asset("catalog.json");
    } catch (error) {
      // A selected but not-yet-populated external library is valid. Do not
      // create or overwrite an operator's catalogue just to list imports.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if ((await stat(file)).size > 1_000_000)
      throw Error("Music catalog too large");
    const c = JSON.parse(await readFile(file, "utf8"));
    if (c.version !== 1 || !Array.isArray(c.tracks) || c.tracks.length > 500)
      throw Error("Invalid music catalog");
    const seen = new Set();
    for (const t of c.tracks) {
      id(t.id);
      if (
        seen.has(t.id) ||
        typeof t.title !== "string" ||
        typeof t.wavFile !== "string"
      )
        throw Error("Invalid catalog track");
      seen.add(t.id);
      if (t.aiGenerated && (!t.contentApproved || !t.audioValidated))
        throw Error("Generated song is not ready");
    }
    return c.tracks;
  }
  async track(
    trackId: string,
    preview = false,
  ): Promise<{ track: Track; path: string; info: ReturnType<typeof wavInfo> }> {
    id(trackId);
    if (trackId.startsWith("aigc-")) {
      const track = this.imports[trackId];
      if (!track || (!track.contentApproved && !preview))
        throw Error("Imported song must be previewed/adopted before broadcast");
      const path = join(this.directory, trackId + ".wav"),
        bytes = await readFile(path);
      if (createHash("sha256").update(bytes).digest("hex") !== track.sha256)
        throw Error("Imported song integrity failure");
      return { track, path, info: wavInfo(bytes) };
    }
    if (trackId.startsWith("cloud-"))
      return this.requireCloud().track(trackId, preview);
    const t = (await this.catalog()).find((t) => t.id === trackId);
    if (!t) throw Error("Unknown track");
    const path = await this.asset(t.wavFile),
      s = await stat(path);
    if (s.size > 256 * 1024 * 1024) throw Error("Track too large");
    const stamp = s.size + ":" + s.mtimeMs;
    let cached = this.infoCache.get(path);
    if (cached?.stamp !== stamp) {
      const file = await open(path, "r");
      try {
        const header = Buffer.alloc(Math.min(65536, s.size));
        await file.read(header, 0, header.length, 0);
        cached = { stamp, info: wavInfo(header, s.size) };
        this.infoCache.set(path, cached);
      } finally {
        await file.close();
      }
    }
    return { track: t, path, info: cached!.info };
  }
  async list() {
    const result = [];
    for (const track of await this.catalog()) {
      const { info } = await this.track(track.id);
      result.push({
        id: track.id,
        title: track.title,
        durationMs: info.durationMs,
        instrumental: !!track.instrumental,
        aiGenerated: !!track.aiGenerated,
      });
    }
    for (const track of Object.values(this.imports).filter(
      (t) => t.contentApproved,
    )) {
      const { info } = await this.track(track.id);
      result.push({
        id: track.id,
        title: track.title,
        durationMs: info.durationMs,
        instrumental: !!track.instrumental,
        aiGenerated: true,
      });
    }
    return [...result, ...(this.cloud?.list() ?? [])];
  }
  async cues(trackId: string, preview = false) {
    const { track, info } = await this.track(trackId, preview);
    let lyrics: unknown[] = [];
    if (track.lyricsFile) {
      const file = await this.asset(track.lyricsFile);
      if ((await stat(file)).size > 256 * 1024) throw Error("Lyrics too large");
      const l = JSON.parse(await readFile(file, "utf8"));
      if (l.version !== 1 || !Array.isArray(l.lines) || l.lines.length > 500)
        throw Error("Invalid lyrics");
      let previousEnd = 0;
      lyrics = l.lines.map((line: any) => {
        number(line.atMs, previousEnd, info.durationMs, "lyric start");
        number(line.endMs, line.atMs + 1, info.durationMs, "lyric end");
        if (typeof line.text !== "string" || line.text.length > 300)
          throw Error("Invalid lyric text");
        previousEnd = line.endMs;
        return { atMs: line.atMs, endMs: line.endMs, text: line.text };
      });
    }
    let envelope = null;
    if (!track.instrumental && track.vocalFile) {
      const file = await this.asset(track.vocalFile);
      if ((await stat(file)).size > 256 * 1024 * 1024)
        throw Error("Vocal track too large");
      envelope = vocalEnvelope(await readFile(file));
    }
    return {
      lyrics,
      envelope,
      mouthSource: track.instrumental
        ? "none"
        : envelope
          ? "vocal"
          : lyrics.length
            ? "timed-lyrics"
            : "none",
    };
  }
  private async saveImports() {
    const file = join(this.directory, "aigc-imports.json");
    this.writing = this.writing.then(async () => {
      await writeFile(file + ".tmp", JSON.stringify(this.imports));
      await rename(file + ".tmp", file);
    });
    await this.writing;
  }
  async importArtifact(
    bytes: Uint8Array,
    metadata: { title: string; instrumental?: boolean },
    signal?: AbortSignal,
  ) {
    if (this.abort.signal.aborted) throw Error("Stage is stopped");
    signal?.throwIfAborted();
    if (
      !metadata ||
      typeof metadata.title !== "string" ||
      !metadata.title.trim() ||
      metadata.title.length > 200 ||
      bytes.byteLength > 256 * 1024 * 1024
    )
      throw Error("Invalid imported music");
    const info = wavInfo(bytes),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    const trackId = "aigc-" + sha256.slice(0, 24);
    const prior = this.imports[trackId];
    if (!prior) {
      await writeFile(join(this.directory, trackId + ".wav.tmp"), bytes);
      signal?.throwIfAborted();
      if (this.abort.signal.aborted) throw Error("Stage is stopped");
      await rename(
        join(this.directory, trackId + ".wav.tmp"),
        join(this.directory, trackId + ".wav"),
      );
      signal?.throwIfAborted();
      if (this.abort.signal.aborted) throw Error("Stage is stopped");
      this.imports[trackId] = {
        id: trackId,
        title: metadata.title,
        wavFile: trackId + ".wav",
        instrumental: metadata.instrumental === true,
        aiGenerated: true,
        audioValidated: true,
        contentApproved: false,
        sha256,
      };
      await this.saveImports();
    } else if (
      prior.title !== metadata.title ||
      !!prior.instrumental !== !!metadata.instrumental
    )
      throw Error("Imported audio already exists with different metadata");
    return {
      trackId,
      jobId: trackId,
      state: prior?.contentApproved ? "ready" : "review",
      durationMs: info.durationMs,
      audioValidated: true,
      contentApproved: prior?.contentApproved === true,
      playbackVerified: false,
    };
  }
  stop() {
    this.abort.abort();
    this.cloud?.stop();
  }
}
