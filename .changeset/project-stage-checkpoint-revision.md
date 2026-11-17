---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': patch
'@cat-factory/app': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/conformance': patch
---

A person can settle a stage's result as they accept it. A task handler may declare `checkpointRevision` (optionally `required`); `POST /workspaces/{ws}/projects/{projectId}/stages/{stageId}/checkpoint` then takes a `revision`, the handler applies it, and the platform records the settled body as a new outcome on the stage's stream, beside the model's proposal, and the acceptance names it (`project_stage_tasks.accepted_outcome_id`): a revision no acceptance names counts for nothing. Refusals carry `project_stage_revision_required`, `project_stage_revision_unsupported` `project_stage_revision_invalid` (with `details.problems`) and `project_stage_result_unreadable`.
