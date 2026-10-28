export const PROTOCOL = "avatar-stage/1" as const;
export const HUMAN_BONES = [
  "hips",
  "spine",
  "chest",
  "upperChest",
  "neck",
  "head",
  "leftShoulder",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightShoulder",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "leftToes",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  "rightToes",
  "leftEye",
  "rightEye",
  "jaw",
  "leftThumbMetacarpal",
  "leftThumbProximal",
  "leftThumbDistal",
  "leftIndexProximal",
  "leftIndexIntermediate",
  "leftIndexDistal",
  "leftMiddleProximal",
  "leftMiddleIntermediate",
  "leftMiddleDistal",
  "leftRingProximal",
  "leftRingIntermediate",
  "leftRingDistal",
  "leftLittleProximal",
  "leftLittleIntermediate",
  "leftLittleDistal",
  "rightThumbMetacarpal",
  "rightThumbProximal",
  "rightThumbDistal",
  "rightIndexProximal",
  "rightIndexIntermediate",
  "rightIndexDistal",
  "rightMiddleProximal",
  "rightMiddleIntermediate",
  "rightMiddleDistal",
  "rightRingProximal",
  "rightRingIntermediate",
  "rightRingDistal",
  "rightLittleProximal",
  "rightLittleIntermediate",
  "rightLittleDistal",
] as const;
export type HumanBone = (typeof HUMAN_BONES)[number];
export interface AvatarPreset {
  id: string;
  label: string;
  file: string;
  sha256: string;
  format: "vrm" | "gltf";
  attribution: string;
  licenseUrl: string;
  humanoid?: Partial<Record<HumanBone, string>>;
  expressions?: Record<string, string>;
  /** Explicit private/local standard VRMA index, keyed by this avatar's SHA256. */
  motionIndexFile?: string;
  motionUrl?: string;
  motion?: {
    url: string;
    tokenEnv?: string;
    credentialsFile?: string;
  };
}
export interface CloudMusicConfig {
  provider: "fal";
  queueUrl: string;
  tokenEnv?: string;
  credentialsFile?: string;
  downloadHosts: string[];
}
export interface MusicConfig {
  directory: string;
  generationUrl?: string;
  tokenEnv?: string;
  credentialsFile?: string;
  cloud?: CloudMusicConfig;
}
export interface VoiceConfig {
  url: string;
  model: string;
  voice: string;
  voices?: string[];
  voicesUrl?: string;
  tokenEnv?: string;
  credentialsFile?: string;
  sessionId?: string;
  metricsUrl?: string;
  instructions?: string;
  /** Backend-specific JSON fields; model, input, voice and WAV format remain authoritative. */
  extraBody?: Record<string, unknown>;
  /** Opt-in sentence synthesis, forwarded as one PCM WAV stream. Zero disables it. */
  segmentMaxChars?: number;
  /** Explicit plain spoken forms for proper names; applied only at the TTS request boundary. */
  pronunciations?: import("./speech-text.ts").SpeechPronunciations;
  /** Per-voice backend writing contracts, exposed on demand by voice status. */
  writingGuides?: Record<string, string>;
  /** Whole upstream synthesis budget, separate from renderer acknowledgement. Default 90 seconds. */
  synthesisTimeoutMs?: number;
  /** Explicit text contract of the configured synthesis backend. */
  textFormat?: "plain" | "drama-3";
  /** preserve keeps admitted audio. One foreground line may wait behind automatic commentary. */
  busyPolicy?: "replace" | "preserve";
  /** Queue wait budget, separate from source observation age and synthesis. Default 60 seconds. */
  pendingTimeoutMs?: number;
}
export interface StageConfig {
  port: number;
  dataDir: string;
  avatars: AvatarPreset[];
  defaultAvatar?: string;
  music?: MusicConfig;
  voice?: VoiceConfig;
  /** Rechecked before synthesis if a foreground line waited for automatic commentary. */
  speechObservationMaxAgeSeconds?: number;
}
export interface WorldConfig extends StageConfig {
  audienceProgress?: Partial<import('./audience-progress.ts').AudienceProgressConfig>;
  enabled: boolean;
  presentation?: Partial<import('../desktop-presentation.ts').DesktopPresentationConfig>;
  remoteUrl?: string;
  commentary?: Partial<import("./commentary.ts").CommentaryConfig>;
  director?: Partial<import("./performance-director.ts").DirectorConfig>;
  replySpeech?: { enabled?:boolean; sources?:string };
}
export type StageEvent = {
  protocol: typeof PROTOCOL;
  type: string;
  at: number;
  data: Record<string, unknown>;
};
export type Emit = (event: StageEvent) => void;
export interface ActionRecord {
  id: string;
  requestId: string;
  key: string;
  kind: string;
  avatarId: string | null;
  status: "queued" | "playing" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  command: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}
export interface RendererReceipt {
  sessionId: string;
  role: "preview" | "broadcast";
  surface?: "control" | "obs" | "desktop";
  renderer?: 'avatar' | 'audio-only';
  status: "ready" | "heartbeat" | "applied" | "playing" | "ended" | "failed";
  eventId?: string;
  avatarId: string;
  avatarSha256: string;
  error?: string;
  audioTimeMs?: number;
  /** Decoded audio duration reported by the current output renderer. */
  durationMs?: number;
  frames?: number;
}
export const id = (value: unknown, label = "id"): string => {
  if (typeof value !== "string" || !/^[\p{L}\p{N}_.:-]{1,150}$/u.test(value))
    throw Error("Invalid " + label);
  return value;
};
export const number = (
  value: unknown,
  min: number,
  max: number,
  label: string,
): number => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw Error("Invalid " + label);
  return value;
};
export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Expected object");
  return value as Record<string, unknown>;
};
