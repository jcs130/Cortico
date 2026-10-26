# Public review progress

An optional host may call `world.publishAudienceProgress(value)` with `audience-progress/v1`.
The same projection is available through `AvatarStageClient.publishAudienceProgress` and the
loopback, same-origin-protected `POST /api/audience-progress`. This is a presentation port,
not a game action or a second cognition loop.

Required fields: `schema`, opaque `id`, ISO `at` and `expiresAt`, `phase`, `topic` (120 chars),
`text` (240 chars), and `speech` (160 chars; empty means silent). Phases are `accepted`,
`reviewing`, `organizing`, `completed`, `empty`, `expired`, `failed`, `timed_out`, `cancelled`,
and `discarded`. Invalid, expired, or backward lifecycle updates are ignored. Only these
explicit fields survive validation; never populate them from a raw reasoning stream,
private message, Memory excerpt, provider error, or tool arguments.

`audienceProgress.enabled` enables the World port. `audienceProgress.speechEnabled`
independently enables short broadcasts through the existing voice/text presentation.
Both default off. The visual card is included in `/api/state` and the renderer's
`audience.progress` SSE event; it expires and disappears on disconnection. This renderer
event is not injected into the Persona's main event stream.

The speaker reuses the existing active-host/audio observations. For each eligible candidate,
the host's System One decision port chooses `speak`, `display` or `skip` with a validated
probability distribution. `display` and `skip` emit no speech; the latest status card still
updates. Input contains only the public candidate, idle state, up to two recent event
source/type pairs (no event bodies) and two short submitted speech excerpts. Submission is
not playback proof. There is no generative chat call, complete history or raw reasoning.
`provider` defaults empty to use the host's configured decision provider; `timeoutMs`
defaults to 1200. Selection is asynchronous and single-flight. Failure, missing provider or
timeout leaves text only. Cancellation and a newer phase invalidate pending selections.
Only a fresh `reviewing` or `completed` message can speak after three seconds, with a
default 45-second gap and five-minute identical-text suppression. Busy, paused, muted,
unavailable and >15-second-old messages are discarded without queuing. The actual audio
revision, foreground, configuration, new speech and expiry are rechecked after selection
and at admission. Queued speech is not playback proof: use the normal
action `playing`/`completed` renderer receipts. Completing a review does not complete a
game goal or adopt its suggestions.
