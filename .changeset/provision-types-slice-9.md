---
'@cat-factory/contracts': patch
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
  the legacy single-connection fallback are unchanged. The deploy job ref is DETERMINISTIC (run
  id + deployer kind + eviction epoch, via the new `deployer.logic.ts` helpers) so a Workflows
  replay re-attaches instead of dispatching a duplicate container; a status-read failure during
  the poll propagates to the driver (so its `jobPollFailureTolerance` fast-fail applies, matching
  `pollAgentJob`) rather than being swallowed; and a non-eviction terminal failure marks the
  deploy container `errored`.
- `CoreDependencies` threads `deployJobClient` + `resolveDeployCloneTarget` into
  `createEnvironmentsModule`'s provisioning service (optional). The facades wire them in slice 10,
  so both runtimes share the identical (unwired) behaviour for now — nothing dispatches a deploy
  job until slice 10's facade wiring + deploy-dispatch conformance lands.

Review fixes folded into the slice:

- On a successful async deploy, `completeDeployerStep` now re-projects the environment, so the
  deployer step's Environment panel shows the final `ready` env + URL instead of staying stuck on
  the dispatch-time `provisioning` snapshot.
- A terminal deploy job (done or a genuine failure) now releases its runner via
  `releaseProvisionJob`, so the one-shot deploy container is reclaimed instead of idling out its
  `sleepAfter` window / leaking a self-hosted pool slot (the agent path's `stopRunContainer`,
  run-id keyed + final-step only, never covered the separately dispatched deploy job).
- The `provisioning` env record `startProvision` writes after dispatch is now best-effort: a failed
  projection write no longer propagates (which the caller turns into a terminal, non-retried failure
  that would strand the live deploy container).
- The deployer step now PINS its resolved provisioning config (`PipelineStep.deployProvisioning`) at
  dispatch, so the poll/finalize maps the job against the config the container was built from rather
  than a fresh frame read a person may have edited mid-flight (e.g. flipping to `infraless`).
- The deploy container's terminal `errored` stamp now keys off the RESOLVED env status, so a `done`
  view the provider maps to a failed env (harness exited 0, namespace missing) no longer shows the
  container "up".
- The eviction-recovery + subtask-progress logic shared with `pollAgentJob` is extracted into
  `recoverContainerEviction` / `applySubtaskProgress`, so the eviction budgets, the "still
  evicting…" wording, and the progress-fraction math live in one place for both paths.
