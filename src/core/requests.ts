import type { HumanBone } from "./types.ts";
import type { SpeechPerformance } from './speech-performance.ts';
export type Scope = "preview" | "broadcast";
export type PerformRequest = {
  action: "perform";
  expression?: string;
  bodyClip?: string;
  intensity?: number;
  gesture?: "wave" | "nod" | "bow" | "cheer" | "idle";
  durationMs?: number;
  scope?: Scope;
  bones?: Partial<Record<HumanBone, [number, number, number]>>;
};
export type ControlRequest =
  | { action: "status" }
  | { action: "select"; avatarId: string; scope?: Scope }
  | PerformRequest
  | { action: "direct"; audioActionId: string; expressionWeights?: Record<string, number>; bodyClip?: string }
  | { action: "cancel" | "result"; actionId: string }
  | { action: "history"; limit?: number };
export type VoiceRequest =
  | { action: "status" | "interrupt" }
  | { action: "select"; voice: string }
  | { action: "speak"; text: string; voice?: string; ifIdleRevision?: number; performance?: SpeechPerformance };
export type MotionRequest =
  | { action: "status" | "stop" }
  | { action: "generate"; prompt: string; durationSec?: number; seed?: number }
  | { action: "result" | "cancel"; jobId: string }
  | { action: "search"; query?: string; offset?: number; limit?: number }
  | { action: "preview" | "approve" | "reject" | "play"; clipId: string };
export type MusicRequest =
  | {
      action: "import";
      reference_handle: string;
      title: string;
      instrumental?: boolean;
    }
  | { action: "status" | "list" | "stop" }
  | {
      action: "generate";
      title: string;
      requestText: string;
      style: string;
      lyrics?: string;
      instrumental?: boolean;
      durationSec: number;
    }
  | { action: "result" | "cancel"; jobId: string }
  | { action: "approve" | "reject"; jobId: string }
  | { action: "play" | "preview"; trackId: string; volume?: number };
export interface ToolRequests {
  avatar_query: {
    action: "status" | "action" | "history" | "music" | "voice";
    actionId?: string;
    limit?: number;
  };
  avatar_control: ControlRequest;
  avatar_voice: VoiceRequest;
  avatar_motion: MotionRequest;
  avatar_music: MusicRequest;
}
export type ToolName = keyof ToolRequests;
