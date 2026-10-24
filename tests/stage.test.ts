import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AvatarStageServer } from "../src/server.ts";
import { AvatarStageClient } from "../src/sdk.ts";
import { TOOL_DEFINITIONS, DESCRIPTION } from "../src/tools.ts";
import type { VoiceConfig } from "../src/core/types.ts";
import { createServer } from "node:http";
import { DesktopPresentation } from '../src/desktop-presentation.ts';
import { DesktopAudioRenderer } from '../src/desktop-audio.ts';
import { animationFixture } from "./fixtures/vrma.ts";
const cleanup: Array<() => Promise<unknown>> = [];

it.each([false, true])('routes speech and song to desktop with explicit performance=%s and reconciles playback', async (explicit) => {
  const bytes = Buffer.alloc(4844); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16,16); bytes.writeUInt16LE(1,20); bytes.writeUInt16LE(1,22); bytes.writeUInt32LE(24000,24);
  bytes.writeUInt32LE(48000,28); bytes.writeUInt16LE(2,32); bytes.writeUInt16LE(16,34); bytes.write('data',36); bytes.writeUInt32LE(bytes.length-44,40);
  const state: any = { protocol: 'desktop-presentation/v1', ready: true, revision: 0, busy: false, foreground: null,
    vocabulary: [{ id: 'happy', kind: 'expression', about: { en: 'Happy' } }, { id: 'wave', kind: 'motion', about: { en: 'Wave' } }], recent: [],
    media: { protocol: 'desktop-media/v1', enabled: true, ready: true, foreground: null, recent: [] } };
  const uploads: Buffer[] = [], commands: any[] = [];
  const desktop = createServer(async (req, res) => {
    if (req.url === '/speech') { res.writeHead(200, { 'content-type': 'audio/wav' }).end(bytes); return; }
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(state)); return; }
    const parts: Buffer[] = []; for await (const part of req) parts.push(part);
    const body = Buffer.concat(parts); res.setHeader('content-type', 'application/json');
    if (req.url === '/api/presentation/audio') { uploads.push(body); res.end(JSON.stringify({ assetId: 'asset-' + uploads.length, sha256: createHash('sha256').update(body).digest('hex') })); return; }
    const command = JSON.parse(body.toString()); commands.push(command);
    if (command.action === 'play-audio') { const row = { ...command, id: 'device-' + commands.length, state: 'queued' };
      state.media.recent.push(row); state.media.foreground = row.id; res.end(JSON.stringify({ accepted: true, ...row }));
    } else { res.end(JSON.stringify({ accepted: true, id: command.id })); }
  });
  await new Promise<void>(done => desktop.listen(0, '127.0.0.1', done));
  cleanup.push(async () => { desktop.closeAllConnections(); await new Promise<void>(done => desktop.close(() => done())); });
  const url = 'http://127.0.0.1:' + (desktop.address() as { port: number }).port;
  const { server, preset } = await setup({ voice: { url: url + '/speech', model: 'fixture', voice: 'fixture' } });
  const display = new DesktopPresentation(() => ({ mode: 'desktop-audio', url }), new AbortController().signal);
  const admitted: any[] = [], errors: string[] = [];
  const renderer = new DesktopAudioRenderer({ stageUrl: () => server.url, display, signal: new AbortController().signal,
    admitted: (...args) => admitted.push(args), log: error => errors.push(error) });
  await renderer.start(); cleanup.push(() => renderer.stop());
  const voice = await server.call('avatar_voice', { action: 'speak', text: 'A short spoken line.',
    ...(explicit ? {performance: {emotion: 'happy', bodyClip: 'wave'}} : {}) }, 'desktop-voice');
  await vi.waitFor(() => { expect(errors).toEqual([]); expect(commands.some(c => c.action === (explicit ? 'act' : 'play-audio'))).toBe(true); }, { timeout: 2500 });
  expect(admitted).toHaveLength(explicit ? 0 : 1); // Explicit cues never call the optional decision model.
  if (explicit) expect(commands.find(c => c.action === 'act')).toMatchObject({id: state.media.recent[0].id, actions: ['happy', 'wave']});
  expect(uploads[0]).toEqual(bytes);
  expect(commands.find(c => c.action === 'play-audio')).toMatchObject({ kind: 'speech', text: 'A short spoken line.' });
  expect(server.stage.ledger.result(String(voice.id)).status).toBe('queued');
  const spoken = state.media.recent[0]; spoken.state = 'playing'; spoken.startedAt = Date.now();
  await vi.waitFor(() => expect(server.stage.ledger.result(String(voice.id)).status).toBe('playing'), { timeout: 2500 });
  expect(await renderer.attach({ audioActionId: voice.id, bodyClip: 'wave', expressionWeights: { happy: .5 } })).toMatchObject({ accepted: true });
  spoken.state = 'completed'; spoken.audioTimeMs = 100;
  await vi.waitFor(() => expect(server.stage.ledger.result(String(voice.id)).status).toBe('completed'), { timeout: 2500 });
  const imported = await server.importMusic(bytes, { title: 'Fixture song', instrumental: true });
  await server.call('avatar_music', { action: 'approve', jobId: imported.jobId });
  const song = await server.call('avatar_music', { action: 'play', trackId: imported.trackId }, 'desktop-song');
  await vi.waitFor(() => expect(admitted).toHaveLength(explicit ? 1 : 2));
  expect(commands.find(c => c.kind === 'music')).toMatchObject({ cues: { mouthSource: 'none' } });
  const music = state.media.recent.at(-1); music.startedAt = Date.now(); music.state = 'completed'; music.audioTimeMs = 100;
  await vi.waitFor(() => expect(server.stage.ledger.result(String(song.id)).status).toBe('completed'), { timeout: 2500 });
  const body = await server.call('avatar_control', { action: 'perform', gesture: 'wave' });
  await expect(server.stage.receipt({ sessionId: server.stage.status().audioOwner, avatarId: preset.id, avatarSha256: preset.sha256,
    role: 'broadcast', renderer: 'audio-only', status: 'ended', eventId: body.id })).rejects.toThrow('cannot confirm');
  expect(server.stage.ledger.result(String(body.id)).status).toBe('queued');
  expect(errors).toEqual([]);
});

async function speechSetup() {
  const r = await setup({
    voice: {
      url: "http://127.0.0.1:1/v1/audio/speech",
      model: "fixture",
      voice: "fixture",
      voices: ["fixture"],
    },
  });
  await r.server.stage.receipt({
    sessionId: "renderer",
    role: "broadcast",
    status: "ready",
    avatarId: r.preset.id,
    avatarSha256: r.preset.sha256,
  });
  r.server.stage.claimAudio("renderer");
  return r;
}

it('submits speech and facial intent together, binds the cue once, and cancels it with speech', async () => {
  const {server, events} = await speechSetup();
  const args = {action: 'speak', text: 'One authored performance.', performance: {emotion: 'happy'}};
  const receipt = await server.call('avatar_voice', args, 'unified');
  expect(receipt).toMatchObject({accepted: true, command: {performance: {emotion: 'happy'}}});
  const cues = server.stage.ledger.history().filter(r => r.kind === 'presentation');
  expect(cues).toHaveLength(1);
  expect(cues[0].command).toMatchObject({audioActionId: receipt.id, expressionWeights: {happy: 1}});
  expect(cues[0].status).toBe('queued');
  expect(events.filter(e => e.type === 'command' && e.data.kind === 'speech')).toHaveLength(1);
  expect(await server.call('avatar_voice', args, 'unified')).toMatchObject({id: receipt.id, reused: true});
  expect(server.stage.ledger.history().filter(r => r.kind === 'presentation')).toHaveLength(1);
  await expect(server.call('avatar_voice', {...args, performance: {emotion: 'sad'}}, 'unified')).rejects.toThrow();
  await server.call('avatar_voice', {action: 'interrupt'});
  await vi.waitFor(() => expect(server.stage.ledger.result(cues[0].id).status).toBe('cancelled'));
});

it('rejects unknown performance before replacing current speech', async () => {
  const {server} = await speechSetup();
  const first = await server.call('avatar_voice', {action: 'speak', text: 'Existing speech.'}, 'before-invalid');
  await expect(server.call('avatar_voice', {action: 'speak', text: 'Invalid.', performance: {bodyClip: 'invented'}}, 'bad-cue')).rejects.toThrow('unavailable');
  expect(server.stage.status().foreground).toBe(first.id);
  expect(server.stage.ledger.history().some(r => r.requestId === 'bad-cue')).toBe(false);
});

it("releases the audio foreground after provider failure so idle commentary can resume", async () => {
  const { server } = await speechSetup();
  const speech = await server.call(
    "avatar_voice",
    { action: "speak", text: "Provider failure fixture." },
    "failed-synthesis",
  );
  const response = await fetch(
    server.url + "/audio/speech/" + speech.id + "?sessionId=renderer",
  );
  expect(response.status).toBe(502);
  await response.arrayBuffer();
  await vi.waitFor(() => {
    expect(server.stage.ledger.result(String(speech.id)).status).toBe("failed");
    expect(server.stage.status().foreground).toBeNull();
  });
});

it("bounds an upstream synthesis that never returns instead of leaving the foreground occupied", async () => {
  const provider = createServer((req) => req.resume());
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  cleanup.push(async () => {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  });
  const { server, preset } = await setup({
    voice: {
      url: `http://127.0.0.1:${(provider.address() as { port: number }).port}`,
      model: "fixture",
      voice: "fixture",
      synthesisTimeoutMs: 40,
    },
  });
  await server.stage.receipt({
    sessionId: "renderer",
    role: "broadcast",
    status: "ready",
    avatarId: preset.id,
    avatarSha256: preset.sha256,
  });
  server.stage.claimAudio("renderer");
  const speech = await server.call(
    "avatar_voice",
    { action: "speak", text: "Bounded synthesis fixture." },
    "synthesis-timeout",
  );
  const response = await fetch(
    server.url + "/audio/speech/" + speech.id + "?sessionId=renderer",
  );
  expect(response.status).toBe(502);
  await response.arrayBuffer();
  await vi.waitFor(() => {
    expect(server.stage.ledger.result(String(speech.id))).toMatchObject({
      status: "failed",
      evidence: { error: expect.stringMatching(/timeout|aborted/i) },
    });
    expect(server.stage.status().foreground).toBeNull();
  });
});

it("still expires an unconsumed renderer command instead of waiting as if synthesis started", async () => {
  const { server, preset } = await speechSetup();
  const speech = await server.call(
    "avatar_voice",
    { action: "speak", text: "No renderer consumed this." },
    "unconsumed-synthesis",
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20000);
  try {
    await server.stage.receipt({
      sessionId: "renderer",
      role: "broadcast",
      status: "heartbeat",
      avatarId: preset.id,
      avatarSha256: preset.sha256,
    });
    await (server.stage as unknown as { check(): Promise<void> }).check();
    expect(server.stage.ledger.result(String(speech.id)).status).toBe("failed");
    expect(server.stage.status().foreground).toBeNull();
  } finally {
    clock.mockRestore();
  }
});

it("keeps slow synthesis separate from renderer acknowledgement and starts the playback grace after transport", async () => {
  let release!: () => void, arrived!: () => void;
  const ready = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = createServer(async (req, res) => {
    for await (const _ of req) {
      /* consume request */
    }
    arrived();
    await gate;
    res.writeHead(200, { "Content-Type": "audio/wav" });
    res.end(Buffer.alloc(64));
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  cleanup.push(async () => {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  });
  const { server, preset } = await setup({
    voice: {
      url: `http://127.0.0.1:${(provider.address() as { port: number }).port}/speech`,
      model: "fixture",
      voice: "fixture",
    },
  });
  const receipt = (status: string, eventId?: string) =>
    server.stage.receipt({
      sessionId: "renderer",
      role: "broadcast",
      status,
      eventId,
      avatarId: preset.id,
      avatarSha256: preset.sha256,
    });
  await receipt("ready");
  server.stage.claimAudio("renderer");
  const speech = await server.call(
    "avatar_voice",
    { action: "speak", text: "A slow upstream sentence." },
    "slow-synthesis",
  );
  const consumed = fetch(
    server.url + "/audio/speech/" + speech.id + "?sessionId=renderer",
  ).then((r) => r.arrayBuffer());
  try {
    await ready;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20000);
    try {
      await receipt("heartbeat");
      await (server.stage as unknown as { check(): Promise<void> }).check();
      expect(server.stage.ledger.result(String(speech.id)).status).toBe(
        "queued",
      );
      expect(server.stage.voice.status().current?.phase).toBe("synthesizing");
      release();
      expect((await consumed).byteLength).toBe(64);
      await (server.stage as unknown as { check(): Promise<void> }).check();
      expect(server.stage.ledger.result(String(speech.id)).status).toBe(
        "queued",
      );
      await receipt("playing", String(speech.id));
      await receipt("ended", String(speech.id));
      expect(server.stage.ledger.result(String(speech.id)).status).toBe(
        "completed",
      );
    } finally {
      clock.mockRestore();
    }
  } finally {
    release();
    await consumed;
  }
});

it("binds presentation to current speech without cutting it, validates expression maps and requires the audio owner", async () => {
  const { server, events, preset } = await speechSetup();
  const speech = await server.call(
    "avatar_voice",
    { action: "speak", text: "你好。" },
    "direct-parent",
  );
  await expect(
    server.call("avatar_control", {
      action: "direct",
      audioActionId: speech.id,
      expressionWeights: { happy: "0.5" },
    }),
  ).rejects.toThrow("Invalid number");
  await expect(
    server.call("avatar_control", {
      action: "direct",
      audioActionId: speech.id,
      expressionWeights: { absent: 0.5 },
    }),
  ).rejects.toThrow("unavailable");
  const cue = await server.call(
    "avatar_control",
    {
      action: "direct",
      audioActionId: speech.id,
      expressionWeights: { happy: 0.5 },
    },
    "direct-cue",
  );
  expect(cue.accepted).toBe(true);
  expect(server.stage.status().foreground).toBe(speech.id);
  expect(events.filter((e) => e.type === "audio.cut")).toHaveLength(0);
  await expect(
    server.stage.receipt({
      sessionId: "silent-preview",
      status: "ended",
      role: "broadcast",
      eventId: cue.id as string,
      avatarId: preset.id,
      avatarSha256: preset.sha256,
    }),
  ).rejects.toThrow("non-owner");
  await server.stage.receipt({
    sessionId: "renderer",
    status: "playing",
    role: "broadcast",
    eventId: cue.id as string,
    avatarId: preset.id,
    avatarSha256: preset.sha256,
  });
  await server.call("avatar_voice", { action: "interrupt" }, "direct-stop");
  expect(server.stage.ledger.result(cue.id as string).status).toBe("cancelled");
  expect(
    await server.call("avatar_control", {
      action: "direct",
      audioActionId: speech.id,
      expressionWeights: {},
    }),
  ).toMatchObject({ accepted: false, status: "skipped" });
});

it("advertises installed VRMA metadata and serves exactly the configured motion library", async () => {
  const { directory, preset } = await fixture();
  const motionIndexFile = join(directory, "motions.json"),
    clip = animationFixture();
  await writeFile(
    motionIndexFile,
    JSON.stringify({
      [preset.sha256]: {
        activities: { speaking: "talk" },
        clips: { talk: clip },
      },
    }),
  );
  const server = new AvatarStageServer({
    port: 0,
    dataDir: join(directory, "ledger"),
    avatars: [{ ...preset, motionIndexFile }],
  });
  await server.start();
  cleanup.push(() => server.stop());
  const avatar = server.stage.status().activeAvatar!;
  expect(avatar.capabilities.clips).toContain("vrma:talk");
  expect(avatar.capabilities.animationCatalog).toEqual([
    expect.objectContaining({ bodyClip: "vrma:talk", duration: 2, auto: true }),
  ]);
  expect(JSON.stringify(avatar.capabilities)).not.toContain("base64");
  expect(JSON.stringify(avatar)).not.toContain(directory);
  const result = await fetch(server.url + "/assets/motions/fixture");
  expect(result.ok).toBe(true);
  expect((await result.json()).clips.talk.sha256).toBe(clip.sha256);
});

it("routes generated motion bytes separately from standard avatar motion indexes", async () => {
  const { directory, preset } = await fixture(),
    clipId = "generated-fixture";
  const payload = { clip: { name: "fixture", duration: 1, tracks: [] } };
  const provider = createServer((req, res) => {
    const row =
      req.url === "/jobs/" + clipId
        ? { status: "ready", clipId, avatarSha256: preset.sha256 }
        : payload;
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(row));
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  cleanup.push(async () => {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  });
  const motionIndexFile = join(directory, "motions.json");
  await writeFile(
    motionIndexFile,
    JSON.stringify({
      [preset.sha256]: { clips: { talk: animationFixture() } },
    }),
  );
  const server = new AvatarStageServer({
    port: 0,
    dataDir: join(directory, "ledger"),
    avatars: [
      {
        ...preset,
        motionIndexFile,
        motionUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}`,
      },
    ],
  });
  await server.start();
  cleanup.push(() => server.stop());
  const avatar = server.stage.status().activeAvatar!;
  expect(avatar.motionLibraryUrl).toBe("/assets/avatars/fixture/motions");
  expect((await fetch(server.url + avatar.motionLibraryUrl)).status).toBe(200);
  for (const path of ["/assets/generated-motions/", "/assets/motions/"]) {
    const response = await fetch(server.url + path + clipId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
  }
});

it("does not let an idle commentary draft replace foreground audio and admits a repeated request only once", async () => {
  const { server, events } = await speechSetup();
  expect(
    TOOL_DEFINITIONS.find((t) => t.name === "avatar_voice")?.tags,
  ).toContain("speak");
  const revision = server.stage.status().audioRevision;
  const first = await server.call(
    "avatar_voice",
    { action: "speak", text: "主线程正在说话。", ifIdleRevision: revision },
    "main-speech",
  );
  expect(first.accepted).toBe(true);
  const declined = await server.call(
    "avatar_voice",
    { action: "speak", text: "过期解说。", ifIdleRevision: revision },
    "background-speech",
  );
  expect(declined).toMatchObject({ accepted: false, status: "skipped" });
  expect(server.stage.status().foreground).toBe(first.id);
  const duplicate = await server.call(
    "avatar_voice",
    { action: "speak", text: "主线程正在说话。" },
    "main-speech",
  );
  expect(duplicate).toMatchObject({ id: first.id, reused: true });
  expect(
    events.filter((e) => e.type === "avatar.speech.submitted"),
  ).toHaveLength(1);
  expect(server.stage.ledger.history(20)).toHaveLength(1);
});

it("cancels a background draft whose disk admission finishes after a newer foreground utterance", async () => {
  const { server, events } = await speechSetup();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((r) => (release = r)),
    admitted = new Promise<void>((r) => (entered = r));
  const submit = server.stage.ledger.submit.bind(server.stage.ledger);
  vi.spyOn(server.stage.ledger, "submit").mockImplementationOnce(
    async (...args) => {
      const row = await submit(...args);
      entered();
      await blocked;
      return row;
    },
  );
  const old = server.call(
    "avatar_voice",
    {
      action: "speak",
      text: "过时的后台稿。",
      ifIdleRevision: server.stage.status().audioRevision,
    },
    "old-draft",
  );
  await admitted;
  const foreground = await server.call(
    "avatar_voice",
    { action: "speak", text: "先回应新消息。" },
    "new-main",
  );
  release();
  const late = await old;
  expect(late).toMatchObject({ accepted: false, status: "cancelled" });
  expect(server.stage.status().foreground).toBe(foreground.id);
  expect(
    events
      .filter((e) => e.type === "avatar.speech.submitted")
      .map((e) => e.data.requestId),
  ).toEqual(["new-main"]);
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});
export async function fixture(
  options: {
    bones?: string[];
    customExpressions?: string[];
    legacy?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "avatar-stage-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const names = [
    "hips",
    "spine",
    "head",
    "rightUpperArm",
    "rightLowerArm",
    ...(options.bones ?? []),
  ];
  const gltf: any = {
    asset: { version: "2.0" },
    nodes: names.map((name) => ({ name })),
    skins: [{ joints: [0, 1, 2, 3, 4] }],
    extensions: {
      VRMC_vrm: {
        humanoid: {
          humanBones: Object.fromEntries(
            names.map((name, node) => [name, { node }]),
          ),
        },
        expressions: {
          preset: { happy: {}, blink: {}, aa: {} },
          custom: Object.fromEntries(
            (options.customExpressions ?? []).map((name) => [name, {}]),
          ),
        },
      },
    },
  };
  if (options.legacy)
    gltf.extensions = {
      VRM: {
        humanoid: { humanBones: names.map((bone, node) => ({ bone, node })) },
        blendShapeMaster: {
          blendShapeGroups: [
            { presetName: "joy", name: "Joy" },
            ...(options.customExpressions ?? []).map((name) => ({
              presetName: "unknown",
              name,
            })),
          ],
        },
      },
    };
  let text = Buffer.from(JSON.stringify(gltf));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 32)]);
  const raw = Buffer.alloc(20 + text.length);
  raw.writeUInt32LE(0x46546c67);
  raw.writeUInt32LE(2, 4);
  raw.writeUInt32LE(raw.length, 8);
  raw.writeUInt32LE(text.length, 12);
  raw.writeUInt32LE(0x4e4f534a, 16);
  text.copy(raw, 20);
  const file = join(directory, "avatar.vrm");
  await writeFile(file, raw);
  const preset = {
    id: "fixture",
    label: "Fixture",
    file,
    sha256: createHash("sha256").update(raw).digest("hex"),
    format: "vrm" as const,
    attribution: "Test fixture",
    licenseUrl: "https://example.invalid/license",
  };
  return { directory, preset };
}
async function setup(
  options: Parameters<typeof fixture>[0] & { voice?: VoiceConfig } = {},
) {
  const { directory, preset } = await fixture(options);
  const events: any[] = [];
  const server = new AvatarStageServer(
    {
      port: 0,
      dataDir: join(directory, "ledger"),
      avatars: [preset],
      voice: options.voice,
    },
    (event) => events.push(event),
  );
  await server.start();
  cleanup.push(() => server.stop());
  return { directory, preset, server, events };
}
it("offers real finger and eye controls and custom VRM expressions without advertising absent joints", async () => {
  const { server } = await setup({
    bones: [
      "rightHand",
      "rightIndexProximal",
      "rightIndexIntermediate",
      "rightIndexDistal",
      "leftEye",
    ],
    customExpressions: ["cheekSmile"],
  });
  const caps = server.stage.status().avatars[0].capabilities;
  expect(caps.bones).toEqual(
    expect.arrayContaining([
      "rightIndexProximal",
      "rightIndexIntermediate",
      "rightIndexDistal",
      "leftEye",
    ]),
  );
  expect(caps.bones).not.toContain("rightThumbProximal");
  expect(caps.expressions).toContain("cheekSmile");
  const accepted = await server.call("avatar_control", {
    action: "perform",
    bones: { rightIndexProximal: [0, 0, 20] },
    expression: "cheekSmile",
  });
  expect(accepted.status).toBe("queued");
  expect(server.stage.ledger.result(String(accepted.id)).command.bones).toEqual(
    { rightIndexProximal: [0, 0, 20] },
  );
  await expect(
    server.call("avatar_control", {
      action: "perform",
      bones: { rightThumbProximal: [0, 0, 20] },
    }),
  ).rejects.toThrow();
});
it("normalizes legacy thumb slots and keeps named custom expressions in the public rig contract", async () => {
  const { server } = await setup({
    legacy: true,
    bones: ["leftThumbProximal", "leftThumbIntermediate", "leftThumbDistal"],
    customExpressions: ["smallSmile"],
  });
  const avatar = server.stage.status().activeAvatar!;
  expect(avatar.capabilities.bones).toEqual(
    expect.arrayContaining([
      "leftThumbMetacarpal",
      "leftThumbProximal",
      "leftThumbDistal",
    ]),
  );
  expect(avatar.humanoid.leftThumbMetacarpal).toBe("leftThumbProximal");
  expect(avatar.humanoid.leftThumbProximal).toBe("leftThumbIntermediate");
  expect(avatar.capabilities.expressions).toEqual(["happy", "smallSmile"]);
  const accepted = await server.call("avatar_control", {
    action: "perform",
    bones: { leftThumbMetacarpal: [0, 0, 10] },
    expression: "smallSmile",
  });
  expect(accepted.status).toBe("queued");
});
it("declares independent tools and performs no network work with unconfigured providers", async () => {
  const network = vi.spyOn(globalThis, "fetch");
  const { server } = await setup();
  expect(network).not.toHaveBeenCalled();
  expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
    "avatar_voice",
    "avatar_control",
    "avatar_motion",
    "avatar_music",
    "avatar_query",
  ]);
  expect(DESCRIPTION.protocol).toBe("avatar-stage/1");
  expect(server.stage.status().avatars).toHaveLength(1);
  await expect(
    server.call(
      "avatar_motion",
      { action: "generate", prompt: "An object waves." },
      "test",
    ),
  ).rejects.toThrow("No motion model");
  expect(network).not.toHaveBeenCalled();
});
it("queries state without creating actions and rejects mutations through the read tool", async () => {
  const { server } = await setup();
  const before = server.stage.ledger.history(100);
  expect(
    (await server.call("avatar_query", { action: "status" })).protocol,
  ).toBe("avatar-stage/1");
  expect(await server.call("avatar_query", { action: "history" })).toEqual({
    actions: before,
  });
  await expect(
    server.call("avatar_query", { action: "speak", text: "must not speak" }),
  ).rejects.toThrow();
  expect(server.stage.ledger.history(100)).toEqual(before);
  expect(TOOL_DEFINITIONS.find((t) => t.name === "avatar_query")!.tags).toEqual(
    ["read"],
  );
});
it("requires real renderer evidence, preserves exact raw text, and never revives cancelled actions", async () => {
  const { server, preset, directory } = await setup();
  const result = await server.call(
    "avatar_control",
    { action: "perform", gesture: "wave" },
    "same",
  );
  expect(result.status).toBe("queued");
  const reused = await server.call(
    "avatar_control",
    { gesture: "wave", action: "perform" },
    "same",
  );
  expect(reused.id).toBe(result.id);
  expect(reused.reused).toBe(true);
  await expect(
    server.call(
      "avatar_control",
      { action: "perform", gesture: "nod" },
      "same",
    ),
  ).rejects.toThrow("another action");
  await server.call(
    "avatar_control",
    { action: "cancel", actionId: result.id },
    "cancel",
  );
  await server.stage.receipt({
    sessionId: "renderer",
    role: "broadcast",
    status: "ended",
    eventId: result.id,
    avatarId: preset.id,
    avatarSha256: preset.sha256,
  });
  expect(server.stage.ledger.result(String(result.id)).status).toBe(
    "cancelled",
  );
  const raw = await readFile(join(directory, "ledger/events.jsonl"), "utf8");
  expect(raw).toContain("Explicit cancellation");
  expect(raw).toContain('"ignored":true');
});
it("enforces one audio owner and rejects non-owner or wrong-model receipts", async () => {
  const { server, preset } = await setup();
  for (const sessionId of ["one", "two"])
    await server.stage.receipt({
      sessionId,
      role: "broadcast",
      status: "ready",
      avatarId: preset.id,
      avatarSha256: preset.sha256,
    });
  expect(server.stage.claimAudio("one").ok).toBe(true);
  expect(() => server.stage.claimAudio("two")).toThrow("Another renderer");
  await expect(
    server.stage.receipt({
      sessionId: "one",
      role: "broadcast",
      status: "heartbeat",
      avatarId: preset.id,
      avatarSha256: "a".repeat(64),
    }),
  ).rejects.toThrow("active avatar");
});
it("SDK consumes the same protocol without replaying snapshot actions and stops without stopping the service", async () => {
  const { server, preset } = await setup();
  const events = vi.fn(),
    client = new AvatarStageClient(server.url, events);
  await client.start();
  cleanup.push(() => client.stop());
  await new Promise((r) => setTimeout(r, 20));
  expect(events).not.toHaveBeenCalled();
  const result = await client.call(
    "avatar_control",
    { action: "perform", gesture: "nod" },
    "sdk-test",
  );
  expect(result.status).toBe("queued");
  await server.stage.receipt({
    sessionId: "renderer",
    role: "broadcast",
    status: "ended",
    eventId: result.id,
    avatarId: preset.id,
    avatarSha256: preset.sha256,
  });
  await vi.waitFor(() =>
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "avatar.action",
        data: expect.objectContaining({ id: result.id, status: "completed" }),
      }),
    ),
  );
  await client.stop();
  expect((await fetch(server.url + "/api/state")).ok).toBe(true);
  await expect(
    client.call("avatar_control", { action: "status" }),
  ).rejects.toThrow("stopped");
});
it("stopping the stage cancels unfinished actions and late receipts cannot make them complete", async () => {
  const { server, preset } = await setup();
  const result = await server.call(
    "avatar_control",
    { action: "perform", gesture: "wave" },
    "stop-test",
  );
  await server.stage.stop();
  expect(server.stage.ledger.result(String(result.id)).status).toBe(
    "cancelled",
  );
  await server.stage.receipt({
    sessionId: "late",
    role: "broadcast",
    status: "ended",
    eventId: result.id,
    avatarId: preset.id,
    avatarSha256: preset.sha256,
  });
  expect(server.stage.ledger.result(String(result.id)).status).toBe(
    "cancelled",
  );
  await expect(
    server.call(
      "avatar_control",
      { action: "perform", gesture: "wave" },
      "after-stop",
    ),
  ).rejects.toThrow("stopped");
});
it("cancels waiting without cancelling or repeating the underlying action", async () => {
  const { server } = await setup(),
    client = new AvatarStageClient(server.url);
  await client.start();
  cleanup.push(() => client.stop());
  const action = await client.invoke(
    "avatar_control",
    { action: "perform", gesture: "wave" },
    "wait-test",
  );
  const stop = new AbortController(),
    waiting = client.wait(String(action.id), { signal: stop.signal });
  setTimeout(() => stop.abort(new Error("wait-cancelled")), 25);
  await expect(waiting).rejects.toThrow("wait-cancelled");
  expect(server.stage.ledger.result(String(action.id)).status).toBe("queued");
  expect(server.stage.ledger.history(100)).toHaveLength(1);
});
it("does not mistake a preview observer for broadcast execution, and rejects undocumented arguments", async () => {
  const { server, preset } = await setup();
  const action = await server.call(
    "avatar_control",
    { action: "perform", gesture: "wave" },
    "broadcast-test",
  );
  await server.stage.receipt({
    sessionId: "preview",
    role: "preview",
    status: "ended",
    eventId: action.id,
    avatarId: preset.id,
    avatarSha256: preset.sha256,
  });
  expect(server.stage.ledger.result(String(action.id)).status).toBe("queued");
  await expect(
    server.call(
      "avatar_voice",
      { action: "speak", text: "Hello", apiKey: "must-not-forward" },
      "bad",
    ),
  ).rejects.toThrow("Unknown arguments.apiKey");
});
