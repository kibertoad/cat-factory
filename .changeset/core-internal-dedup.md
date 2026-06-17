---
'@cat-factory/core': patch
---

Internal cleanup of the core package — no behavior or API changes. Deduplicates
repeated helpers into shared modules: the subtask-snapshot comparison
(`sameSubtasks`/`sameSubtaskItems`) used by the execution + bootstrap flows now
lives in `domain/subtasks.logic`, a `getErrorMessage` helper replaces the
repeated `error instanceof Error ? error.message : String(error)` expression, the
shared `STANDARDS_FOOTER` prompt line is centralized in `agents/prompt-shared`,
and the identical document/task in-memory provider registries now extend a
generic `MapSourceRegistry`.
