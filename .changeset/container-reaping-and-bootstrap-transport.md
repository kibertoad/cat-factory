---
'@cat-factory/worker': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': patch
---

Fill the per-run container reaping gaps and unify the bootstrap flow onto the
generic runner transport.

- **Reaping (worker):** add an instance-level container reaper backed by a small
  D1 registry (`live_containers`, migration `0022`). The Cloudflare transport now
  records each dispatched container and clears it on release through a single kill
  path (`ContainerInstanceRegistry`); a `*/2` cron pass (`reapStaleBefore`) SIGKILLs
  any container older than `CONTAINER_MAX_AGE_MINUTES` (default 90, clamped ≥75) via
  the existing `EXEC_CONTAINER` binding — no Cloudflare API token — and warn-logs
  each kill as a leak signal. Covers run/blueprint/bootstrap uniformly.
- **Per-path reclaim (orchestration):** the execution success (final step) and
  failure (`failRun`) paths, and the bootstrap success path, now reclaim their
  container explicitly instead of waiting out `sleepAfter`. Best-effort/idempotent;
  no-ops where no async container executor is wired.
- **Bootstrap on the transport (worker + kernel):** `ContainerRepoBootstrapper` is
  now a thin job-spec builder + result mapper that dispatches through the shared
  `RunnerTransport` seam (new `RunnerJobClient` collaborator) rather than talking to
  `EXEC_CONTAINER` directly — backend-polymorphic like the implementation executor.
  `RunnerDispatchKind` gains `'bootstrap'` and `RunnerJobResult` gains
  `defaultBranch`.
