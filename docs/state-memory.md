Owner: `bots/cortiv/persona/state-memory.ts`, `bots/cortiv/persona/persona.ts`.

# Current memory and historical notes

Current claims live in `.state-memory.json`. Each has a stable object/property key, monotonically increasing revision, original observation time and source, write time, optional expiry and retirement flag. `memory_record read` lists effective heads; `history` requires a key and returns prior versions. A targeted read also returns an inactive head so its revision remains available for a deliberate correction.

`set` and `retire` require the expected head revision and an observation ID from `memory_record evidence`. The Persona registers actual World events and non-Memory read/action tool results, retaining the event cursor or call ID as a source reference. File reads, file modification times and assistant speech do not create observations. A new version must reference a later observation. Revision comparison and atomic replacement run under a filesystem lock. The claim remains the agent's interpretation of the cited observation; the system verifies provenance and ordering, not semantic entailment or World completion.

`expires_at` removes a temporary reading from current retrieval when its validity ends. Retirement leaves a tombstone. Neither expiry nor retirement resets the head revision. Copies of old evidence cannot renew or reactivate it. Current summaries are bounded; evidence previews are bounded; an explicit observation ID reads the stored source excerpt of up to 8,000 characters.

## Existing deployments

`StateMemory.migrate()` runs on Persona attachment. It copies each existing recent/configured state-note source once to a content-addressed file under `.memory-history/` and records its original content revision. It preserves the source file and assigns no current claims from its prose. Repeating the migration retains the first backup. Identity and resident principle files remain readable as before.

Recent notes, session/handoff archives, migration backups, the raw claim ledger and files configured for foreground/planning memory return a managed current view by default. Automatic indexes expose historical entry points rather than old state prose. `read_file` or `grep_files` with `history:true` explicitly retrieves historical text. The activity agenda and pending-work ledger remain the owners of intentions and completion status. Existing intentions can be inspected in historical sources and deliberately adopted into those ledgers.

The same view applies to planning inputs, default search, automatic recent notes and replayed Memory tool results. Handoff generation re-resolves those tool results without modifying the original event store. Background prose and final summaries are archived; their bodies are not automatically promoted into current claims. Background claim updates pass the same version and observation checks.

Closed agenda notes can be corrected with `activity_plan amend` and the current agenda revision from `read`. The stage remains closed; the earlier note and its timestamp remain in `corrections`. A concurrent or older correction cannot overwrite a newer one.

Arbitrary prose can still contain mistaken interpretations. This contract prevents the supported historical sources from becoming current state merely through rewriting or replay, and rejects stale structured updates. It does not detect all contradictions in unrestricted natural language. Vector similarity is independent of this validity contract.
