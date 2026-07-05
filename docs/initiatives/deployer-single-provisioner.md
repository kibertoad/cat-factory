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

| #    | Item                                                                                                                                                                | Where                                                                                                                                                                                         | Status                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| B2   | Resolve provider from the env RECORD's `provisionType`/`engine` (not workspace-primary) in teardown + refresh                                                       | `EnvironmentConnectionService.resolveProviderForRecord`; `EnvironmentTeardownService.teardownRecord`; `EnvironmentProvisioningService.refreshStatus`                                          | done                                                                       |
| B1   | Teardown-on-supersede with identity compare (best-effort; TTL backstop)                                                                                             | `environments.logic.ts` (`shouldTeardownSuperseded` + tests), `EnvironmentProvisioningService.supersedePriorEnvironment` (+ `environmentTeardown` dep, wired in `orchestration/container.ts`) | done                                                                       |
| E    | Clear `deploy*`/`container` in `resetStepForRerun` + add `rerunRange` for the loop-back                                                                             | `StepGraph`                                                                                                                                                                                   | done                                                                       |
| A1   | Type-aware deployer: provision only when there's an env (k8s/custom OR undeclared-with-legacy-connection); skip compose/infraless/undeclared-no-connection/frontend | `RunDispatcher.advanceDeployerFrames`, `EnvironmentProvisioningService.hasLegacyConnection`                                                                                                   | done                                                                       |
| A2   | Inject a single `deployer` before the first tester/human-test/playwright in 12 built-ins; version bumps                                                             | `kernel/src/domain/seed.ts`                                                                                                                                                                   | done                                                                       |
| A3   | Run-start guard: k8s/custom + consumer + no enabled deployer earlier ⇒ refuse (`deployer_required_before_tester`)                                                   | `tester-infra.logic.ts` (`needsDeployerBeforeConsumer` + tests), `ExecutionService.assertDeployerBeforeConsumer`, `contracts` `CONFLICT_REASONS`                                              | done                                                                       |
| HT   | human-test stops self-provisioning; reads Deployer env; recreate/fix-loop/pull-main loop back to Deployer                                                           | `HumanTestController`, `ExecutionService` (`readEnvironment` seam), `RunDispatcher` (poll delegations removed), `StepGraph.rerunRange`                                                        | done                                                                       |
| GATE | Named-step pipeline authoring (`definePipeline`) replacing index-aligned `gates`/`enabled` arrays                                                                   | `kernel/src/domain/seed.ts` (+ `seed.test.ts`)                                                                                                                                                | done                                                                       |
| FE   | `SYSTEM_AGENT_META['deployer']` + localized `deployer_required_before_tester` conflict (8 locales)                                                                  | `frontend .../catalog.ts`, `usePipelineErrorToast.ts`, `i18n/locales/*`                                                                                                                       | done                                                                       |
| CONF | Cross-runtime conformance for the injected deployer + human-test read/loop-back                                                                                     | `internal/conformance`                                                                                                                                                                        | traced-preserved (validated in CI — can't run workerd/Postgres on Windows) |
| CS   | Changeset for touched published packages                                                                                                                            | `.changeset/deployer-single-provisioner.md`                                                                                                                                                   | done                                                                       |

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
- **Env is ALWAYS ready when human-test is first reached** — the Deployer step only completes on a
  `ready` env (a primary-frame failure is terminal). So `begin` reads synchronously and parks; a
  not-ready/absent env (e.g. infraless/skip) degrades to manual mode. No provisioning-poll on
  human-test any more.
- **Deployer injection point:** after `mocker` (where present), before the first `tester-*` /
  `human-test` / `playwright`. `pipelineShape.ts` enforces only COMPANION adjacency, so this is
  safe; the deployer is not a companion and never splits a companion/producer pair.
- **`EnvironmentRecord` has no `manifestId`** — resolve-by-record keys on `(provisionType, engine)`
  with a legacy fallback; a workspace with two custom handlers of the same type/engine falls back
  to the primary (acceptable, pre-existing limitation).
- Keep the runtimes symmetric: no schema change here (no new columns/ports), so the change is pure
  service/engine + seed logic; conformance covers the shared behaviour.

## Deferred (not in this slice)

- **Disposer** operational step (workstream C) — palette-addable; TTL-only default (D-C5(i)).
- **TTL hardening** (workstream D): default `ENVIRONMENT_DEFAULT_TTL_MINUTES = 240`, mothership
  sweep verify, optional sweep lease.
- Async/container-backed teardown (namespace-DELETE suffices for the k8s adapter today).
