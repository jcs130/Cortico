## 0.1.2-rc.16.memory.1

- Bound display textures to 2048 pixels before their first GPU upload, share resized images across texture clones, and release decoded image resources. Source avatar files remain unchanged.
- Limit render surfaces to 691,200 pixels and animation rendering to 30 FPS; use a low-power graphics preference and report actual render resource counts.
- Dispose avatar textures, render lists and WebGL contexts when the presentation page closes. Audio scheduling and character motion catalogues retain their existing contracts.

## 0.1.2-rc.16

- Separate semantic facial intensity from decision confidence, preserving local continuous interpolation and authored controls.
- Support independent numeric facial channels in Stage manual performance, preserve directed blink ownership, and release decayed channels.
- Intersect desktop automatic motion choices with the visible Stage model's reviewed catalogue.

## 0.1.2-rc.15

- Hold visual cues during a shared audio-floor wait and dispatch them only after device playback starts, so long audio queues do not expire their gestures before anyone speaks.

## 0.1.2-rc.14

- Allow silent visual surfaces to confirm their own presentation frames while requiring current parent audio for playback start and the same visual session for completion. They still cannot confirm audio or take over the audio device.

## 0.1.2-rc.13

- Fill automatic face and gesture channels independently while retaining authored choices, including desktop audio and text surfaces. Unavailable optional cues no longer suppress the entire selector.
- Mirror installed presentation cues to silent Stage/OBS surfaces when desktop owns audio; retain separate rendering receipts and stale-cue cancellation without delaying speech.
- Retain installed motion keys and semantic tags in decision diagnostics. Document an optional self-only YSM integration and its cancellation/ownership boundaries; no game-server bridge is installed by this package.

- Place capture captions above the avatar with reserved headroom, matching the shared rounded dark speech bubble style.

- Add shared actual-playback captions to control and OBS pages, with desktop audio support and stale snapshot/cancellation handling.

## 0.1.2-rc.12

Add synthesis-only artifacts and optional same-WAV game/livestream mirroring with independent receipts and no second TTS request.

## 0.1.2-rc.11

- Preserve dated replies when unrelated speakers append chat; keep scene freshness, explicit foreground priority and duplicate guards. Record the cited evidence when freshness rejects a draft.
- Reconcile external shared-audio turn waits as queued observations, with no playback completion claim.

## 0.1.2-rc.10

- Add the native drama-rs `/v1/speak` protocol, verified health/remote voice discovery and one unsplit streaming WAV request per utterance. Unknown voices never fall back.
- Preserve exact WAV bytes, request JSON and transport evidence for each native request, including cancellation/failure. Native EOF and HTTP 200 leave full-text generation completion unknown.
- Keep incremental PCM playback, native 44.1 kHz timing, physical playback receipts and upstream cancellation. An optional explicit synthesis seed is forwarded without a daily default.

## 0.1.2-rc.8

- Separate successful synthesis from a connected renderer waiting for its physical audio turn. Configure `voice.rendererStartTimeoutMs` against the real playback queue, without fabricating playing/ended or extending source freshness.
- Retain the short failure window for unconsumed commands/disconnected renderers and a bounded start deadline for connected queues.

## 0.1.2-rc.7

- Verify WAV completion headers when present, with an opt-in requirement for services declaring X-Speech-Stop. Do not send an unsolicited speed parameter.
- Destroy partial downstream audio streams on provider failure so disconnects and generation limits cannot become clean playback completion.
- Clarify that sampling seeds are optional experiments, not a live voice lock, and keep vocal directions sparse.

## 0.1.2-rc.6

- Add opt-in native PCM SSE synthesis: one backend generation context per utterance, immediate PCM forwarding under one WAV envelope, and no independent client chunks.
- Check the provider's completion stop and sample count. Preserve generation-limit failures instead of reporting a truncated response as complete.
- Expose configured transport, verified PCM rate, seed and actual provider completion metadata on demand. Keep renderer playback receipts and voice selection separate.

## 0.1.2-rc.5

- Replace fixed-character speech cuts with clause/word boundaries, pack tiny sentences, and protect configured proper names. Do not replay point sounds or delivery cues in continuation requests.
- Add an opt-in plain spoken-name dictionary at the TTS boundary; keep original dialogue, chat, voice selection and playback receipts unchanged. Do not inject unverified phoneme or speaker tags.
- Retain bounded actual synthesis inputs with per-segment timing for on-demand diagnosis.

## 0.1.2-rc.4

- Add opt-in short-sentence TTS with backend extra parameters and per-voice writing guides. Preserve speaker tokens across sentence continuations and keep identity fields authoritative.
- Serialize synthesis across utterances and cancellation. Forward each finished sentence as PCM under one WAV envelope; do not wait for the complete utterance before forwarding its first sentence.
- Preserve the original action ID, cancellation and renderer playback receipts. Synthesis completion remains separate from actual playing/ended evidence.

## 0.1.2-rc.3

- Speak a valid public commentary sentence unchanged as soon as its complete streamed record is available; remove the second generative rewrite for duplicate or stale lines.
- Preserve dated observations when telemetry or unrelated chat changes. Replies remain fenced by new chat in their cited World; explicit current-state claims, foreground speech, cancellation and original evidence clocks retain validation.
- Reconsider changed input on the next normal tick after a stale candidate; unchanged input is not regenerated and transient failures retain their retry delay.

## 0.1.2-rc.2

- Validate complete streamed commentary records before model completion, retain at most one continuation, and fence interruptions/provider resets without replay.
- Forward bounded PCM to the Stage-owned desktop audio player before synthesis completes; cancellation closes transport and playback.
- Route manual controls and queries to the actual desktop figure. Add explicit supported movement and unsupported-capability receipts.
- Make one-line pending timeout configurable (60 seconds by default); keep observation freshness independent.

# Changelog

## 0.1.2-rc.1

- Include the rejected, validated speech candidate in the single stateless revision request. A rejection reason alone did not identify the wording that needed correction. Original evidence clocks, one-revision limit, foreground priority and all admission checks remain unchanged; raw provider output and rejected speech are not added to playback history.
- First public preview. Ship reusable source, browser modules and configuration examples; exclude deployment-specific validation reports and use neutral character examples in the public speech guide and page.

## 0.1.2-dev.20261027.2

- Return duplicate speech and outdated current-state claims to the host drafter for one bounded revision. The reply includes the original evidence clocks and which timeframes remain valid; all admission, foreground priority and freshness checks still apply. Rejected revisions never reach TTS.


## 0.1.2-dev.20261026.6

- Preserve an active automatic commentary sentence while admitting at most one foreground line for the next audio gap. The waiting line returns immediately, is not synthesized ahead, and expires after 15 seconds; its original observation timestamp, renderer ownership and cancellation state are rechecked before dispatch.
- Keep automatic lookahead from taking the reserved foreground gap. Interrupt, explicit cancellation, renderer release, avatar/music changes and shutdown cancel waiting speech; reconnect/restart does not replay it.
- Distinguish model-requested silence, invalid JSON/contract output and duplicate text in bounded commentary diagnostics without recording raw prompts or full model output.

## 0.1.2-dev.20261026.5

- Draft at most one optional commentary candidate during confirmed speech playback, then submit at the next configured idle gap. Recheck the original evidence, output revision, foreground dialogue, runtime and freshness before submission; no audio backlog or game-body control is introduced.
- Use decoded desktop audio duration to time lookahead near the end of an utterance. Music, synthesis waiting and unknown busy output do not trigger prefetch. Add draft/hold/submit timing for verification.
- Remove optional gesture-catalogue refresh from speech admission and synthesis/playback's critical path. Slow or failed presentation discovery cannot hold audio; late gestures remain bound to their original audio action.

## 0.1.2-dev.20261026.4

- Preserve separate outcome events during commentary drafting; only complete snapshots supersede prior state. Keep original evidence timestamps and all foreground/pause/stale checks.
- Bound commentary material to attributed text previews and minimal transport metadata. Do not append entire tool receipts or arbitrary nested metadata to speech requests.

## 0.1.2-dev.20261026.3

- Add an optional host-authored public progress card for the stage and a bounded SDK/HTTP presentation port.
- Optional short progress speech reuses the current output, requires fresh active/idle observations and revision-checked admission, and drops stale/busy reports without queuing. A bounded, asynchronous System One choice decides speak/display/skip from compact public input; no generative call or full history is added.
- Keep review completion separate from game success; never read raw reasoning or private conversation history for this channel.

## 0.1.2-dev.20261026.2

- Allow dialogue, greetings and creative speech without a live observation timestamp. Explicit observation timestamps still reject stale, invalid and future evidence; commentary continues to forward original source times.
- Declare the observation age setting in the World configuration schema and distinguish conversation from live observation claims in the speech contract.

## 0.1.2-dev.20261026.1

- Keep server telemetry and outgoing chat echoes from interrupting an independent commentary draft; real new conversation still takes priority.
- A byte-identical refreshed observation no longer invalidates its in-flight draft. Original event cursors and timestamps remain required; freshness, changed facts and pause/stop guards are unchanged.

## 0.1.2-dev.20261025.6

- Forward the oldest original timestamp among the draft's cited event envelopes into speech admission. Optional commentary no longer fails a configured observation-time requirement solely because its internal caller omitted the field. Missing or stale sources are not replaced with the current time.
- Bound commentary's evidence and generation window by the configured speech observation policy, so an otherwise longer commentary window does not repeatedly draft lines that speech cannot admit. Commentary remains opt-in and uses task-only host cognition without owning game actions.

## 0.1.2-dev.20261025.5

- Accept original ISO 8601 source observation timestamps including timezone for live speech, while retaining numeric Unix seconds compatibility. Models need not calculate epoch seconds. Stale, future, invalid and timezone-ambiguous evidence is still rejected before output; timestamps are never refreshed or repaired automatically.

## 0.1.2-dev.20261025.4

- When live speech requires source observation evidence, expose that condition in the active tool schema and description before submission. Status, interrupt and voice selection remain usable without observation timestamps; the default contract remains compatible.

## 0.1.2-dev.20261025.3

- Deliver ordinary speech and its synchronized presentation completion/cancellation as piggyback receipts, so finishing a sentence does not itself wake another narration turn. Failures and other asynchronous results still notify promptly.

## 0.1.2-dev.20261025.2

- Add explicit preserve/replace speech admission policy. Preserve keeps current speech intact and skips new lines without synthesis or backlog, including concurrent admissions; explicit interrupt remains available.
- Repeated speech request IDs do not replace active audio or increment its revision.

## 0.1.2-dev.20261025.1

- Keep valid speech when optional expressions or body clips are unavailable; preserve requested intent and report omitted cues.
- Share capability resolution across stage, desktop audio and desktop text. Desktop cue rejection no longer cancels admitted audio.
- Export the cue resolver from the framework-independent core entry point.

# 0.1.2-dev.20261022.3

- Add an optional desktop audio device over the public finished-media protocol; reuse the speech queue, song catalog, lyrics and host decision connection.
- Reconcile original stage actions with actual desktop playback; audio-only receipts cannot certify body execution.
- Expose renderer stream events as an explicit SDK opt-in and release an output lease on device stop.

# 0.1.2-dev.20261021.10

- Carry the active synthesis text contract into automatic commentary drafting and parsing. Preserve Drama3 vocal directions through to synthesis; compare spoken words when detecting repeats.
- Declare the backend text format in the World configuration and report it in current facts. Discard an in-flight draft after a format change.

# 0.1.2-dev.20261021.9

- Export the standard VRMA motion layer and expression mixer for figure packs and desktop renderers to share the same implementation.

# 0.1.2-dev.20261021.8

- Restore the previous frame's procedural overlay before sampling animation; constant or omitted head tracks no longer accumulate idle rotation. Restore it before raw animation and disposal as well.
- Retain the .7 fact coverage and structured voice recovery fixes.

# 0.1.2-dev.20261021.6

- Treat an explicitly configured, empty song library as an empty catalog on first launch; retain errors for malformed existing catalogs.
- Separate bounded TTS synthesis from the renderer acknowledgement clock; do not cancel an active slow synthesis at the 15-second renderer deadline. Transport completion does not count as audible playback.
- Release failed voice foregrounds and their dependent cues, allowing later idle commentary to resume.
- Give standard motion indexes and generated motion clips separate URLs; keep existing avatar index and clip links readable without route shadowing.

# 0.1.2-dev.20261021.5

- Discover explicitly installed standard VRMA libraries through shared tools, SDK and the preview page; validate bytes and actual time accessors.
- Add optional host-owned typed emotion/motion selection concurrent with TTS, preserving explicit actions and current audio identity.
- Follow actual speech/song playback with speaking/singing loops and return to idle on stop; cancel only the automatic cue's owned gesture.
- Preserve a completed clip's final time until its owner reconciles the terminal frame; avoid leaving a stale active body action that blocks later gestures.

# 0.1.2-dev.20261021.4

- Add optional evidence-based commentary through the host cognition port; keep game execution independent and skip drafts without fresh facts.
- Invalidate stale drafts on new chat, foreground speech, pause and stop; condition idle submission on the current audio revision.
- Declare speech tools with the speak tag and emit a shared speech submission event, preserving request identity and separate playback evidence.

# 0.1.2-dev.20261021.3

- Fix browser audio activation ordering, show the output state at the top of the page and restore an opted-in tab when browser policy permits.
- Add standard VRMA motion indexes, authored idle playback and gesture crossfades; blend raw generated motion in and out without replacing the idle with a T-pose.
- Bundle browser helpers and the pinned official VRMA loader so static-file routing cannot omit a new dependency.

# 0.1.2-dev.20261021.2

- Expose the configured TTS text format and an on-demand Drama3 writing guide.
- Preserve directed standard VRM visemes and single-eye blinks when mixing automatic facial animation.
- Clear stale private-presentation metadata when switching to a standard avatar.

# src/core、src/index.ts：演出扩展变更

## 0.1.2-dev.20261021.1

- Prepare asynchronous avatar presentations before the render loop owns their skeleton or physics; fence replaced loads and dispose obsolete candidates.
- Offer the complete standard humanoid bone vocabulary, real finger/eye capabilities and custom VRM expressions; normalize legacy thumb slot names.
- Share the bone contract between tools, SDK types and offline self-description; accept an optional presentation bone resolver for truthful pose evidence.

## 0.1.2-dev.20261020.4

- Clear the lifecycle when configuration or server construction fails, allowing a later explicit start.

## 0.1.2-dev.20261020.3

- Move EdenLive inference into AIGC and neutral voxel capture into the Minecraft core.
- Propagate SDK/tool cancellation; fence late events across stop/start.
- Keep UniMate, TTS, explicit music import and real rendering receipts in this World.

# Changelog

## 0.1.2-dev.20261021.7

- Return explicit empty snapshot coverage in current performance facts, retaining original events and satisfying host consumers.
- Preserve bounded structured TTS recovery codes and tool identifiers without forwarding raw provider errors or credentials.
- Remove the obsolete song generation form that always returned capability_moved; creation belongs to the separate AIGC World.

## 0.1.2-dev.20261020.2 - 2026-10-20

- Add read-only avatar_query for stage state, voice, song catalog and action evidence.
- Keep stage snapshots out of the system prefix; deliver runtime facts through events and queries.
- Remove obsolete generation-provider validation from local archive configuration.
- Keep TTS/music ownership scoped to this stage; Bot assembly must choose one broadcast audio output.

## 0.1.2-dev.20261020.1 - 2026-10-20

- Move image/video/music generation ownership to the independent AIGC World; keep TTS, stage actions, song adoption and playback here.
- Import WAV artifacts through host blob handles or the independent binary SDK; verify hashes, persist candidates, preview and adopt explicitly.
- Preserve read access to legacy music jobs and local catalogs without resubmitting unknown requests or retaining a second music-generation client.
- Verify import, preview/adoption and restart recovery offline; production loading and actual playback remain separate acceptance steps.

## 0.1.1 - 2026-10-20

- Add explicit fal MiniMax Music cloud queue adapter, local WAV candidates, single-output preview, adoption, durable request IDs and cancellation.
- Support standard 24kHz cloud TTS WAVs alongside the existing 48kHz LAN service; optional provider speech instructions.
- Support authenticated HTTPS motion gateways with path prefixes, without local inference weights.
- Publish cloud configuration examples and current provider access limits; keep lyric, duration and voice identity claims separate from file validation.
- Align the thin Cortico adapter and offline self-description with World API 6 / Cortico 0.2.4. Core, HTTP server and SDK remain framework independent.

## 0.1.0 - 2026-10-20

- Initial independent avatar World: rigged VRM presets, semantic poses, reusable motion library and optional local UniMate.
- Single TTS/music output owner, streaming WAV, interruption, original action ledger and renderer execution receipts.
- Independent SDK/server and clean production build without Cortico.
## 0.1.2-dev.20261027.1

- Reserve bounded scene and observed-outcome slots across telemetry floods. Later cleanup receipts retain the earlier dated outcome; they do not overwrite the reason an activity ended.
- Separate current-state speech freshness from explicitly retrospective speech. Preserve original evidence timestamps through draft admission and deferred playback; output ownership, pause, deduplication and foreground priority remain enforced.
- Preserve body progress at the end of long snapshots within the existing preview budget. Allow short reactions to difficulties and discoveries without waiting for a successful task result.
