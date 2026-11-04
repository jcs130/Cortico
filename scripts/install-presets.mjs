import fs from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
const catalog = JSON.parse(
  await fs.readFile(new URL("../assets/presets.json", import.meta.url), "utf8"),
);
const args = process.argv.slice(2),
  directory = resolve(args[0] ?? "./data/avatars"),
  selected = args.slice(1);
await fs.mkdir(directory, { recursive: true });
const installed = [];
for (const preset of catalog.presets) {
  if (selected.length && !selected.includes(preset.id)) continue;
  const file = join(directory, preset.id + ".vrm");
  let bytes;
  try {
    bytes = await fs.readFile(file);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    const response = await fetch(preset.url, { redirect: "error" });
    if (!response.ok) throw Error("Preset download HTTP " + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (
    bytes.length !== preset.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== preset.sha256
  )
    throw Error("Preset hash mismatch: " + preset.id);
  await fs.writeFile(file, bytes);
  installed.push({
    id: preset.id,
    label: preset.label,
    file,
    sha256: preset.sha256,
    format: preset.format,
    attribution: preset.attribution,
    licenseUrl: preset.licenseUrl,
  });
  console.log("Installed " + preset.label + " — " + preset.attribution);
}
await fs.writeFile(
  join(directory, "installed.json"),
  JSON.stringify(
    { version: 1, sourceRevision: catalog.revision, avatars: installed },
    null,
    2,
  ) + "\n",
);
console.log(
  "Add the avatars from " +
    join(directory, "installed.json") +
    " to your explicit stage configuration.",
);
