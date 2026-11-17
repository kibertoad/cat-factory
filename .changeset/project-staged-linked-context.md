---
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/conformance': patch
---

A task that links a staged project reads each stage's accepted result, rendered by the handler of the task type that wrote it, in the definition's order; a stage with no accepted result yet is stated, and the recorded revision is the newest accepted one. A result still awaiting its checkpoint is not read. `ProjectRecordRepository` gains `listStageTasksOfProjects`, a batched read on both runtimes.
