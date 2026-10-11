Owner: `procedures.ts` — executable procedural Memory tools.

# Reusable procedures

Use `procedure_find` to retrieve a relevant method by purpose, conditions or adapter. Read only the selected version and needed evidence. Old observations describe their original time and environment, not the current scene.

`procedure_save` creates a candidate: id, adapter, description (purpose, params and returned fields), conditions, JavaScript async function body, dependencies, and base. Use base:null for a new id; otherwise use the current candidate head. Revisions preserve authors, call ids, parent and source hashes. Saving does not execute or adopt anything. Raw workspace tools cannot modify the managed procedures directory; drafts and general notes can live elsewhere.

## Composition

An adapter supplies capabilities. `minecraft-method/v1` supplies the existing `mc`, `bot` and `Vec3` in `mc_script`. Another World may implement another adapter using the same artifact, evidence and adoption protocol; capabilities and permissions remain that World's responsibility.

Dependencies map local aliases to exact `{handle,revision}` artifacts. `await methods.run("alias", {parameter:value})` invokes that pinned child and returns its result. Params and returned JSON are immutable. All children share the parent's time, call and body-control budgets; dependencies must be awaited serially. Maximum eight unique versions, depth four, 48K combined source characters and 32 invocations. A new child revision does not silently change an existing parent: save a parent revision with the new dependency explicitly.

Example shape (write the actual checks from the adapter's current API):

```js
const before = await mc.state();
// Check applicable support, reach, resources, permission and current task here.
const action = await methods.run("operation", params);
const after = await mc.state();
return { before, action, after };
```

For Minecraft, read `mc_script {api:"index"}` and specific native help as needed. Native operations do not navigate or choose tools. Once native body control is acquired, do not enqueue `mc.do` from that program. Check source/flow/block/item state using actual return fields. No imports, filesystem, network, raw bot or extra privileges are exposed.

## Verification, revision and adoption

1. Call the adapter with the returned procedure handle/hash and validate:true. Every dependency is parsed; no action is executed. Syntax success is not goal success.
2. Execute with current params in a naturally applicable situation. Read the actual terminal event/receipt and before/after observations. A returned `{ok:true}` is authored program output; check the underlying calls and external effects.
3. `procedure_review` links the execution UUID to your outcome, explanation, test context and optional numeric measurements (put units in names; unknown is null). The tool accepts only an actual delivered execution receipt from the log. Failures and uncertainty remain useful evidence. Keep assessment separate from observed receipt.
4. Compare comparable reviews using comparison; document changed environment, teammates and sample size. One success does not prove improvement across situations. Revise from counterexamples using base=head, then validate and execute the candidate again.
5. `procedure_adopt` selects a reviewed version for future retrieval. Requires completed execution and your achieved-goal assessment. Use expectedAdopted to avoid overwriting a concurrent selection. Roll back by explicitly selecting an older reviewed revision. Adoption does not replace running tasks.

The library persists across context handoffs and restarts. Record unresolved learning goals and lookup ids in your normal agenda. Reuse successful code where appropriate, use model judgment at uncertain branches, and request new observations when assumptions stop matching. You need not write or revise a program for a one-off action. Maintenance-authored infrastructure or methods must retain that source; they are not your autonomous learning results. This mechanism changes procedures and memory, not model weights.
