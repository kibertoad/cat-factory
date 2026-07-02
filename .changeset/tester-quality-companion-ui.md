---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
'@cat-factory/kernel': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

feat(testing): pipeline-builder toggle + Test Report surfacing for the test quality companion (PR 2)

Completes the test quality-control (QC) companion (see
`docs/initiatives/tester-quality-companion.md`) with its authoring + observability surfaces:

- **Pipeline builder**: a per-Tester-step toggle (enabled by default) turns the QC companion
  off, and an optional estimate-gating panel runs the coverage audit only on tasks whose
  estimate clears a threshold (mirroring the companion-gating panel). The estimator-required
  hint now covers QC gating too.
- **Test Report window**: a "Coverage review" section renders each QC verdict (adequate /
  gaps-found, the reviewer's feedback + concrete gaps, model, timestamp) plus the loop budget
  and a "budget spent" badge — so a report that greenlit only after a QC-driven re-run shows
  why it looped.
- **Persistence fix**: the pipeline create/update/clone API + `PipelineService` now thread
  `testerQuality` (and the sibling `followUps`, which had the same latent gap) end-to-end, so a
  custom pipeline's builder toggle actually persists instead of being silently stripped by the
  request-body validator. A QC estimate gate is validated like companion gating (a threshold
  must be set and a `task-estimator` must run earlier).
- **Conformance**: the full QC loop (audit → loop the Tester on gaps → conclude on an adequate
  report) is now driven through an injected deterministic reviewer on every runtime, asserting
  the verdicts + counters persist identically across D1 and Drizzle.

All new user-facing copy is translated across every shipped locale.
