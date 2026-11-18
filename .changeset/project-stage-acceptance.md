---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/conformance': patch
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

A project stage may declare `acceptance` criteria, and must then declare a checkpoint. Once a stage task records its result, an inline assessment (the new `StageAcceptanceAssessor` port, built from the facade's model dependencies, overridable as `CoreDependencies.stageAcceptanceAssessor`) argues each criterion with passages quoted from the stage's rendered result. The platform computes the report: `met` only when every quoted passage is in the result, `unmet` as claimed, `unverified` otherwise; an unwired assessor or a failed assessment is stated on the report. A reply that argues no criterion in the expected shape is `failed`, and quotes past the per-criterion limit are counted and keep a criterion from `met`. The report is stored on the stage-task record (`project_stage_tasks.acceptance`, D1 0120 and its Drizzle twin; `ProjectRecordRepository.setStageTaskAcceptance`, remote on a mothership node): an `assessed` report stands, one that assessed nothing is replaced by the next attempt, and a result with none yet reads as `pending` on the stage's state. A person still decides at the checkpoint.

The judges' assessor and this one share `runInlineJsonAssessment`, which also bounds each call with a timeout, so a stalled provider no longer holds a judge step indefinitely.

Public API 1.103.0: a definition's stage gains the optional `acceptance` field.
