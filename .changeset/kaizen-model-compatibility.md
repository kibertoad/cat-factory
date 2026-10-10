---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/observability-otel': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/app': patch
---

Kaizen no longer tries (and fails) to grade with an incompatible model. The grader is an
inline LLM call, so when a workspace's Kaizen model resolves to a subscription-only model the
deployment can't run inline, or to a model with no usable provider, it used to degrade to the
routing default (e.g. `qwen`) and fail, filling the grading table with `failed` rows. It now
skips grading those runs and shows a warning banner steering the user to point Kaizen at a
compatible provider-backed model. The Model Configuration editor also warns when a preset's
Kaizen model runs only on a subscription the deployment can't use inline. The per-workspace
model catalog (`GET /workspaces/:ws/models`, not the public `/api/v1/models`) now carries an
`inlineUsable` flag, computed with the deployment's inline-harness seam, that drives both
surfaces. Kaizen can still be turned off with the existing workspace setting.

Each skipped run is logged and counted under the new `kaizen.grading_skipped` operational
counter (exported as `cat_factory.platform.kaizen_gradings_skipped`), since the banner reads only
the workspace default preset and a task under another preset or with its own pin is skipped with
nothing in the SPA to say so.
