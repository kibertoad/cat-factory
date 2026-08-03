---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/agents': patch
'@cat-factory/kernel': patch
'@cat-factory/worker': patch
---

BREAKING (public API, the last permitted break): the final pre-stability polish of `/api/v1`,
adopted together with the stability commitment (ADR 0032). From this release the public API does
not change without an incremental migration path and a version change.

- `POST /api/v1/initiatives` moved to `POST /api/v1/jobs`, unifying the headless job lifecycle
  under one resource root. The SDK group `initiatives` is now `jobs`; the wire schemas renamed to
  `CreatePublicJob` / `PublicJobAccepted`.
- `publicTask.executionId` renamed to `publicTask.runId`, matching `publicRun.runId` and
  `/api/v1/runs/:runId/...`.
- `POST /api/v1/tasks/:taskId/start` now requires a `decide`-scope key when the resolved pipeline
  can park on a human decision (approval gate or review/brainstorm kind), the same rule
  `POST /api/v1/jobs` applies. Existing `write` keys that started such pipelines get
  `403 pipeline_requires_decide_scope`.
