<!-- Owner: bots/cortiv/persona/persona.ts, state-memory.ts, activity-agenda.ts, pending-work.ts and dream-memory.ts -->

# Memory, intentions and observations

Persistent Memory and a model request have different lifetimes. A compact request can omit old dialogue while the workspace, raw session and receipt archives retain it. Omission does not complete, cancel or invalidate an intention.

| Owner | Meaning | Reading contract |
| --- | --- | --- |
| Workspace prose | Experiences, preferences, relationships, project detail and source material | Read original text by file and line. Sources and observation times remain visible. |
| `StateMemory` | Versioned interpretations of identified external observations | Read by key and revision. The latest active version does not establish that an old observation is still current. |
| `ActivityAgenda` | Adopted purposes, intended beneficiaries, completion criteria and progress | Current choice first; bounded summaries and paged detail retain all stored objectives. |
| `PendingWork` | A reminder to recheck a particular unfinished intention | Time or a matching event changes waiting to ready; it does not prove completion. |
| World receipts and current facts | External execution outcomes and sampled state | Verify the World, identity, time and actual result. A task's acceptance is not an objective's completion. |

Configuring a prose file for foreground or background reading does not turn it into a derived fact ledger. Ordinary goals, preferences, recent notes and handoff archives retain direct `read_file` access and original pagination. Explicit `history:true` remains compatible. The internal current-claim ledger and its immutable prior versions retain their managed query contract.

Foreground requests place bounded historical indexes and experience before current claim summaries and World facts. These labels express provenance rather than proving a note's interpretation. Older source text can be read alongside evidence that supersedes it; changing or deleting that text does not update a claim or retire a task.

The agenda limits each proposal and read page to eight entries. Its persistent store can retain more open objectives; a new choice does not require closing an unrelated one. The intent window admits at most eight entries and 4,000 characters, with the active objective first. Remaining objectives stay queryable. Closed records cannot be reopened by a stale proposal.

Background Memory writes compare content revisions. A snapshot cannot overwrite a newer foreground note, and rereading does not remove a captured-history restriction on the recent note. Successful writes survive later cancellation or generation failure; retry does not replay already written material. These protections do not infer whether the content is semantically correct.

World bindings carry complete task identity and evidence. Automatic retirement applies only to an explicitly bound external result that settles the entire intention. Unbound reminders require explicit review; a past review time cannot justify deleting them or announcing completion.
