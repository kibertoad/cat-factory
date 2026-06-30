---
'@cat-factory/orchestration': minor
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/app': minor
---

Refuse to start a pipeline that includes an agent relying on binary-artifact storage when the workspace's account has none configured.

The requirement is modelled as a new `binary-storage` agent trait (carried today by the UI Tester, which uploads its screenshots), so the system is universal: a future artifact-producing agent just declares the trait instead of the engine hard-coding it. `ExecutionService` enforces it on start/retry/restart and throws a `binary_storage_unconfigured` conflict, which the SPA surfaces as an error prompt with a "Configure storage" jump to the content-storage settings.
