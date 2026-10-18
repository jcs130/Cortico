Code owners: `focused-cognition.ts`, `planning-review.ts`, `historical-recall.ts`, and `../index.ts`.

# Cognition outputs and historical recall

The model's output limit includes reasoning and the returned answer. A short utterance does
not imply a small total generation budget. A blank review is a failed result; it leaves the
activity version eligible for a later review. `(nothing)` explicitly records a no-change review.

`cognition.focused.provider` selects the connection for a one-round task. An empty value uses
the current provider. `speechProvider` independently selects the connection for speech drafts;
`maxOutputTokens` and `speechMaxOutputTokens` bound the two roles. The provider owns model,
reasoning fields and endpoint compatibility. The fork API does not apply the main loop's
request-reasoning hook. Give short speech a connection with reasoning disabled, routine plans
a connection with an appropriate lower effort and sufficient output, and focused causal
reviews their separately configured reflection provider and budget. A missing named connection
returns an error; it does not silently change models. Existing cancellation and single-flight
behaviour remains in place.

`memory_record evidence` searches at most 128 retained external observations. Zero matches
does not establish that an activity never happened or is unfinished. A miss includes an exact
`recall` entry point. `memory_record recall` with a nonblank `query` searches persistent
workspace excerpts and the explicitly configured game memory read tool concurrently. Workspace
search uses literal keywords and returns source paths and line numbers. Its matches are previews;
read the relevant lines to resolve clipped statements and original attribution.

The optional `historicalRecall` group names a mounted World and a read tool implementing
Agent MC World's public `action:service, operation:prepare` contract. The host forwards only
the query and the configured UTF-8 byte budget. Server/account/agent scope, credentials,
provenance validation and historical cache semantics stay in the game memory implementation.
Unavailable Worlds stay unavailable; no connection is started and no other World is substituted.
The shared timeout aborts reads while allowing completed sources to return. Caller cancellation
cancels the whole tool rather than producing an empty search receipt.

Recall neither writes a current claim nor generates, adopts or executes a skill. Historical
sources retain their dates and speakers. Current completion uses the current World's versioned
work identity and external receipts. A maintainer's read probe verifies transport, not the
agent's subsequent adoption or learning.

When game historical recall is enabled, planning and focused causal reviews also receive the
read-only `recall_history(query)` tool. Up to three fork rounds allow retrieval followed by a
complete answer. They receive no other host/World tools. The model chooses a concrete query;
there is no automatic full-library read or forced retrieval on every review. The review's
original deadline, runtime/revision checks and result-age limit also cover retrieval time.

Tests exercise actual Persona/Core/provider request routing, valid agenda retention, empty
output retryability, durable history retrieval, scope selection, cancellation and partial-source
timeout behaviour. Production latency, natural recall/adoption and learning benefits require a
separate live observation after loading.
