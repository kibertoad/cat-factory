---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/conformance': patch
'@cat-factory/app': patch
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

A project stage can compose one Markdown document from the stages it reads. The new built-in `writeup` task type runs on `pl_writeup`, whose `project-writer` agent writes the document against its stage's brief and outline, referencing the artifacts the results it read hold. Its handler (`writeupTaskHandler`, which any project kind lists beside its own) names the outline sections the document lacks and drops, naming it, any artifact no result it read holds. `ProjectTaskInput` gains `upstreamArtifacts`, the artifact refs of the results a staged task starts from. Each runtime facade re-exports `WRITEUP_PIPELINE_ID`. The pipeline-purpose vocabulary gains `project-writeup`. Public API 1.104.0: the task-type vocabulary gains `writeup`.
