/** One runtime-free source for SDK docs, World tools and offline self-description. */
import { HUMAN_BONES } from "./core/types.ts";
const boneNames = HUMAN_BONES;
const text = { type: "string" },
  action = (values: string[]) => ({ type: "string", enum: values });
export const TOOL_DEFINITIONS = [
  {
    name: "avatar_voice",
    tags: ["act", "speak"],
    description:
      "Present dialogue using this World's explicitly configured output. Read status first: desktop-text sends literal bubbles to the desktop pet with audio=false; no TTS is started and actual shown/completed receipts are separate from queued. Use pet_act and the current desktop vocabulary for manual desktop expressions/actions. The default stage mode speaks through its single configured TTS path with synchronized avatar mouth: plain requires natural text; drama-3 permits optional vocal directions. Physical gestures are not spoken stage directions. No hidden rewriting or TTS fallback. interrupt cancels this output's pending dialogue. In stage mode TTS and singing share one foreground audio owner.",
    parameters: {
      type: "object",
      properties: {
        action: action(["status", "speak", "interrupt", "select"]),
        text: { type: "string", minLength: 1, maxLength: 2000 },
        voice: text,
        performance: {
          type: 'object', additionalProperties: false,
          description: 'Optional cues authored in this same inference. Bound to this utterance locally; no audioActionId or extra model turn is needed. Read status.performance for current expression/bodyClip ids. Unavailable cues are omitted and reported in presentationWarnings; speech continues. Emotion is authored intent, not a TTS style control. Emit this call alongside game tools when both are appropriate.',
          properties: {
            emotion: { type: 'string', minLength: 1, maxLength: 100, description: 'Emotional intent. Without expression, use an exact installed expression id.' },
            expression: { type: 'string', minLength: 1, maxLength: 100, description: 'Exact facial expression id; overrides the emotion default.' },
            bodyClip: { type: 'string', minLength: 1, maxLength: 100, description: 'Exact installed motion id for the current output.' },
          },
        },
        observed_at: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'number' }], description: 'Copy the actual source event/sample timestamp or captured_at of the evidence being described. Prefer its original ISO 8601 string with timezone; existing Unix seconds also work. Do not compute epoch seconds, invent a time, or replace stale evidence with the current time. Missing/stale evidence can be rejected before speech is submitted.' },
        ifIdleRevision: {
          type: "integer",
          minimum: 0,
          description:
            "Optional background admission guard: speak only if audio is still idle and status.audioRevision matches. A changed foreground cancels the draft without interrupting it.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "avatar_control",
    tags: ["act"],
    description:
      "Control this independent 3D stage. status lists actual rig/expression capabilities, installed animationCatalog, action evidence and generators. select changes the avatar. perform selects a real expression, humanoid rotation in degrees, exact bodyClip (including standard vrma: names), or wave/nod/bow/cheer/idle. direct attaches expressionWeights and an optional installed bodyClip to a current speech/song audioActionId; it starts with actual playback, yields to manual body controls and ends with that audio. Queued is not rendered. Query the original actionId for playing/ended evidence. Body controls never synthesize speech. Optional automatic presentation uses the host's saved decision connection, not another chat or hidden generation service.",
    parameters: {
      type: "object",
      properties: {
        action: action([
          "status",
          "select",
          "perform",
          "direct",
          "cancel",
          "result",
          "history",
        ]),
        avatarId: text,
        expression: text,
        bodyClip: text,
        audioActionId: {
          ...text,
          description:
            "For direct: original currently queued/playing speech or song action id. Cue is cancelled with that audio.",
        },
        expressionWeights: {
          type: "object",
          additionalProperties: { type: "number", minimum: 0, maximum: 1 },
        },
        intensity: { type: "number", minimum: 0, maximum: 1 },
        gesture: action(["wave", "nod", "bow", "cheer", "idle"]),
        durationMs: { type: "integer", minimum: 200, maximum: 10000 },
        scope: action(["preview", "broadcast"]),
        bones: {
          type: "object",
          properties: Object.fromEntries(
            boneNames.map((n) => [
              n,
              {
                type: "array",
                items: { type: "number", minimum: -75, maximum: 75 },
                minItems: 3,
                maxItems: 3,
              },
            ]),
          ),
          additionalProperties: false,
        },
        actionId: text,
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "avatar_motion",
    tags: ["act"],
    description:
      "Search and reuse suitable approved body motion for the current avatar before generating with the explicitly configured provider such as UniMate. Search results include review state and retained playback evidence. If no existing action fits, generate asynchronously and keep the returned jobId; acceptance is not completion or playback. Start with simple 2-second gestures. result/search reconcile the original job. cancel never retries. Preview generated candidates and approve acceptable motion before play. Numerical checks do not certify clothing collision or gesture meaning. No configured model means use direct gestures/pose controls and installed clips; there is no hidden cloud fallback.",
    parameters: {
      type: "object",
      properties: {
        action: action([
          "status",
          "generate",
          "result",
          "search",
          "cancel",
          "preview",
          "approve",
          "reject",
          "play",
          "stop",
        ]),
        prompt: { type: "string", minLength: 5, maxLength: 1200 },
        durationSec: { type: "number", minimum: 2, maximum: 12 },
        seed: { type: "integer", minimum: 0, maximum: 2147483647 },
        jobId: text,
        clipId: text,
        query: text,
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "avatar_music",
    tags: ["act"],
    description:
      "Import finished WAV artifacts by reference_handle, preview/adopt them, and play installed tracks through the single-owner stage. Generation is provided by cortico-world-aigc; legacy generate returns capability_moved. Imported audio is a review candidate and never auto-plays. Explicit approve/reject follows actual review. One renderer owns audio. Songs and TTS share one output. Singing mouth follows vocal envelope or timed lyrics, not accompaniment. Import does not verify lyrics or singer identity.",
    parameters: {
      type: "object",
      properties: {
        action: action([
          "status",
          "list",
          "generate",
          "import",
          "result",
          "cancel",
          "play",
          "stop",
          "preview",
          "approve",
          "reject",
        ]),
        trackId: text,
        jobId: text,
        reference_handle: text,
        title: text,
        requestText: text,
        lyrics: text,
        style: text,
        instrumental: { type: "boolean" },
        durationSec: { type: "integer", minimum: 30, maximum: 120 },
        volume: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "avatar_query",
    tags: ["read"],
    description:
      "Read this stage's current snapshot or retained action history, voice configuration and local song catalog. These reads do not speak, move, generate, cancel, adopt or play. Dynamic facts are queried here and through events; they are not inserted into the system prefix.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: action(["status", "action", "history", "music", "voice"]),
        actionId: text,
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
] as const;
export const EVENT_DEFINITIONS = [
  {
    type: "avatar.speech.submitted",
    description:
      "Accepted speech text and original request/action identifiers; submission is not playback.",
  },
  {
    type: "avatar.action",
    description:
      "Individual action state and actual renderer evidence; not a host turn boundary",
  },
  {
    type: "avatar.motion",
    description:
      "Motion generation terminal evidence; ready is a candidate, not playback",
  },
  {
    type: "avatar.music",
    description: "Song generation or actual audio execution evidence",
  },
  {
    type: "avatar.voice",
    description:
      "TTS transport, trace ids and actual audio completion/interruption evidence",
  },
] as const;
export const DESCRIPTION = {
  protocol: "avatar-stage/1",
  worldId: "avatar-stage",
  tools: TOOL_DEFINITIONS,
  events: EVENT_DEFINITIONS,
};
export const WORLD_DESCRIPTION = {
  tools: TOOL_DEFINITIONS,
  events: EVENT_DEFINITIONS,
};
