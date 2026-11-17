---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': patch
'@cat-factory/app': patch
---

A person can settle a stage's result as they accept it. A task handler may declare `checkpointRevision` (optionally `required`); `POST /workspaces/{ws}/projects/{projectId}/stages/{stageId}/checkpoint` then takes a `revision`, the handler applies it, and the platform records the settled body as a new outcome on the stage's stream, beside the model's proposal, before accepting it. Refusals carry `project_stage_revision_required`, `project_stage_revision_unsupported` and `project_stage_revision_invalid` (with `details.problems`).
