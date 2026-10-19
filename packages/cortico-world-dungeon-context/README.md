<!-- Owner: src/context.ts and src/index.ts -->

# Dungeon observation compatibility adapter

Private API 5 adapter for an existing modified host. Upstream 0.2.0 uses extension API 6 and was inspected separately; this package pins upstream 0.1.4 explicitly and is not intended for npm publication.

The original World handles authentication, connections, tool execution and events. This adapter adds `requestFacts`, `verifiedFacts` and read-only `dungeon_evidence list/read`. It does not perform background requests or model calls, choose goals, require gifts, infer ownership from a seller name, or write to Persona Memory.

Current cached status, inventory and class-rule reads expire after 60 seconds. Potential mutations and relevant events invalidate them. A read that overlaps a mutation cannot restore old state. Missing, expired and invalidated readings remain unknown. Up to ten action receipts from the past 15 minutes accompany requests as dated excerpts; their complete original arguments and text results are archived in the World data directory, scoped by server and a credential digest. Attachments remain in the host's original blob store. No credential is stored. Character or credential changes select a different archive; a new connection never restores archived observations as current state.

Receipt references survive a restart and can be read explicitly. `list` covers the in-memory recent observation window; an exact historical reference can still read its file after restart. Archives are factual records of requests and replies, not proof of objective completion. Server suggestions are preserved as original text and remain optional actions.

Install only as the selected implementation of World `dungeon`, replacing its extension link; do not enable two implementations or create another account. Existing deployment configuration, credentials and server state remain with the original World.
