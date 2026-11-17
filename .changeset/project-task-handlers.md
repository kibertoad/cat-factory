---
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/conformance': patch
---

Split a project kind's code into its kind module and per-task-type task handlers.

A `ProjectTaskHandler` owns one task type's agent kind, outcome body schema and version, and the planning, briefing and finishing of its tasks. A `ProjectKindModule` keeps the definition spec, the view and the linked-context rendering, and names the handlers its projects run in `handlers`; several kinds may offer one handler. Each project outcome now records the task type that wrote it (`project_outcomes.task_type`, D1 migration 0118 and its Drizzle twin, backfilled from the task block), and readers decode it with that type's handler.

Breaking for a deployment that registers its own project kind: move `agentKind`, `outcomeSchemaVersion`, `parseOutcome`, `planTask`, `brief`, `mergeCheckpoint`, `finish`, `describe`, `artifactRefs` and the `outcome` schema onto a handler, list it with `eraseTaskHandler` in the module's `handlers`, and read a handler's outcomes in `view` and `renderContext` through `outcomesOf`.
