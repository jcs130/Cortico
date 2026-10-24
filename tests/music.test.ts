import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MusicService } from "../src/core/music.ts";
import { wavInfo, vocalEnvelope } from "../src/core/wav.ts";
const cleanup: Array<() => Promise<unknown>> = [];
it("lists a fresh external library as empty without creating or replacing its catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "avatar-empty-library-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const library = join(directory, "music");
  await mkdir(library);
  const music = new MusicService(
    () => ({ directory: library }),
    join(directory, "state"),
  );
  await music.start();
  cleanup.push(async () => music.stop());
  expect(await music.list()).toEqual([]);
  await expect(
    import("node:fs/promises").then((fs) =>
      fs.stat(join(library, "catalog.json")),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(library, "catalog.json"), "invalid catalog");
  await expect(music.list()).rejects.toThrow();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
it("reads original 24-bit stereo catalog WAVs and derives vocal cues without using accompaniment", () => {
  const samples = 240,
    b = Buffer.alloc(44 + samples * 2 * 3);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(144000, 28);
  b.writeUInt16LE(6, 32);
  b.writeUInt16LE(24, 34);
  b.write("data", 36);
  b.writeUInt32LE(b.length - 44, 40);
  for (let at = 44; at < b.length; at += 3) b.writeIntLE(4194304, at, 3);
  expect(wavInfo(b).durationMs).toBe(10);
  expect(vocalEnvelope(b).samples[0]).toBe(1);
  expect(wavInfo(b.subarray(0, 44), b.length).frames).toBe(samples);
});
it("keeps generation outside the stage and performs no provider request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "avatar-generation-moved-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const music = new MusicService(
    () => ({ directory: "", generationUrl: "https://must-not-call.invalid" }),
    directory,
  );
  await music.start();
  cleanup.push(async () => music.stop());
  await expect(
    music.generate({ action: "generate", title: "Original" }, "same"),
  ).rejects.toThrow("capability_moved");
  expect(music.state()).toMatchObject({
    generationConfigured: false,
    generationOwner: "cortico-world-aigc",
  });
});
it("rejects catalog links that escape the explicitly configured library", async () => {
  const directory = await mkdtemp(join(tmpdir(), "avatar-music-path-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "music"));
  await writeFile(join(directory, "outside.wav"), "private");
  const music = new MusicService(
    () => ({ directory: join(directory, "music") }),
    join(directory, "state"),
  );
  await music.start();
  cleanup.push(async () => music.stop());
  await expect(music.asset("../outside.wav")).rejects.toThrow("escapes");
});
