---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
'@cat-factory/conformance': minor
---

Add "Requirements brainstorm" and "Architecture brainstorm" agents — structured-dialogue
gates that PROPOSE options with explicit trade-offs and let a human converge on a direction,
rather than doing all the work themselves or expecting the work done upfront.

- One shared, stage-discriminated engine (`BrainstormService` over the existing
  `IterativeReviewService`), driven through the generic `ReviewGateController`. Two agent kinds
  (`requirements-brainstorm`, `architecture-brainstorm`) reuse it via a stage-bound repository
  adapter.
- Persistence: a new `brainstorm_sessions` table keyed per (block, **stage**) — a block may hold
  a live requirements AND a live architecture session at once — mirrored across both runtimes
  (D1 + Drizzle/Postgres) with a cross-runtime conformance suite.
- Handoffs (DB session state → next stage's prompt): `requirements-brainstorm` → the
  requirements review (its converged direction becomes the reviewed subject);
  `architecture-brainstorm` → the architect (surfaced additively as a prior output).
- Pipelines: both steps are added to `pl_full` and `pl_fullstack` but **disabled by default**
  (opt-in per pipeline) — existing runs are unchanged.
- Frontend: a shared brainstorm window (option cards with trade-offs → choose/steer/dismiss →
  incorporate → re-run), wired through the result-view seam, the workspace stream, and the
  palette catalog.

Breaking: adds a new required table on both runtimes (`brainstorm_sessions` D1 migration +
Drizzle migration) and a new optional `ExecutionEventPublisher.brainstormSessionChanged` event.
No data migration — pre-1.0, stale state is acceptable.

The brainstorm iteration cap reuses the merge preset's `maxRequirementIterations` /
`maxRequirementConcernAllowed` knobs (no new preset field).
