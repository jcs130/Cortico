import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { HUMAN_BONES, id, type AvatarPreset } from "./types.ts";
import { loadAnimationIndex, type AnimationIndex } from "./animation-index.ts";
// Names normalized by the three-vrm VRM 0 loader into its VRM 1 expression API.
const VRM0_EXPRESSIONS: Record<string, string> = {
  joy: "happy",
  sorrow: "sad",
  fun: "relaxed",
  a: "aa",
  i: "ih",
  u: "ou",
  e: "ee",
  o: "oh",
  lookup: "lookUp",
  lookdown: "lookDown",
  lookleft: "lookLeft",
  lookright: "lookRight",
  blink_l: "blinkLeft",
  blink_r: "blinkRight",
};
// VRM 0 thumb slots are renamed by three-vrm when creating its normalized rig.
const VRM0_BONES: Record<string, string> = {
  leftThumbProximal: "leftThumbMetacarpal",
  leftThumbIntermediate: "leftThumbProximal",
  rightThumbProximal: "rightThumbMetacarpal",
  rightThumbIntermediate: "rightThumbProximal",
};
export class AvatarLibrary {
  private loaded = new Map<
    string,
    {
      preset: AvatarPreset;
      json: any;
      capabilities: Record<string, unknown>;
      motions?: AnimationIndex;
    }
  >();
  async load(presets: AvatarPreset[]) {
    this.loaded.clear();
    for (const preset of presets) {
      id(preset.id);
      if (this.loaded.has(preset.id)) throw Error("Duplicate avatar id");
      if (!/^[a-f0-9]{64}$/.test(preset.sha256))
        throw Error("Avatar SHA256 is required");
      const bytes = await readFile(preset.file);
      if (
        bytes.length > 150 * 1024 * 1024 ||
        bytes.readUInt32LE(0) !== 0x46546c67 ||
        bytes.readUInt32LE(4) !== 2 ||
        bytes.readUInt32LE(8) !== bytes.length
      )
        throw Error("Invalid GLB/VRM");
      if (createHash("sha256").update(bytes).digest("hex") !== preset.sha256)
        throw Error("Avatar hash mismatch: " + preset.id);
      const json = JSON.parse(
        bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString(),
      );
      for (const asset of [...(json.buffers ?? []), ...(json.images ?? [])])
        if (asset.uri && !String(asset.uri).startsWith("data:"))
          throw Error(
            "Avatar must embed resources; external loader requests are disabled",
          );
      const vrm1 = json.extensions?.VRMC_vrm,
        vrm0 = json.extensions?.VRM;
      if (preset.format === "vrm" && !vrm1 && !vrm0)
        throw Error("Avatar is not a VRM");
      const humanoid =
        vrm1?.humanoid?.humanBones ??
        Object.fromEntries(
          (vrm0?.humanoid?.humanBones ?? []).map((b: any) => [
            VRM0_BONES[b.bone] ?? b.bone,
            { node: b.node },
          ]),
        );
      const nodes = new Set((json.nodes ?? []).map((n: any) => n.name));
      const bones = HUMAN_BONES.filter(
        (b) =>
          humanoid[b] !== undefined ||
          Boolean(preset.humanoid?.[b] && nodes.has(preset.humanoid[b])),
      );
      const expressions = vrm1
        ? [
            ...new Set([
              ...Object.keys(vrm1.expressions?.preset ?? {}),
              ...Object.keys(vrm1.expressions?.custom ?? {}),
            ]),
          ]
        : vrm0
          ? (vrm0.blendShapeMaster?.blendShapeGroups ?? [])
              .map((x: any) =>
                x.presetName === "unknown" ? x.name : x.presetName,
              )
              .filter((n: unknown) => typeof n === "string" && n.length > 0)
              .map((n: string) => VRM0_EXPRESSIONS[n] ?? n)
          : Object.keys(preset.expressions ?? {});
      const motions = preset.motionIndexFile
        ? await loadAnimationIndex(preset.motionIndexFile, preset.sha256)
        : undefined;
      this.loaded.set(preset.id, {
        preset,
        json,
        motions,
        capabilities: {
          format: preset.format,
          bones,
          expressions,
          clips: [
            ...(json.animations ?? []).map(
              (a: any, i: number) => a.name ?? "animation_" + i,
            ),
            ...Object.keys(motions?.clips ?? {}).map((name) => "vrma:" + name),
          ],
          animationCatalog: Object.entries(motions?.clips ?? {}).map(
            ([name, { url: _url, ...metadata }]) => ({
              bodyClip: "vrma:" + name,
              ...metadata,
            }),
          ),
          motionConfigured: !!(preset.motion?.url ?? preset.motionUrl),
          skinCount: json.skins?.length ?? 0,
        },
      });
    }
  }
  get(avatarId: string) {
    const found = this.loaded.get(avatarId);
    if (!found) throw Error("Avatar is not installed");
    return found;
  }
  list() {
    return [...this.loaded.values()].map(({ preset, capabilities }) => ({
      id: preset.id,
      label: preset.label,
      sha256: preset.sha256,
      attribution: preset.attribution,
      licenseUrl: preset.licenseUrl,
      capabilities,
    }));
  }
  public(avatarId: string) {
    const { preset, capabilities, json, motions } = this.get(avatarId);
    const human =
      json.extensions?.VRMC_vrm?.humanoid?.humanBones ??
      Object.fromEntries(
        (json.extensions?.VRM?.humanoid?.humanBones ?? []).map((b: any) => [
          VRM0_BONES[b.bone] ?? b.bone,
          { node: b.node },
        ]),
      );
    const names = Object.fromEntries(
      Object.entries(human)
        .map(([name, binding]: [string, any]) => [
          name,
          json.nodes?.[binding.node]?.name,
        ])
        .filter(([, nodeName]) => typeof nodeName === "string"),
    );
    return {
      id: preset.id,
      label: preset.label,
      sha256: preset.sha256,
      format: preset.format,
      url: "/assets/avatars/" + encodeURIComponent(preset.id),
      attribution: preset.attribution,
      licenseUrl: preset.licenseUrl,
      humanoid: { ...names, ...preset.humanoid },
      expressions: preset.expressions ?? {},
      ...(motions
        ? {
            motionLibraryUrl:
              "/assets/avatars/" + encodeURIComponent(preset.id) + "/motions",
          }
        : {}),
      capabilities,
    };
  }
}
