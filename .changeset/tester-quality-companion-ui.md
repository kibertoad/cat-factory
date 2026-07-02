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
  request-body validator. This includes the persistence layer itself: new `follow_ups` +
  `tester_quality` JSON columns on the `pipelines` table, mirrored D1 (migration
  `0032_pipeline_companion_toggles`) ⇄ Drizzle (schema + generated migration), written by both
  repos and read by the shared `rowToPipeline` mapper. A QC estimate gate is validated like
  companion gating (a threshold must be set and a `task-estimator` must run earlier).
- **Conformance**: the full QC loop (audit → loop the Tester on gaps → conclude on an adequate
  report) is now driven through an injected deterministic reviewer on every runtime, asserting
  the verdicts + counters persist identically across D1 and Drizzle. A separate round-trip
  assertion saves a custom pipeline with a `followUps` opt-out + a gated `testerQuality` config
  and re-reads it from the store, so the new columns can't silently drop the toggles on either
  runtime.

All new user-facing copy is translated across every shipped locale.
