---
'@cat-factory/orchestration': minor
'@cat-factory/server': patch
'@cat-factory/conformance': patch
---

A project stage with `start: 'auto'` starts itself once it is ready: when the project is created, after a task records an outcome, and after a person clears a checkpoint. The engine creates the stage's task and starts its run with no initiator, the way an initiative spawns its tasks. An automatic stage starts once: deleting its task stops it. A task whose run never started is started by the next trigger, and a run on an individual-usage model is left on the board for a person.
