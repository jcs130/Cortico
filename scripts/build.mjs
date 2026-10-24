import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const compiler = new URL("../node_modules/typescript/bin/tsc", import.meta.url);
const result = spawnSync(
  process.execPath,
  [fileURLToPath(compiler), "-p", "tsconfig.build.json"],
  { stdio: "inherit", windowsHide: true },
);
if (result.status) process.exit(result.status);
// Keep the browser distribution self contained. Third party VRMA support and
// local helpers are bundled; Three/VRM still share the server's pinned imports.
await fs.cp(new URL("../web/", import.meta.url), new URL("../dist/web/", import.meta.url), { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("../web/viewer.js", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/web/viewer.js", import.meta.url)),
  bundle: true, format: "esm", target: "es2022",
  external: ["three", "three/*", "@pixiv/three-vrm"],
});
await fs.copyFile(
  new URL("../src/prompt.md", import.meta.url),
  new URL("../dist/prompt.md", import.meta.url),
);
const { WORLD_DESCRIPTION } = await import(
  new URL("../dist/tools.js", import.meta.url)
);
await fs.writeFile(
  new URL("../describe.json", import.meta.url),
  JSON.stringify(
    {
      ...WORLD_DESCRIPTION,
      prompts: [
        {
          key: "worlds.avatar-stage.env",
          title: "3D 演出能力",
          role: "envPrompt",
          content: await fs.readFile(
            new URL("../src/prompt.md", import.meta.url),
            "utf8",
          ),
        },
      ],
    },
    null,
    2,
  ) + "\n",
);
