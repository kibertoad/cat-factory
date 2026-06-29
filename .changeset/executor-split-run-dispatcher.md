---
'@cat-factory/orchestration': patch
---

Refactor (internal, no behaviour change): extract the execution engine's per-step
dispatch + completion spine out of `ExecutionService` into a new `RunDispatcher`
collaborator (the four registries, the completion hub, the gate machinery, the
deterministic deployer/tracker steps, the registered pre/post-op cluster, the
structured-artifact ingest, and the follow-up companion gate). `ExecutionService`
keeps the run-lifecycle preamble + run-control API and delegates; three now-dead
constructor fields are dropped. `ExecutionService.ts` drops from 4,620 to ~2,460
lines. Public API and wiring are unchanged, so the runtimes stay symmetric.
