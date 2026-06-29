---
"@cat-factory/orchestration": patch
---

Trim the `ExecutionService` constructor of its last two vestigial fields (the final Phase 6
cleanup of the engine split): `resolveRunRepoContext` (stored but never read — `RunDispatcher`
already takes it from the constructor param) and `runInitiatorScope` (read only to build
`RunDispatcher`, now a constructor-local). No behaviour change; the public
`ExecutionServiceDependencies` shape is unchanged.
