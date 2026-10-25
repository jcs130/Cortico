# Changelog

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
