---
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': minor
---

Requirements review: react to findings + a rework agent that feeds downstream steps.

The requirements-review flow is now wired into the UI and reworks the requirements
instead of overwriting the block description:

- **New review window** (`RequirementsReviewWindow.vue`) modelled on the polished
  prose review window: a human reacts to the reviewer's structured findings —
  answering the relevant ones, dismissing the irrelevant — then runs the
  **requirements-rework** agent. Triggered from the inspector's "Review
  requirements" button (open-finding count badge). The old dormant
  `RequirementReviewModal` is removed.
- **Rework, not overwrite.** `incorporate()` no longer rewrites
  `block.description`. It folds the answers into ONE standard-format requirements
  document (new versioned `REWORK_SYSTEM_PROMPT`: SHALL statements + MoSCoW +
  Given/When/Then acceptance + domain rules) stored on the review, and returns
  `{ review }`. It runs even with **zero findings**, so every task can carry a
  clean, writer-ready spec.
- **Downstream consumption.** When a block has an incorporated review,
  `ExecutionService` feeds that reworked document to **every** agent step in place
  of the original description and drops the (already-folded-in) linked docs/tasks;
  the requirements-writer aggregates the reworked text per task instead of the raw
  description. The rework call rejects a length-truncated document instead of
  persisting a silently-incomplete spec.
- **Both runtimes, enforced.** The requirements feature is wired on the Node facade
  too — a `requirement_reviews` Postgres table (Drizzle schema + migration) and
  `DrizzleRequirementReviewRepository`, plus the review/model deps in the Node
  container — so the review/rework API and the agent-context substitution behave
  identically on Cloudflare and Node. The cross-runtime conformance suite asserts the
  substitution against both stores so the parity can't silently drift.
- **Frozen description.** Once a task's requirements are reworked, the inspector
  freezes its raw description (read-only, tucked behind an expander) and puts the
  standardized requirements in focus — the description is no longer what agents read.
