import { endpoint, bearer, jsonRequest } from "./http.ts";
import { id, type AvatarPreset } from "./types.ts";
export class MotionProvider {
  private stopped = false;
  private abort = new AbortController();
  constructor(private readonly avatar: () => AvatarPreset | undefined) {}
  start() {
    this.stopped = false;
    this.abort = new AbortController();
  }
  stop() {
    this.stopped = true;
    this.abort.abort();
  }
  private async request(path: string, method = "GET", body?: unknown) {
    if (this.stopped) throw Error("Motion client stopped");
    const config: {
      url?: string;
      tokenEnv?: string;
      credentialsFile?: string;
    } = this.avatar()?.motion ?? { url: this.avatar()?.motionUrl };
    const url = config.url;
    if (!url)
      throw Error(
        "No motion model is configured for this avatar; use direct gestures instead",
      );
    const base = endpoint(url);
    const remotePath = new URL(
      path.replace(/^\//, ""),
      base.href.replace(/\/?$/, "/"),
    );
    return jsonRequest(
      remotePath,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(await bearer(config)),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      this.abort.signal,
    );
  }
  async call(args: Record<string, unknown>, requestId: string) {
    switch (args.action) {
      case "status":
        return this.request("/health");
      case "generate":
        return this.request("/jobs", "POST", {
          prompt: args.prompt,
          durationSec: args.durationSec ?? 2,
          seed: args.seed ?? 42,
          requestId,
        });
      case "result":
        return this.request(
          "/jobs/" + encodeURIComponent(id(args.jobId, "job id")),
        );
      case "cancel":
        return this.request(
          "/jobs/" + encodeURIComponent(id(args.jobId, "job id")),
          "DELETE",
        );
      case "search": {
        const p = new URLSearchParams({
          query: String(args.query ?? ""),
          offset: String(args.offset ?? 0),
          limit: String(args.limit ?? 50),
        });
        return this.request("/jobs?" + p);
      }
      case "approve":
      case "reject":
        return this.request(
          "/jobs/" + encodeURIComponent(id(args.clipId, "clip id")) + "/review",
          "POST",
          { review: args.action === "approve" ? "approved" : "rejected" },
        );
      default:
        throw Error("Unsupported motion provider action");
    }
  }
  async clip(clipId: string) {
    id(clipId);
    const job = await this.request("/jobs/" + encodeURIComponent(clipId));
    if (
      !["ready", "review"].includes(String(job.status)) ||
      job.clipId !== clipId
    )
      throw Error("Motion is not ready");
    if (job.avatarSha256 !== this.avatar()?.sha256)
      throw Error("Motion belongs to a different avatar");
    return {
      job,
      data: await this.request("/clips/" + encodeURIComponent(clipId)),
    };
  }
  used(clipId: string, eventId: string, role: "preview" | "broadcast") {
    return this.request(
      "/jobs/" + encodeURIComponent(id(clipId)) + "/used",
      "POST",
      { eventId, role },
    );
  }
}
