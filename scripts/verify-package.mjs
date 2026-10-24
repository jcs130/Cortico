/** Run after npm pack. npm/TS tool locations are explicit, no network fallback. */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const [tgz, directory, npmCli] = process.argv.slice(2);
if (!tgz || !directory || !npmCli)
  throw Error(
    "Usage: node scripts/verify-package.mjs package.tgz NEW_EMPTY_DIR /path/npm-cli.js",
  );
const target = resolve(directory),
  source = fileURLToPath(new URL("..", import.meta.url));
await fs.mkdir(target); // Refuse to reuse a prior verification tree.
await fs.writeFile(
  join(target, "package.json"),
  JSON.stringify({ name: "avatar-clean-check", private: true, type: "module" }),
);
function run(args) {
  const r = spawnSync(process.execPath, args, {
    cwd: target,
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) throw Error(r.stderr + "\n" + r.stdout);
  return r.stdout;
}
run([
  npmCli,
  "install",
  "--offline",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--omit=dev",
  resolve(tgz),
]);
const require = createRequire(join(target, "package.json"));
const resolveImport = (name) =>
  new URL(
    run([
      "--input-type=module",
      "-e",
      `console.log(import.meta.resolve(${JSON.stringify(name)}))`,
    ]).trim(),
  );
assert.throws(() => require.resolve("cortico"));
let fetchCount = 0;
const oldFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  fetchCount++;
  throw Error("Unexpected external fetch " + String(args[0]));
};
const { AvatarStageServer } = await import(
  resolveImport("cortico-world-avatar-stage/server")
);
await import(resolveImport("cortico-world-avatar-stage/core"));
await import(resolveImport("cortico-world-avatar-stage/sdk"));
await import(resolveImport("cortico-world-avatar-stage"));
const { DESCRIPTION } = await import(
  resolveImport("cortico-world-avatar-stage/tools")
);
assert.equal(DESCRIPTION.tools.length, 5);
const server = new AvatarStageServer({
  port: 0,
  dataDir: join(target, "state"),
  avatars: [],
});
await server.start();
assert.equal(fetchCount, 0);
globalThis.fetch = oldFetch;
for (const path of [
  "/",
  "/vendor/three/three.module.js",
  "/vendor/three/three.core.js",
  "/vendor/addons/loaders/GLTFLoader.js",
  "/vendor/vrm/three-vrm.module.js",
]) {
  const response = await fetch(server.url + path);
  assert(response.ok, path + " HTTP " + response.status);
  await response.arrayBuffer();
}
await server.stop();
// Compile independent source with only TypeScript + Node typings, no framework.
run([
  npmCli,
  "install",
  "--offline",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--save-dev",
  "typescript@5.9.3",
  "@types/node@22",
]);
await fs.cp(join(source, "src"), join(target, "src"), { recursive: true });
await fs.rm(join(target, "src/index.ts"));
for (const name of [
  "tsconfig.json",
  "tsconfig.build.json",
  "tsconfig.core.json",
])
  await fs.copyFile(join(source, name), join(target, name));
run([require.resolve("typescript/bin/tsc"), "-p", "tsconfig.core.json"]);
await fs.writeFile(
  join(target, "public-types.ts"),
  `import {AvatarStageClient} from 'cortico-world-avatar-stage/sdk';
import {type StageConfig, type StageEvent, type ToolRequests} from 'cortico-world-avatar-stage/core';
const cfg:StageConfig={port:0,dataDir:'./state',avatars:[]};
const client=new AvatarStageClient('http://127.0.0.1:18431',(e:StageEvent)=>void e.protocol);
const req:ToolRequests['avatar_voice']={action:'speak',text:'hello'};
void client.invoke('avatar_voice',req,'stable-id');
// @ts-expect-error misspelled operation must not be accepted.
void client.invoke('avatar_voice',{action:'speeak',text:'hello'});
// @ts-expect-error invalid semantic bone.
void client.invoke('avatar_control',{action:'perform',bones:{notAHumanBone:[0,0,0]}});
void cfg;
`,
);
run([
  require.resolve("typescript/bin/tsc"),
  "--noEmit",
  "--strict",
  "--skipLibCheck",
  "--module",
  "nodenext",
  "--moduleResolution",
  "nodenext",
  "--target",
  "es2022",
  "public-types.ts",
]);
assert.throws(() => require.resolve("cortico"));
const evidence = {
  passed: true,
  at: new Date().toISOString(),
  package: resolve(tgz),
  directory: target,
  corticoInstalled: false,
  startupExternalFetches: fetchCount,
  productionImports: ["core", "server", "sdk", "tools", "root"],
  vendorPaths: "production hoisted dependencies served successfully",
  sourceBuildWithoutCortico: true,
  publicTypes: true,
};
await fs.writeFile(
  join(target, "verification.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify(evidence));
