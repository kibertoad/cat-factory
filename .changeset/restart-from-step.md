---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Restart a pipeline run from a chosen step.

Both the run's step-detail overlay (`AgentStepDetail`) and each step on the pipeline
timeline (`PipelineProgress`, a hover-revealed side button) now offer **"Restart from
here"**: re-run the pipeline from that step onward — even on a finished run — resetting
the chosen step plus every later step's iteration counters (companion attempts,
gate/test attempts, eviction recoveries) and re-driving a fresh run. The steps
BEFORE the chosen one are preserved verbatim, so their outputs (and resolved
decisions) still reach the restarted step as its `priorOutputs` handoff context.

Unlike retry (which resumes at the first FAILURE), restart rewinds to an arbitrary
human-picked step, so it can re-run steps that already completed. A block's
incorporated requirements are deliberately NOT touched — they live on the
requirement-review record, not the run — so a restarted `spec-writer`/`coder`
still receives the incorporated requirements document (or the base description when
none was generated). Restarting AT the `requirements-review` gate itself re-runs the
reviewer, which mints a fresh iteration-1 review (its `review()` replaces the prior
one) — exactly the "reset the iterations counter from this step" semantics.

Backed by `POST /workspaces/:ws/executions/:executionId/restart` (`{ fromStepIndex }`,
`restartFromStepSchema`) → `ExecutionService.restartFromStep`, which tears down any
still-live driver/container for the run it replaces (so restarting a RUNNING run
never orphans a container or a parked Workflows/pg-boss driver), then mints a new run
id and re-drives like a retry. Like start/retry, an individual-usage (Claude/GLM/
Codex) block needs the initiator's personal password (prompted, then retried, on a
428). Runtime-neutral (shared `@cat-factory/server` + orchestration), so both facades
get it; a cross-runtime conformance assertion pins the restart + the requirements
handoff on every runtime.
