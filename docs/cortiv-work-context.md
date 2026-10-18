# bots/cortiv/persona/pending-work.ts and activity-agenda.ts

An intention may bind to a World's `workStates` identity using `work_ref`:
`world`, `scope` (realm/account/agent), `subject`, `instance`, and `revision`.
The reference must identify an external result that fully settles the intention.
`pending_work bind` attaches an existing open intention; `defer` may supply the reference
when creating one. `activity_plan bind` also requires the current `expected_revision`
and a binding explanation in `note`.

Current World facts are reconciled before foreground context and planning inputs are
rendered. A server-confirmed completion or cancellation at a matching or later revision
retires only the same bound occurrence. Evidence and historical notes remain in the
ledger, and pending timers are cancelled after a successful memory commit. Equal-version
contradictions, another account/World/occurrence, unbound legacy entries, task admission
and elapsed time do not establish completion. Reopening a mistakenly closed agenda stage
archives and detaches the old binding; the fresh contrary evidence remains in its history.

Reconciliation advances the agenda revision and invalidates dependent proposals so a late
background result cannot restore retired work. Pending summaries prioritize newer intentions
within their existing text budget; pagination still exposes every older entry. Closed work
stays searchable and carries its source evidence. This bookkeeping does not establish that
an agent has learned a better method or completed another World objective.
