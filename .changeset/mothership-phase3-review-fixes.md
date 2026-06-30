---
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
---

Mothership Phase 3 review fixes:

- `ExecutionService.start` now clears a replaced block's prior per-run subscription activation
  best-effort (try/catch), mirroring the terminal cleanup in `RunStateMachine.emit`. In mothership
  mode `subscriptionActivationRepository` is remote and `deleteByExecution` is not yet allow-listed
  (it throws `unknown_method`), so the previously-unguarded call would break re-running any block;
  the TTL sweep reclaims the stale row as the backstop.
- The persistence RPC controller memoises the `block` / `serviceList` scope reads
  (`blockRepository.findById` / `serviceRepository.listByIds`) per request, so when the request
  also dispatches that same read it reuses the resolver's result instead of issuing a second
  identical query.
