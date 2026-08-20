# Per-workspace agent prompt overrides

A workspace can replace any agent kind's system prompt from the pipeline builder and switch back
through the full history of what it has run. This doc is the authority on the override store and
the composition rules; the code-registered deployment tier of the same text (variants) is
documented in [`custom-agents.md`](./custom-agents.md#variations-of-an-existing-kind-alternate-prompts-programmatically).

## The store is an APPEND-ONLY revision log

`agent_prompt_revisions`, keyed `(workspace, agent_kind, revision)`, and the HIGHEST revision is
live: no update, no delete. Going back to what the product ships appends a revision whose `text`
is **NULL**: a real state, distinct from a kind nobody edited, which keeps the workspace tracking
the shipped prompt as it is bumped instead of pinning today's wording. **The composite key is the
concurrency control**: a second editor's insert COLLIDES and `AgentPromptService` re-reads the
head to raise `prompt_revision_conflict`. **Never turn that insert into an upsert**:
last-write-wins would silently discard one of two people's prompts.

## An override replaces the SHIPPED TRACK PROMPT, never the whole system prompt

`systemPromptFor(kind, registry, override?, delivery?)` re-applies the surface directives and trait
guidance on top, because those are invariants of how the platform runs a kind rather than editorial
content, so the editor shows, and an override supplies, `baseSystemPromptFor`.

### Trait guidance that names an injected file is gated on the file arriving

`delivery` is the fourth argument and it is the dispatch's `.cat-context/` paths
(`traitDeliveryFor(context)`, one helper for all three composing surfaces). An
`AgentTraitDefinition.guidance` function receives it and may return `undefined` to contribute
nothing for THIS dispatch. The two foundational traits use that: each opens by pointing at a file
the engine injects only when a `FoundationalServiceResolver` is wired, so on a deployment with none
they were a few hundred words of pointer to a path that does not exist, riding every turn.

Three rules bind a new gated trait:

- **Gate on PRESENCE, never on content.** Where the resolver is wired the file is always written and
  SAYS which state it is in (resolved / none registered / unavailable), and acting on that statement
  is what the guidance asks for. `BINARY_OUTPUT_GUIDANCE` is deliberately NOT gated for the stronger
  version of the same reason: its absent case is a REFUSAL the agent must be told ("do not attempt
  any upload"), and gating it off would let a generator produce artifacts it can store nowhere.
- **An absent `delivery` means UNKNOWN, not empty**, and renders the guidance in full. The prompt
  editor, the Sandbox and a unit test all legitimately have no dispatch.
- **`appendedDirectivesFor` is therefore a MAXIMUM**, not a prediction of one dispatch: what the
  editor promises is that no rule the platform enforces is missing from what it shows, and a real
  dispatch may send a subset. `promptOverrides.spec.ts` pins both directions (exact equality for a
  dispatch that delivered every gated file, containment for one that delivered none).

**Reach for the two TOTAL seams, not that pair.** `shippedBasePromptFor(kind, registry)` is what an
override REPLACES and `composedSystemPromptFor(kind, registry, replacement?, delivery?)` is what then
goes on the wire, and each already branches on whether the kind's prompt is bespoke. `systemPromptFor` alone
is right only for a kind that has no bespoke entry: for an inline ENGINE kind it returns the thin
`roles.ts` line and appends a second copy of directives the real prompt already carried, so a caller
using it shows an editor text nobody runs and grades a candidate on a prompt nothing sends. Three
callers ride the total pair: container dispatch (`dispatchSystemPromptFor`, which only adds reading
the replacement off the run context), the prompt editor, and the Sandbox run-driver.

## An invariant reaches a shipped prompt by TWO routes and only one survives an override

`applySurfaceDirectives` APPENDS, but a built-in track prompt carries the same rule INLINE.
Replace the track prompt and the double-append guard reads "already has it" about a string that
no longer exists, so every kind whose deliverable IS its reply silently loses the rule and
returns an empty reply the harness fails the run on. `restoreShippedInvariants` closes that by
diffing against the fully composed SHIPPED prompt. **A new engine-enforced fragment belongs in
`OVERRIDE_PRESERVED_FRAGMENTS`**, or an override can delete it.

That diff is taken under THIS dispatch's `delivery`, not with every gate open. No member of the
preserve list is gated today, and threading the argument is what stops that becoming a silent
problem: measured with the gate open, a gated member would be restored onto an overridden prompt on
a deployment whose un-overridden prompt correctly drops it, so two dispatches of one kind would
disagree about a rule depending on whether somebody had edited the prompt.

The test for membership is whether the fragment describes how the platform RUNS the kind rather
than what it should look for, and it catches more than the obvious two. `REVIEW_FINDINGS_LAYOUT` is
there because a companion's verdict is READ by the engine and RENDERED to a person: an override
edited for an unrelated reason would otherwise take the severity grading with it (every finding
then reaches the engine equally urgent, and nothing can hold a run on a must-fix) along with the
escaping rule (a multi-line summary arrives as invalid JSON and costs a repair retry), with nothing
in the editor saying why. `TRIAGE_JSON_CONTRACT` is there because the `task-estimator`'s prompt
comes from a built-in track, so the `{ role, directives }` split below is not available to it and
the JSON shape `coerceTaskEstimate` reads sits inside the editable text. **A parse failure there is
SILENT**: no estimate is persisted, so every step gated on the estimate simply stops being gated
and the run looks normal.

## The engine resolves the override ONCE per dispatch

It lands on `AgentRunContext.systemPromptOverride`, so the container, inline and consensus paths
cannot disagree about which prompt a step ran under. **A new prompt-assembly site must honour
it.** A step records the revision it ran under (`PipelineStep.promptRevision`, absent means
shipped), which Kaizen keys its `(prompt, agent, model)` combo off.

## A per-kind GENERATION setting is the sibling store, not another revision log

The output-token ceiling rides `workspace_agent_settings` (per workspace, per kind, edited in the
same editor), resolved by the SAME once-per-dispatch rule onto `AgentRunContext.maxOutputTokens`
with a pipeline step's `stepOptions.maxOutputTokens` winning over it. It UPSERTS where the prompt
log appends (a scalar someone retypes, not authored text a lost update would destroy), and
"inheriting" is the row's ABSENCE, never a stored null. Ceilings are advisory on the
subscription-CLI inline path. Doc:
[`configurable-agent-output-budgets.md`](../../docs/initiatives/configurable-agent-output-budgets.md).

## How a deployment VARIANT composes with a workspace override

A code-registered variant (`registerVariant`, see
[`custom-agents.md`](./custom-agents.md#variations-of-an-existing-kind-alternate-prompts-programmatically))
is the same unit of text one tier out, resolved in the SAME once-per-dispatch place and emitted
through the SAME `systemPromptOverride` field, so no executor branches on it and the invariants
above hold for it unchanged. The WORKSPACE override wins as the narrower tier, and a
`promptAddition` then folds onto the workspace's text rather than the shipped text, which is why
an addition, not a replacement, is the default a variant should reach for. The dispatch pins what
actually ran on `step.promptVariant` `{ id, applied, fingerprint? }` beside `promptRevision`, and
every reader keys off the PIN, never off `stepOptions.agentVariantId`.

## `BESPOKE_SYSTEM_PROMPTS` is SPLIT into `{ role, directives }`

`merger` and `on-call` dispatch a bespoke constant instead of their role prompt, bypassing
`applySurfaceDirectives`. The role is editable; the directives (the JSON contract the engine
parses, on-call's read-only guardrail) are re-appended on top. **Adding another such kind means
adding it there, split**: one added with its directives inside `role` compiles and dispatches
fine, and fails only later as a workspace that edited it losing its guardrail. The inline engine
kinds have the same split in `INLINE_ENGINE_SYSTEM_PROMPTS`; see
[`requirements-review.md`](./requirements-review.md).

## The sandbox shares ONE unit of text with this feature

A stored sandbox `systemText` and a stored override are both the BASE prompt, composed at RUN
time through the same override path production uses, so a candidate is graded on what would
actually be sent. Promote is `POST /agent-prompts/:kind/promote`, NOT a sandbox route: it writes
the live prompt, so it answers to `settings.manage` rather than the sandbox's
`integrations.manage`.

That sharing runs the OTHER way too, and it is the trap for the Sandbox's future container cells:
their dispatch would go through `dispatchSystemPromptFor`, which reads the workspace override off
the run context. **An experiment must run its SELECTED candidate**, so that path has to suppress
the override explicitly. Passed straight through, every prompt column of the grid would score
identically, with nothing saying why.
