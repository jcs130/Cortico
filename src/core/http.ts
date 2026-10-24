import { readFile } from "node:fs/promises";
export function endpoint(value: string, localOnly = false) {
  const u = new URL(value);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (localOnly &&
      (u.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)))
  )
    throw Error("Invalid configured service endpoint");
  return u;
}
export async function bearer(config: {
  tokenEnv?: string;
  credentialsFile?: string;
}): Promise<Record<string, string>> {
  let token = config.tokenEnv ? process.env[config.tokenEnv] : undefined;
  if (config.credentialsFile) {
    const json = JSON.parse(await readFile(config.credentialsFile, "utf8"));
    token = json.apiKey ?? json.token;
  }
  return token ? { Authorization: "Bearer " + token } : {};
}
export async function jsonRequest(
  url: URL | string,
  init: RequestInit = {},
  signal?: AbortSignal,
) {
  const r = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.any([
      AbortSignal.timeout(10000),
      ...(signal ? [signal] : []),
    ]),
  });
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  if (r.body)
    for await (const value of r.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += value.byteLength;
      if (bytes > 1_000_000) throw Error("Oversized provider response");
      chunks.push(value);
    }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!r.ok)
    throw Error(
      typeof data.error === "string" ? data.error : `Provider HTTP ${r.status}`,
    );
  return data as Record<string, unknown>;
}
