import { readFile } from "node:fs/promises";
import { AvatarStageServer } from "./server.ts";
import { dirname, resolve } from "node:path";
import { normalizeConfig } from "./core/config.ts";
const file = process.argv[2];
if (!file) throw Error("Usage: npm start -- <deployment.local.json>");
const config = normalizeConfig(
    JSON.parse(await readFile(file, "utf8")),
    dirname(resolve(file)),
  ),
  server = new AvatarStageServer(config);
await server.start();
console.log(server.url);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => void server.stop().then(() => process.exit()));
