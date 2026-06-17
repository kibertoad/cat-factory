---
'@cat-factory/orchestration': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/agents': patch
---

Internal cleanup — no behavior or API changes. Deduplicates repeated helpers into
shared modules: the subtask-snapshot comparison (`sameSubtasks`/`sameSubtaskItems`)
used by the execution + bootstrap flows now lives in `@cat-factory/kernel`
(`domain/subtasks.logic`), a `getErrorMessage` helper replaces the repeated
`error instanceof Error ? error.message : String(error)` expression, the shared
`STANDARDS_FOOTER` prompt line is centralized in `@cat-factory/agents`
(`agents/prompt-shared`), and the identical document/task in-memory provider
registries now extend a generic `MapSourceRegistry` exported from
`@cat-factory/kernel`.
