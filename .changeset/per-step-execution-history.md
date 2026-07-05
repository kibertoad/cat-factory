---
'@cat-factory/contracts': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/app': patch
---

Show a step's failure trail on its step-detail overlay. The step-detail overlay now has an "Execution history" toggle that reveals the prior failed attempts recorded for that specific step (plus the current failure when the run is presently failed at it): the run-level "previous errors" history narrowed to one step. Each `AgentFailure` now carries the `stepIndex` it failed at (stamped by the engine's failure funnel), so the trail can be attributed per step.
