---
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/conformance': patch
---

A task that links a staged project reads each stage's accepted result, rendered by the handler of the task type that wrote it, in the definition's order; a stage with no accepted result yet is stated, and the recorded revision names every accepted stage outcome. A result still awaiting its checkpoint is not read, and a staged project is linkable only once some stage has an accepted result. Only the bodies a rendering uses are read. A project pinned to a definition the deployment cannot resolve is stated rather than rendered by its kind. `ProjectOutcomeStore.listOfProjects` is replaced by `envelopesOfProjects` and `bodiesOfProjects`. `ProjectRecordRepository` gains `listStageTasksOfProjects`, a batched read on both runtimes.
