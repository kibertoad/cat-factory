---
'@cat-factory/executor-harness': patch
'@cat-factory/orchestration': patch
'@cat-factory/integrations': patch
'@cat-factory/server': patch
'@cat-factory/agents': patch
'@cat-factory/cli': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/app': patch
---

Lint tightening: ratchet oxlint `complexity` from 40 to its step-2 target of 30.

Refactored every function above complexity 30 along cohesive, behaviour-neutral seams (helper
extractions / options-object bundles), including the god-file offenders: the Worker
`buildContainer` registry resolution → a `container-registries.ts` sibling, `RunDispatcher`'s
settled-poll branch tree → a new `PollCompletionController`, and `ExecutionService.stepInstance`'s
re-entrancy predicate → a `reentrancy.logic.ts` sibling (both of which also shrink their host
god-files). The executor-harness image tag is bumped (harness `src/**` changed).
