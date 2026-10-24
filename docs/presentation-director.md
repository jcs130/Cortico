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

For each accepted utterance, classification runs concurrently with TTS. Its state contains only mode and up to 500 characters of current text, plus actual available expressions and up to ten eligible motion choices. There is no full chat history. Choice instructions preserve negation, quoted actions, hypothetical language and speaker identity. The result is a distribution over installed choices, not executable code. Expression weights approach the selected emotion smoothly. A missing, failed or stale decision does not delay or cancel audio, and a new utterance aborts the previous classification.

`avatar_control action:direct` attaches expression weights and an optional installed body clip to one current `audioActionId`. It cannot replace audio, switch avatars, invent a motion or command game actions. The renderer waits for actual matching audio playback. Explicit face and body actions retain priority; cancellation removes only the automatic cue's own motion. Stop, replacement, late replies and owner-only rendering receipts remain separate from action acceptance.

Speaking and singing use mapped loop activities while their audio is actually playing. Singing follows the audio clock, including its current position. Stopping audio returns smoothly to idle; a muted mirror follows the audio owner's playing/terminal events. A page that owns audio uses its own playback state, including pauses, rather than substituting a mirror clock. Song-title metadata alone does not establish the song's emotional meaning. Use timed lyrics/vocal envelopes for mouth movement; a body loop is not choreography generated for that song.

Useful references: [JEV typed decisions](https://jev-ai.org/docs/), [Eidolon emotion selection](https://github.com/Sallyn0225/eidolon-sc), [SoullinkEmotion3D](https://github.com/nanlingyin/SoullinkEmotion3D), [standard VRMA](https://github.com/vrm-c/vrm-specification/tree/master/specification/VRMC_vrm_animation-1.0).

Measure actual request tokens, elapsed time, cache values when supplied, audio start/end and matching renderer receipts separately. Small isolated examples do not prove live responsiveness, speech quality or long-term animation variety.
