# Installed motion and playback direction

This optional feature uses a host-owned typed decision port compatible with System One/JEV. It does not own a conversation, persona, provider credential or planning model. `director.enabled` defaults to `false`. A host without the optional decision port still supports all explicit tools.

```json
{
  "director": { "enabled": true, "provider": "saved-decision-connection", "timeoutMs": 1200 },
  "avatars": [{ "id": "example", "motionIndexFile": "assets/motions.json" }]
}
```

Keep the avatar's usual file, hash, format and attribution fields. `motionIndexFile` resolves against the deployment directory. Its top-level key is the avatar SHA256:

```json
{
  "<avatar-sha256>": {
    "idle": "idle",
    "activities": { "speaking": "talk-loop", "singing": "song-loop" },
    "gestures": { "wave": "wave" },
    "clips": {
      "talk-loop": {
        "url": "data:model/gltf-binary;base64,...",
        "sha256": "<motion-sha256>",
        "label": "Talk",
        "description": "Quiet conversational explanation",
        "tags": ["speaking"], "loop": true, "auto": true,
        "source": "author's asset page", "license": "asset's license"
      }
    }
  }
}
```

The other mapped clips must also be present. Only standard VRMC_vrm_animation GLBs with embedded resources are accepted. Timing is read from the binary time accessors; optional accessor min/max metadata is not required. The public capability catalogue contains names, duration, tags, provenance and hashes, without embedded bytes or private filesystem paths. `avatar_control action:perform bodyClip:vrma:<name>` plays an installed motion. The page offers the same catalogue for manual preview.

Set `auto:true` only after reviewing a clip on the actual avatar. Inspect limbs, feet, floor clearance, root drift, fingers, loop boundaries and transitions. A downloaded file, successful parser or completed playback does not establish animation quality. Keep diagnostic, unsuitable or unreviewed clips available for explicit preview without offering them to the classifier. No assets are downloaded by default.

For each accepted utterance, classification runs concurrently with TTS. Its state contains only mode and up to 500 characters of current text, up to two recent facts, plus actual available expressions and up to 24 eligible motion choices. There is no full chat history. Choice instructions preserve negation, quoted actions, hypothetical language and speaker identity. The result is a distribution over installed choices, not executable code. Expression weights approach the selected emotion smoothly. A missing, failed or stale decision does not delay or cancel audio, and a new utterance aborts the previous classification.

Authored face and body cues own separate channels. An installed explicit expression keeps its priority while the selector may fill the missing gesture; an explicit gesture can keep its priority while the selector fills the expression. When both channels are already supplied, no decision request is made. Unsupported emotion names remain reported intent rather than silently disabling all animation. Desktop playback merges the channels against the same utterance, including late catalogue results, without replacing or repeating its audio. The decision log includes the selected installed clip key and semantic tags for downstream diagnostics; admission is still separate from renderer execution.

With desktop audio output, admitted cues are also mapped against the Stage avatar's actual catalogue and sent to its silent visual surfaces. This lets an OBS transparent window follow the same utterance instead of sending all gestures exclusively to the desktop device. Visual cues have a separate serialized revision, current-audio check and renderer receipt. A failed visual mirror cannot cancel speech; a desktop audio-only renderer cannot certify body execution.

`avatar_control action:direct` attaches expression weights and an optional installed body clip to one current `audioActionId`. It cannot replace audio, switch avatars, invent a motion or command game actions. The renderer waits for actual matching audio playback. Explicit face and body actions retain priority; cancellation removes only the automatic cue's own motion. Stop, replacement, late replies and owner-only rendering receipts remain separate from action acceptance.

Speaking and singing use mapped loop activities while their audio is actually playing. Singing follows the audio clock, including its current position. Stopping audio returns smoothly to idle; a muted mirror follows the audio owner's playing/terminal events. A page that owns audio uses its own playback state, including pauses, rather than substituting a mirror clock. Song-title metadata alone does not establish the song's emotional meaning. Use timed lyrics/vocal envelopes for mouth movement; a body loop is not choreography generated for that song.

Useful references: [JEV typed decisions](https://jev-ai.org/docs/), [Eidolon emotion selection](https://github.com/Sallyn0225/eidolon-sc), [SoullinkEmotion3D](https://github.com/nanlingyin/SoullinkEmotion3D), [standard VRMA](https://github.com/vrm-c/vrm-specification/tree/master/specification/VRMC_vrm_animation-1.0).

Measure actual request tokens, elapsed time, cache values when supplied, audio start/end and matching renderer receipts separately. Small isolated examples do not prove live responsiveness, speech quality or long-term animation variety.

## Optional in-game YSM presentation

YSM is a separate renderer and has a different skeleton and animation format. Share semantic intentions such as greeting or celebration, then resolve them against the actual installed model's extra-animation catalogue. Never send VRMA joint rotations as YSM rotations or assume a common animation name across models. Missing mappings should stay unsupported.

YSM's [extra animations](https://yesstevemodel.github.io/wiki/animation/extra/) can loop or hold their final frame. Every temporary chat gesture therefore needs an owned request, bounded lifetime and explicit release. Keep wheel locking off; stop on locomotion, combat, damage, swimming/self-rescue, item use, model/world replacement, disconnect or utterance end. It must not acquire the gameplay movement task or generate fake swings/turning/steps. Cancelling an old request must not cancel a newer gesture.

The native [`/ysm play` commands](https://yesstevemodel.github.io/wiki/command/) are administrative capabilities. A Paper/Freesia installation needs an explicit authenticated self-only bridge if ordinary Agents are to use them: discover the current model/hash and supported animations, request one supported animation with a correlation ID and deadline, query the original request after a timeout, and release only that request. Do not give Agents OP, forge native handshakes or execute arbitrary Molang to work around an absent API. Model-state acknowledgement, Java-client rendering and Web rendering must be tested separately. This extension does not currently install or claim such a game-server bridge.
