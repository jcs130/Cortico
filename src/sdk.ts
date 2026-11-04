import { randomUUID } from "node:crypto";
import { endpoint, jsonRequest } from "./core/http.ts";
import { PROTOCOL, type StageEvent, type Emit } from "./core/types.ts";
import type { ToolName, ToolRequests } from "./core/requests.ts";
export class AvatarStageClient {
  readonly url: string;
  private abort: AbortController | null = null;
  private listening: Promise<void> | null = null;
  private state: Record<string, unknown> = {
    protocol: PROTOCOL,
    connected: false,
  };
  constructor(
    url: string,
    private readonly report: Emit = () => {},
    private readonly options: { rendererEvents?: boolean } = {},
  ) {
    this.url = endpoint(url, true).origin;
  }
  status() {
    return structuredClone(this.state);
  }
  async publishAudienceProgress(value: unknown, signal?: AbortSignal) {
    if (!this.abort) throw Error('Client is stopped');
    return jsonRequest(this.url + '/api/audience-progress', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) },
      AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]));
  }
  async importMusic(
    bytes: Uint8Array,
    metadata: { title: string; instrumental?: boolean },
    signal?: AbortSignal,
  ) {
    if (!this.abort) throw Error("Client is stopped");
    return jsonRequest(
      this.url + "/api/import-music",
      {
        method: "POST",
        headers: {
          "Content-Type": "audio/wav",
          "x-avatar-metadata": encodeURIComponent(JSON.stringify(metadata)),
        },
        body: Uint8Array.from(bytes),
      },
      AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]),
    );
  }
  invoke<T extends ToolName>(
    tool: T,
    args: ToolRequests[T],
    requestId?: string,
    signal?: AbortSignal,
  ) {
    return this.call(
      tool,
      args as unknown as Record<string, unknown>,
      requestId,
      signal,
    );
  }
  async wait(
    actionId: string,
    {
      signal,
      timeoutMs = 30000,
    }: { signal?: AbortSignal; timeoutMs?: number } = {},
  ) {
    if (!this.abort) throw Error("Client is stopped");
    const combined = AbortSignal.any([
      this.abort.signal,
      AbortSignal.timeout(timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    while (!combined.aborted) {
      const state = await jsonRequest(
        this.url + "/api/actions/" + encodeURIComponent(actionId),
        {},
        combined,
      );
      if (["completed", "failed", "cancelled"].includes(String(state.status)))
        return state;
      await new Promise<void>((ok, fail) => {
        const done = () => {
          clearTimeout(timer);
          combined.removeEventListener("abort", aborted);
          ok();
        };
        const aborted = () => {
          clearTimeout(timer);
          combined.removeEventListener("abort", aborted);
          fail(combined.reason);
        };
        const timer = setTimeout(done, 100);
        combined.addEventListener("abort", aborted, { once: true });
      });
    }
    throw combined.reason;
  }
  async call(
    tool: string,
    args: Record<string, unknown>,
    requestId: string = randomUUID(),
    signal?: AbortSignal,
  ) {
    if (!this.abort) throw Error("Client is stopped");
    const response = await jsonRequest(
      this.url + "/api/call",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool, args, requestId }),
      },
      AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]),
    );
    if (response.protocol !== PROTOCOL)
      throw Error("Unsupported stage protocol");
    if (args.action === "status" && tool === "avatar_control")
      this.state = response.result as Record<string, unknown>;
    if (
      ["status", "select"].includes(String(args.action)) &&
      tool === "avatar_voice"
    )
      this.state.voice = response.result;
    return response.result as Record<string, unknown>;
  }
  async start() {
    if (this.abort) return;
    this.abort = new AbortController();
    try {
      this.state = await jsonRequest(
        this.url + "/api/state",
        {},
        this.abort.signal,
      );
      if (this.state.protocol !== PROTOCOL)
        throw Error("Unsupported stage protocol");
      this.listening = this.loop(this.abort.signal);
    } catch (e) {
      this.abort = null;
      throw e;
    }
  }
  private async loop(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const response = await fetch(this.url + "/events", {
          signal,
          redirect: "error",
        });
        if (!response.ok || !response.body)
          throw Error("Stage stream unavailable");
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let pending = "";
        try {
          while (!signal.aborted) {
            const part = await reader.read();
            if (part.done) break;
            pending += decoder.decode(part.value, { stream: true });
            if (pending.length > 1_000_000) throw Error("Oversized event");
            let end;
            while ((end = pending.indexOf("\n\n")) >= 0) {
              const wire = pending.slice(0, end);
              pending = pending.slice(end + 2);
              const line = wire.split("\n").find((l) => l.startsWith("data: "));
              if (!line) continue;
              const event = JSON.parse(line.slice(6)) as StageEvent;
              if (event.protocol !== PROTOCOL)
                throw Error("Unsupported event protocol");
              if (event.type === "snapshot") this.state = event.data;
              else if (event.type === "command" && event.data.kind === "select")
                this.state.activeAvatar = event.data.avatar;
              else if (
                [
                  "avatar.action",
                  "avatar.motion",
                  "avatar.music",
                  "avatar.voice",
                ].includes(event.type)
              ) {
                if (event.type === "avatar.action") {
                  const previous = (this.state.actions ?? []) as Array<
                    Record<string, unknown>
                  >;
                  this.state = {
                    ...this.state,
                    actions: [
                      event.data,
                      ...previous.filter((a) => a.id !== event.data.id),
                    ].slice(0, 12),
                  };
                } else if (event.type === "avatar.motion") {
                  const previous = (this.state.motionJobs ?? []) as Array<
                    Record<string, unknown>
                  >;
                  this.state = {
                    ...this.state,
                    motionJobs: [
                      { ...event.data, jobId: event.data.id },
                      ...previous.filter((j) => j.jobId !== event.data.id),
                    ].slice(0, 12),
                  };
                } else if (event.type === "avatar.music") {
                  const music = (this.state.music ?? {}) as Record<
                    string,
                    unknown
                  >;
                  const jobs = (music.jobs ?? []) as Array<
                    Record<string, unknown>
                  >;
                  this.state.music = {
                    ...music,
                    jobs: [
                      event.data,
                      ...jobs.filter((j) => j.jobId !== event.data.jobId),
                    ].slice(0, 20),
                  };
                } else if (event.type === "avatar.voice") {
                  const previous = (this.state.voice ?? {}) as Record<
                    string,
                    unknown
                  >;
                  this.state = {
                    ...this.state,
                    voice: { ...previous, last: event.data },
                  };
                }
                this.report(event);
              }
              if (this.options.rendererEvents && ['command', 'audio.cut', 'avatar.speech.submitted'].includes(event.type)) this.report(event);
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      } catch (e) {
        if (!signal.aborted)
          this.state = {
            ...this.state,
            connectionError: e instanceof Error ? e.message : String(e),
          };
      }
      if (!signal.aborted && this.options.rendererEvents) this.report({ protocol: PROTOCOL, type: 'stream.disconnected', at: Date.now(), data: {} });
      if (!signal.aborted)
        await new Promise<void>((ok) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            ok();
          };
          const timer = setTimeout(done, 2000);
          signal.addEventListener("abort", done, { once: true });
        });
    }
  }
  async stop() {
    this.abort?.abort();
    await this.listening;
    this.abort = null;
    this.listening = null;
  }
}
