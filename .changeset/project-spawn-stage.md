---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/conformance': patch
'@cat-factory/app': patch
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

A project stage can put work into the services a project links. The new built-in `spawn` task type runs on `pl_spawn`, whose one `project-spawner` step the engine performs itself: it creates a task in each linked service (title and description templated with `{service}`, a task type, an optional pipeline), links the project to it so it reads the accepted stages, starts its run, and records what it created and every service it skipped. Its handler (`spawnTaskHandler`, which any project kind lists beside its own) is performed by the engine and requires a checkpoint and an earlier stage, and the checkpoint refuses with `project_stage_work_unsettled` until every task it created is done or removed.

`ProjectTaskHandler` gains `performedBy` (`agent` or `engine`), `checkpointAwaits` (the tasks a result waits on before acceptance, which implies a checkpoint) and `stageRequires.after`. `ProjectStepController` takes `engineTasks`, what performs each engine task type. `TaskProjectLinkService` gains `linkMany`, which admits projects once per board for tasks the caller just created. `BlockRepository` gains `getMany(workspaceId, ids)`, a workspace-scoped batch read on both runtimes, remote on a mothership node. `BoardService.addTask` takes an optional explicit id. Each runtime facade re-exports `SPAWN_PIPELINE_ID`. The initiative loop and the spawner share `modules/spawn/spawnedTask.ts`.

Public API 1.102.0: the task-type vocabulary gains `spawn`, the pipeline-purpose vocabulary gains `project-spawn`, and the conflict reasons gain `project_stage_work_unsettled`.
