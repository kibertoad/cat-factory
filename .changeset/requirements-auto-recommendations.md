---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Requirements review: auto-recommend answers for findings that don't need a business decision.

The requirements reviewer now classifies each finding it raises as `autoAnswerable` — answerable
confidently from universal engineering/product best practice or the context already provided
(vs. needing a genuine business/product decision). For the `autoAnswerable` findings, the
Requirement Writer AUTO-generates a grounded recommendation and it is auto-accepted as the
finding's **default answer** (pre-filled, editable, dismissable), so the human only hand-answers
the findings that genuinely need their input. Findings needing a business decision are left blank
and flagged "needs your input"; the human still drives incorporation. The reviewer prompt is
bumped to `requirement-review@v3`.

The behaviour is configurable per pipeline step: a new **auto-recommendation** toggle on the
`requirements-review` step in the pipeline builder (**on by default**). Disabling it reverts to
the fully-manual flow (answer or request recommendations for every finding).

This introduces the extensible per-step **`stepOptions`** seam — a single JSON bag
(`pipelines.step_options`, parallel to `agentKinds`) that is the going-forward home for new
per-step pipeline parameters, replacing the "one array + one column per knob" pattern
(`autoRecommend` is its pilot field). See `docs/initiatives/pipeline-step-options.md` for
folding the legacy per-step arrays (`gates`/`thresholds`/`enabled`/`consensus`/`gating`/
`followUps`/`testerQuality`) into it.

Persistence: a new nullable `step_options` column on `pipelines`, mirrored across the D1 and
Drizzle stores (no data migration — absent ⇒ all defaults). Requirement-review items and
recommendations gain optional `autoAnswerable` / `auto` fields (stored in the existing JSON
columns, no migration).
