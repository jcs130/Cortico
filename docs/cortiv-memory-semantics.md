<!-- Owner: bots/cortiv/persona/persona.ts, state-memory.ts, activity-agenda.ts, pending-work.ts and dream-memory.ts -->

# Memory, intentions and observations

Persistent Memory and a model request have different lifetimes. A compact request can omit old dialogue while the workspace, raw session and receipt archives retain it. Omission does not complete, cancel or invalidate an intention.

| Owner | Meaning | Reading contract |
| --- | --- | --- |
| Workspace prose | Experiences, preferences, relationships, project detail and source material | Read original text by file and line. Sources and observation times remain visible. |
| `StateMemory` | Versioned observations, historical events and beliefs | Read by key, kind and revision. An active version does not establish the current World state. |
| `ActivityAgenda` | Adopted purposes, intended beneficiaries, completion criteria and progress | Current choice first; bounded summaries and paged detail retain all stored objectives. |
| `PendingWork` | A reminder, optionally linked to an adopted intention | Time or a matching event changes waiting to ready; reminder closure does not complete the parent goal. |
| World receipts and current facts | External execution outcomes and sampled state | Verify the World, identity, time and actual result. A task's acceptance is not an objective's completion. |

Configuring a prose file for foreground or background reading does not turn it into a derived fact ledger. Ordinary goals, preferences, recent notes and handoff archives retain direct `read_file` access and original pagination. Explicit `history:true` remains compatible. The internal current-claim ledger and its immutable prior versions retain their managed query contract.

Foreground requests place bounded historical indexes and experience before current claim summaries and World facts. These labels express provenance rather than proving a note's interpretation. Older source text can be read alongside evidence that supersedes it; changing or deleting that text does not update a claim or retire a task.

The agenda limits each proposal and read page to eight entries. Its persistent store can retain more open objectives; a new choice does not require closing an unrelated one. The intent window admits at most eight entries and 4,000 characters, with the active objective first. Remaining objectives stay queryable. Closed records cannot be reopened by a stale proposal.

Background Memory writes compare content revisions. A snapshot cannot overwrite a newer foreground note, and rereading does not remove a captured-history restriction on the recent note. Successful writes survive later cancellation or generation failure; retry does not replay already written material. These protections do not infer whether the content is semantically correct.

World bindings carry complete task identity and evidence. Automatic retirement applies only to an explicitly bound external result that settles the entire intention. Unbound reminders require explicit review; a past review time cannot justify deleting them or announcing completion.

## Claim kinds and legacy review

`observation` records a temporary sample and requires `expires_at` or `valid_for_seconds`. A relative lifetime starts at the original observation time. Writing an already old sample preserves its expiration. `event` describes a past occurrence; `belief` records a revisable understanding. Neither substitutes for current World observations. All set/retire writes retain the existing evidence and revision guards.

Legacy claims without a kind remain readable as `legacy`; loading does not rewrite their value, provenance or history. `read kind:legacy include_inactive:true` also exposes expired and retired latest versions. `classify` requires an exact revision, a chosen kind and a reason after reviewing the original evidence. It appends a version with the same value and observation time, cannot extend an existing expiry, and cannot reclassify an already typed or retired entry. New external evidence is required for a subsequent interpretation revision.

## Reminder identity and parent intentions

Every new reminder uses a stable id. Existing changes require the revision returned by `read`, and each committed change preserves the previous entry in `history`. A stable `request_id` identifies a defer retry; repeating it does not move the review time or create another id. Closed ids cannot reopen.

`intent_id` is an exact adopted agenda id. Linking requires a recorded reason; the parent goal is unchanged. Missing or closed parents, unreviewed legacy entries and unknown event sources remain visible as review diagnostics. `review` can correct an event selector with evidence while retaining status and original times. New event sources are checked against the configured World ids; type is a separate selector field.

Filtered list/read/history queries provide targeted access without inserting the whole backlog into each request. A review time is not a deadline, a request acceptance is not completion, and a reminder is not an independent source of objective truth. Legacy records migrate through explicit, versioned review/classify/link operations; there is no bulk semantic cancellation or automatic reclassification.
