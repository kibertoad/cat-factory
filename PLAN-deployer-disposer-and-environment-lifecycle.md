# Plan: deployer-in-pipelines + environment disposal (disposer / rerun-cleanup / TTL)

Status: **proposal / design plan.** No code changed. This document is the plan only.

## 0. Why this exists (the triggering failure)

A local-mode run (`exec_2a8027a7b7af4d53855bf6db`, pipeline **"Quick implement"** `pl_quick`,
task "Add CRUD endpoint for managing bees", PR #7 on `kibertoad/simpler-service3`) failed at the
**`tester-api`** step with _"Ephemeral run mode selected but no environment coordinates/credentials
were provided and no instance of the service is reachable."_

Root cause, confirmed against the source:

- The service frame `simpler-service3` declares `provisioning.type: "kubernetes"` (kustomize
  overlay `deployment/k8s/overlays/prenv`, ECR images tagged `{{branch}}`).
- The tester's **run mode** is chosen purely from `provisioning.type` — `kubernetes`/`custom`
  ⇒ `ephemeral` — in `testerInfraSpec` / `testerEnvironmentSection`
  (`packages/server/src/agents/prompts.ts:461-504`, `packages/agents/src/agents/prompts/testing.ts:184-196`).
  In ephemeral mode the tester **must not** stand the app up itself.
- The tester's **coordinates** (the "Ephemeral environment under test" URL/creds block,
  `packages/agents/src/agents/prompts/standard.ts:237-261`) are rendered **only when a provisioned
  environment record exists** for the block (`AgentContextBuilder.resolveEnvironment` →
  `resolveForBlock`, returns `null` on an empty registry).
- These two are **decoupled and keyed off different inputs.** `pl_quick` has **no `deployer`
  step** (nor does any of the 15 built-in pipelines), and there is no workspace environment
  handler wired, so **nothing ever provisioned an environment**: the `environments` table is
  empty, no `cf-env-*` namespace exists in the local k3s cluster. Result: run mode says
  "ephemeral", the coordinates block is empty, and the tester correctly aborts.
- Neither the start-time gate (`ExecutionService.assertTesterInfraConfigured` only checks a
  handler _could_ provision) nor `validatePipelineShape` (no deployer-ordering rule) caught it.

So: a `kubernetes`/`custom` service run through a **deployer-less** pipeline is a guaranteed
dead-end at the tester. Fixing that is workstream **A**. The user also asked about environment
**destruction** — after TTL, on deployer re-run, on pipeline completion, and via an explicit
**`disposer`** step for user-controlled timing. Those are workstreams **B–E**.

## 1. Goals / non-goals

**Goals**

1. A `kubernetes`/`custom` service tested (or human-tested) by a built-in pipeline gets an
   ephemeral environment provisioned **before** the tester runs — or fails fast with an
   actionable error instead of dead-ending inside the tester.
2. Environments are **destroyed reliably**: on deployer re-run/supersede, on TTL expiry (already
   partially works), and — optionally, under user control — at a chosen point in the pipeline via
   a new **`disposer`** step.
3. Injecting `deployer` into shared built-in pipelines is **safe for `docker-compose`/`infraless`
   services** (no behavior change for them).

**Non-goals**

- Making local k3s actually serve PREnvs (ingress controller, host `:80/:443` mapping, local
  image builds). That's local-environment setup, out of scope here; the wrapper repo's local mode
  should prefer `docker-compose`/`infraless` frames. This plan targets the upstream engine.
- The Kargo adapter itself (separate repo, blocked on a kernel release — see `docs/env-lifecycle.md`).
- Cyclic env dependencies (provider needing its consumer's URL) — explicitly out of scope upstream.

## 2. Current state (grounded in the source)

### 2.1 What already exists and works

- **`deployer` is a fully-wired operational StepHandler** (not an LLM agent):
  `DEPLOYER_AGENT_KIND='deployer'` / `isDeployStep` in
  `packages/integrations/src/modules/environments/environments.logic.ts:25,34`; registered in
  `RunDispatcher.buildStepHandlerRegistry` at `RunDispatcher.ts:2437-2443` (`order:100`,
  `canHandle: !!this.environmentProvisioning && isDeployStep(...)`). Fans out over the own frame +
  involved-service frames (`resolveDeployTargets` `RunDispatcher.ts:1522`), provisions each via
  `environmentProvisioning.startProvision` (`:1461`), sync or async container-backed
  (`image:'deploy'`) with `pollDeployerJob` (`:1670`). **When `environmentProvisioning` is not
  wired the step is a harmless generic pass-through.**
- **`EnvironmentProvider.teardown` exists** (`kernel/src/ports/environment-provider.ts:367`) and is
  implemented idempotently by every concrete provider: Kubernetes (namespace DELETE, 404/409
  tolerant), Compose (`safeDown` + `cleanupProject`), HTTP (runs the manifest `teardown:` template
  — **no-op if the manifest omits it**), EKS. `ProvisionedEnvironment.expiresAt` (`:179`) lets a
  provider return a TTL.
- **`EnvironmentTeardownService`** (`packages/integrations/src/modules/environments/EnvironmentTeardownService.ts`):
  `teardown(ws,id)` (one env + tombstone) and `sweepExpired(now)` (TTL sweep, best-effort,
  retry-next-pass).
- **A real TTL reaper.** `expires_at` is set at provision (`resolveExpiry`,
  `EnvironmentProvisioningService.ts:889`) and enforced by `listExpired`
  (`runtimes/node/src/repositories/environments.ts:291`) driven by a Node 2-min timer
  (`runtimes/node/src/environments.ts`, wired `server.ts:298`) and a Cloudflare 2-min cron
  (`runtimes/cloudflare/src/index.ts:474`). Local **non-mothership** inherits the Node timer;
  local **mothership** intentionally runs none (`runtimes/local/src/server.ts:139-144`).
- **On-demand teardown** (HTTP DELETE `EnvironmentController.ts:308`) and **human-test gate**
  teardown (`HumanTestController`, the _only_ in-run teardown today, on confirm/destroy/recreate).

### 2.2 The gaps

| #   | Gap                                                                                                                                                                                                                      | Evidence                                                                                      | Severity               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------- |
| G1  | **No `deployer` in any built-in pipeline.** 12 pipelines run a tester/human-test with no provisioning step.                                                                                                              | `kernel/src/domain/seed.ts` (all `pl_*`)                                                      | **the triggering bug** |
| G2  | **Re-provision/supersede orphans real infra.** `supersedePriorEnvironment` soft-deletes the registry row only; never calls `provider.teardown`. Relies on deterministic-namespace overwrite-in-place.                    | `EnvironmentProvisioningService.ts:874-880,926-946`; `RunDispatcher.ts:1440` (infraless path) | high                   |
| G3  | **No disposal tied to run lifecycle.** Run completion / `failRun` / retry never tear down a deployer-provisioned env. Envs with **null TTL** live forever.                                                               | `RunStateMachine.failRun:487-526`; `completeDeployerStep:1872`; retry `resetStep`             | high                   |
| G4  | **No `deployer`-before-`tester` enforcement.** Ordering is positional; a tester with no upstream deployer silently runs env-less, and can read a **stale prior-run** env (registry read is block-keyed, not run-keyed).  | `pipelineShape.ts:62-66`; `AgentContextBuilder.resolveEnvironment:805-812`                    | med                    |
| G5  | **Teardown resolves the wrong provider under per-type provisioning.** `teardownRecord`/`refreshStatus` use legacy `connectionService.resolveProvider(workspaceId)`, ignoring the row's stored `provision_type`/`engine`. | `EnvironmentTeardownService.ts:55-56`; `EnvironmentProvisioningService.ts:715`                | med                    |
| G6  | **No `disposer` kind** for explicit, user-timed teardown.                                                                                                                                                                | grep: none                                                                                    | feature                |
| G7  | **Local-mothership runs no TTL sweeper**; **HTTP provider teardown is a silent no-op** without a manifest `teardown:` block; **sweep has no lease** (double-invoke possible).                                            | `runtimes/local/src/server.ts:139-144`; `HttpEnvironmentProvider.ts:114-127`                  | low                    |
| G8  | `resetStep` (retry) vs `resetStepForRerun` (companion) diverge on `deploy*` fields.                                                                                                                                      | `retry.logic.ts:109-127` vs `StepGraph.ts:62-76`                                              | low/latent             |

## 3. Design

### Workstream A — `deployer` in every tester/human-test pipeline (fixes G1, G4)

**A1. Make the deployer type-aware (prerequisite — do this first).**
Today `advanceDeployerFrames` skips only `infraless` and provisions everything else, _including
`docker-compose`_. If we inject `deployer` into shared pipelines as-is, a `docker-compose` service
would get a provisioned compose env, whose URL then flips the tester from **local** mode (stand
compose up _in-container_, the current behavior) to **ephemeral** — an unintended behavior change.

→ Extend the skip in `advanceDeployerFrames` (`RunDispatcher.ts:1439`) so the deployer **acts only
for `kubernetes` and `custom`**, and records `{status:'skipped'}` for `docker-compose` **and**
`infraless`. Net effect: the deployer becomes a **no-harm prefix** — it provisions exactly the
types that need an externally-reachable env, and is a fast no-op for the types whose tester
self-provisions locally. This makes uniform injection into all 12 pipelines safe.

> Decision point D-A1: _Should the deployer ever provision `docker-compose`?_ Recommendation:
> **no, by default** (preserve in-container local-mode testing; avoids double bring-up). If a
> reachable compose env is ever wanted (e.g. sharing a URL for manual poking), that should be an
> explicit per-frame opt-in, not the default.

**A2. Inject `'deployer'` into the 12 tester/human-test pipelines** in `kernel/src/domain/seed.ts`,
placed **after `mocker`** (where present) and **before the first `tester-*` / `human-test`** step:

`pl_full`, `pl_fullstack`, `pl_quick`, `pl_simple`, `pl_integrate`, `pl_human_review`,
`pl_pr_review`, `pl_visual`, `pl_frontend`, `pl_dep_update`, `pl_tech_debt`, `pl_bug_triage`.

- **Parallel-array alignment:** `pl_full` (`gates`@194,`enabled`@215), `pl_fullstack`
  (`gates`@292,`enabled`@316), `pl_bug_triage` (`gates`@547) hand-author these index-aligned
  arrays — insert a matching element (`gate=false`, `enabled=true`) at the deployer's index. The
  other 9 have no such arrays → plain element insert.
- **Bump each touched built-in's `version`** (default is 1; e.g. `pl_full`→`version:2`) so
  persisted workspace copies get the reseed offer (convention at `seed.ts:658-660`; precedent
  `pl_initiative` `version:2`, `pl_document` `version:3`).
- **Frontend:** add `SYSTEM_AGENT_META['deployer']` in `frontend/app/app/utils/catalog.ts:333`
  (label/icon/color/description) — otherwise it renders as a generic gray "Agent".

**A3. Run-start guard (defense-in-depth, the actionable-error fix for G4).**
Because the deployer self-skips compose/infraless (A1), the deployer is normally always present;
but users can build custom pipelines or disable the step. Add a **dynamic per-run check** — the
static `pipelineShape.ts` validator can't see the service type, so a purely-static rule would
over-constrain compose/infraless. Model it on the existing capability gate
`PipelineService.assertObservabilityGatedStepAllowed` (`PipelineService.ts:82-97`), evaluated at
`ExecutionService.start` next to `assertPipelineLaunchable` (`ExecutionService.ts:1394`):

> If the block's service `provisioning.type ∈ {kubernetes, custom}` **and** the enabled chain
> contains a `tester-api`/`tester-ui`/`playwright`/`human-test` step with **no enabled `deployer`
> earlier**, reject the run start with a clear message ("this service provisions a kubernetes
> environment; add a Deployer step before the Tester, or set the service to docker-compose /
> infraless").

This turns today's silent dead-end-inside-the-tester into a fail-fast at launch. It also closes
the **stale-env footgun**: a kubernetes service can no longer run a deployer-less pipeline and pick
up a prior run's registry row.

### Workstream B — tear down on deployer re-run / supersede (fixes G2, G5)

**B1. Teardown-on-supersede with identity comparison.** In the supersede path
(`supersedePriorEnvironment`, reached from `recordProvisioned` and the `infraless` flip), before
soft-deleting the prior live row, compare the **provider identity** of old vs new
(`(provision_type/engine, externalId/namespace)`):

- **Same identity** (deterministic namespace, same provider) → in-place overwrite; keep the current
  tombstone-only behavior (tearing down then re-applying the same namespace would churn/race).
- **Different identity** (config changed → different namespace, or provider/type changed, or the
  `infraless` flip where nothing replaces it) → enqueue the superseded row to
  `EnvironmentTeardownService.teardown` (**best-effort, async, non-blocking** — a teardown failure
  must not fail the new provision; the TTL reaper remains the backstop).

This is the single highest-value disposal fix: it stops orphaning namespaces/projects/PREnvs on
config changes and on the `infraless` flip, without destabilizing the common overwrite-in-place case.

**B2. Resolve the provider by the record's stored type/engine (G5).** `teardownRecord`
(`EnvironmentTeardownService.ts:55`) and `refreshStatus` (`EnvironmentProvisioningService.ts:715`)
must resolve the provider from the row's persisted `provision_type`/`engine` (the same per-type
resolution `startProvision` uses), not the legacy workspace-wide `resolveProvider`. Otherwise a
workspace with multiple per-type handlers tears down through the wrong provider (or fails to
resolve). Required for B1 and the disposer to be correct.

### Workstream C — the `disposer` operational step (fixes G6; the user's "control" ask)

A new **non-LLM operational step**, built exactly like `deployer` (no `AgentKindRegistry`/`roles.ts`
entry). It lets users decide **when** an env is destroyed — e.g. run `tester-api` (automated) →
`human-test` (manual) → **`disposer`** at the very end, so the env survives for manual testing and
is torn down only after everyone's done.

**C1. Kind + predicate.** `DISPOSER_AGENT_KIND='disposer'` + `isDisposeStep` in
`environments.logic.ts` (mirror `:25/:34`); export from `integrations/src/index.ts`.

**C2. StepHandler.** Add to `RunDispatcher.buildStepHandlerRegistry` near the deployer entry
(`order` ~105), `canHandle: !!this.environmentTeardown && isDisposeStep(step.agentKind)`. `handle`:
resolve the run/block's env record(s) for the own frame + involved frames
(reuse `resolveDeployTargets`' frame set), call `environmentTeardown.teardown(...)` per frame
(via the per-type provider from B2), then `recordStepResult`. Thread `EnvironmentTeardownService`
into `RunDispatcherDeps` (it currently lives on `ExecutionService`).

**C3. Failure semantics — best-effort, never fail a shipped PR.** A disposer runs late (often after
`merger`); a teardown hiccup must **not** flip a merged pipeline to failed. Record a **warning**
result on teardown failure and let the TTL reaper (D) catch the leftover. (Contrast the deployer,
whose primary-frame failure is terminal — provisioning is a prerequisite, disposal is cleanup.)

**C4. Presentation + classification.** `step-surface.test.ts:21` — add `'disposer'` to the
"not inline model step" list. `frontend/app/app/utils/catalog.ts` — `SYSTEM_AGENT_META['disposer']`
(system-meta only; not palette-addable unless we want users dragging it in — recommend
palette-addable with `category:'test'`/an ops category so users can place it themselves, matching
the "control" ask). Optional `pipelineRender.ts` special case.

**C5. Where it goes in built-ins (decision D-C5).** Three options for the _default_ disposal timing:

- **(i) No disposer in built-ins; TTL only.** Envs auto-expire; users add a disposer if they want
  deterministic teardown. Simplest; relies on D2 default-TTL.
- **(ii) Terminal `disposer` appended after `merger`** in the tester/human-test pipelines. Clean
  mirror of the leading deployer; deterministic teardown right after ship. But removes the
  "inspect the env after merge" affordance unless disabled.
- **(iii) Opt-in via a pipeline-level flag** ("auto-dispose on completion") that the engine honors
  at run completion, independent of a visible step.

Recommendation: **(i) + make the disposer palette-addable**, backed by the D2 default TTL as the
always-on safety net. This gives users full control (drop a disposer exactly where they want the
teardown to happen) without silently destroying envs people may still want to look at, and without
a second hidden code path. Revisit (ii) for specific pipelines if users ask for auto-teardown.

> Async teardown note: teardown is **synchronous in-Worker** today (no `asyncTeardown` analogue to
> `asyncProvision`). A namespace `DELETE` is fine synchronously; a kustomize/helm _uninstall_ that
> needs a deploy container is **not modeled**. If we later need container-backed teardown, add an
> `asyncTeardown` capability + a `pollDisposerJob` branch mirroring `pollDeployerJob`. Out of scope
> for the first cut (namespace-delete covers the k8s adapter).

### Workstream D — TTL as the safety net (hardens G3, G7)

The reaper already works; two hardening items make it a reliable backstop under the disposer model:

**D1. Guarantee a TTL is always set.** `resolveExpiry` returns `null` when neither the provider nor
the manifest supplies one → that env is **never swept**. Apply a **deployment-wide default TTL**
(config, e.g. `ENVIRONMENT_DEFAULT_TTL_MINUTES`) as the final fallback in `resolveExpiry` so no env
is immortal. (Kargo already caps `online_until` at +4h — keep the default at or below provider
caps; the wrapper's `KARGO_DEFAULT_TTL_MINUTES` is advisory.)

**D2. Local-mothership sweeper.** Document that local-mothership relies on the remote mothership's
cron (`runtimes/local/src/server.ts:139-144`); standalone local mode gets the Node timer. If
standalone-local users need TTL enforcement offline, that's already covered — no change. For
mothership, ensure its cron actually calls `sweepExpired` (verify wiring).

**D3. (Optional) Sweep lease.** Add a short claim/lease on a row before `provider.teardown` so a
concurrent Node-timer + CF-cron (or multi-node) don't double-invoke teardown. Providers are mostly
idempotent, so this is low priority.

### Workstream E — small correctness cleanups (G8)

Align `StepGraph.resetStepForRerun` (`StepGraph.ts:62-76`) to clear the `deploy*` fields like
`retry.logic.ts:resetStep` does, so a deployer that ever lands in a companion-rework range
re-provisions instead of skip-to-complete on stale `deployEnvs`. Latent today (deployers aren't
companion producers); cheap to fix while here.

## 4. Answers to the specific questions raised

- **"Include deployer in all pipelines with a Tester (or human testing)."** → Workstream A: 12
  pipelines, inserted before the first tester/human-test, **plus** make the deployer type-aware
  (A1) so it's a safe no-op for `docker-compose`/`infraless`, **plus** a fail-fast run-start guard
  (A3).
- **"Dispose environment after a certain TTL automatically."** → **Already exists** (2-min reaper on
  `expires_at`). Hardening: guarantee a default TTL so nothing is immortal (D1).
- **"Clean up if the deployer is re-run."** → Workstream B1: this is the top _real_ disposal gap
  today — supersede only tombstones the DB row. Fix = teardown the superseded env when its provider
  identity differs from the new one (best-effort; TTL backstop).
- **"After the entire pipeline has completed, I assume?"** → Recommended **not** as an always-on
  auto-teardown (people often want to inspect a merged env). Instead: explicit **`disposer`** step
  where the user wants it (C), with TTL as the guaranteed backstop (D). An opt-in
  "auto-dispose on completion" flag is available as decision D-C5(iii) if desired.
- **"Maybe a `Disposer` agent placed in the pipeline, so users control automated + manual testing
  then dispose."** → Exactly Workstream C. This is the right primitive; make it palette-addable so
  users drop it after the last consumer (e.g. after `human-test`).

## 5. Sequencing

1. **Phase 0 — correctness, no UX change:** B2 (provider-by-record) → B1 (teardown-on-supersede) →
   E (reset alignment). Stops infra leaks immediately.
2. **Phase 1 — fail-fast:** A3 run-start guard. Turns the dead-end tester into an actionable launch
   error even before pipelines change.
3. **Phase 2 — provisioning in built-ins:** A1 (type-aware deployer) → A2 (inject into 12 pipelines,
   version bumps, frontend meta). Now kubernetes/custom services actually get an env.
4. **Phase 3 — explicit disposal:** C (disposer kind, StepHandler, palette + meta).
5. **Phase 4 — backstop hardening:** D1 default TTL, D2/D3 as needed.

Phases 0–1 are independently shippable and already de-risk the reported failure.

## 6. Files to touch (consolidated)

**Backend**

- `packages/kernel/src/domain/seed.ts` — inject `deployer` into 12 pipelines; version bumps (A2).
- `packages/orchestration/src/modules/execution/RunDispatcher.ts` — type-aware skip in
  `advanceDeployerFrames` (A1); disposer StepHandler + optional `pollDisposerJob` (C2); thread
  `environmentTeardown` into `RunDispatcherDeps`.
- `packages/orchestration/src/modules/execution/ExecutionService.ts` — run-start deployer guard
  near `:1394` (A3); wire teardown into the dispatcher.
- `packages/orchestration/src/modules/pipelines/PipelineService.ts` — (optional) save-time
  `assertDeployerBeforeTester`-style capability check, modeled on `assertObservabilityGatedStepAllowed`.
- `packages/integrations/src/modules/environments/environments.logic.ts` — `DISPOSER_AGENT_KIND` +
  `isDisposeStep` (C1); export in `integrations/src/index.ts`.
- `packages/integrations/src/modules/environments/EnvironmentProvisioningService.ts` — teardown-on-
  supersede with identity compare (B1); provider-by-record in `refreshStatus` (B2); default-TTL
  fallback in `resolveExpiry` (D1).
- `packages/integrations/src/modules/environments/EnvironmentTeardownService.ts` — provider-by-record
  in `teardownRecord` (B2); optional sweep lease (D3).
- `packages/agents/src/agents/kinds/step-surface.test.ts` — add `'disposer'` to not-inline list (C4).
- `packages/orchestration/src/modules/execution/StepGraph.ts` — clear `deploy*` in
  `resetStepForRerun` (E).

**Frontend**

- `frontend/app/app/utils/catalog.ts` — `SYSTEM_AGENT_META['deployer']` (A2) and
  `SYSTEM_AGENT_META['disposer']` (+ optional `AGENT_ARCHETYPES` entry to make disposer
  palette-addable) (C4).
- `frontend/app/app/utils/pipelineRender.ts` — optional deployer/disposer render cases.

**Config / runtime**

- Deployment-wide `ENVIRONMENT_DEFAULT_TTL_MINUTES` (D1); verify mothership sweep wiring (D2).

## 7. Testing

- **Unit:** `advanceDeployerFrames` skips compose/infraless, provisions k8s/custom (A1);
  supersede teardown fires only on identity change (B1); provider resolved by record type (B2);
  run-start guard rejects the exact `pl_quick`+kubernetes shape and passes compose/infraless (A3);
  disposer handler tears down + is best-effort on failure (C3); `resolveExpiry` default TTL (D1).
- **Shape/pipeline:** `pipelineShape.test.ts`; updated built-in chains in
  `internal/conformance/src/suite.ts`; `frontend/.../catalog.spec.ts`.
- **End-to-end (the actual repro):** re-run "Quick implement" on a `kubernetes` service — expect
  either (a) with a deployer present, an env is provisioned and the tester gets coordinates, or
  (b) without one, a fail-fast launch error naming the missing deployer — never the silent
  ephemeral-with-no-coordinates dead-end. Then re-run the deployer with a changed manifest and
  confirm the superseded namespace is torn down; let an env pass its TTL and confirm the reaper
  removes it.

## 8. Open decisions (need a call before implementing)

- **D-A1:** Deployer skips `docker-compose` by default? (recommended: yes.)
- **D-C5:** Default disposal timing — TTL-only + palette disposer (recommended), terminal disposer
  in built-ins, or an opt-in auto-dispose-on-completion flag?
- **Default TTL value** for D1 (and its relationship to provider caps, e.g. Kargo's +4h).
- **Async/container-backed teardown** — needed now, or is namespace-DELETE sufficient for the k8s
  adapter (recommended: defer)?
- **Disposer palette-addable vs system-only** — recommended palette-addable to honor the
  user-control ask.

## 9. References (source anchors)

- Tester run-mode vs coordinates decoupling: `packages/server/src/agents/prompts.ts:461-504`;
  `packages/agents/src/agents/prompts/testing.ts:36-61,184-196`;
  `packages/agents/src/agents/prompts/standard.ts:237-261`;
  `.../execution/AgentContextBuilder.ts:394-416,805-812`.
- Deployer step: `.../execution/RunDispatcher.ts:1387-1505,1522-1575,1583-1661,1670-1795,1872-1971,2437-2443,590-591`;
  `deployer.logic.ts`; `environments.logic.ts:25-36`.
- Teardown / TTL: `kernel/src/ports/environment-provider.ts:140-145,179,367`;
  `EnvironmentTeardownService.ts`; `EnvironmentProvisioningService.ts:874-946,889-897`;
  `runtimes/node/src/repositories/environments.ts:291`; `runtimes/node/src/environments.ts`;
  `runtimes/cloudflare/src/index.ts:474`; `runtimes/local/src/server.ts:139-144`.
- Pipelines / kinds / dispatch: `kernel/src/domain/seed.ts`;
  `packages/contracts/src/entities.ts:552-663`, `primitives.ts:236-238` (open-string `AgentKind`),
  `environments.ts:190-196` (`ProvisionType`); `pipelineShape.ts:62-206`;
  `PipelineService.ts:82-97`; `.../execution/step-handler-registry.ts`;
  `RunDispatcher.ts:2417-2656`; `frontend/app/app/utils/catalog.ts:333-571`.
- Related existing docs: `docs/env-lifecycle.md` (repo-config validate/bootstrap/repair —
  different subsystem), `docs/per-service-provisioning.md`, `docs/native-environment-adapter.md`.
