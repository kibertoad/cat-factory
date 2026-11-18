---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/conformance': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/app': patch
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

A project stage can propose a decision register for a person to settle. The new built-in `decisions` task type runs on `pl_decisions`, whose `project-decider` agent proposes, from the stages the stage reads, each decision with its options, a recommended default, the rationale and the evidence. Its handler (`decisionTaskHandler`, which any project kind lists beside its own handlers) requires every item settled at the stage's checkpoint, and the settled register is what later stages read. The pipeline-purpose vocabulary gains `project-decisions`. Each runtime facade re-exports `DECISIONS_PIPELINE_ID`. Public API 1.101.0: the task-type vocabulary gains `decisions`.
