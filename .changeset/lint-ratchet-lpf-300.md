---
'@cat-factory/orchestration': patch
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
'@cat-factory/app': patch
---

Split every product function above 300 lines along cohesive, behaviour-neutral seams so the
`max-lines-per-function` ratchet reaches step 2 (400 → 300) and `max-lines` drops to its new floor
(2802 → 2648). The engine's `ExecutionService` constructor now composes its gate windows + review
subjects through sibling factories (`gate-window-controllers.ts`), `createCore` through
`container/engine-collaborators.ts` + `container/engine-dependent-modules.ts`, the Node composition
root through `container-core-deps.ts` + `container-foundation.ts`, the Worker's container assembly
through an in-file `buildWorkerCoreDependencies`, and six Pinia stores through per-group action
factories under `stores/{execution,auth,github,initiative,board,workspace}/`. No behaviour change.
