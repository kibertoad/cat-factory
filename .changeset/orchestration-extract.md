---
'@cat-factory/orchestration': minor
---

Extract `@cat-factory/orchestration` from `@cat-factory/core`

The delivery-workflow engine (board, boardScan, bootstrap, execution, pipelines,
requirements) and the composition root (`createCore`) move to the new
`@cat-factory/orchestration` package. `@cat-factory/core` is now a thin barrel
that re-exports the full surface of all split packages for backward compatibility —
no consumer import paths change.
