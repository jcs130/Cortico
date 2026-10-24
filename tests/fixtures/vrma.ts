import { createHash } from "node:crypto";
export function animationFixture(
  times = [0, 2],
  extra: Record<string, unknown> = {},
) {
  const binary = Buffer.alloc(times.length * 20);
  times.forEach((t, i) => {
    binary.writeFloatLE(t, i * 4);
    binary.writeFloatLE(1, times.length * 4 + i * 16 + 12);
  });
  const json = {
    asset: { version: "2.0" },
    nodes: [{}],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: "1.0",
        humanoid: { humanBones: { hips: { node: 0 } } },
      },
    },
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteLength: times.length * 4 },
      {
        buffer: 0,
        byteOffset: times.length * 4,
        byteLength: times.length * 16,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: times.length,
        type: "SCALAR",
      },
      { bufferView: 1, componentType: 5126, count: times.length, type: "VEC4" },
    ],
    animations: [
      {
        samplers: [{ input: 0, output: 1 }],
        channels: [{ sampler: 0, target: { node: 0, path: "rotation" } }],
      },
    ],
    ...extra,
  };
  const text = Buffer.from(JSON.stringify(json)),
    padded = Buffer.concat([
      text,
      Buffer.alloc((4 - (text.length % 4)) % 4, 32),
    ]);
  const bytes = Buffer.alloc(28 + padded.length + binary.length);
  [0x46546c67, 2, bytes.length, padded.length, 0x4e4f534a].forEach((v, i) =>
    bytes.writeUInt32LE(v, i * 4),
  );
  padded.copy(bytes, 20);
  bytes.writeUInt32LE(binary.length, 20 + padded.length);
  bytes.writeUInt32LE(0x004e4942, 24 + padded.length);
  binary.copy(bytes, 28 + padded.length);
  return {
    url: "data:model/gltf-binary;base64," + bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    label: "Speaking",
    tags: ["speaking"],
    loop: true,
    auto: true,
  };
}
