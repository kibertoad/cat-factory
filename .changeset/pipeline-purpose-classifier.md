---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

feat: add a selectable `purpose` classifier to pipelines (`build` / `document` / `review` / `research` / `planning`)

Pipelines now carry an explicit use-case classifier instead of it being inferred from their steps. It is chosen in the pipeline builder (a new selector), stamped on every built-in preset in `seedPipelines()`, and persisted in a new `pipelines.purpose` column (mirrored D1 ⇄ Drizzle).

Two surfaces key off it, sharing the pure predicates in `@cat-factory/contracts` (`pipelineAllowedForTaskType`, `purposeAllowsAgentCategory`):

- **Task pickers** — a `document` task now offers ONLY document pipelines (the add-task modal, the task run-settings default, and the focus-view run menu), and the add-task form defaults a document task to the `pl_document` writing pipeline. Every other task type is unrestricted.
- **Builder palette** — selecting a non-`build` purpose hides the Implementation and Testing agent kinds (a document/review/research/planning pipeline writes no product code and runs no tests).

Every built-in pipeline's `version` is bumped so existing workspaces are offered a reseed that stamps the new `purpose`. Breaking-change note (pre-1.0, no back-fill): a pipeline persisted before this change reads as unclassified — shown everywhere except a document task — until it is reseeded (built-ins) or re-saved with a purpose (custom).
