---
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/workspaces': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Batch the shared-service read paths (remove N+1 queries) + fan-out and mount-UI polish.

Composing a board from the services it mounts fired one query **per mounted service** on
several hot paths. They now issue a single chunked `IN (…)` query instead:

- New batched repository ports `ExecutionRepository.listByServices`,
  `BootstrapJobRepository.listByServices`, `PipelineScheduleRepository.listByServices`
  (D1 + Drizzle), mirroring the existing `BlockRepository.listByServices`. Used by the
  workspace snapshot (executions), `BootstrapService.listJobs`, and
  `RecurringPipelineService.list`.
- Frame deletion now clears a doomed service's mounts off every board and deletes the
  services in two batched queries (`WorkspaceMountRepository.removeByServices` +
  `ServiceRepository.deleteMany`) instead of a `listByService` + per-mount/per-service loop.
- The real-time fan-out resolves its target workspaces in a **single join**
  (`WorkspaceMountRepository.listWorkspaceIdsMountingBlock`) rather than a `serviceIdOf`
  followed by a `listByService` on every event; `FanOutEventPublisher` no longer needs a
  block repository.
- Mounting a service from the toolbar now surfaces failures (e.g. cross-org) as a toast
  instead of silently swallowing the error, and new mounts lay out on a 5-wide grid instead
  of stacking on the diagonal.
- Every dynamically-built `IN (…)` D1 query now chunks through a single grounded constant
  (`D1_MAX_IN_PARAMS` / `chunkForIn`). Cloudflare D1 rejects a statement with more than 100
  bound parameters, so the previous 500-wide chunks were over the real ceiling, and the
  workspace snapshot's `countByServiceIds` (the org catalog's mount counts) didn't chunk at
  all — it threw `D1_ERROR: too many SQL variables` once an account owned enough services.
