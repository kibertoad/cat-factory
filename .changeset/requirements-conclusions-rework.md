---
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/worker': patch
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
  description. Backed by an optional `requirementReviewRepository` dep, so the Node
  facade (no review persistence yet) degrades to the original behavior.
