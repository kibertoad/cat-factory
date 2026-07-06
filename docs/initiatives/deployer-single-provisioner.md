# Deployer as the single environment provisioner (+ environment-lifecycle correctness)

## Goal & rationale

A local-mode run (pipeline **"Quick implement"** `pl_quick`, a `kubernetes` service) dead-ended at
the **`tester-api`** step with _"Ephemeral run mode selected but no environment coordinates/
credentials were provided and no instance of the service is reachable."_ Root cause: the tester's
**run mode** is chosen from `provisioning.type` (`kubernetes`/`custom` ⇒ ephemeral), but its
**coordinates** are rendered only when a provisioned env RECORD exists — and `pl_quick` has **no
`deployer` step**, so nothing ever provisioned one. A `kubernetes`/`custom` service run through a
deployer-less pipeline is a guaranteed dead-end at the tester.

The full design (grounded against source) lived in the root `PLAN-deployer-disposer-and-
environment-lifecycle.md`; this tracker supersedes it and records the **owner decisions** that
reshaped it:

- **The Deployer is the ONLY place environments are provisioned.** No agent/gate self-provisions.
  In particular the **`human-test` gate stops standing up its own env** — it consumes the env the
  Deployer provisioned.
- **Provision ONCE per run, shared across AI + human usage.** A single Deployer step before the
  first env-consumer provides the one env that the tester(s) AND the human-test gate use.
- **Redeploy = loop back to the Deployer.** When a human-test fixer pushes new commits (or the
  human hits "recreate" / pulls main), the gate re-runs the upstream Deployer step to rebuild the
  env, then re-enters and reads the fresh one — rather than provisioning itself.
- Disposal timing decision (deferred workstreams): **TTL-only + a palette-addable Disposer**,
  default TTL **240 min**. NOT implemented in this slice (see "Deferred").

## Intended end state

1. Every built-in tester/human-test pipeline runs a **type-aware `deployer`** before the first
   env-consumer: it provisions **only** `kubernetes`/`custom` and is a fast **skip** for
   `docker-compose`/`infraless`/undeclared/frontend frames (so uniform injection is safe).
2. A `kubernetes`/`custom` service whose enabled chain has a tester/human-test but **no enabled
   deployer earlier** is **refused at launch** with an actionable error (never the silent tester
   dead-end).
3. `human-test` never provisions; it reads the Deployer's env and loops back to the Deployer to
   rebuild it.
4. Environment records are cleaned up reliably on **deployer re-run/supersede** (identity-aware
   teardown) and torn down through the **correct per-type provider** (not the workspace-primary).

## Target pattern (reference implementations)

- **Type-aware deployer skip:** `advanceDeployerFrames` in
  `backend/packages/orchestration/src/modules/execution/RunDispatcher.ts` — provisions only when
  `next.provisioning?.type ∈ {kubernetes, custom}`; records `{status:'skipped'}` otherwise.
- **Loop-back-to-deployer:** `StepGraph.rerunRange` + `HumanTestController.loopBackToDeployer`,
  mirroring `CompanionController` (`loopCompanionProducer` → `{kind:'continue'}`).
- **Run-start guard:** `ExecutionService` start-only gate modelled on
  `PipelineService.assertObservabilityGatedStepAllowed` + the pure
  `missingDeployerBeforeConsumer` in `tester-infra.logic.ts`.
- **Identity-aware supersede teardown:** pure `shouldTeardownSuperseded` in
  `environments.logic.ts`, driven from `EnvironmentProvisioningService.supersedePriorEnvironment`.
- **Provider-by-record:** `EnvironmentConnectionService.resolveProviderForRecord`.

## Per-item status

| #    | Item                                                                                                                                                                                                                                          | Where                                                                                                                                                                                         | Status                                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| B2   | Resolve provider from the env RECORD's `provisionType`/`engine` (not workspace-primary) in teardown + refresh                                                                                                                                 | `EnvironmentConnectionService.resolveProviderForRecord`; `EnvironmentTeardownService.teardownRecord`; `EnvironmentProvisioningService.refreshStatus`                                          | done                                                                                                                           |
| B1   | Teardown-on-supersede with identity compare (best-effort; TTL backstop)                                                                                                                                                                       | `environments.logic.ts` (`shouldTeardownSuperseded` + tests), `EnvironmentProvisioningService.supersedePriorEnvironment` (+ `environmentTeardown` dep, wired in `orchestration/container.ts`) | done                                                                                                                           |
| E    | Clear `deploy*`/`container` in `resetStepForRerun` + add `rerunRange` for the loop-back                                                                                                                                                       | `StepGraph`                                                                                                                                                                                   | done                                                                                                                           |
| A1   | Type-aware deployer: provision when there's an env — `k8s`/`custom`, `docker-compose` WITH a resolvable compose handler, OR undeclared-with-legacy-connection; skip `infraless`/undeclared-no-connection/frontend/compose-with-no-handler-yet | `RunDispatcher.advanceDeployerFrames`, `EnvironmentProvisioningService.hasLegacyConnection`/`canProvision`                                                                                    | done (compose centralization COMPLETE — the shared-stacks wizard saves the compose handler; DinD fallback retired — see below) |
| A2   | Inject a single `deployer` before the first tester/human-test/playwright in 12 built-ins; version bumps                                                                                                                                       | `kernel/src/domain/seed.ts`                                                                                                                                                                   | done                                                                                                                           |
| A3   | Run-start guard: k8s/custom + consumer + no enabled deployer earlier ⇒ refuse (`deployer_required_before_tester`)                                                                                                                             | `tester-infra.logic.ts` (`needsDeployerBeforeConsumer` + tests), `ExecutionService.assertDeployerBeforeConsumer`, `contracts` `CONFLICT_REASONS`                                              | done                                                                                                                           |
| HT   | human-test stops self-provisioning; reads Deployer env; recreate/fix-loop/pull-main loop back to Deployer                                                                                                                                     | `HumanTestController`, `ExecutionService` (`readEnvironment` seam), `RunDispatcher` (poll delegations removed), `StepGraph.rerunRange`                                                        | done                                                                                                                           |
| GATE | Named-step pipeline authoring (`definePipeline`) replacing index-aligned `gates`/`enabled` arrays                                                                                                                                             | `kernel/src/domain/seed.ts` (+ `seed.test.ts`)                                                                                                                                                | done                                                                                                                           |
| FE   | `SYSTEM_AGENT_META['deployer']` + localized `deployer_required_before_tester` conflict (8 locales)                                                                                                                                            | `frontend .../catalog.ts`, `usePipelineErrorToast.ts`, `i18n/locales/*`                                                                                                                       | done                                                                                                                           |
| CONF | Cross-runtime conformance for the injected deployer + human-test read/loop-back                                                                                                                                                               | `internal/conformance`                                                                                                                                                                        | traced-preserved (validated in CI — can't run workerd/Postgres on Windows)                                                     |
| CS   | Changeset for touched published packages                                                                                                                                                                                                      | `.changeset/deployer-single-provisioner.md`                                                                                                                                                   | done                                                                                                                           |

Follow-up (spun out, not in this PR): **extensible custom-gate config** — see
[`extensible-custom-gate-config.md`](./extensible-custom-gate-config.md).

## Conventions & gotchas

- **`get`/`listExpired` filter `deleted_at IS NULL`.** Therefore teardown must run BEFORE the
  tombstone (a soft-deleted row is invisible to `EnvironmentTeardownService.teardown`'s `get`), and
  a FAILED teardown must leave the row live so the TTL reaper (`listExpired`) still retries it.
- **Identity compare degrades gracefully:** compare `(provisionType, engine)` always (known early),
  and `externalId` only when the new one is known (sync path / finalize). The async placeholder
  insert (`startProvision`, `externalId: null`) can't compare namespaces yet → conservative: DON'T
  teardown (same type/engine ⇒ deterministic overwrite-in-place; TTL backstops a rare async
  config-change leak). `infraless` flip / `supersedeForBlock` passes `next=null` ⇒ teardown.
  `persistFailedEnvironment` passes no `next` ⇒ tombstone-only (never tear down the prior on a
  FAILED new provision).
- **Env should be ready when human-test is first reached** — the Deployer step completes with the
  primary frame recorded `ready` (a primary-frame failure is terminal), so `begin` reads
  synchronously and parks; a not-ready/absent env (e.g. infraless/skip) degrades to manual mode. No
  provisioning-poll on human-test any more. **Caveat + fix (review finding):** the Deployer records
  the primary frame `ready` for ANY non-`failed` handle, so an async provider whose env is still
  `provisioning` at settle-time would leave a stale `provisioning` env RECORD that nothing re-polls
  once the step completes — which used to degrade human-test to manual mode against a stale
  snapshot. The `readEnvironment` seam (`ExecutionService`) now RECONCILES the live provider status
  (`refreshStatus`) whenever the stored record isn't `ready`, so a slow-but-now-ready env reads
  ready; an env still genuinely provisioning/failed degrades as before.
- **Deployer injection point:** after `mocker` (where present), before the first `tester-*` /
  `human-test` / `playwright`. `pipelineShape.ts` enforces only COMPANION adjacency, so this is
  safe; the deployer is not a companion and never splits a companion/producer pair.
- **`EnvironmentRecord` has no `manifestId`** — resolve-by-record keys on `(provisionType, engine)`
  with a legacy fallback; a workspace with two custom handlers of the same type/engine falls back
  to the primary (acceptable, pre-existing limitation).
- Keep the runtimes symmetric: no schema change here (no new columns/ports), so the change is pure
  service/engine + seed logic; conformance covers the shared behaviour.

## Docker-compose centralization (dependency on the shared-stacks wizard)

The north-star: the **Deployer provisions everything — service AND surrounding infra — so testers
just test against a pre-provisioned env**, with the provisioning logic centralized in one place.
The `stack-recipes-and-shared-stacks` initiative (landing in parallel on `main`) made
`docker-compose` a real provider (recipe execution + shared-stack attach + preflights), running
through `EnvironmentProvisioningService.startProvision`. The Tester already prefers a provisioned
env for ANY type (`server`'s `testerInfraSpec` → `environment: 'ephemeral'` whenever an `envUrl`
exists), so once the Deployer provisions the compose env the Tester targets it automatically.

**What this slice does:** `advanceDeployerFrames` routes `docker-compose` through the Deployer
**when a compose handler resolves** (`canProvision` → `resolveHandlerForType('docker-compose')`).
So a workspace that has configured a compose connection gets its per-PR compose stack provisioned by
the Deployer (single provisioner), and the Tester targets it.

**Final state — DONE (shared-stacks slice 7 landed the wizard).** The setup wizard's "save" step
registers the workspace's `docker-compose` `local-docker` handler (and writes the recipe onto the
frame), so a compose handler now resolves and the Deployer is the SOLE compose provisioner. The
in-container (DinD) fallback is retired:

1. `decideTesterInfra` (`tester-infra.logic.ts`): `docker-compose` is handler-based like
   `kubernetes`/`custom` — the `localTestInfraSupported`/`hasComposePath` inputs and the
   `limited-local`/`compose-unconfigured` reasons are gone.
2. `needsDeployerBeforeConsumer` + `ExecutionService.assertTesterInfraConfigured`'s `needsHandler`
   cover `docker-compose`, so a compose chain that reaches a tester/human-test with no resolvable
   handler is refused up-front (same fail-fast as k8s/custom).
3. The `local`/`composePath` branch in `server`'s `testerInfraSpec` is dropped — compose targets the
   Deployer-provisioned env (`environment: 'ephemeral'`).
4. The harness's in-container `docker compose up` (`executor-harness/src/agent.ts`, gated by the job
   body's `environment: 'local'`) is now unreachable and can be retired in a later image-bumping
   slice (the one remaining tail).

Breaking (pre-1.0, acceptable): a `docker-compose` service reaching a tester/human-test with no
configured compose handler is now refused at run start rather than falling back to a DinD bring-up.

## Post-merge review-findings addressed

Addressed in the same round as the `origin/main` merge (findings from a PR review of this branch):

- **Stale `provisioning` env degraded human-test** — `readEnvironment` now reconciles live status
  (see the "Env should be ready…" gotcha above).
- **Loop-back orphaned the prior env** — `HumanTestController.loopBackToDeployer` now tears the
  current env down (best-effort) BEFORE re-running the Deployer, so a non-deterministic (e.g.
  SHA-scoped) namespace isn't orphaned until the TTL reaper on every rebuild.
- **Non-actionable run-start error** — the `deployer_required_before_tester` message now leads with
  the doable remedy (reseed the built-in pipeline + start a new run, or set the service to
  docker-compose/infraless) rather than "add a Deployer step" (`deployer` is a `SYSTEM_AGENT_META`
  display kind, not a palette-addable archetype). Same message covers the retry/restart case (a
  pre-upgrade run whose stored steps predate the Deployer injection is refused on retry — intended
  fail-fast, resolved by starting a fresh run on the reseeded pipeline).
- **Duplicated backward step-scan** — the loop-back's "nearest preceding deployer" scan moved onto
  `StepGraph.nearestStepIndexBefore` (beside `rerunRange` / `companionProducerIndex`).

## Deferred (not in this slice)

- **Disposer** operational step (workstream C) — palette-addable; TTL-only default (D-C5(i)).
- **TTL hardening** (workstream D): default `ENVIRONMENT_DEFAULT_TTL_MINUTES = 240`, mothership
  sweep verify, optional sweep lease.
- Async/container-backed teardown (namespace-DELETE suffices for the k8s adapter today).
