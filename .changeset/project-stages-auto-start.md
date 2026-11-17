---
'@cat-factory/orchestration': minor
'@cat-factory/server': patch
'@cat-factory/conformance': patch
---

A project stage with `start: 'auto'` starts itself once it is ready: when the project is created, after a task records an outcome, and after a person clears a checkpoint. The engine creates the stage's task and starts its run with no initiator, the way an initiative spawns its tasks; a stage that fails to start is logged and stays `ready` for a person.
