---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/app': patch
---

Kaizen no longer tries (and fails) to grade with an incompatible model. The grader is an
inline LLM call, so when a workspace's Kaizen model resolves to a subscription-only model the
deployment can't run inline — or to nothing configured at all — it used to degrade to the
routing default (e.g. `qwen`) and fail, flooding the grading table with `failed` rows. It now
skips grading those runs entirely and surfaces a warning banner steering the user to point
Kaizen at a compatible provider-backed model. The Model Configuration editor also warns when a
preset's Kaizen model is only available via an individual subscription. The per-workspace model
catalog now carries an `inlineUsable` flag (computed with the deployment's inline-harness seam)
that drives both surfaces. Kaizen remains disableable via the existing workspace setting.
