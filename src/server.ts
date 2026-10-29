import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  AvatarStage,
  PROTOCOL,
  type StageConfig,
  type Emit,
  id,
  object,
} from "./core/index.ts";
import { DESCRIPTION, TOOL_DEFINITIONS } from "./tools.ts";
import { validateToolInput } from "./core/schema.ts";
const root = fileURLToPath(new URL("..", import.meta.url));
const webRoot = existsSync(resolve(root, "dist/web/viewer.js"))
  ? resolve(root, "dist/web")
  : resolve(root, "web");
const require = createRequire(import.meta.url);
const threeBuild = dirname(require.resolve("three"));
const vrmLibrary = dirname(require.resolve("@pixiv/three-vrm"));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};
export class AvatarStageServer {
  readonly stage: AvatarStage;
  private http: Server | null = null;
  private clients = new Set<ServerResponse>();
  private actualPort = 0;
  constructor(config: StageConfig, report?: Emit) {
    this.stage = new AvatarStage(config, (event) => {
      const wire = "data: " + JSON.stringify(event) + "\n\n";
      for (const response of this.clients) {
        if (response.destroyed || response.writableLength > 512 * 1024) {
          response.destroy();
          this.clients.delete(response);
        } else response.write(wire);
      }
      report?.(event);
    });
  }
  get url() {
    return `http://127.0.0.1:${this.actualPort}`;
  }
  async start() {
    if (this.http) return;
    await this.stage.start();
    const http = createServer((req, res) => {
      void this.handle(req, res).catch((e) => {
        if (!res.headersSent)
          this.json(res, 400, {
            protocol: PROTOCOL,
            error: e instanceof Error ? e.message : String(e),
          });
        else res.destroy();
      });
    });
    this.http = http;
    http.requestTimeout = 10000;
    try {
      await new Promise<void>((ok, fail) => {
        http.once("error", fail);
        http.listen(this.stage.config.port, "127.0.0.1", ok);
      });
      this.actualPort = (http.address() as { port: number }).port;
    } catch (e) {
      this.http = null;
      await this.stage.stop();
      throw e;
    }
  }
  private json(res: ServerResponse, code: number, data: unknown) {
    res
      .writeHead(code, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      })
      .end(JSON.stringify(data));
  }
  async call(
    tool: string,
    args: Record<string, unknown>,
    requestId: string = randomUUID(),
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const declaration = TOOL_DEFINITIONS.find((t) => t.name === tool);
    if (!declaration) throw Error("Unknown tool");
    validateToolInput(declaration.parameters, args);
    id(requestId, "request id");
    if (tool === "avatar_query") return this.stage.query(args);
    if (tool === "avatar_control") return this.stage.control(args, requestId);
    if (tool === "avatar_motion")
      return this.stage.motionAction(args, requestId);
    if (tool === "avatar_voice") return this.stage.voiceAction(args, requestId);
    if (tool === "avatar_music") return this.stage.musicAction(args, requestId);
    throw Error("Unknown tool");
  }
  private async body(req: IncomingMessage) {
    let raw = "";
    for await (const part of req) {
      raw += part;
      if (Buffer.byteLength(raw) > 65536) throw Error("Request too large");
    }
    return object(JSON.parse(raw));
  }
  /** Explicit binary artifact ingress; ordinary JSON request limit stays unchanged. */
  async importMusic(
    bytes: Uint8Array,
    metadata: { title: string; instrumental?: boolean },
    signal?: AbortSignal,
  ) {
    return this.stage.music.importArtifact(bytes, metadata, signal);
  }
  private async file(
    res: ServerResponse,
    path: string,
    mime?: string,
    req?: IncomingMessage,
  ) {
    const size = (await stat(path)).size;
    const range = req?.headers.range;
    let start = 0,
      end = size - 1;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) throw Error("Unsupported byte range");
      start = Number(match[1]);
      end = match[2] ? Math.min(end, Number(match[2])) : end;
      if (start > end || start >= size) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
    }
    res.writeHead(range ? 206 : 200, {
      "Content-Type": mime ?? MIME[extname(path)] ?? "application/octet-stream",
      "Content-Length": end - start + 1,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req?.method === "HEAD") res.end();
    else
      createReadStream(path, { start, end })
        .on("error", () => res.destroy())
        .pipe(res);
  }
  private async staticFile(
    res: ServerResponse,
    directory: string,
    name: string,
    req: IncomingMessage,
  ) {
    if (
      !name ||
      name.includes("\0") ||
      name.includes("\\") ||
      name.split("/").some((x) => !x || x === ".." || x === ".") ||
      isAbsolute(name)
    )
      throw Error("Invalid static path");
    const base = await realpath(directory),
      path = await realpath(resolve(base, name)),
      rel = relative(base, path);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw Error("Static path escaped root");
    await this.file(res, path, undefined, req);
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (
      req.headers.host &&
      !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(req.headers.host)
    ) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost"),
      path = url.pathname;
    if (!["GET", "HEAD", "POST", "PUT"].includes(req.method ?? "")) {
      res.writeHead(405).end();
      return;
    }
    if (
      ["POST", "PUT"].includes(req.method ?? "") &&
      req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}`
    ) {
      res.writeHead(403).end();
      return;
    }
    if (path === "/api/state" && req.method === "GET") {
      this.json(res, 200, this.stage.status());
      return;
    }
    if (path === '/api/audience-progress' && req.method === 'POST') {
      this.json(res, 200, { protocol: PROTOCOL, accepted: this.stage.publishAudienceProgress(await this.body(req)) });
      return;
    }
    const motionIndex = /^\/assets\/avatars\/([^/]+)\/motions$/.exec(path);
    const legacyMotionIndex = /^\/assets\/motions\/([^/]+)$/.exec(path);
    const indexId =
      motionIndex?.[1] ??
      (legacyMotionIndex &&
      this.stage.avatars
        .list()
        .some(
          (avatar) => avatar.id === decodeURIComponent(legacyMotionIndex[1]),
        )
        ? legacyMotionIndex[1]
        : undefined);
    if (indexId && req.method === "GET") {
      const index = this.stage.avatars.get(
        id(decodeURIComponent(indexId)),
      ).motions;
      if (!index) {
        this.json(res, 404, {
          error: "No standard animation library installed",
        });
        return;
      }
      this.json(res, 200, index);
      return;
    }
    const actionResult = /^\/api\/actions\/([^/]+)$/.exec(path);
    if (actionResult && req.method === "GET") {
      this.json(
        res,
        200,
        this.stage.ledger.result(id(decodeURIComponent(actionResult[1]))),
      );
      return;
    }
    if (path === "/api/capabilities" && req.method === "GET") {
      this.json(res, 200, DESCRIPTION);
      return;
    }
    if (path === "/api/import-music" && req.method === "POST") {
      if (req.headers["content-type"] !== "audio/wav")
        throw Error("Import requires audio/wav");
      const raw = String(req.headers["x-avatar-metadata"] ?? "");
      if (raw.length > 2048) throw Error("Import metadata too large");
      const metadata = JSON.parse(decodeURIComponent(raw));
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > 256 * 1024 * 1024) throw Error("Imported audio too large");
        chunks.push(Buffer.from(part));
      }
      if (req.destroyed && !req.complete)
        throw Error("Import connection aborted");
      this.json(
        res,
        200,
        await this.importMusic(Buffer.concat(chunks), metadata),
      );
      return;
    }
    if(path==='/api/voice-artifacts'&&req.method==='POST') {
      const body=await this.body(req),requestId=id(body.requestId,'artifact request ID');
      if(Object.keys(body).some(key=>!['requestId','text'].includes(key)))throw Error('Audio producer accepts only requestId and one full text line');
      if(typeof body.text!=='string')throw Error('One full line is required');
      const abort=new AbortController();res.once('close',()=>{if(!res.writableEnded)abort.abort();});
      await this.stage.voice.artifacts.create(requestId,body.text,abort.signal);
      const artifact=await this.stage.voice.artifacts.read(requestId);
      res.writeHead(200,{'Content-Type':'audio/wav','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'X-Voice-Artifact-Id':requestId,'X-Voice-Audio-Sha256':artifact.metadata.sha256!,
        'X-Voice-Generation-Complete':String(artifact.metadata.generationComplete)}).end(artifact.bytes);
      return;
    }
    const voiceArtifact=/^\/api\/voice-artifacts\/([^/]+)(\/broadcast)?$/.exec(path);
    if(voiceArtifact) {
      const requestId=id(decodeURIComponent(voiceArtifact[1]),'artifact request ID');
      if(voiceArtifact[2]&&req.method==='POST') {
        await this.body(req);this.json(res,200,await this.stage.broadcastVoiceArtifact(requestId));return;
      }
      if(!voiceArtifact[2]&&req.method==='PUT') {
        if(req.headers['content-type']!=='audio/wav')throw Error('PCM16 WAV required');
        let size=0;const parts:Buffer[]=[];
        for await(const part of req){size+=part.length;if(size>4*1024*1024)throw Error('Artifact max4MiB');parts.push(Buffer.from(part));}
        if(req.destroyed&&!req.complete)throw Error('Artifact upload aborted');
        this.json(res,200,await this.stage.voice.artifacts.import(requestId,Buffer.concat(parts)));return;
      }
    }
    if (path === "/api/call" && req.method === "POST") {
      const body = await this.body(req),
        requestId =
          body.requestId ?? req.headers["x-avatar-request-id"] ?? randomUUID();
      this.json(res, 200, {
        protocol: PROTOCOL,
        result: await this.call(
          String(body.tool),
          object(body.args),
          id(requestId, "request id"),
        ),
      });
      return;
    }
    if (path === "/api/receipt" && req.method === "POST") {
      this.json(res, 200, await this.stage.receipt(await this.body(req)));
      return;
    }
    if (path === "/api/audio-owner" && req.method === "POST") {
      const body = await this.body(req);
      this.json(res, 200, this.stage.claimAudio(id(body.sessionId)));
      return;
    }
    if (path === '/api/audio-release' && req.method === 'POST') {
      const body = await this.body(req);
      this.json(res, 200, this.stage.releaseAudio(id(body.sessionId)));
      return;
    }
    if (path === "/events" && req.method === "GET") {
      if (this.clients.size >= 12) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(
        ": " +
          " ".repeat(2048) +
          "\n\ndata: " +
          JSON.stringify({
            protocol: PROTOCOL,
            type: "snapshot",
            at: Date.now(),
            data: this.stage.status(),
          }) +
          "\n\n",
      );
      this.clients.add(res);
      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
      heartbeat.unref();
      req.once("close", () => {
        clearInterval(heartbeat);
        this.clients.delete(res);
      });
      return;
    }
    const avatar = /^\/assets\/avatars\/([^/]+)$/.exec(path);
    if (avatar) {
      const { preset } = this.stage.avatars.get(
        id(decodeURIComponent(avatar[1])),
      );
      await this.file(res, preset.file, "model/gltf-binary", req);
      return;
    }
    const motion = /^\/assets\/(?:generated-motions|motions)\/([^/]+)$/.exec(
      path,
    );
    if (motion) {
      const clip = await this.stage.motion.clip(
        id(decodeURIComponent(motion[1])),
      );
      this.json(res, 200, clip.data);
      return;
    }
    const audio = /^\/audio\/(speech|music|cues)\/([^/]+)$/.exec(path);
    if (audio) {
      if (
        !this.stage.audioAllowed(
          id(url.searchParams.get("sessionId"), "audio session"),
        )
      ) {
        res.writeHead(403).end();
        return;
      }
      const key = id(decodeURIComponent(audio[2]));
      const preview = this.stage.musicPreviewAllowed(
        id(url.searchParams.get("sessionId")),
        key,
      );
      if (audio[1] === "speech") {
        await this.stage.voice.stream(key, res);
      } else if (audio[1] === "music") {
        await this.file(
          res,
          (await this.stage.music.track(key, preview)).path,
          "audio/wav",
          req,
        );
      } else this.json(res, 200, await this.stage.music.cues(key, preview));
      return;
    }
    if (req.method === "POST") {
      res.writeHead(404).end();
      return;
    }
    const vendors: [string, string][] = [
      ["/vendor/three/", threeBuild],
      ["/vendor/addons/", resolve(threeBuild, "../examples/jsm")],
      ["/vendor/vrm/", vrmLibrary],
    ];
    for (const [prefix, directory] of vendors)
      if (path.startsWith(prefix)) {
        await this.staticFile(
          res,
          directory,
          decodeURIComponent(path.slice(prefix.length)),
          req,
        );
        return;
      }
    if (
      path === "/" ||
      path === "/index.html" ||
      /^\/(viewer|audio|speech|expression-weights|style)\.(js|css)$/.test(path)
    ) {
      await this.staticFile(
        res,
        webRoot,
        path === "/" ? "index.html" : path.slice(1),
        req,
      );
      return;
    }
    res.writeHead(404).end();
  }
  async stop() {
    await this.stage.stop();
    for (const response of this.clients) response.end();
    this.clients.clear();
    if (this.http) {
      const http = this.http;
      this.http = null;
      http.closeAllConnections();
      await new Promise<void>((ok) => http.close(() => ok()));
    }
  }
}
