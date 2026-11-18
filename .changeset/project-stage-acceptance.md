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

A project stage may declare `acceptance` criteria, and must then declare a checkpoint. Once a stage task records its result, an inline assessment (the new `StageAcceptanceAssessor` port, built from the facade's model dependencies, overridable as `CoreDependencies.stageAcceptanceAssessor`) argues each criterion with passages quoted from the stage's rendered result. The platform computes the report: `met` only when every quoted passage is in the result, `unmet` as claimed, `unverified` otherwise; an unwired assessor or a failed assessment is stated on the report. The report is stored on the stage-task record (`project_stage_tasks.acceptance`, D1 0120 and its Drizzle twin; `ProjectRecordRepository.setStageTaskAcceptance`, first write wins, remote on a mothership node) and served on the stage's state. A person still decides at the checkpoint.

Public API 1.103.0: a definition's stage gains the optional `acceptance` field.
