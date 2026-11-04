import { resolve } from "node:path";
import type { StageConfig } from "./types.ts";
/** Resolve deployment paths once; never change a shared host process's cwd. */
export function normalizeConfig(
  config: StageConfig,
  baseDir: string,
): StageConfig {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
    throw Error("Invalid loopback stage port");
  if (!config.dataDir?.trim())
    throw Error("A deployment-specific dataDir is required");
  return {
    ...config,
    dataDir: resolve(baseDir, config.dataDir),
    avatars: config.avatars.map((a) => ({
      ...a,
      file: resolve(baseDir, a.file),
      motionIndexFile: a.motionIndexFile
        ? resolve(baseDir, a.motionIndexFile)
        : undefined,
      motion: a.motion
        ? {
            ...a.motion,
            credentialsFile: a.motion.credentialsFile
              ? resolve(baseDir, a.motion.credentialsFile)
              : undefined,
          }
        : undefined,
    })),
    music: config.music
      ? {
          ...config.music,
          directory: config.music.directory
            ? resolve(baseDir, config.music.directory)
            : "",
          credentialsFile: config.music.credentialsFile
            ? resolve(baseDir, config.music.credentialsFile)
            : undefined,
          cloud: config.music.cloud
            ? {
                ...config.music.cloud,
                credentialsFile: config.music.cloud.credentialsFile
                  ? resolve(baseDir, config.music.cloud.credentialsFile)
                  : undefined,
              }
            : undefined,
        }
      : undefined,
    voice: config.voice
      ? {
          ...config.voice,
          credentialsFile: config.voice.credentialsFile
            ? resolve(baseDir, config.voice.credentialsFile)
            : undefined,
        }
      : undefined,
  };
}
