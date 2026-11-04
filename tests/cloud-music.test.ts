import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { MusicService } from "../src/core/music.ts";
import { AvatarStageServer } from "../src/server.ts";
import { AvatarStageClient } from "../src/sdk.ts";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});
function tone() {
  const samples = 24000,
    b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    b.writeInt16LE(
      Math.round(Math.sin((i * 2 * Math.PI * 440) / 24000) * 1000),
      44 + i * 2,
    );
  return b;
}

it("reads adopted legacy audio after removing all generation configuration and credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "avatar-legacy-archive-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const bytes = tone(),
    oldDirectory = join(directory, "cloud-music");
  await mkdir(join(oldDirectory, "old-job"), { recursive: true });
  await writeFile(join(oldDirectory, "old-job", "song.wav"), bytes);
  await writeFile(
    join(oldDirectory, "jobs.json"),
    JSON.stringify([
      {
        jobId: "old-job",
        state: "ready",
        trackId: "cloud-old-track",
        input: { title: "Existing song" },
        approved: true,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ]),
  );
  const music = new MusicService(() => ({ directory: "" }), directory);
  await music.start();
  cleanup.push(async () => music.stop());
  expect((await music.track("cloud-old-track")).track.title).toBe("Existing song");
  expect((await music.list())[0].id).toBe("cloud-old-track");
  expect(music.state().generationConfigured).toBe(false);
});

it("imports a completed AIGC artifact as an unadopted candidate, preserves it across restart and never generates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "avatar-aigc-import-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(Error("unexpected provider request"));
  const config = () => ({
    directory: "",
    cloud: {
      provider: "fal" as const,
      queueUrl: "https://never-call.invalid",
      downloadHosts: [],
    },
  });
  const music = new MusicService(config, directory);
  await music.start();
  cleanup.push(async () => music.stop());
  const imported = await music.importArtifact(tone(), {
    title: "Created elsewhere",
    instrumental: true,
  });
  expect(imported).toMatchObject({
    state: "review",
    contentApproved: false,
    playbackVerified: false,
  });
  await expect(music.track(imported.trackId)).rejects.toThrow("adopted");
  expect(await music.list()).toEqual([]);
  expect((await music.track(imported.trackId, true)).info.durationMs).toBe(
    1000,
  );
  await music.review(imported.jobId, true);
  expect((await music.list())[0].id).toBe(imported.trackId);
  music.stop();
  const restored = new MusicService(config, directory);
  await restored.start();
  cleanup.push(async () => restored.stop());
  expect((await restored.track(imported.trackId)).track.title).toBe(
    "Created elsewhere",
  );
  await expect(restored.generate({}, "new")).rejects.toThrow(
    "capability_moved",
  );
  expect(network).not.toHaveBeenCalled();
  await writeFile((await restored.track(imported.trackId)).path, "tampered");
  await expect(restored.track(imported.trackId)).rejects.toThrow("integrity");
});
it("uses an explicit binary SDK import without increasing the ordinary JSON request limit or auto-playing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "avatar-aigc-sdk-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const server = new AvatarStageServer({
    port: 0,
    dataDir: directory,
    avatars: [],
    music: { directory: "" },
  });
  await server.start();
  cleanup.push(() => server.stop());
  const client = new AvatarStageClient(server.url);
  await client.start();
  cleanup.push(() => client.stop());
  const imported = await client.importMusic(tone(), {
    title: "AIGC candidate",
  });
  expect(imported).toMatchObject({ state: "review", playbackVerified: false });
  expect(await server.stage.music.list()).toEqual([]);
  await client.call("avatar_music", {
    action: "approve",
    jobId: imported.jobId,
  });
  expect((await server.stage.music.list())[0].title).toBe("AIGC candidate");
  const forbidden = await fetch(server.url + "/api/import-music", {
    method: "POST",
    headers: {
      Origin: "https://not-the-stage.invalid",
      "Content-Type": "audio/wav",
    },
    body: tone(),
  });
  expect(forbidden.status).toBe(403);
});
