# Configurable per-agent-kind output budgets

## Goal & rationale

An agent kind's output-token ceiling was a DEPLOYMENT-only fact: a number in each runtime's
routing builder (`AGENT_ROUTING`, overridable per kind through `AGENT_MODELS` /
`AGENT_MAX_OUTPUT_TOKENS`). That is the wrong owner for it. For the kinds whose whole deliverable
IS one reply (a research brief, an outline, a review verdict) the ceiling bounds the ARTIFACT
rather than guarding against a runaway, and how long that artifact needs to be is a property of
the work the workspace is doing, not of the deployment.

The failure mode is quiet, which is what makes it worth a seam rather than another env var: a
truncated reply (`finish_reason: length`) is not an error, so the run carries on and drafts from a
half-written brief. The motivating case was `doc-researcher` needing ~20k output tokens against
the shared 5000 default (raised to a per-kind default in
[#1544](https://github.com/kibertoad/cat-factory/pull/1544), which is the floor this builds the
override tiers on).

**End state:** three tiers, resolved once per dispatch by the engine, narrowest winning:

| Tier                 | Where it lives                               | Who sets it                 |
| -------------------- | -------------------------------------------- | --------------------------- |
| Pipeline step        | `StepOptions.maxOutputTokens`                | Whoever edits that pipeline |
| Workspace, per kind  | `workspace_agent_settings.max_output_tokens` | Workspace admin             |
| Deployment, per kind | `AgentModelConfig.maxOutputTokens` (env)     | Operator                    |

## Target pattern

`AgentContextBuilder.resolveMaxOutputTokens` is the ONE resolution site, folding the winner onto
`AgentRunContext.maxOutputTokens`; the inline executor reads
`context.maxOutputTokens ?? config.maxOutputTokens`. This deliberately mirrors
`systemPromptOverride`, and for the same reason: the container, inline and consensus paths must
not be able to disagree about the budget a step ran under, and a step's telemetry should record
what was actually sent.

Two seams carried the work with no new machinery:

- **Per-step is free.** `StepOptions` (see [`pipeline-step-options.md`](./pipeline-step-options.md))
  is one JSON column, so the field needed no migration on either runtime, and `ExecutionService`
  already copies the bag onto the runtime step.
- **Per-workspace copies the prompt-override stack**: `agent_prompt_revisions` is the same shape
  of thing (per-workspace, per-agent-kind, overriding a shipped default, edited in the pipeline
  builder), so the port / repo pair / controller / store / editor placement all follow it.

## Why the workspace store is PLAIN where the prompt store is append-only

The prompt log exists because last-write-wins would silently discard a body of authored text, so
its `(workspace, agent_kind, revision)` collision IS the concurrency control and it must never
become an upsert. A ceiling is one scalar a human typed: a lost update costs the loser a number
they can see is wrong and retype. So this store upserts on its primary key, has no revision log,
and `remove` is a real operation.

That asymmetry is the thing most likely to be "fixed" by a future reader into a bug in one
direction or the other, so it is asserted from both sides: the conformance suite pins that this
store REPLACES on re-upsert, and the prompt suite pins that its own store REFUSES a duplicate.

## Conventions & gotchas

- **"Inheriting" is expressed by ABSENCE, never a stored row of nulls.** The service deletes the
  row when the last field is cleared, so there is exactly one representation. A nullable column
  still exists (a future second knob will want it), and both the repo suite and the engine test
  pin that a stored `null` reads as inherit rather than as a zero-token budget, which would make
  every reply come back empty.
- **The update route is a PATCH.** An omitted field keeps its stored value so a second knob can be
  added without a read-modify-write race against this one; an explicit `null` clears.
- **The ceiling is keyed on the EFFECTIVE dispatched kind**, like the prompt override: a gate's
  helper (`ci-fixer`, the fork proposer) gets its own budget rather than inheriting the hosting
  step's.
- **`get` is on the RUN path**, so it is allow-listed in `REMOTE_PERSISTENCE_METHODS`. An
  un-routed method there fails every agent dispatch in mothership mode with `unknown_method`
  rather than merely dimming a panel.
- **The cap is ADVISORY on the subscription-CLI inline path.** The harness documents this at
  `InlineJob.maxOutputTokens` ("the one-shot CLIs don't all honour it"), so a value set here
  neither raises nor constrains an ambient `claude`/`codex` inline run: it bites on the metered
  provider path. This is stated at every tier's contract, because a knob that silently does
  nothing on one deployment shape is worse than an absent one.
- **The SPA never guesses the deployment default.** It is env-resolved per kind, so the per-step
  field's "inherited" placeholder names the WORKSPACE value when there is one and stays generic
  otherwise, rather than printing a number that would be wrong wherever an operator tuned it.
- **Both controls are OVERRIDE fields**, so they follow the interface-mode rule: gated on
  `showOverrideField`, hidden in basic mode only while unset, and revealed as soon as a value
  exists, or a basic-mode user runs on a budget a teammate pinned and can neither see nor clear it.

## Status

Landed in one slice: contract + kernel port + both runtime repos + migrations + mothership
allow-list + engine resolution + controller + both builder surfaces + conformance + i18n.

Follow-ups deliberately NOT in scope:

- **Temperature (and any further generation knob) on the same store.** The row and the PATCH shape
  were built for it, but adding one now would be speculative: the ceiling had a concrete failure
  to fix and temperature does not.
- **Sharing the per-kind default numbers between the two runtime routing builders.** They
  duplicate the budgets today and have already drifted (the Worker carries a `coderDefault` Node
  lacks). Worth extracting, but it is a refactor of the DEPLOYMENT tier and independent of these
  override tiers.
- **Surfacing a truncation.** A `finish_reason: length` on a kind whose deliverable is its reply
  is exactly the signal that a budget is too low, and it is recorded in `llm_call_metrics` today
  but never shown. Turning it into a notification (or a badge on the step) would close the loop
  this initiative only opened.
