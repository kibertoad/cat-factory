---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/conformance': patch
'@cat-factory/app': patch
---

Project definitions can declare stages.

A definition's `stages` each run one task type and write one outcome stream, run after the stages named in `after`, may read stages in their ancestry (`consumes`), and may hold each result at a `checkpoint` until a person accepts it. Each stage's `config` is validated by its task type's handler (`ProjectTaskHandler.parseConfig`); the research handler takes a research spec, so research can run as any number of stages of one project. A stage's state is derived from the new `project_stage_tasks` records (D1 migration 0119 and its Drizzle twin) and the project's outcomes, and is served on the board view as `stages`. `POST /workspaces/{ws}/projects/{projectId}/stages/{stageId}/tasks` starts a stage and `POST .../checkpoint` accepts its result; refusals carry the new conflict reasons `project_stage_in_progress`, `project_stage_blocked`, `project_stage_awaiting_checkpoint`, `project_stage_not_repeatable` and `project_stage_checkpoint_not_pending`, and a task of a staged project that no stage started is refused with `project_task_has_no_stage`.

A definition that declares no stages hashes exactly as before, so existing pins stay valid.

Breaking for a deployment that registers its own project kind: `ProjectDefinitionRegistry` and `validateProjectDefinition` take kind modules instead of spec validators, and a `ProjectTaskInput` carries `stage`.
