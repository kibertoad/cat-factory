---
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/integrations': patch
'@cat-factory/workspaces': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Eliminate N+1 query loops in the service layer. `ExecutionService.teardownForBlockTree` now
resolves runs with a single `listByWorkspace` instead of a per-block `getByBlock`;
`TaskConnectionService.listSourceStates` hoists its installation/connection reads out of the
per-provider loop; and `BoardService` (`removeBlock` / `addServiceFromRepo`) and
`AccountService.listForUser` batch their per-item point reads via two new chunked-`IN`
repository methods, `ServiceRepository.listByFrameBlocks` and `AccountRepository.listByIds`
(implemented symmetrically on the D1 and Drizzle stores, with cross-runtime conformance
coverage). Behavior is unchanged.
