---
'@cat-factory/orchestration': patch
---

ExecutionService split (take 2), phase 6 (partial): drop three dead constructor fields
(`accountRepository`, `environmentTeardown`, `branchUpdater`) that became write-only after the
earlier collaborator extractions — each is now consumed only via its destructured constructor
param when wiring a sub-collaborator (`AgentContextBuilder` / `HumanTestController`), never
through `this.`. The constructor params (and so the public `ExecutionServiceDependencies` shape)
are unchanged. The substantial constructor trim still awaits the Phase 4 `RunDispatcher`
extraction.
