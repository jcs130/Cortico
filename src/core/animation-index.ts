import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";

export interface InstalledAnimation {
  url: string;
  sha256: string;
  label?: string;
  description?: string;
  tags?: string[];
  auto?: boolean;
  loop?: boolean;
  source?: string;
  license?: string;
  duration: number;
}
export interface AnimationIndex {
  idle?: string;
  gestures?: Record<string, string>;
  activities?: { speaking?: string; singing?: string };
  clips: Record<string, InstalledAnimation>;
}

function animationDuration(bytes: Buffer, json: any): number {
  let binary: Buffer | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset),
      type = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + size > bytes.length) throw Error("Truncated VRMA chunk");
    if (type === 0x004e4942)
      binary = bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size;
  }
  const durations = new Map<number, number>();
  for (const animation of json.animations ?? [])
    for (const sampler of animation.samplers ?? []) {
      if (durations.has(sampler.input)) continue;
      const accessor = json.accessors?.[sampler.input],
        view = json.bufferViews?.[accessor?.bufferView];
      if (
        !accessor ||
        accessor.type !== "SCALAR" ||
        accessor.componentType !== 5126 ||
        !Number.isInteger(accessor.count) ||
        accessor.count < 1 ||
        accessor.sparse ||
        !view
      )
        throw Error("Invalid animation time accessor");
      const resource = json.buffers?.[view.buffer];
      const data = resource?.uri
        ? Buffer.from(String(resource.uri).split(",")[1] ?? "", "base64")
        : binary;
      if (!data) throw Error("Missing animation time buffer");
      const stride = view.byteStride ?? 4,
        start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      const end = start + (accessor.count - 1) * stride + 4;
      if (
        !Number.isInteger(stride) ||
        stride < 4 ||
        !Number.isInteger(start) ||
        start < 0 ||
        end > data.length ||
        end > (view.byteOffset ?? 0) + view.byteLength
      )
        throw Error("Animation times exceed their buffer view");
      let previous = -1;
      for (let i = 0; i < accessor.count; i++) {
        const time = data.readFloatLE(start + i * stride);
        if (!Number.isFinite(time) || time < 0 || time <= previous)
          throw Error("Animation times must be finite and increasing");
        previous = time;
      }
      durations.set(sampler.input, previous);
    }
  return Math.max(0, ...durations.values());
}
/** Explicit, locally installed VRMA data. No scripts, network discovery or retarget guessing. */
export async function loadAnimationIndex(
  file: string,
  avatarSha256: string,
): Promise<AnimationIndex> {
  if ((await stat(file)).size > 128 * 1024 * 1024)
    throw Error("Animation index exceeds the asset byte budget");
  const source = JSON.parse(await readFile(file, "utf8"));
  const raw = source[avatarSha256];
  if (
    !raw ||
    typeof raw !== "object" ||
    !raw.clips ||
    typeof raw.clips !== "object"
  )
    throw Error("Animation index has no entry for this avatar hash");
  const clips: Record<string, InstalledAnimation> = Object.create(null);
  for (const [name, spec] of Object.entries(raw.clips) as [string, any][]) {
    if (!name || name.length > 150 || !spec || typeof spec !== "object")
      throw Error("Invalid animation entry");
    const encoded =
      /^data:(?:model\/gltf-binary|application\/octet-stream);base64,([A-Za-z0-9+/=]+)$/.exec(
        spec.url,
      );
    if (!encoded) throw Error("Installed VRMA must embed its bytes");
    const bytes = Buffer.from(encoded[1], "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== spec.sha256)
      throw Error("Animation hash mismatch: " + name);
    if (
      bytes.length < 20 ||
      bytes.readUInt32LE(0) !== 0x46546c67 ||
      bytes.readUInt32LE(4) !== 2 ||
      bytes.readUInt32LE(8) !== bytes.length
    )
      throw Error("Invalid VRMA container: " + name);
    const json = JSON.parse(
      bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString(),
    );
    if (!json.extensions?.VRMC_vrm_animation?.humanoid?.humanBones)
      throw Error("Standard VRMC_vrm_animation is required: " + name);
    for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])])
      if (resource.uri && !String(resource.uri).startsWith("data:"))
        throw Error("External animation resources are not installed");
    const duration = animationDuration(bytes, json);
    if (!Number.isFinite(duration) || duration <= 0)
      throw Error("Animation has no finite duration: " + name);
    clips[name] = {
      url: spec.url,
      sha256: spec.sha256,
      duration,
      ...(typeof spec.label === "string"
        ? { label: spec.label.slice(0, 100) }
        : {}),
      ...(typeof spec.description === "string"
        ? { description: spec.description.slice(0, 300) }
        : {}),
      tags: Array.isArray(spec.tags)
        ? spec.tags.filter((t: unknown) => typeof t === "string").slice(0, 16)
        : [],
      auto: spec.auto === true,
      loop: spec.loop === true,
      ...(typeof spec.source === "string" ? { source: spec.source } : {}),
      ...(typeof spec.license === "string" ? { license: spec.license } : {}),
    };
  }
  for (const name of [
    ...(raw.idle === undefined ? [] : [raw.idle]),
    ...Object.values(raw.gestures ?? {}),
    ...Object.values(raw.activities ?? {}),
  ])
    if (typeof name !== "string" || !clips[name])
      throw Error("Animation mapping references a missing clip");
  return {
    clips,
    idle: raw.idle,
    gestures: raw.gestures,
    activities: raw.activities,
  };
}
