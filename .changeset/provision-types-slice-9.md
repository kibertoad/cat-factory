---
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
---

Per-service provision types (Phase 2, slice 9): the async, container-backed deployer lifecycle.
A `deployer` step can now stand an environment up in a deploy container (real
`kubectl`/`kustomize`/`helm`) — dispatch the job, park the run, poll it, and finalize the
outcome — instead of only the synchronous in-Worker REST path. The synchronous raw-manifest
path is unchanged.

- `EnvironmentProvisioningService` gains the async lifecycle alongside `provision()`:
  `startProvision(args, ref)` resolves the provider and either provisions SYNCHRONOUSLY (raw
  manifests — returns a final `completed` handle) or, when the provider's
  `asyncProvision.buildProvisionJob` returns a job, DISPATCHES a `deploy`-kind job and persists
  a `provisioning` env record (so run details show the env spinning up), returning `dispatched`
  with the job ref. `pollProvisionJob` polls the deploy job's view; `finalizeProvision` maps a
  terminal view into the env record (a `failed` view → a `failed` env carrying the harness
  error); `releaseProvisionJob` reclaims the runner. Two new optional deps wire the transport:
  `deployJobClient` (the facade's `RunnerJobClient`, typed structurally so integrations stays
  runtime-neutral) and `resolveDeployCloneTarget` (the VCS-specific manifests-repo clone URL +
  ref + short-lived token). Unwired ⇒ a render-needing config fails loudly; the synchronous path
  is unaffected. The shared `provision()` internals (`resolveProvision` /
  `buildProvisionRequest` / `provisionSync` / `recordProvisioned` / `captureProvisionFailure`)
  were extracted so the sync and async paths can't drift.
- `RunDispatcher.runDeployerStep` now dispatches via `startProvision` and parks on `awaiting_job`
  for an async deploy job (re-attaching on replay via `step.jobId`); a new `pollDeployerJob`
  branch in `pollAgentJob` drives the deploy poll — surfacing live container/subtask progress,
  recovering a container eviction by re-dispatching a fresh deploy job within the same budgets as
  the agent path, and finalizing a terminal view into the step result. The infraless no-op and
  the legacy single-connection fallback are unchanged.
- `CoreDependencies` threads `deployJobClient` + `resolveDeployCloneTarget` into
  `createEnvironmentsModule`'s provisioning service (optional). The facades wire them in slice 10,
  so both runtimes share the identical (unwired) behaviour for now — nothing dispatches a deploy
  job until slice 10's facade wiring + deploy-dispatch conformance lands.
