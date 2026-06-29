# @cat-factory/orchestration

## 0.42.0

### Minor Changes

- 48a3df6: Surface the per-run container's live lifecycle in a container agent's details, and bring
  the API Tester window to parity with the Coder.

  Previously a container-backed step showed a "Spinning up container…" badge that simply
  **vanished** once the container was up, leaving a blank "working" state — you couldn't tell
  whether the agent was still preparing the checkout or already making model calls, and there
  was no way to see which container the run was on or whether it was up / errored / gone.

  - **Live phase.** The executor-harness now exposes its current lifecycle phase
    (`starting` → `clone` → `agent` → `push`) on the running job view — the same marker that
    already drove the stuck-run breadcrumb. The engine threads it through
    (`RunnerJobView` / `AgentJobUpdate`) onto the step so the details show WHAT the container
    is doing: "Preparing workspace" vs "Agent running" vs "Pushing changes".
  - **Container identity + address.** The transport now attaches the container's id (the
    Cloudflare Durable Object id; the local Docker container id) and, where one exists, its
    reachable URL (the local host URL) — so a run's details name WHERE it runs.
  - **Explicit lifecycle status.** Steps carry a `container` projection
    (`starting` / `up` / `errored`, with `destroyed` derived once the run's container is
    reclaimed), so the details say whether the container is spinning up, running, errored, or
    gone — instead of inferring it from a run-level failure.
  - **API Tester parity.** The Tester result window now reuses the same observability the
    Coder's step detail shows — the container lifecycle (status / phase / id / url), the
    ephemeral environment status, and the run's infrastructure attempts + logs — alongside its
    test report, instead of the report alone. The Tester (and the human-test / visual-confirm
    gate helpers) now surface the cold-boot `starting` window before the agent comes up, like
    the Coder, rather than jumping straight to "running".
  - **The legacy `startingContainer` boolean is removed** in favour of the richer `container`
    projection everywhere (no dual-signal path): every container-backed step — including the
    gate helpers — now reports its lifecycle through `container`. (Stale persisted steps simply
    drop the field; backwards compatibility is a non-goal.)

  Bumps the `@cat-factory/executor-harness` image to `1.24.0` (and the matching tag in
  `deploy/backend`).

- 48a3df6: Fix the Tester→Fixer loop, make fixer runs inspectable, and let the Tester abort a run.

  Three related issues in the API/UI Tester flow:

  - **The Tester never actually re-ran after a Fixer round, so the step was marked "done"
    regardless of the outcome.** The harness keys each job by `run + agentKind` and re-attaches
    to an existing entry rather than re-running (replay idempotency). A container-reusing
    transport (a warm local pool / a self-hosted runner pool) keeps that registry alive across
    rounds — reclaiming a pooled member does NOT destroy it — so a re-dispatched Tester
    re-attached to its FIRST round's completed job and silently replayed the stale report. Each
    re-dispatch within a run now carries a per-round **dispatch epoch** folded into the harness
    job id (`AgentRunContext.dispatchEpoch`), so the re-test always runs anew. Also covers the
    CI/conflicts gate fixer loops, which share the same re-dispatch shape. Defensively, a report
    with any failed outcome can no longer be greenlit (a failed check is treated as a blocker).
    The conformance suite now models a pooled container so the loop is exercised faithfully.

  - **Fixer companion runs were opaque.** A Tester step now keeps an append-only `attemptLog`
    of its fixer rounds (what each round was handed + how it ended), rendered as an inspectable
    timeline in the test report window instead of only a bare "N/M fix" count.

  - **The Tester can now ABORT a run instead of looping the fixer.** When the change cannot be
    meaningfully tested — its ephemeral environment never came up, a required dependency is
    missing — the Tester sets `abort: { reason }` on its report (or the engine auto-aborts when
    the step's ephemeral environment is in a `failed` state). The run stops, the block is left
    blocked (retryable), and a human-actionable notification is raised — the fixer is NOT
    dispatched, since it cannot provision infrastructure.

  This is a breaking change to the persisted Tester step state and the test-report wire shape
  (new `attemptLog` / `abort` fields); per the project's pre-1.0 policy, stale in-flight runs
  may simply break rather than migrate.

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0
  - @cat-factory/contracts@0.53.0
  - @cat-factory/agents@0.22.0
  - @cat-factory/integrations@0.35.3
  - @cat-factory/sandbox@0.8.41
  - @cat-factory/spend@0.10.33
  - @cat-factory/workspaces@0.9.24
  - @cat-factory/prompt-fragments@0.9.5

## 0.41.4

### Patch Changes

- Updated dependencies [614e985]
  - @cat-factory/integrations@0.35.2

## 0.41.3

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/contracts@0.52.0
  - @cat-factory/agents@0.21.17
  - @cat-factory/integrations@0.35.1
  - @cat-factory/kernel@0.53.1
  - @cat-factory/prompt-fragments@0.9.4
  - @cat-factory/sandbox@0.8.40
  - @cat-factory/spend@0.10.32
  - @cat-factory/workspaces@0.9.23

## 0.41.2

### Patch Changes

- 69558f9: Add a Kubernetes-based ephemeral-environment provider, selected per workspace through an
  env-backend registry that mirrors the runner-pool backends.

  The ephemeral-environment connection is now discriminated by a `kind` field (`manifest` =
  the generic BYO HTTP management API, `kubernetes` = native per-PR namespaces), resolved
  through a `registerEnvironmentBackend` provider-registry seam — so a native backend is a
  single registry entry + a config variant + a UI form, with no new table/service/controller.

  The Kubernetes backend applies an operator-authored set of k3s/Kubernetes manifests into a
  per-PR namespace over the kube-apiserver (server-side apply), reusing the Kubernetes runner
  backend's shared apiserver client (Bearer ServiceAccount token + custom-CA TLS). Manifests
  are read checkout-free from either the PR repo (co-located) or a separate repo; the URL is
  derived from an ingress host template or read back from an applied Service/Ingress
  LoadBalancer (k3s Traefik / ServiceLB). It is wired symmetrically into the Cloudflare and
  Node facades (the Worker rejects a custom-CA config it can't honor), and local mode can
  point at a developer-run local k3s (its env URL-safety policy is widened to loopback/LAN).
  See `backend/docs/local-k3s-environments.md`.

  BREAKING (pre-1.0):

  - The `environments/connection` register/test wire shape now takes a discriminated `config`
    instead of a bare `manifest`, and the `environment_connections` table gains a `kind`
    column (existing rows backfill to `manifest`).
  - The `EnvironmentProvider` provision request gains optional `runRepo` / `resolveRepoFiles`
    seams (additive).
  - The deployment-wide environment-provider injection option
    (`buildNodeContainer({ environmentProvider })` / `startLocal({ environmentProvider })`) is
    removed — native adapters register via `registerEnvironmentBackend` instead.

- Updated dependencies [69558f9]
  - @cat-factory/contracts@0.51.0
  - @cat-factory/kernel@0.53.0
  - @cat-factory/integrations@0.35.0
  - @cat-factory/agents@0.21.16
  - @cat-factory/prompt-fragments@0.9.3
  - @cat-factory/sandbox@0.8.39
  - @cat-factory/spend@0.10.31
  - @cat-factory/workspaces@0.9.22

## 0.41.1

### Patch Changes

- 29d8b5d: Harness error handling & observability: structured failure cause, stuck-run diagnosis, and transient API retry.

  - **Structured failure cause.** The executor-harness now reports a structured `failureCause`
    (`inactivity-timeout` | `max-duration` | `agent` | `git` | `api` | `no-usable-output` |
    `no-changes`) and an extended `detail` on a failed job view, alongside the existing one-line
    `error`. The backend prefers the structured cause to classify a failure (→ `AgentFailureKind`
    / `BootstrapFailureKind`) and falls back to the existing error-string regex when it's absent
    (older image, or a manifest pool that doesn't map the cause), so the change is backward
    compatible. The fallback now matches the bootstrap path's regex on BOTH the agent and
    bootstrap paths (a watchdog timeout classifies as `timeout`, not a generic `agent`). A `git`
    operation or an upstream `api` call that fails carries its real cause rather than `agent`.
    The Node/self-hosted runner pool forwards the structured cause/detail too (new optional
    `failureCausePath`/`detailPath` on the pool response manifest), so it isn't Cloudflare-only.
    Container eviction stays facade-detected (the harness never emits the eviction marker). The
    watchdog phrases are centralized so they can't drift from the regex that still reads them.
  - **Stuck-run diagnosis.** An inactivity kill now reports which phase was hung and the last tool
    that ran (e.g. "...likely hung in agent phase; last tool bash 40s ago"), with a per-phase
    timing breakdown in `detail` and on the failure log. A per-job child logger binds the run's
    correlation fields (jobId/repo/branch/kind) onto every line.
  - **Transient API retry.** Opening a PR/MR now retries a transient upstream failure (5xx / 429 /
    network) with bounded, abort-aware exponential backoff (honoring `Retry-After`), so a momentary
    blip no longer fails an otherwise-complete run. The 422/409 "already exists" success paths are
    unaffected.
  - **Surfaced silent degradation.** Checkpoint-push failures, dropped follow-up lines, malformed
    Pi JSONL records, and SIGKILL escalation are now logged at warn with counts instead of being
    swallowed. A final non-newline-terminated Pi event is flushed so its progress/span isn't lost.

  Bumps the `@cat-factory/executor-harness` image to `1.22.0` (and the matching tag in
  `deploy/backend`).

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/contracts@0.50.1
  - @cat-factory/integrations@0.34.1
  - @cat-factory/agents@0.21.15
  - @cat-factory/sandbox@0.8.38
  - @cat-factory/spend@0.10.30
  - @cat-factory/workspaces@0.9.21
  - @cat-factory/prompt-fragments@0.9.2

## 0.41.0

### Minor Changes

- 40f687d: Surface container/environment spin-up breakages on the agent step instead of hanging or hiding them.

  - **Local Docker mode fails fast.** `LocalContainerRunnerTransport` now aborts the
    container start the moment the container has exited (or a CLI call fails) instead of
    spinning for the full ready timeout, and the thrown error carries the real Docker
    stderr plus a tail of the container's own logs — so a broken daemon / failed image
    pull / crashing entrypoint shows the root cause in the step's failure card and the
    provisioning-logs drawer within one poll rather than ~60s of "spinning up container".
    Adds a `logs()` method to the `ContainerRuntimeAdapter` seam (Docker + Apple adapters).

  - **Kubernetes runner fails fast on doomed pods.** `KubernetesRunnerTransport` now
    detects terminal container start-up reasons (`ImagePullBackOff`/`ErrImagePull`/
    `InvalidImageName`/`CreateContainerConfigError`/`CrashLoopBackOff`/…) and aborts the
    readiness wait immediately with the pod's real `reason: message` as a hard `dispatch`
    failure — instead of polling the full 120s and then mis-tagging a deterministic failure
    (e.g. a bad image) as a recoverable "evicted" that the engine re-drives into the same
    120s hang. The recoverable timeout/terminated paths are also enriched with the latest
    pod-status detail so a stuck pod is no longer a bare "not ready within 120000ms".

  - **Custom EnvironmentProvider failures are stored and displayed.** A failed `deployer`
    provision (the provider threw, or returned `status:'failed'`) is now a real, displayed
    step failure: the errored environment (with the provider's verbatim `lastError`) is
    persisted and stamped onto the step, and the run records a new `environment`
    `AgentFailureKind` — instead of a green step with the error buried in its prose output.
    A provider that reports `status:'failed'` WITHOUT throwing can now carry its verbatim
    reason on the new optional `ProvisionedEnvironment.error` field (`@cat-factory/kernel`),
    which surfaces as the step's `lastError` instead of a generic "Provisioning failed". The
    failure is terminal + surfaced for one-click retry (NOT auto-retried), deliberately
    symmetric with the `dispatch` (container-failed-to-start) failure.

  **Breaking shape change:** `agentFailureKindSchema` gains the `environment` member.
  Pre-1.0, no migration — stale failure rows simply don't use the new kind.

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/contracts@0.50.0
  - @cat-factory/kernel@0.51.0
  - @cat-factory/integrations@0.34.0
  - @cat-factory/agents@0.21.14
  - @cat-factory/prompt-fragments@0.9.1
  - @cat-factory/sandbox@0.8.37
  - @cat-factory/spend@0.10.29
  - @cat-factory/workspaces@0.9.20

## 0.40.2

### Patch Changes

- e0f1149: Design-context sources: add Zeplin, generalize the abstraction, drop the Claude Design backend connector.

  - **New source: Zeplin** (`source='zeplin'`, per-workspace Bearer PAT) — a real server-fetchable
    REST handoff source exposing screens, components and design tokens. On by default; a no-op until a
    workspace connects it.
  - **De-Figma-shaped abstraction:** Figma and Zeplin now map into a shared, source-neutral
    `DesignContext` model rendered by `renderDesignContext` (`integrations/documents/design.logic.ts`).
    The per-source prompt fragments collapse into a single `design.context` fragment.
  - **Breaking — Claude Design backend connector removed.** Its only real read path is login-bound
    (Claude Code's `DesignSync` / `/design-sync`, via the user's claude.ai login), so a headless
    multi-tenant backend can never authenticate. The provider, the `'claude-design'` source value, the
    descriptor `credentialScope` field, and the entire per-user `user_document_connections` store
    (D1 + Drizzle tables, repositories, kernel ports, scope-aware `DocumentConnectionService`) are
    removed — all document sources are workspace-scoped again. The supported Claude Design workflow is
    now: `/design-sync` into the repo → commit → agents read it as checkout files. Stale
    `user_document_connections` rows are dropped (D1 migration `0020`, Drizzle drop migration); per the
    pre-1.0 policy there is no data migration.

- Updated dependencies [e0f1149]
  - @cat-factory/contracts@0.49.0
  - @cat-factory/kernel@0.50.0
  - @cat-factory/integrations@0.33.0
  - @cat-factory/prompt-fragments@0.9.0
  - @cat-factory/agents@0.21.13
  - @cat-factory/sandbox@0.8.36
  - @cat-factory/spend@0.10.28
  - @cat-factory/workspaces@0.9.19

## 0.40.1

### Patch Changes

- fc324d2: Add Kubernetes support for executor containers via a universal "agent runner backend"
  abstraction.

  The self-hosted runner pool is generalized into a discriminated runner-backend
  connection (a new `kind` field): `manifest` (the existing BYO HTTP scheduler pool) and
  `kubernetes` (new), with a `registerRunnerBackend` provider-registry seam so future
  backends (Nomad, EKS, …) are a single registry entry + a config variant + a UI form — no
  new table, service, controller, or integration window.

  The Kubernetes backend (`KubernetesRunnerTransport`, target k8s 1.35+) runs one bare Pod
  per run and reaches the per-pod executor-harness through the kube-apiserver **pod-proxy
  subresource** (Bearer ServiceAccount token), so the orchestrator needs only HTTPS to the
  apiserver — no in-cluster networking or per-run Service — and full `RunnerJobView`
  fidelity is preserved with zero executor-harness changes. It is wired symmetrically into
  both the Cloudflare and Node facades (and local mode via Node), and surfaced in the
  existing runner-backend Integrations window via a backend-type selector.

  BREAKING (pre-1.0): the `runner-pool/connection` register/test wire shape now takes a
  discriminated `config` instead of a bare `manifest`, and the `runner_pool_connections`
  table gains a `kind` column (existing rows backfill to `manifest`). The
  `executor-harness` image is unchanged (no image/tag bump).

- Updated dependencies [fc324d2]
  - @cat-factory/contracts@0.48.0
  - @cat-factory/kernel@0.49.0
  - @cat-factory/integrations@0.32.0
  - @cat-factory/agents@0.21.12
  - @cat-factory/prompt-fragments@0.8.9
  - @cat-factory/sandbox@0.8.35
  - @cat-factory/spend@0.10.27
  - @cat-factory/workspaces@0.9.18

## 0.40.0

### Minor Changes

- e3b3540: feat(environments): durable, asynchronous environment-provider config-repair agent

  When mechanical config bootstrap can't produce a valid provider config (`needsAgent`, or the
  re-validation still fails) and the caller passed `allowAgentFallback`, the engine dispatches a
  coding agent that fixes the provider's config file in an existing repo and pushes the fix back.
  That repair is now a **durable, asynchronous, observable run** — modelled exactly on the
  "bootstrap repo" flow — instead of being awaited synchronously inside the `bootstrapRepo` HTTP
  request (a ~20-minute in-request poll loop that could not survive on the Cloudflare Worker).

  - The repair is its own `kind='env-config-repair'` run in the unified `agent_runs` table (no DB
    migration — the table is kind-scoped), driven durably by **Cloudflare Workflows**
    (`EnvConfigRepairWorkflow`) ⇄ **Node pg-boss** (`env-config-repair.advance` queue), and
    re-driven by the existing cron / stale-run sweeper on either runtime. Local mode inherits the
    pg-boss driver via `buildNodeContainer`.
  - `ContainerEnvConfigRepairer` (`@cat-factory/server`) is reworked into the kernel
    `EnvConfigRepairer` port (`startRepair`/`pollRepair`/`stopRepair`) — dispatch returns
    immediately; the durable runner polls. It still dispatches a plain `coding` job (no `bootstrap`
    block, no PR, no force-push), distinct from the repo-bootstrap flow.
  - `bootstrapRepo` now **starts** the repair run and returns immediately with `usedAgent:true`,
    `repairJobId`, and `ok:false` (pending); the new `EnvConfigRepairService` re-validates the repo
    on completion (via a callback into `EnvironmentConnectionService`, where the decrypted secrets +
    manifest config live) and records the terminal `ok`/`issues`. In PR mode the fix is targeted at
    the config PR branch, not the target branch.
  - The run is observable: progress/outcome is pushed as an `env-config-repair` workspace event and
    carried on the workspace snapshot (`envConfigRepairJobs`); the SPA holds it in the agentRuns
    store and rides the unified `agent-runs` retry/stop endpoints (the new kind supports both —
    retry re-starts a fresh run from the failed job's coords). There is no board block — a repair is
    surfaced only on the infrastructure-providers surface that triggered it.
  - Wired symmetrically across the Cloudflare, Node and local facades, with a cross-runtime
    conformance assertion (`driveEnvConfigRepair` + a fake `EnvConfigRepairer`) that drives a repair
    to `succeeded` with the post-repair validation recorded on both D1 and Postgres. Gated on the
    container prerequisites plus a provider that supports `describeRepairAgent`, so a stock
    deployment running the generic manifest provider is unchanged.
  - The original bootstrap `inputs` (which shape the repair agent's prompt) are persisted on the
    run record (internal, never on the wire), so a retry re-dispatches a fresh run with the SAME
    prompt context via `EnvConfigRepairService.retry` instead of dropping them.

  Breaking (pre-1.0, no migration): the `dispatchConfigRepair` /
  `CoreDependencies.dispatchEnvConfigRepair` seam is replaced by the `EnvConfigRepairer` /
  `EnvConfigRepairRunner` / `EnvConfigRepairJobRepository` ports + `Core.envConfigRepair`; any
  in-flight synchronous repair shape is obsolete.

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/contracts@0.47.0
  - @cat-factory/kernel@0.48.0
  - @cat-factory/integrations@0.31.0
  - @cat-factory/agents@0.21.11
  - @cat-factory/prompt-fragments@0.8.8
  - @cat-factory/sandbox@0.8.34
  - @cat-factory/spend@0.10.26
  - @cat-factory/workspaces@0.9.17

## 0.39.2

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/integrations@0.30.0
  - @cat-factory/contracts@0.46.0
  - @cat-factory/agents@0.21.10
  - @cat-factory/kernel@0.47.2
  - @cat-factory/prompt-fragments@0.8.7
  - @cat-factory/sandbox@0.8.33
  - @cat-factory/spend@0.10.25
  - @cat-factory/workspaces@0.9.16

## 0.39.1

### Patch Changes

- 5ad45de: Refactor (internal, no behaviour change): extract the execution engine's per-step
  dispatch + completion spine out of `ExecutionService` into a new `RunDispatcher`
  collaborator (the four registries, the completion hub, the gate machinery, the
  deterministic deployer/tracker steps, the registered pre/post-op cluster, the
  structured-artifact ingest, and the follow-up companion gate). `ExecutionService`
  keeps the run-lifecycle preamble + run-control API and delegates; three now-dead
  constructor fields are dropped. `ExecutionService.ts` drops from 4,620 to ~2,460
  lines. Public API and wiring are unchanged, so the runtimes stay symmetric.

## 0.39.0

### Minor Changes

- 3d0b85c: feat(environments): wire the live environment-provider config-repair agent (PR #416 increment 2)

  When mechanical config bootstrap can't produce a valid provider config (`needsAgent`, or the
  post-commit re-validation still fails) and the caller passed `allowAgentFallback`, the engine now
  dispatches a coding agent that clones the target repo at the write branch, fixes the provider's
  config file in place, and pushes the fix back onto the same branch — then `EnvironmentConnectionService`
  re-validates.

  - New `ContainerEnvConfigRepairer` (`@cat-factory/server`) dispatches a plain `coding` job via the
    shared `RunnerJobClient`/`RunnerTransport` (no `bootstrap` block, no PR) and awaits it. It is
    distinct from the repo-bootstrap flow — it never reinitialises history or force-pushes.
  - The `dispatchConfigRepair` / `CoreDependencies.dispatchEnvConfigRepair` seam now returns `void`
    (it only pushes the fix); re-validation moved into `EnvironmentConnectionService`, where the
    decrypted secrets + manifest config live.
  - Wired symmetrically across the Cloudflare and Node facades (local inherits via `buildNodeContainer`),
    gated on the container prerequisites plus an injected provider that supports `describeRepairAgent`,
    so a stock deployment running the generic manifest provider is unchanged.

### Patch Changes

- Updated dependencies [3d0b85c]
  - @cat-factory/integrations@0.29.0

## 0.38.1

### Patch Changes

- Updated dependencies [c2ec53b]
  - @cat-factory/contracts@0.45.1
  - @cat-factory/agents@0.21.9
  - @cat-factory/integrations@0.28.1
  - @cat-factory/kernel@0.47.1
  - @cat-factory/prompt-fragments@0.8.6
  - @cat-factory/sandbox@0.8.32
  - @cat-factory/spend@0.10.24
  - @cat-factory/workspaces@0.9.15

## 0.38.0

### Minor Changes

- 4b5d267: Environment provider repo-config lifecycle: validate + bootstrap (+ agent-repair seam)

  Adds optional `EnvironmentProvider` capabilities so a native adapter (e.g. a future Kargo
  adapter) can manage its config file inside the deployed repo:

  - `validateRepo` — mechanical repo-config validation, run on-demand
    (`POST /environments/connection/validate-repo`) and as a provision pre-flight gate that
    fails synchronously before `provider.provision()` instead of as an async failed environment.
  - `describeBootstrapInputs` + `bootstrapProviderConfiguration` — mechanically generate the
    config file from UI-collected variables; the engine commits it (idempotent; optional PR) and
    re-validates (`POST /environments/connection/bootstrap-repo`).
  - `describeRepairAgent` — agent-repair prompt + dispatch seam (the live engine dispatch is
    scaffolded but not yet wired; see `backend/docs/env-lifecycle.md`).

  All repo I/O flows through the existing VCS-neutral `RepoFiles` abstraction, so the provider
  never sees a VCS host or token (GitHub today, GitLab later). The provider descriptor now
  carries `supportsRepoValidation` / `supportsRepoBootstrap` / `bootstrapInputs`. The generic
  `HttpEnvironmentProvider` implements none of these, so manifest-driven providers are unchanged.

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/contracts@0.45.0
  - @cat-factory/integrations@0.28.0
  - @cat-factory/agents@0.21.8
  - @cat-factory/sandbox@0.8.31
  - @cat-factory/spend@0.10.23
  - @cat-factory/workspaces@0.9.14
  - @cat-factory/prompt-fragments@0.8.5

## 0.37.3

### Patch Changes

- 0784fe0: ExecutionService split (take 2), phase 6 (partial): drop three dead constructor fields
  (`accountRepository`, `environmentTeardown`, `branchUpdater`) that became write-only after the
  earlier collaborator extractions — each is now consumed only via its destructured constructor
  param when wiring a sub-collaborator (`AgentContextBuilder` / `HumanTestController`), never
  through `this.`. The constructor params (and so the public `ExecutionServiceDependencies` shape)
  are unchanged. The substantial constructor trim still awaits the Phase 4 `RunDispatcher`
  extraction.
- 0784fe0: ExecutionService split (take 2), phase 5: group the gate-window actions into per-feature
  sub-facades. The dedicated review/test windows drove a parked gate through ~30 near-identical
  3-line delegations on `ExecutionService` (`reviewRequirements` / `incorporateClarity` /
  `proceedBrainstorm` / `confirmHumanTest` / `approveVisualConfirm` / …), bloating its public
  surface. They are now grouped into cohesive sub-facades exposed as getters on the still-injected
  `executionService` — `.requirementsReview` / `.clarityReview` / `.brainstorm` / `.humanTest` /
  `.visualConfirm` — and the matching server controllers call through them
  (`executionService.requirementsReview.review(...)` etc.). The composition roots are untouched
  (the single `executionService` is still what every facade injects), so the runtimes stay
  symmetric. No behaviour change.

## 0.37.2

### Patch Changes

- 5e54936: ExecutionService split (take 2), phase 3: debag the gate controllers onto the spine
  collaborators. `ReviewGateController`, `CompanionController`, `TesterController`,
  `HumanTestController` and `VisualConfirmationController` previously each received the SAME
  shared state-machine primitives as a fat per-callback bag (`ReviewGateController` alone took
  18: `parkStepOnDecision` / `advancePastResolvedGate` / `finishStep` / `startStep` /
  `updateBlockProgress` / `finalizeBlock` / `stopRunContainer` / `persistInstance` /
  `emitInstance` / `raiseDecisionRequired` / …). They now take the cohesive `stateMachine`
  (`RunStateMachine`) + `stepGraph` (`StepGraph`) collaborators instead, so the duplicated
  spine wiring is gone and each controller's deps shrink to its own data access plus its
  genuinely controller-specific operations. No behaviour change.
- 5e54936: ExecutionService split (take 2), phase 2: extract `RunStateMachine` — the async
  instance/block state-machine spine (`execution/RunStateMachine.ts`), composing `StepGraph`.
  It owns everything the engine and every gate controller share about MOVING a run:
  `persistInstance` / `emitInstance` (+ the metrics rollup, Kaizen scheduling and terminal
  personal-credential cleanup), `updateBlockProgress` / `refreshBlockProgress`,
  `parkStepOnDecision` / `advancePastResolvedGate`, `finalizeBlock`, `failRun`,
  `stopRunContainer`, and the park-related notifications (`raiseDecisionRequired` /
  `ensureWaitingNotification` / `clearWaitingNotification`). `ExecutionService` now delegates
  (its public `failRun` is a thin pass-through, preserving the driver-facing API).

  The merge/auto-start subgraph (`finalizeMerge` / `applyModuleAssignment` /
  `autoStartDependents`) deliberately stays on the engine — `finalizeBlock` here only flips
  block status and raises the no-merger notification, so this layer carries no merge
  collaborators. With phase 1's `StepGraph`, the spine the previous attempt left scattered as
  private methods (and handed to each controller as a fat callback bag) now has one cohesive
  home; debagging the controllers onto it is the next phase. No behaviour change — methods
  moved verbatim, replay-correctness invariants (persist→emit ordering, set-once timestamps,
  `runId` stamping) preserved.

## 0.37.1

### Patch Changes

- cc101a7: ExecutionService split (take 2), phase 1: extract `StepGraph` — the pure, synchronous
  step/cursor mutators (`startStep` / `finishStep` / `pauseStepForInput` / `resetStepForRerun`
  plus the companion rework loop `companionProducerIndex` / `rerunProducerThrough` /
  `loopCompanionProducer`) — into its own collaborator (`execution/StepGraph.ts`, constructed
  with just a `Clock`). The engine now delegates to `this.stepGraph.*`. This is the
  dependency-free inner layer of the run state-machine spine: lifting it gives the engine and
  every gate controller ONE definition of the step-timing rules instead of each receiving them
  as a loose callback bag (the debagging lands in a later phase). No behaviour change.

## 0.37.0

### Minor Changes

- 8727f2b: Filesystem blob backend + UI-managed, per-account content storage.

  - New `FilesystemBinaryBlobBackend` (Node/local) stores binary artifacts (UI-tester
    screenshots, reference designs) on disk under a base path (default `.file-storage`,
    git-ignored). Added `'fs'` to `BinaryArtifactStorageKind`.
  - Content-storage configuration moves entirely into the UI, scoped per **account**
    (Account → Deployment settings), stored in `account_settings` (no DB migration; the
    S3 access keys are sealed in the existing secrets blob). The blob backend is now
    resolved per request/run from the account's settings via the new
    `makeResolveBinaryArtifactStore` seam (`@cat-factory/server`), replacing the static
    `binaryArtifactStore` on the container with a `resolveBinaryArtifactStore(workspaceId)`.
  - Available backends per runtime: **Node/local** offer `fs` / `s3` / `db`, **Cloudflare**
    offers `r2` only (S3 is deliberately not offered on the Worker — the AWS SDK does not belong
    in the Worker bundle). Defaults when an account hasn't configured storage: **local** defaults
    to the filesystem backend (works out of the box); **Node** defaults to off (storage requires
    explicit configuration); **Cloudflare** defaults to its R2 bucket.

  BREAKING: the env-var content-storage configuration is removed — `BINARY_STORAGE_BACKEND`,
  `S3_ARTIFACT_*`, and `AppConfig.binaryStorage`/`BinaryStorageConfig` no longer exist.
  Configure storage per-account in the UI instead. Switching an account's backend orphans its
  previously-stored artifacts (no migration of existing bytes), which is acceptable pre-1.0.

### Patch Changes

- 764c05b: ExecutionService split, phase 5 (final): rename the temporary `runStepBody` fallthrough to
  `handleAgentStep` — the legitimate generic container/inline-agent StepHandler (`kind: 'agent'`,
  lowest priority) — now that every specific kind is claimed by its own handler. `stepInstance`
  is now just the fixed run-lifecycle preamble plus a single `dispatchStepHandler` call; the
  old ~290-line implicit-ordering `if`/early-return chain is gone, replaced by explicit
  `order`-driven handler dispatch. No behaviour change.
- 764c05b: ExecutionService split, phase 4: lift the remaining `stepInstance` dispatch branches
  (the four review/brainstorm gates, human-test, visual-confirm, the polling gates, and
  inline companions) into dedicated `StepHandler`s with explicit `order` preserving the
  original precedence. `runStepBody` now holds only the generic container/inline-agent
  fallthrough. Behaviour-preserving; verified on both runtimes.
- 764c05b: ExecutionService split, phase 2: add a `phase` discriminator to the `StepCompletionResolver`
  seam (`terminal` default vs a new `post-completion` early slot) and migrate the inline
  blueprint/spec/task-estimate ingestion branches of `recordStepResult` into `post-completion`
  resolvers. The early slot runs before the follow-up/approval gates read `step.output`, so the
  task-estimate summary still drives the approval proposal. The kind-agnostic PR-writeback and
  reviewable-artifact-output branches stay inline. Behaviour-preserving; verified on both runtimes.
- 764c05b: ExecutionService split, phase 3: lift the container-companion and tester verdict
  short-circuits out of `recordStepResult`'s inline top into an engine-internal
  `StepCompletionInterceptor` seam (`canIntercept` + `intercept → AdvanceResult | null`,
  sibling to `StepHandler`), dispatched at the top of `recordStepResult`. Remove the
  unused `control` field from the kernel `StepResolution` (superseded by the interceptor,
  which returns a full `AdvanceResult` the bare enum couldn't carry). Behaviour-preserving;
  verified on both runtimes.
- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/kernel@0.46.0
  - @cat-factory/contracts@0.44.0
  - @cat-factory/integrations@0.27.0
  - @cat-factory/agents@0.21.7
  - @cat-factory/sandbox@0.8.30
  - @cat-factory/spend@0.10.22
  - @cat-factory/workspaces@0.9.13
  - @cat-factory/prompt-fragments@0.8.4

## 0.36.5

### Patch Changes

- 8fad695: Update dependencies to latest.

  - `undici` 7→8 (test-only `MockAgent`). undici's MockAgent must match Node's
    bundled undici to intercept the global `fetch`; Node 26 bundles undici 8.5.0,
    so the test runner / CI is pinned to **Node 26**. Production runtime is
    unaffected — `undici` is a dev/test dependency only, and the service still runs
    on any Node >=20 (e.g. the example `deploy/node` image stays on Node 24).
  - Minor/patch bumps: `wrangler` 4.105, `@cloudflare/*`, `@types/node` 26.0.1,
    `vue` 3.5.39, `msw` 2.14.6, `valibot` 1.4.2, `workers-ai-provider` 3.2.1,
    `@toad-contracts/*` (core 0.4.0, valibot 0.5.0, hono/testing/http-client 0.3.2),
    `@aws-sdk/client-s3` 3.1075.
  - The AI SDK (`ai`, `@ai-sdk/*`) is intentionally held at v6 / v3-v4: the latest
    `workers-ai-provider` (3.2.1, the Cloudflare Workers AI provider) still peers on
    `ai@^6` / `@ai-sdk/provider@^3` and is not yet compatible with `ai` v7.
  - Pinned the whole Vue runtime family to one version via a pnpm `override`
    (`vue` + `@vue/*` → 3.5.39). Bumping `vue` to 3.5.39 left Nuxt 4.4.8's
    transitive deps pinning parts of the graph to 3.5.38, so two copies of Vue were
    bundled into the SPA; Vue's render internals are module-level singletons, so the
    second copy crashed the app on boot (`Cannot read properties of null (reading
'ce')` in `renderSlot`) — a blank 500 page that hung the whole e2e suite. One
    version = one singleton.
  - GitHub Actions: `actions/checkout` v6→v7, `pnpm/action-setup` v6.0.9,
    `zizmorcore/zizmor-action` v0.5.7, `changesets/action` pinned to v1.9.0. CI Node 24→26.

- Updated dependencies [8fad695]
  - @cat-factory/integrations@0.26.5
  - @cat-factory/contracts@0.43.3
  - @cat-factory/kernel@0.45.5
  - @cat-factory/agents@0.21.6
  - @cat-factory/sandbox@0.8.29
  - @cat-factory/prompt-fragments@0.8.3
  - @cat-factory/spend@0.10.21
  - @cat-factory/workspaces@0.9.12

## 0.36.4

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2
  - @cat-factory/agents@0.21.5
  - @cat-factory/integrations@0.26.4
  - @cat-factory/kernel@0.45.4
  - @cat-factory/prompt-fragments@0.8.2
  - @cat-factory/sandbox@0.8.28
  - @cat-factory/spend@0.10.20
  - @cat-factory/workspaces@0.9.11

## 0.36.3

### Patch Changes

- ab146e5: Suppress the real-time self-echo for board moves/reparents so dragging a task several
  times in quick succession is reliable. The SPA now tags every request with a stable
  per-tab connection id (`X-Connection-Id`) and the realtime WebSocket connect with the
  matching `?cid=`; the board `move`/`reparent` controllers forward it through
  `BoardService` to `boardChanged`, and both realtime hubs (the Cloudflare
  `WorkspaceEventsHub` Durable Object and the Node `NodeRealtimeHub`) skip delivering the
  coarse `board` event back to the connection that caused it. The originating client keeps
  its optimistic state plus its own authoritative REST response instead of refreshing off
  its own move (a mid-flight snapshot of which carried a stale position, snapping the block
  back). Other subscribers still receive the event and refresh.
- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3
  - @cat-factory/agents@0.21.4
  - @cat-factory/integrations@0.26.3
  - @cat-factory/sandbox@0.8.27
  - @cat-factory/spend@0.10.19
  - @cat-factory/workspaces@0.9.10

## 0.36.2

### Patch Changes

- c11a0cc: Add a `prepublishOnly` build hook so each package is compiled to `dist/` before it is
  packed, regardless of how publish is invoked. `dist/` is gitignored and was only built by
  the canonical `pnpm ci:publish` flow, so a bare `pnpm publish` could ship an empty shell
  (this is what happened to `@cat-factory/gitlab` and `@cat-factory/provider-s3`). The hook
  removes that footgun for every publishable library.
- Updated dependencies [c11a0cc]
  - @cat-factory/agents@0.21.3
  - @cat-factory/contracts@0.43.1
  - @cat-factory/integrations@0.26.2
  - @cat-factory/kernel@0.45.2
  - @cat-factory/prompt-fragments@0.8.1
  - @cat-factory/sandbox@0.8.26
  - @cat-factory/spend@0.10.18
  - @cat-factory/workspaces@0.9.9

## 0.36.1

### Patch Changes

- 5363166: ExecutionService split, phase 1: lift the `deployer` and `tracker` step branches out of
  `stepInstance`'s per-kind body into dedicated `StepHandler`s (built inline in the engine,
  each delegating to the existing `runDeployer`/`runTracker` paths). Behaviour-preserving;
  verified on both runtimes via the cross-runtime conformance suite.
- 5363166: Begin splitting the `ExecutionService` god class (refactoring candidate #8). Phase 0:
  introduce an engine-internal `StepHandler` registry that `stepInstance` dispatches to after
  its fixed run-lifecycle preamble, with a single fallthrough handler delegating the entire
  per-kind body unchanged (zero behaviour change — the safety net for the incremental,
  conformance-gated migration that follows). Adds an optional `control` field to the kernel
  `StepResolution` seam (consumed from a later phase; resolvers that omit it keep today's
  advance-on-completion behaviour).
- Updated dependencies [5363166]
  - @cat-factory/kernel@0.45.1
  - @cat-factory/agents@0.21.2
  - @cat-factory/integrations@0.26.1
  - @cat-factory/sandbox@0.8.25
  - @cat-factory/spend@0.10.17
  - @cat-factory/workspaces@0.9.8

## 0.36.0

### Minor Changes

- eab73b8: feat(documents): add Claude Design as a per-user design-context document source

  Implements the Claude Design half of the design record in
  `backend/docs/figma-claude-design-context.md`. Claude Design becomes a new
  `DocumentSourceProvider` (`source='claude-design'`) that reuses the whole documents
  integration (link plumbing, controller, `.cat-context/` materialization, prompt
  fragment), with a deterministic design-system normalizer that turns a project's
  `_ds_manifest.json` / `@dsCard`-marked component HTML + CSS custom properties into the
  same `### Components` / `### Design tokens` Markdown shape the Figma provider emits — so
  it earns its place over a plain HTML upload.

  Auth is a **personal per-user PAT**, supported on every runtime: a new descriptor flag
  `credentialScope: 'user'` routes such a source to a new per-user
  `user_document_connections` store (D1 ⇄ Drizzle, encrypted at rest under a distinct HKDF
  info), keyed by the acting user and never shared with the workspace. `DocumentConnectionService`
  becomes scope-aware; the import path threads the acting user. Workspace-scoped sources
  (Notion/Confluence/GitHub/Figma/Linear) are unchanged. The acting user falls back to the
  empty user id ONLY when auth is disabled (dev-open / single-user local mode) so those
  deployments still connect; when auth is enabled the controller fails closed with a 401
  rather than silently using the shared empty-user bucket.

  Claude Design is **opt-in**, not on by default: its credentialed project-read API is
  still provisional (the read is claude.ai-login-bound, no per-user service token yet), so
  it is excluded from the default `DOCUMENT_SOURCES` set and must be enabled explicitly
  (`DOCUMENT_SOURCES=…,claude-design`) once the API is real — every other source stays on
  by default.

  Also hoists the host-pinned `safeFetch`/SSRF guard/capped-read into a shared
  `documents/http.ts` reused by Figma and Claude Design. Wired symmetrically into both
  facades and gated by a new cross-runtime conformance case (per-user connect → list →
  disconnect).

- eab73b8: feat(documents): add Figma as a design-context document source

  Implements the Figma half of the design record in
  `backend/docs/figma-claude-design-context.md`. Figma becomes a new
  `DocumentSourceProvider` (`source='figma'`) authenticated by a per-workspace
  personal access token, reusing the whole documents integration (connection table,
  sealing, link plumbing, controller, `.cat-context/` materialization). `fetchDocument`
  renders a frame/file's layout tree, text, components-used and (Enterprise-gated)
  design tokens to Markdown, with a best-effort rendered-preview URL on a reference
  line. Wired symmetrically into both the Cloudflare and Node facades (and the
  `DOCUMENT_SOURCES` allow-list), gated by a cross-runtime conformance case. Adds the
  `design.figma-context` prompt fragment for frontend agents. (Claude Design ships in a
  companion changeset.)

  Also makes a URL pasted into a block description auto-match its imported document by the
  document's stable `(source, externalId)` — canonicalised through the providers'
  `parseRef` (`AgentContextBuilder.documentUrlResolver`) — instead of by exact URL-string
  equality, which silently failed for a real Figma share link (title path segment, dash
  node id, `&t=` tracking params) whose canonical stored `url` omits that noise.

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0
  - @cat-factory/kernel@0.45.0
  - @cat-factory/integrations@0.26.0
  - @cat-factory/prompt-fragments@0.8.0
  - @cat-factory/agents@0.21.1
  - @cat-factory/sandbox@0.8.24
  - @cat-factory/spend@0.10.16
  - @cat-factory/workspaces@0.9.7

## 0.35.1

### Patch Changes

- 67c7196: Break the `orchestration → sandbox → sandbox-fixtures → orchestration` package
  dependency cycle so the workspace graph is acyclic. The cycle was closed by a
  single type-only conformance test in `sandbox-fixtures` that imported
  `@cat-factory/orchestration` (a `devDependency`). That test now lives in
  `orchestration` (which owns the requirements/clarity logic types and already sees
  the fixtures), leaving `sandbox-fixtures` a pure leaf data package. No runtime
  behaviour changes; this only removes a dev-time cycle that blocked a per-package
  build task graph.
  - @cat-factory/sandbox@0.8.23

## 0.35.0

### Minor Changes

- e641417: Add a document-authoring pipeline and a richer document task definition.

  **Reviewers now read the real repository.** The `reviewer` (code) and `doc-reviewer`
  companions run as read-only container reviewers: they clone the producer's PR branch and
  read the ACTUAL changed files / committed document with tools before rating, instead of
  grading the producer's summary reply (a review of a summary is worthless). They are
  dispatched through the same async container path the coder/merger use and return their
  verdict as structured JSON, resolved by the same threshold / rework-loop / human-gate
  handling as before. Inline companions (`architect-companion` / `spec-companion`) are
  unchanged. A container companion is gated on a wired sandbox like any other container kind.

  A new forward-authoring track produces an in-repo Markdown document (PRD / RFC / design
  doc / ADR / technical reference / runbook / research report) shipped as a pull request —
  distinct from the reverse-documentation kinds (`documenter` / `business-documenter` /
  `blueprints`) that describe existing code. Four new agent kinds are registered through the
  public `registerAgentKind` seam — `doc-researcher` and `doc-outliner` (inline), `doc-writer`
  (container-coding, opens the PR coder-style) and `doc-finalizer` (container-coding, polishes
  on the PR branch) — plus a `doc-reviewer` companion that loops the writer back for rework.

  Two built-in pipelines are seeded: `pl_document` (research → outline [human gate] → write →
  AI review loop [human gate] → finalize → conflicts → ci → merger) and `pl_document_quick`.

  The `document` task type gains a wider `docKind` set (`prd`/`rfc`/`adr`/`design`/`technical`/
  `api`/`runbook`/`research`/`reference`/`other`) and optional `audience`, `targetPath` and
  `outlineHints` fields, threaded into the agent context so the document agents specialise their
  prompts. No new persisted tables — the committed Markdown is the durable artifact.

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/contracts@0.42.0
  - @cat-factory/kernel@0.44.0
  - @cat-factory/agents@0.21.0
  - @cat-factory/integrations@0.25.2
  - @cat-factory/prompt-fragments@0.7.41
  - @cat-factory/sandbox@0.8.22
  - @cat-factory/spend@0.10.15
  - @cat-factory/workspaces@0.9.6

## 0.34.1

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0
  - @cat-factory/agents@0.20.3
  - @cat-factory/integrations@0.25.1
  - @cat-factory/sandbox@0.8.21
  - @cat-factory/spend@0.10.14
  - @cat-factory/workspaces@0.9.5

## 0.34.0

### Minor Changes

- 63e2177: Add Linear support as a document source and issue tracker. Linear Docs can be
  imported as task context (mirroring Notion/Confluence); Linear issues can be
  imported and linked to board blocks (mirroring Jira/GitHub Issues); the `tracker`
  pipeline step can file issues into Linear; and PR writeback comments on and
  resolves the linked Linear issue. Authentication is a per-workspace personal API
  key (sealed at rest), behind a shared GraphQL client shaped so OAuth can be added
  later. Adds one nullable `linear_team_id` column to `tracker_settings` (mirrored
  across D1 and Postgres) for the team new issues are filed under.

### Patch Changes

- Updated dependencies [63e2177]
  - @cat-factory/contracts@0.41.0
  - @cat-factory/integrations@0.25.0
  - @cat-factory/agents@0.20.2
  - @cat-factory/kernel@0.42.2
  - @cat-factory/prompt-fragments@0.7.40
  - @cat-factory/sandbox@0.8.20
  - @cat-factory/spend@0.10.13
  - @cat-factory/workspaces@0.9.4

## 0.33.0

### Minor Changes

- 6903cd7: Board mutations now push a real-time `boardChanged` event. Creating, renaming,
  moving, reparenting, deleting blocks (and toggling dependencies / epic assignment)
  emit a coarse board signal through the `ExecutionEventPublisher`, so every user
  active on a workspace — and every board mounting a shared service — sees human
  board edits live instead of only after a refresh. Best-effort and a no-op when no
  real-time transport is wired.

## 0.32.1

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/contracts@0.40.1
  - @cat-factory/kernel@0.42.1
  - @cat-factory/agents@0.20.1
  - @cat-factory/integrations@0.24.1
  - @cat-factory/prompt-fragments@0.7.39
  - @cat-factory/sandbox@0.8.19
  - @cat-factory/spend@0.10.12
  - @cat-factory/workspaces@0.9.3

## 0.32.0

### Minor Changes

- 32c653f: Add the Visual Confirmation gate and split the tester into an API + UI tester.

  - **Tester split:** the `tester` kind is renamed to `tester-api` (general/API exploratory
    testing) and a new `tester-ui` kind drives a real browser (Playwright), captures a
    non-redundant screenshot of each distinct view, uploads them to the binary-artifact
    store, and reports them under `TestReport.screenshots[]`. Both share the Tester→Fixer
    loop and the `tester.environment` infra choice (`isTesterKind`). The UI tester dispatches
    with `image:'ui'` so a transport can route it to a dedicated Playwright/browser image.
  - **Visual Confirmation gate** (`visual-confirmation`): a park-on-decision engine gate
    (modelled on `human-test`) that gathers the UI tester's screenshots + the human-uploaded
    reference design images (paired by view) and parks for a person to review actual-vs-reference.
    The human approves (advance), requests a fix (dispatches the Tester's `fixer`, then re-parks),
    or recaptures. Raises a `visual_confirmation_ready` notification; passes through when no
    binary-artifact store is wired. New `pl_visual` pipeline (`… tester-ui → visual-confirmation
→ merger`) and the `GET /blocks/:id/artifacts` + visual-confirmation action endpoints.
  - Cross-runtime conformance covers the gate's no-store pass-through and the artifact store's
    `listByBlock`.

  BREAKING: the `tester` agent kind is renamed to `tester-api`. Per this repo's pre-1.0 policy
  (no backwards-compatibility shims), any persisted state that still names `tester` simply stops
  matching: a saved/custom pipeline referencing `tester` is detected as outdated and reseeded from
  the catalog, and an execution that is parked mid-`tester` at upgrade time will no longer be
  recognised by the tester gate (re-run the task). New runs are unaffected — the seeded pipelines
  all use `tester-api`.

  NOTE: the dedicated UI-tester container image (Playwright/Chromium) and the per-kind image
  routing into it (a second Cloudflare container class; image-per-step on the local/pool
  transports) are a deploy-time follow-up — the `image:'ui'` dispatch seam is in place. Until that
  routing AND the harness env-passthrough (`ARTIFACT_UPLOAD_URL`/`ARTIFACT_UPLOAD_TOKEN` + a
  Playwright driver) land, `tester-ui` has no browser and the `pl_visual` gate runs in MANUAL mode
  (a human uploads references + screenshots and reviews them), which is why `pl_visual` is flagged
  `experimental`.

- 32c653f: Harden + complete the Visual Confirmation gate / binary-artifact storage after review.

  - **Security (artifact serving):** the artifact upload + blob endpoints now pin the content
    type to a raster-image allow-list (`png`/`jpeg`/`webp`/`gif`, SVG/HTML rejected `415`) at the
    write boundary, and serve blobs with `X-Content-Type-Options: nosniff` + a clamped
    `Content-Type`/`Content-Disposition` — closing a stored-XSS vector where an attacker-controlled
    type could be served inline same-origin. Shared `imageArtifacts.ts` keeps the workspace upload
    and the in-container ingest paths consistent.
  - **Configurable artifact retention (new):** a per-workspace `artifactRetentionDays` setting
    (default 14, bounded 1–3650), editable in the workspace settings panel. A daily Cloudflare cron
    / hourly Node timer sweep prunes each workspace's screenshots + reference images past its window
    — BOTH the metadata rows and the bytes (`BinaryArtifactStore.pruneOlderThan`), so the store no
    longer grows unbounded. Mirrored D1 ⇄ Drizzle (migration `0018` / a generated Drizzle migration)
    and asserted by the cross-runtime binary-artifacts conformance suite.
  - **tester-ui ingest seam (backend half):** `ContainerAgentExecutor` injects an `artifactUpload`
    `{ url, token }` into the `tester-ui` job body, reusing the run's existing container session
    token + proxy base URL, and a new container-token-authed `POST ${proxyBaseUrl}/artifacts/ingest`
    route stores the bytes as a run-scoped `screenshot`. (The UI-tester image routing + harness env
    passthrough remain the deploy-time follow-up — see the handover doc.)
  - **Gate UX:** a `request-fix` that can't dispatch (no PR branch / no async executor) now surfaces
    a reason + records a failed round instead of silently re-parking; after a fix the gate flags that
    the shown screenshots predate it (recapture to refresh); the unused `headSha` placeholder is
    dropped; and the gate window revokes its cached screenshot object URLs on unmount.

### Patch Changes

- 32c653f: Second review pass on the Visual Confirmation gate / binary-artifact storage — hardening + a
  gap-closing follow-up:

  - **Retention no longer orphans bytes.** `BinaryArtifactStore.pruneOlderThan` now keeps a
    metadata row whenever its blob delete fails (instead of dropping the row and orphaning the
    bytes forever), so the next sweep retries it; the all-succeeded path still collapses to one
    bulk delete.
  - **Upload size guarded before buffering.** Both the workspace upload and the in-container
    ingest endpoints reject a grossly oversized body from `Content-Length` BEFORE reading it into
    memory (`exceedsRequestSizeLimit`), with the exact per-file 16 MiB ceiling still enforced after
    parsing.
  - **Per-run screenshot ceiling.** The container ingest route caps a single run at 100 uploaded
    screenshots (`429` past it), so a runaway/compromised container can't fill the blob store.
  - **Consistent content-type posture.** The harness ingest now rejects a recognised non-image
    type (`415`) instead of silently storing it mislabelled as PNG, matching the workspace upload
    endpoint; a typeless upload still defaults to PNG.
  - **Tighter human-upload scoping.** The workspace artifact endpoint ignores any client-supplied
    `executionId` (reference images are block-scoped and precede any run; run-scoped captures come
    through the token-authed ingest, where the run is derived from the verified token).
  - **`created_at` retention index** added on `binary_artifacts` (D1 `0017` + a generated Drizzle
    migration) so the per-workspace prune is an indexed range delete.
  - **`pl_visual` flagged experimental** (`labels: ['experimental']`): until UI-tester image
    routing + harness env-passthrough land, the gate runs in manual mode — the label keeps the
    pipeline discoverable without implying automatic screenshot capture.
  - Removed the unused `capturing` phase from `visualConfirmStepStateSchema` (the auto re-capture
    loop it anticipated is still deferred), and added a cross-runtime conformance test for the
    gate's request-fix → fixer → re-park → approve loop.

  Note (breaking, already in this PR): the `tester` agent kind was renamed to `tester-api` (with a
  new browser-driven `tester-ui` sibling). Per the project's pre-1.0 no-backwards-compat policy,
  custom pipelines/blocks persisted with the old `tester` kind are not migrated and will need to be
  re-pointed at `tester-api`.

- 32c653f: Third review pass on the Visual Confirmation gate / binary-artifact storage:

  - **Frontend build fix.** `VisualConfirmationWindow.vue` still referenced the `capturing`
    phase that round 2 removed from `visualConfirmStepStateSchema` (a TS2353 excess-property
    on `PHASE_LABEL` and a TS2367 no-overlap comparison in `working`), which broke
    `nuxt typecheck`. Dropped both.
  - **Reference re-upload now wins.** `VisualConfirmationController.gatherPairs` kept the
    OLDEST reference image per view (`?? ref.id`), so a human re-uploading a corrected
    reference for a view they already populated never saw it. References are now assigned
    last-writer (newest), matching the oldest-first `listByBlock` ordering.
  - **Upload buffering is now actually bounded.** The `Content-Length` precheck was
    bypassable by a chunked / header-less body, after which `formData()` buffered the whole
    request into memory before the per-file ceiling ran. Both upload routes (workspace +
    in-container ingest) now wrap the body in `hono/body-limit`, which counts bytes as the
    stream is read, so a missing/spoofed `Content-Length` can't buffer past the ceiling.
  - **Per-run screenshot cap holds under concurrency.** The container-ingest cap was a
    check-then-act race; concurrent ingests could each pass it before any row landed. A
    post-insert reconcile now rolls back (deletes) any insert that lands in the overflow
    tail, so the store is bounded to exactly the cap per run without dropping earlier shots.
  - **Removed the vestigial `headSha`** from `visualConfirmStepStateSchema` (and its
    `begin()` initializer) — it was always null and never read; round 1 claimed it was
    dropped but it wasn't.
  - **Reuse:** the harness ingest route now uses the exported `bearerToken` helper instead
    of a fourth private copy of the `Bearer` parser.

- 32c653f: Review round 4 (visual-confirmation gate / binary artifacts):

  - **Don't load the AWS SDK unless S3 is actually used.** `@cat-factory/provider-s3` now imports
    `@aws-sdk/client-s3` lazily (on the first S3 operation) instead of at module load, so a
    Node/local deployment running the `db` (or no) blob backend no longer pays the SDK's load cost
    even though the facade statically imports `S3BinaryBlobBackend` to wire its container.
  - **Guard Approve when the gate flags its screenshots as unreliable.** The visual-confirmation
    window now requires an explicit "I've reviewed this manually" acknowledgement before Approve is
    enabled whenever the gate set a `degradedReason` (no capture happened, a fix failed, or a fix
    landed AFTER the shown screenshots) — so a stale/empty gallery can't be approved in one blind
    click.
  - **Cheaper per-run upload cap.** The harness screenshot ingest precheck uses an indexed
    `countByExecution` (no row materialise) and only runs the post-insert overflow reconcile when the
    insert could actually cross the cap, so the steady-state upload is one COUNT + one insert.
  - **Serve a blob in a single metadata read** via `BinaryArtifactStore.getBlobWithMetadata`.
  - **Drop dangling screenshot refs.** The gate validates the agent-reported screenshot `artifactId`s
    against what the run actually uploaded, so a fabricated id or one removed by the retention sweep
    renders as "not captured" rather than a 404 image.
  - Make the UI-tester prompt honest: it now only instructs an upload when `ARTIFACT_UPLOAD_URL` is
    provided to the run (manual mode otherwise), and treats the reference-design directory as
    optional.

  The new `countByExecution` / `getBlobWithMetadata` store methods are mirrored D1 ⇄ Drizzle and
  asserted by the cross-runtime binary-artifacts conformance suite.

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0
  - @cat-factory/contracts@0.40.0
  - @cat-factory/agents@0.20.0
  - @cat-factory/integrations@0.24.0
  - @cat-factory/sandbox@0.8.18
  - @cat-factory/spend@0.10.11
  - @cat-factory/workspaces@0.9.2
  - @cat-factory/prompt-fragments@0.7.38

## 0.31.0

### Minor Changes

- b5231b0: Make prompt-caching a first-class, visible capability and add per-kind progress-guard
  leniency.

  **Caching capability + observability.** `providerCachePolicy` moves to the kernel
  (`domain/cache-policy.ts`, re-exported from `@cat-factory/agents`) so the model catalog
  can derive a per-flavour `ModelOption.cachesPrompts` from the effective provider — the
  same model reads `false` on its cache-less Cloudflare/Workers-AI flavour and `true` once
  a direct key upgrades it to its caching `direct` flavour. The already-recorded
  `cachedPromptTokens` is now aggregated per agent kind in `summarizeByExecution` (D1 +
  Drizzle, kept symmetric) and surfaced as `cachedPromptTokens` + a derived `cacheHitRate`
  on the step rollup and the LLM-metrics export.

  **Vendor-selection UI.** The model picker shows a `Prompt caching` / `No prompt caching`
  badge per flavour, the API-keys panel notes which direct keys enable caching, and the
  step metrics bar shows a cached-token split when present — so a user can see (and act on)
  the hot path running cache-less. Shipped model defaults are intentionally NOT changed;
  extending `providerCachePolicy` to more providers (Moonshot / OpenRouter / LiteLLM) is
  gated on benchmark evidence (see `backend/docs/prompt-caching.md`).

  **Per-kind guard leniency.** The container progress guard can now be loosened per agent
  kind via an optional `guardLimits` job-body field (clamped per knob in the harness;
  merged over the env/built-in defaults — loosen-only, never tighten). A data-driven
  `agentTuningFor` seam (`@cat-factory/agents`, plus an `AgentKindDefinition.tuning` hook
  for custom kinds) supplies the profile, which `ContainerAgentExecutor` folds into the
  dispatch body. Initial profiles give `conflict-resolver` more error headroom and the
  research-heavy kinds a higher consecutive-web cap, so a legitimately-progressing run is
  not killed for its normal pattern. Output-token ceilings are unchanged.

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/contracts@0.39.0
  - @cat-factory/kernel@0.41.0
  - @cat-factory/agents@0.19.0
  - @cat-factory/integrations@0.23.5
  - @cat-factory/prompt-fragments@0.7.37
  - @cat-factory/sandbox@0.8.17
  - @cat-factory/spend@0.10.10
  - @cat-factory/workspaces@0.9.1

## 0.30.0

### Minor Changes

- 6d829bb: Make invalid-state pipelines more robust. On app open, a startup advisory surfaces pipelines that
  reference a nonexistent agent kind or have an invalid shape (delete a custom one, reseed a built-in)
  and built-in pipelines whose seeded definition is newer than the stored copy (reseed to adopt it).

  Built-in pipelines now carry a per-pipeline `version` (persisted on both runtimes via a new D1
  migration and a Drizzle column), the snapshot ships the current catalog versions
  (`pipelineCatalogVersions`), and a new `POST /workspaces/:ws/pipelines/:id/reseed` endpoint restores a
  built-in's canonical definition while preserving its labels/archive state.

  BREAKING: existing workspaces' persisted built-in pipelines have no stored `version`, so they read as
  "update available" once until reseeded — intentional adoption of the now-versioned definitions.

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/contracts@0.38.0
  - @cat-factory/kernel@0.40.0
  - @cat-factory/workspaces@0.9.0
  - @cat-factory/agents@0.18.5
  - @cat-factory/integrations@0.23.4
  - @cat-factory/prompt-fragments@0.7.36
  - @cat-factory/sandbox@0.8.16
  - @cat-factory/spend@0.10.9

## 0.29.0

### Minor Changes

- 714b7c9: Add "forgot my password" self-service reset for password-based logins.

  A user can request a reset link by email (`POST /auth/forgot-password`) and set a new
  password via a one-time, expiring token (`POST /auth/reset-password`). Tokens are stored
  hashed (SHA-256), single-use, and mirror the invitation flow; the reset email is sent
  through a new deployment-level **system** email sender configured via
  `EMAIL_SYSTEM_PROVIDER` / `EMAIL_SYSTEM_FROM` / `EMAIL_SYSTEM_API_KEY` (when unset, the
  link is logged for local/dev). The request endpoint never reveals whether an email is
  registered.

  Schema addition (both runtimes): a new `password_reset_tokens` table (D1 migration
  `0017_password_reset_tokens.sql` ⇄ a Drizzle Postgres migration). No data migration is
  needed — the table starts empty.

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/contracts@0.37.0
  - @cat-factory/kernel@0.39.0
  - @cat-factory/workspaces@0.8.0
  - @cat-factory/agents@0.18.4
  - @cat-factory/integrations@0.23.3
  - @cat-factory/prompt-fragments@0.7.35
  - @cat-factory/sandbox@0.8.15
  - @cat-factory/spend@0.10.8

## 0.28.3

### Patch Changes

- Updated dependencies [efbd910]
  - @cat-factory/contracts@0.36.0
  - @cat-factory/agents@0.18.3
  - @cat-factory/integrations@0.23.2
  - @cat-factory/kernel@0.38.1
  - @cat-factory/prompt-fragments@0.7.34
  - @cat-factory/sandbox@0.8.14
  - @cat-factory/spend@0.10.7
  - @cat-factory/workspaces@0.7.46

## 0.28.2

### Patch Changes

- Updated dependencies [692ccb4]
  - @cat-factory/agents@0.18.2
  - @cat-factory/sandbox@0.8.13

## 0.28.1

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/contracts@0.35.0
  - @cat-factory/kernel@0.38.0
  - @cat-factory/agents@0.18.1
  - @cat-factory/integrations@0.23.1
  - @cat-factory/prompt-fragments@0.7.33
  - @cat-factory/sandbox@0.8.12
  - @cat-factory/spend@0.10.6
  - @cat-factory/workspaces@0.7.45

## 0.28.0

### Minor Changes

- 76543fa: Add a **Human Review gate** — an opt-in pipeline step (`human-review`, pipeline `pl_pr_review`
  "Build & PR review") that watches a task's PR for a human code review on GitHub and loops the
  existing `fixer` agent to address feedback:

  - Advances once the PR meets GitHub's required approvals (read from branch protection) with no
    unresolved review threads.
  - Dispatches the `fixer` to address outstanding review threads (immediately when approved; after a
    per-task grace window otherwise), then resolves each handed thread on GitHub via the GraphQL
    review-thread API so the next probe sees it cleared. A reviewer re-opening a thread re-triggers a fix.
  - Waits indefinitely for the human (re-arming, never auto-failing), surfacing a `human_review`
    notification while it waits.
  - A human can request a freeform fix at any time from the gate window
    (`POST /workspaces/:ws/blocks/:blockId/human-review/request-fix`), dispatched immediately.

  Built as a registry gate in `@cat-factory/gates` (new `PullRequestReviewProvider` port +
  `GitHubPullRequestReviewProvider`, wired in every facade) reusing the generic gate driver, plus
  small generic engine seams: `pollExhaustion: 'rearm'`, a `GateDefinition.onHelperComplete` side-effect
  hook, and a `pendingFix` manual-inject path. Adds a per-task `humanReviewGraceMinutes` merge-preset
  knob (D1 ⇄ Drizzle migration). The cross-runtime conformance suite asserts the gate on every runtime.

  Review hardening:

  - Branch-protection's required-approval count is read against the PR's **actual base branch**
    (`pulls/{n}.base.ref`), not the repo default — so a PR into a stricter protected branch is gated
    against its own rule instead of silently defaulting to 1.
  - A **stalled fixer** (no progress on an unchanged head while feedback is outstanding) now raises a
    `human_review` notification instead of waiting silently/invisibly forever.
  - The awaiting-approval `human_review` card carries the run's `executionId`, so the inbox deep-links
    into the gate window (the "request a fix here" affordance) instead of merely selecting the block.
  - The thread-resolve reconcile is scoped strictly to threads the gate itself handed the fixer
    (retained until confirmed resolved) — a **third-party review bot's** open thread is never silently
    closed, and its feedback isn't mistaken for the fixer's own.
  - `requestHumanReviewFix` rejects (409) when the gate has no review provider / async executor wired,
    instead of accepting a request it would silently drop.
  - The static branch-protection read is cached on the gate state after the first probe, so an
    indefinite wait no longer re-reads it every poll.

  **Breaking:** `FIXER_AGENT_KIND` moved from `@cat-factory/orchestration`'s `ci.logic` to
  `@cat-factory/kernel` (re-exported from `ci.logic` for existing call sites); the `merge_threshold_presets`
  table gains a non-null `human_review_grace_minutes` column.

### Patch Changes

- Updated dependencies [76543fa]
  - @cat-factory/kernel@0.37.0
  - @cat-factory/contracts@0.34.0
  - @cat-factory/agents@0.18.0
  - @cat-factory/integrations@0.23.0
  - @cat-factory/sandbox@0.8.11
  - @cat-factory/spend@0.10.5
  - @cat-factory/workspaces@0.7.44
  - @cat-factory/prompt-fragments@0.7.32

## 0.27.1

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/integrations@0.22.0
  - @cat-factory/contracts@0.33.0
  - @cat-factory/kernel@0.36.0
  - @cat-factory/agents@0.17.2
  - @cat-factory/prompt-fragments@0.7.31
  - @cat-factory/sandbox@0.8.10
  - @cat-factory/spend@0.10.4
  - @cat-factory/workspaces@0.7.43

## 0.27.0

### Minor Changes

- eb48652: Local-mode infrastructure delegation + native runner-adapter seam.

  Local mode now lets a workspace opt, independently, into delegating its container agents
  and/or its Tester ephemeral environments to an external service instead of running
  everything on the host container runtime. Two new per-workspace settings drive it
  (`delegateAgentsToRunnerPool`, `delegateTestEnvToProvider`, both default off), surfaced as
  toggles on the Ephemeral environments screen (local mode only) and enabled only once the
  respective provider — a self-hosted runner pool / an environment provider — is registered.

  - **Agents**: when delegated, container jobs dispatch to the workspace's registered runner
    pool instead of host Docker (a clean 409 at start, and the existing dispatch error, when
    delegated with no pool registered).
  - **Environments**: the toggle sets the local-mode default Tester environment — `local`
    (host Docker / DinD) by default, `ephemeral` (the provider) when on; per-service / per-task
    choices still win. An `ephemeral` run is refused at start when delegated with no provider
    connected.
  - **Native runner-adapter seam**: an injected `runnerPoolProvider` now drives the actual
    dispatch transport on both the Cloudflare and Node facades (falling back to the generic
    `HttpRunnerPoolProvider`), fully symmetric with `environmentProvider`. A wrapper can thus
    ship one package implementing `EnvironmentProvider` + `RunnerPoolProvider` (e.g. Kargo) to
    serve both concerns with native code on every runtime.

  BREAKING (pre-1.0, internal): an un-pinned Tester task in local mode now defaults to the
  `local` (DinD) environment instead of `ephemeral`. New `workspace_settings` columns are
  added on both runtimes (D1 migration + Drizzle migration); local mode now defaults
  `ENVIRONMENTS_ENABLED=true` so the env module assembles for the opt-in.

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/contracts@0.32.0
  - @cat-factory/kernel@0.35.0
  - @cat-factory/agents@0.17.1
  - @cat-factory/integrations@0.21.7
  - @cat-factory/prompt-fragments@0.7.30
  - @cat-factory/sandbox@0.8.9
  - @cat-factory/spend@0.10.3
  - @cat-factory/workspaces@0.7.42

## 0.26.0

### Minor Changes

- 9f7ee39: Add "Requirements brainstorm" and "Architecture brainstorm" agents — structured-dialogue
  gates that PROPOSE options with explicit trade-offs and let a human converge on a direction,
  rather than doing all the work themselves or expecting the work done upfront.

  - One shared, stage-discriminated engine (`BrainstormService` over the existing
    `IterativeReviewService`), driven through the generic `ReviewGateController`. Two agent kinds
    (`requirements-brainstorm`, `architecture-brainstorm`) reuse it via a stage-bound repository
    adapter.
  - Persistence: a new `brainstorm_sessions` table keyed per (block, **stage**) — a block may hold
    a live requirements AND a live architecture session at once — mirrored across both runtimes
    (D1 + Drizzle/Postgres) with a cross-runtime conformance suite.
  - Handoffs (DB session state → next stage's prompt): `requirements-brainstorm` → the
    requirements review (its converged direction becomes the reviewed subject);
    `architecture-brainstorm` → the architect (surfaced additively as a prior output).
  - Pipelines: both steps are added to `pl_full` and `pl_fullstack` but **disabled by default**
    (opt-in per pipeline) — existing runs are unchanged.
  - Frontend: a shared brainstorm window (option cards with trade-offs → choose/steer/dismiss →
    incorporate → re-run), wired through the result-view seam, the workspace stream, and the
    palette catalog.

  Breaking: adds a new required table on both runtimes (`brainstorm_sessions` D1 migration +
  Drizzle migration) and a new optional `ExecutionEventPublisher.brainstormSessionChanged` event.
  No data migration — pre-1.0, stale state is acceptable.

  The brainstorm iteration cap reuses the merge preset's `maxRequirementIterations` /
  `maxRequirementConcernAllowed` knobs (no new preset field).

- 81b60d4: Add the future-looking **Follow-up companion** to the Coder agent.

  As the Coder works it now surfaces forward-looking items — genuine loose ends, useful
  side-tasks it is deliberately not acting on, and clarifying questions — by appending them
  to a `.cat-follow-ups.jsonl` sentinel file in its working directory. The executor-harness
  tails that file and streams the items **out** on the job view (drain-on-read, like tool
  spans), so a blinking **Follow-up companion** chip on the Coder step lights up the moment
  the first item appears — while the container is still running.

  A human triages each item at any point: file a follow-up as a tracker issue (GitHub Issues
  / Jira, via the existing `TicketTrackerProvider`), send it back to the Coder to address
  after delivering the key task, answer a question, or dismiss it. The pipeline's following
  steps do not start until **every** item is decided: an undecided follow-up or unanswered
  question parks the run at the Coder's completion (a new `followup_pending` notification).
  Once all are decided the engine loops the Coder for the queued / answered items (within a
  per-step budget) before advancing. The companion is enabled by default on Coder steps and
  disableable per step in the pipeline builder.

  This is pure engine + run-step state (no new table) so it is runtime-symmetric across the
  Cloudflare and Node facades — the cross-runtime conformance suite asserts the park →
  decide → loop → advance behaviour on both. Wire contracts (`followUpItem` /
  `followUpsStepState`, the `followup_pending` notification, the `follow-ups` result view),
  the `streamFollowUps` harness job flag + `RunnerJobView.followUps` channel (with an
  optional pool-manifest `followUpsPath`), and the `FOLLOW_UP_GUIDANCE` Coder prompt fragment
  are added across the stack.

  Bumps the executor-harness image (new src) — publish + redeploy to roll it out.

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/contracts@0.31.0
  - @cat-factory/kernel@0.34.0
  - @cat-factory/agents@0.17.0
  - @cat-factory/integrations@0.21.6
  - @cat-factory/prompt-fragments@0.7.29
  - @cat-factory/sandbox@0.8.8
  - @cat-factory/spend@0.10.2
  - @cat-factory/workspaces@0.7.41

## 0.25.1

### Patch Changes

- Updated dependencies [4dd6e97]
  - @cat-factory/agents@0.16.1
  - @cat-factory/sandbox@0.8.7

## 0.25.0

### Minor Changes

- ea59e91: Add the Kaizen agent: a post-run, continuous-improvement reviewer (toggleable per
  workspace, never a pipeline-builder step) that grades each completed agent step on how
  smooth/efficient vs confused/chaotic the interaction was and recommends prompt/model
  improvements.

  - After a run completes, the engine schedules a grading per completed agent step
    (skipping verified combos); a background sweep (Cloudflare cron / Node interval) runs
    the inline LLM grade. The grader's model is configured in Model Configuration like
    every other agent (the hidden-from-palette `kaizen` kind).
  - A `(promptVersion, agentKind, model)` combo that grades strongly (>=4) with no
    recommendations five times in a row is marked **verified** and is no longer graded.
  - New persisted tables `kaizen_gradings` + `kaizen_verified_combos` (D1 ⇄ Drizzle parity,
    asserted by a new cross-runtime conformance suite) and a per-workspace `kaizenEnabled`
    setting (a new `workspace_settings.kaizen_enabled` column).
  - New read API (`GET /workspaces/:ws/kaizen`, `GET /workspaces/:ws/executions/:id/kaizen`),
    a `kaizen` real-time event, a Kaizen screen (grading history + verified combos), and
    per-step grading status (scheduled/running/complete + results) inside the run window —
    never on the board.
  - A step with neither a provided-context snapshot nor any recorded LLM calls (e.g. prompt
    recording is off deployment-wide) is settled `failed` rather than graded blind, so a
    guessed grade can't advance a combo toward a bogus `verified`.
  - The Worker Kaizen sweep gains an in-isolate re-entrancy guard (mirroring the Node
    sweeper) so overlapping passes don't race the per-combo streak update.

### Patch Changes

- Updated dependencies [ea59e91]
  - @cat-factory/contracts@0.30.0
  - @cat-factory/kernel@0.33.0
  - @cat-factory/agents@0.16.0
  - @cat-factory/integrations@0.21.5
  - @cat-factory/prompt-fragments@0.7.28
  - @cat-factory/sandbox@0.8.6
  - @cat-factory/spend@0.10.1
  - @cat-factory/workspaces@0.7.40

## 0.24.2

### Patch Changes

- Updated dependencies [18f6b3b]
  - @cat-factory/integrations@0.21.4

## 0.24.1

### Patch Changes

- b82304e: Remove per-model price overrides from the workspace budget. A workspace's budget is
  now just a currency + monthly limit overlaid on the built-in `DEFAULT_SPEND_PRICING`
  table; the `spendModelPrices` setting, its contracts/schemas, and the
  `workspace_settings.spend_model_prices` column (D1 + Postgres) are dropped. Also fixes
  the budget save in the UI throwing `spendMonthlyLimit.trim is not a function` when the
  number input emits a numeric value.

  **Breaking:** the `spend_model_prices` column is dropped on both runtimes with no
  migration of existing override data (pre-1.0); any stored overrides are discarded and
  budgets fall back to the built-in price table.

- Updated dependencies [b82304e]
  - @cat-factory/contracts@0.29.0
  - @cat-factory/kernel@0.32.0
  - @cat-factory/spend@0.10.0
  - @cat-factory/agents@0.15.2
  - @cat-factory/integrations@0.21.3
  - @cat-factory/prompt-fragments@0.7.27
  - @cat-factory/sandbox@0.8.5
  - @cat-factory/workspaces@0.7.39

## 0.24.0

### Minor Changes

- 765cc42: Capture the complete context provided to each container agent as observability, in an
  isolated telemetry store.

  - New `agent_context_snapshots` table records, per container-agent dispatch, the fully
    fragment-composed system + user prompts, the best-practice fragment bodies folded in,
    and the full content of the files injected into the container (`.cat-context/*`) — the
    gap the per-call LLM telemetry can't see (the agent reads those files via tools). The
    snapshot is a redacted allow-list projection of the dispatched job (never any token or
    credential-bearing URL). Recorded best-effort at dispatch by `ContainerAgentExecutor`
    via the new `AgentContextObservabilityService`, gated by the deployment prompt-recording
    switch (`LLM_RECORD_PROMPTS`) AND a new per-workspace `storeAgentContext` setting
    (on by default; a toggle in Workspace settings). Surfaced on demand via
    `GET /workspaces/:ws/executions/:executionId/agent-context` and a "Provided context"
    view in the observability panel.
  - Telemetry now lives in an isolated store, separate from the transactional domain
    (append-heavy/high-volume/short-retention write profile). `llm_call_metrics` and the new
    `agent_context_snapshots` table both move there: a dedicated `telemetry` Postgres schema
    on Node (same connection) and a separate, **required** `TELEMETRY_DB` D1 database on
    Cloudflare. Both ride the existing `LLM_CALL_METRICS_RETENTION_DAYS` retention window.

  BREAKING (pre-1.0, no migration provided): the Cloudflare Worker now requires a
  `TELEMETRY_DB` D1 binding (provision with `wrangler d1 create cat_factory_telemetry` and
  add the `[[d1_databases]]` entry pointing `migrations_dir` at
  `telemetry-migrations`). `llm_call_metrics` is dropped from the main D1 / `public` schema;
  existing rows are not migrated.

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/kernel@0.31.0
  - @cat-factory/contracts@0.28.0
  - @cat-factory/agents@0.15.1
  - @cat-factory/integrations@0.21.2
  - @cat-factory/sandbox@0.8.4
  - @cat-factory/spend@0.9.5
  - @cat-factory/workspaces@0.7.38
  - @cat-factory/prompt-fragments@0.7.26

## 0.23.0

### Minor Changes

- 52d886a: Improve the ergonomics of authoring custom agent kinds and gates:

  - **Typed provider registry** (`defineProviderToken`/`wireProvider`/`requireProvider`, kernel),
    surfaced through `GateContext.getProvider`/`requireProvider`. A custom gate reaches its data
    source through the context instead of a hand-authored module global + unsafe `!`. The built-in
    `@cat-factory/gates` suite dogfoods it (public `wireX` signatures unchanged).
    **Breaking:** `GateContext` gains required `getProvider`/`requireProvider` (use `stubGateContext`).
  - **Schema-driven structured output** (`defineStructuredOutput`, agents): one valibot schema
    derives both the `agent.output` spec and a typed `parse`/`safeParse`, replacing the hand-written
    `shapeHint` string + lenient coercer. `registerAgentKind` auto-fills `agent.output` from a
    `structuredOutput` schema.
  - **Boot-time registration validation** (`validateRegistrations`/`validateRegistrationsOnce`,
    orchestration): a facade validates registered gates/kinds/pipelines at startup (gate `helperKind`
    resolves, `resultView` is known) and fails loudly instead of mid-run. Wired into both runtimes.
  - **Prompt + resultView wiring** (agents/contracts): `FINAL_ANSWER_IN_REPLY` + the read-only
    guardrail are applied to registered kinds from their `agent.surface` (fixing a registered
    `container-explore` kind missing the guardrail); `resultView` is now a typed picklist of
    `RESULT_VIEW_IDS` (unknown ids fail validation instead of silently falling back to prose).

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0
  - @cat-factory/contracts@0.27.0
  - @cat-factory/agents@0.15.0
  - @cat-factory/integrations@0.21.1
  - @cat-factory/sandbox@0.8.3
  - @cat-factory/spend@0.9.4
  - @cat-factory/workspaces@0.7.37
  - @cat-factory/prompt-fragments@0.7.25

## 0.22.0

### Minor Changes

- a639189: Observability for ephemeral-environment and container provisioning.

  - **Unified provisioning event log.** A new append-only log records every attempt to
    spin up / tear down throwaway infrastructure — ephemeral environments
    (provision/teardown/status) and the runner-pool / per-run containers
    (dispatch/release/poll-failure) — with the outcome and the verbatim provider/runtime
    error on failure. Surfaced via `GET /workspaces/:ws/provisioning-logs` and a "View
    logs" button in the ephemeral-environment provider and self-hosted runner-pool config
    panels.
  - **Env lifecycle in run details.** An agent run's step now carries the ephemeral
    environment it runs against (spinning up / running / shut down / errored + URL/expiry
    - exact error), shown in the step detail (notably for the Tester).
  - **Container-start failures.** When a container/runner never accepts the job, the run
    details now say "Container failed to start" and show the exact provider/runtime error
    (a `dispatch`-kind failure) instead of a generic "Run failed". A run's step detail also
    has an "Infrastructure attempts" drawer (filtered by execution id) that surfaces that
    run's container/runner/env spin-up + tear-down attempts.
  - **Secret redaction.** The verbatim provider/runtime error and structured detail are
    scrubbed at the single recorder choke point before they are persisted/served — bearer
    tokens, `Authorization`/`x-api-key` header echoes, credentialed URLs, and recognisable
    token shapes (`sk-`/`ghp_`/`AKIA`/JWT) are replaced with `[REDACTED]` while the
    surrounding context (field name, URL host, token scheme) is kept for diagnosis.

  **Breaking / operational:** the provisioning log lives in a PHYSICALLY SEPARATE store to
  isolate its high write churn. The Cloudflare Worker needs a new `PROVISIONING_DB` D1
  binding (its own `migrations-provisioning` dir — create the database and apply its
  migrations); when absent, the feature is simply off. The Node service uses a dedicated
  `provisioning` Postgres schema, created with `CREATE SCHEMA IF NOT EXISTS` by `migrate()`
  on boot (the DB role needs `CREATE` on the database — the same privilege the app already
  uses to create its `public` tables). Retention is governed by `PROVISIONING_LOG_RETENTION_DAYS`
  (default 14). Catching a container dispatch error at the dispatch site means a transient
  dispatch blip is now a terminal `dispatch` failure (retry from the failure card) rather
  than relying on a Workflows step retry.

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/kernel@0.29.0
  - @cat-factory/contracts@0.26.0
  - @cat-factory/integrations@0.21.0
  - @cat-factory/agents@0.14.9
  - @cat-factory/sandbox@0.8.2
  - @cat-factory/spend@0.9.3
  - @cat-factory/workspaces@0.7.36
  - @cat-factory/prompt-fragments@0.7.24

## 0.21.1

### Patch Changes

- ed3a673: Requesting Requirement-Writer recommendations is now asynchronous, like every other
  requirements-review operation. The request returns at once with `pending` placeholder
  recommendations and the user is handed back to the board; the Writer runs per finding in
  the durable driver (signalled through the parked requirements gate, mirroring the
  incorporate flow), filling each placeholder (`pending` → `ready`) with live progress and
  raising a notification when the batch is ready. The review window shows "N / M ready" plus
  per-finding "generating…" placeholders, and the board's "Recommending…" badge is now driven
  by server state (a `pending` recommendation), so it survives closing the window. A finding's
  typed answers are flushed before the request and preserved across the async cycle, so the
  user's explicit answers are still there when they return to confirm recommendations.
  Re-requesting a single recommendation rides the same async path; rejecting one now reopens
  its source finding so it can be answered manually. No schema migration (recommendation
  status lives in the existing JSON column) and no prompt/image change.
- Updated dependencies [ed3a673]
  - @cat-factory/contracts@0.25.1
  - @cat-factory/agents@0.14.8
  - @cat-factory/integrations@0.20.1
  - @cat-factory/kernel@0.28.1
  - @cat-factory/prompt-fragments@0.7.23
  - @cat-factory/sandbox@0.8.1
  - @cat-factory/spend@0.9.2
  - @cat-factory/workspaces@0.7.35

## 0.21.0

### Minor Changes

- 69d2270: Surface the Sandbox (the parallel prompt/model testing surface) end to end. Previously
  only the domain logic (`@cat-factory/sandbox`), wire contracts and kernel ports existed,
  with no way to use the feature; this wires the full stack:

  - **Services** (`@cat-factory/orchestration`): `SandboxService` (prompt-version lineage,
    fixture library with lazy builtin seeding, experiment definitions) + `SandboxRunService`
    (the run-driver + judge — expands an experiment matrix into cells, runs each inline
    candidate against the prompt-version's system text + the fixture input, grades it with a
    judge model against the task rubric, and records the deterministic objective findings
    score). Assembled as the `sandbox` core module when its repositories are wired.
  - **HTTP API** (`@cat-factory/server`): `SandboxController` mounts the prompt/fixture/
    experiment CRUD + `POST /sandbox/experiments/:id/launch`. 503 when unconfigured.
  - **Persistence**: the Sandbox gets its **own database** per runtime for blast-radius
    isolation — a dedicated `SANDBOX_DB` D1 database on the Cloudflare Worker (its own
    `sandbox-migrations/` lineage) and a dedicated `sandbox` Postgres schema on Node
    (Drizzle). Both runtimes contribute the repositories via a single sandbox-owned
    `Partial<CoreDependencies>` mixin, so neither facade enumerates them. Cross-runtime
    conformance asserts parity.
  - **Frontend** (`@cat-factory/app`): a Sandbox window (opened from the sidebar +
    command palette) to clone/version prompts, browse graded fixtures, and define + run
    experiments with a scored results grid.

  BREAKING (deployment): the Cloudflare Worker reads an optional new `SANDBOX_DB` binding;
  without it the Sandbox API answers 503 (the rest of the product is unaffected). To enable
  it, provision a second D1 database and point the binding + its `migrations_dir` at the
  package's `sandbox-migrations/` (see `deploy/backend/wrangler.toml`). On Node the
  `sandbox` schema is created automatically by the boot migrator.

  Container/repo fixtures (a real checkout) are not yet supported by the in-product run
  driver and are refused at launch; the builtin fixtures are all inline.

  Run-driver hardening: a relaunch clears the prior result grid first (new
  `SandboxRunRepository`/`SandboxGradeRepository.removeByExperiment`, mirrored on D1 +
  Drizzle) instead of accumulating duplicate cells; the experiment's terminal status is
  derived from whether any cell was actually graded (`failed` when every candidate failed OR
  every grade failed — never a misleading `done` over a grid of unscored cells, and never
  left `running`); the token budget must be ≥ 1 (a `0` budget is rejected at create rather
  than silently failing every cell) and is documented as a soft cap enforced between cells;
  the judge model defaults to the deployment routing default (no hardcoded vendor) and
  requires an explicit `judgeModel` when none is configured (the experiment builder now
  exposes a judge-model picker so a deployment with no default still has recourse); an
  unparseable / empty / reasoning-only judge reply is now recorded as a grading **error** on
  the cell rather than silently flooring every dimension to the minimum (which read as a
  confident bottom-of-scale grade); the judge-reply JSON extractor — now the single robust
  `extractJson` promoted to `@cat-factory/kernel` and shared by the requirements reviewer, the
  document planner and the Sandbox judge (replacing two weaker object-only copies) — is
  string-literal aware, scans forward past any leading bracket whose span isn't valid JSON
  (so prose like `I weighed [the auth flow]: {…}` no longer defeats extraction for the
  object-returning reviewers), and falls back past a leading non-JSON code fence. The judge
  prompt appends the shared `FINAL_ANSWER_IN_REPLY` directive like the other parsed-reply
  agents, and the provider-for-scope resolution the Sandbox shares with the reviewers is now
  one `resolveScopedModelProvider` kernel helper instead of two copies. The Sandbox window now surfaces a
  non-503 load failure (with a retry) instead of rendering an empty, healthy-looking panel.
  The fixture↔kind mapping the UI filters by now lives on the `@cat-factory/sandbox` catalog
  (`SandboxAgentKindMeta.fixtureKinds`) instead of a parallel frontend switch. Concurrent
  launches of the same experiment are now serialised by an atomic
  `SandboxExperimentRepository.claimForRun` (a conditional transition to `running`, mirrored on
  D1 + Drizzle): only the winner clears + re-expands the result grid, so two simultaneous
  launches can't duplicate the grid or race the grid-clearing deletes, and the grid setup runs
  inside the terminal-status `finally` so a failure there can't strand the experiment
  `running`. The matrix cell cap is surfaced on the overview (`maxCells`) so the builder gates
  on the SAME limit instead of re-encoding the literal. NOTE: the run-driver still executes the
  matrix inline in the launch request (bounded by the cell cap + token budget); a durable
  fan-out (Workflows / pg-boss) for large matrices remains a follow-up.

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/contracts@0.25.0
  - @cat-factory/kernel@0.28.0
  - @cat-factory/integrations@0.20.0
  - @cat-factory/sandbox@0.8.0
  - @cat-factory/agents@0.14.7
  - @cat-factory/prompt-fragments@0.7.22
  - @cat-factory/spend@0.9.1
  - @cat-factory/workspaces@0.7.34

## 0.20.0

### Minor Changes

- 3546e3d: Move operator/integration config out of environment variables into encrypted, UI-editable
  DB settings. DB is now the source of truth — the moved env vars are **removed** (no
  fallback), so the listed vars below no longer have any effect.

  **Per-workspace budget (Workspace settings → Budget).** A workspace's spend currency,
  monthly limit, and per-model price overrides now live on the `workspace_settings` row.
  The spend safeguard resolves each workspace's effective pricing (base table + overrides)
  behind a short-TTL cache, scoping the budget gate to the workspace's own usage
  (`SpendService.status`/`isOverBudget` now take a `workspaceId`; new
  `TokenUsageRepository.totalsSinceForWorkspace`). **Behaviour change:** spend is metered +
  gated per workspace, not deployment-wide; a workspace with no budget inherits the built-in
  default (~100 EUR/month). Removes env: `SPEND_MONTHLY_LIMIT`, `SPEND_CURRENCY`,
  `SPEND_MODEL_PRICES`. A budget of `0` is intentional ("no PAID spend"): metered runs are
  refused **up front** at start/retry with a clear `409` (not just a silent mid-run pause),
  while LOCAL-runner models (keyless) and connected SUBSCRIPTIONS (flat-rate quota) keep
  running since they incur no metered cost — so `0` is the "local-/subscription-only" setting.
  The over-budget exemption (previously subscription-only) now also covers local-runner steps,
  inline and container alike. The hot-path per-workspace rollup is indexed
  (`idx_token_usage_workspace` on `(workspace_id, created_at)`, both runtimes).

  **Per-workspace incident enrichment (service inspector → Post-release health).** PagerDuty

  - incident.io credentials are sealed in a new per-workspace `incident_enrichment_connections`
    table (one grouped blob) and resolved/decrypted at enrichment time by a new
    `WorkspaceIncidentEnrichmentProvider`. Removes env: `PAGERDUTY_API_TOKEN`,
    `PAGERDUTY_FROM_EMAIL`, `INCIDENTIO_API_KEY`. The write API is three-state per provider
    group (omit ⇒ keep, `null` ⇒ clear, value ⇒ set) so one vendor can be removed without
    wiping the other.

  **Per-account integration secrets (Account settings → Deployment integrations, admin only).**
  The Slack app OAuth credentials and the container web-search upstream keys (Brave /
  SearXNG) now live in a new per-account `account_settings` table (one sealed secrets blob,
  HKDF tag `cat-factory:account-settings`), behind an admin-gated
  `GET|PUT /accounts/:id/settings`. Resolved dynamically: Slack OAuth at connect time, the
  web-search upstream per run (off the container session's account id). The executor now
  advertises the container `web_search` tool to a run **only when its account actually has
  keys** (so an agent is never handed a tool that always fails); a run with no upstream gets
  an empty result set rather than a hard `503`. Removes env:
  `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URL`, `WEB_SEARCH_BRAVE_API_KEY`,
  `WEB_SEARCH_SEARXNG_URL`, `WEB_SEARCH_SEARXNG_API_KEY` (the env-built upstream + its
  `createWebSearchUpstreamFromEnv`/`gateways.webSearch` fallback are deleted, not just
  unwired). (`SLACK_ENABLED` still gates Slack module assembly; the new tables/services
  assemble whenever `ENCRYPTION_KEY` is set.)

  **Hardening.** Re-sealing a partial settings/credentials write now **refuses** (clear `409`)
  when the stored blob can't be decrypted (e.g. after an encryption-key change) instead of
  silently dropping the un-edited secret group on the re-seal.

  New tables mirror across both runtimes (D1 migrations 0012–0014 ⇄ Drizzle schema +
  generated migration) with cross-runtime conformance assertions for the budget +
  incident-enrichment round-trips. `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`, and the GitHub
  App/OAuth secrets stay in env (bootstrap/auth). Retention windows, inline-web-search
  toggles, Langfuse keys, and execution timeouts intentionally remain env-configured.

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/contracts@0.24.0
  - @cat-factory/kernel@0.27.0
  - @cat-factory/spend@0.9.0
  - @cat-factory/integrations@0.19.0
  - @cat-factory/agents@0.14.6
  - @cat-factory/prompt-fragments@0.7.21
  - @cat-factory/workspaces@0.7.33

## 0.19.2

### Patch Changes

- a62044d: Tag 409 conflicts with a distinct, machine-readable `reason` (kernel `ConflictReason`, surfaced under `error.details`) so the SPA can tell run-control conflicts apart. The "no configured provider" start refusal now shows an actionable toast naming the model(s) with a "Configure AI" jump (same remedy as the no-AI startup banner); the other run/bootstrap conflicts get worded toasts. The toast handling is centralised in the execution/agentRuns stores, so every start/restart/retry/merge surface (including the fire-and-forget board menus) gets it.
- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1
  - @cat-factory/agents@0.14.5
  - @cat-factory/integrations@0.18.3
  - @cat-factory/spend@0.8.26
  - @cat-factory/workspaces@0.7.32

## 0.19.1

### Patch Changes

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0
  - @cat-factory/spend@0.8.25
  - @cat-factory/agents@0.14.4
  - @cat-factory/integrations@0.18.2
  - @cat-factory/workspaces@0.7.31

## 0.19.0

### Minor Changes

- f4f954b: Dogfood the extensible-gates seam: the built-in polling-gate suite (`ci`, `conflicts`,
  `post-release-health` + the `on-call` escalation) is no longer hard-coded in the engine —
  it ships as a new **`@cat-factory/gates`** package authored ENTIRELY through the public
  `registerGate` seam, depending only on kernel + contracts. If the platform's own gates can
  be expressed as an external package, so can any deployment's.

  **Breaking (pre-1.0, no migration):** the `ci` / `conflicts` / `post-release-health`
  providers leave the engine. `ciStatusProvider`, `mergeabilityProvider`,
  `releaseHealthProvider` and `incidentEnrichment` are removed from
  `ExecutionServiceDependencies` / `CoreDependencies`; a deployment now wires them into the
  gate suite via the exported `wireCiStatusProvider` / `wireMergeabilityProvider` /
  `wireReleaseHealthProvider` / `wireIncidentEnrichment` handles after
  `import '@cat-factory/gates'`. The merge collaborators (`pullRequestMerger`,
  `branchUpdater`) stay on the engine.

  - **gates (new)**: the three gate factories + the four provider wire-handles +
    `registerBuiltinGates()`, registered as an import side effect. Each gate is a
    pass-through until its provider is wired, so a bare import is always safe. Also exports
    `applyGateProviders(overrides)` + the `GateProviderOverrides` bag: a facade build resets
    the deployment-global providers up-front then re-wires from config, and this is the seam
    that re-applies explicit/faked providers AFTER that wiring (so they survive the Worker's
    per-request rebuild and override a config-wired provider) — used by the cross-runtime
    conformance suite to drive the externalized `ci` gate over a controlled verdict.
  - **kernel**: the pure gate logic (`aggregateCi`/`classifyReleaseHealth`/… +
    `renderReleaseEvidence`) and the gate/helper agent-kind constants move into
    `domain/gate-logic.ts` so a gate package can author a gate without depending on the
    engine. New `GateDefinition.resolveHelperCompletion` hook (+ `GateHelperJobResult` /
    `GateHelperCompletionArgs`): the seam an INVESTIGATE-don't-fix helper (`on-call`) needs
    to settle a gate without re-probing — the real gap the dogfood surfaced.
  - **orchestration**: the three inline gates + the bespoke `resolveOnCallStep` /
    `raiseReleaseRegression` / `enrichIncident` / `raiseCiFailed` branches are deleted; the
    engine builds its gate registry purely from what's registered, and drives an on-call-style
    helper completion through the generic `resolveHelperCompletion` hook. The **`merger`**
    step resolver stays a privileged built-in (reclassified): it owns terminal block status
    and executes a policy-gated real merge — a different archetype from the light, externally
    authorable resolvers, so it keeps its engine-internal access rather than the public seam.
  - **worker / node-server**: each facade `import`s `@cat-factory/gates` and wires its
    existing provider impls (`GitHubCiStatusProvider`, `RegistryReleaseHealthProvider`, …)
    via the `wireX` handles instead of threading them through the engine. `local-server`
    inherits this through `buildNodeContainer`.
  - **conformance**: a new cross-runtime assertion drives the externalized built-in `ci`
    gate (green pass-through, red → ci-fixer → re-probe) over a faked provider on both
    runtimes; the registered-gate test now restores the built-ins after clearing the shared
    registry.

### Patch Changes

- Updated dependencies [f4f954b]
  - @cat-factory/kernel@0.25.0
  - @cat-factory/agents@0.14.3
  - @cat-factory/integrations@0.18.1
  - @cat-factory/spend@0.8.24
  - @cat-factory/workspaces@0.7.30

## 0.18.1

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/contracts@0.23.0
  - @cat-factory/kernel@0.24.0
  - @cat-factory/integrations@0.18.0
  - @cat-factory/agents@0.14.2
  - @cat-factory/prompt-fragments@0.7.20
  - @cat-factory/spend@0.8.23
  - @cat-factory/workspaces@0.7.29

## 0.18.0

### Minor Changes

- 7346a4f: Make the polling **Gate** and **StepCompletionResolver** mechanisms externally
  extensible, so a company-authored deployment package can register its OWN full-blown gate
  (deterministic probe + helper/companion agent + exhaustion handling) or step resolver
  purely via an import side effect — exactly the way it already registers a custom agent
  kind. No fork, no engine patch, and no executor-harness image change (pure backend TS).

  - **kernel**: new `domain/gate-registry.ts` (`registerGate(kind, factory)` +
    `GateDefinition`/`GateContext`/`GateProbe`/`recordGateAttempt`/…) and
    `domain/step-resolver-registry.ts` (`registerStepResolver(kind, factory)` +
    `StepCompletionResolver`/`ResolverContext`/…), moved out of orchestration so an
    extension package depends only on kernel + agents. `RaiseNotificationInput` moved to
    `ports/notification-channel.ts` so the runtime-neutral `GateContext` can build one. A
    registered gate/resolver is a `(ctx) => Definition` factory the engine invokes once at
    registry-build time — solving the `this`-capture the built-in gates rely on while
    keeping them inline and unchanged.
  - **orchestration**: `ExecutionService.buildGateRegistry()` /
    `buildStepResolverRegistry()` now merge the deployment-registered factories with the
    built-ins (registered replaces built-in of the same kind, last-wins) via new
    `makeGateContext()`/`makeResolverContext()` seams; the gate/resolver types are
    re-exported from the package index for discovery.
  - **example-custom-agent**: registers a `license-check` gate (escalating to a new
    `license-fixer` agent kind) + an auditor step resolver + a `wireLicenseProvider` seam,
    proving a custom gate ships with zero engine changes.
  - **conformance**: a new cross-runtime assertion drives a registered custom gate
    (pass-through, escalate-then-pass) and a registered step resolver on both runtimes.

### Patch Changes

- Updated dependencies [7346a4f]
  - @cat-factory/kernel@0.23.0
  - @cat-factory/agents@0.14.1
  - @cat-factory/integrations@0.17.1
  - @cat-factory/spend@0.8.22
  - @cat-factory/workspaces@0.7.28

## 0.17.0

### Minor Changes

- 6ff1f10: Link Confluence/Notion/GitHub documents as **living** best-practice fragments.

  A team can now link an external document (a Confluence page, a Notion page, or a
  GitHub file — any connected Document source) as a prompt-fragment whose guidance is
  **re-resolved from the source at the moment an agent run uses it**, rather than a
  one-time snapshot. Edit the upstream doc and the next agent run follows the new
  version — no re-import. The body is cached on the fragment as a last-resolved
  snapshot and refreshed on a short TTL (default 5 min); if the source is unreachable
  the run falls back to the cached body, so resolution never blocks a run. Available
  at both the account and workspace tiers; an account-tier link fetches through a
  chosen workspace's connection — recorded on the fragment so every consuming
  workspace re-resolves through that same connection at run time, not its own.

  New surface: `POST /:scope/document-fragments` (link a document as a fragment) and
  `POST /:scope/prompt-fragments/:id/refresh` (force an immediate re-resolve), a
  "Documents" tab in the fragment-library manager with a "Live · <source>" badge, and
  a `documentRef`/`resolvedAt` provenance block on `PromptFragment`.

  As part of this, run-time fragment-id resolution now goes through the merged tenant
  catalog (built-in ∪ account ∪ workspace) instead of only the built-in static pool,
  so **managed (DB-authored) fragments also reach a run** — previously only built-in
  ids resolved at run time. Behaviour is unchanged when the prompt-fragment library is
  not configured.

  Persistence: `prompt_fragments` gains `doc_source` / `doc_external_id` /
  `doc_via_workspace_id` / `resolved_at` columns on both runtimes (a D1 migration and
  a Drizzle migration); stale pre-existing rows simply carry nulls.

### Patch Changes

- Updated dependencies [6ff1f10]
  - @cat-factory/contracts@0.22.0
  - @cat-factory/kernel@0.22.0
  - @cat-factory/agents@0.14.0
  - @cat-factory/integrations@0.17.0
  - @cat-factory/prompt-fragments@0.7.19
  - @cat-factory/spend@0.8.21
  - @cat-factory/workspaces@0.7.27

## 0.16.0

### Minor Changes

- 04befe8: Business-only specs + an explicit `technical` task label.

  **Business-only spec-writer + "no new specs" outcome.** The spec-writer now captures
  ONLY business requirements. For a purely technical task (a refactor / non-functional /
  internal change with no externally-observable behaviour) "no new specs" is a valid
  outcome: the writer returns `{"noBusinessSpecs": true}`, the baseline spec is left
  untouched (`specPostOp` commits nothing), and the new `AgentRunResult.noBusinessSpecs`
  channel carries the determination. The spec-companion corroborates or disputes it via a
  new optional `technicalCorroborated` verdict on `companionAssessmentSchema` (a disputed
  "no specs" claim loops the writer back as before). The spec-writer prompts are updated
  accordingly (no version bump — they are not under prompt-version control).

  **Explicit `technical` label on a task.** Blocks gain an optional `technical` field
  (`true`/`false`/unset), persisted on both runtimes (D1 column ⇄ Drizzle column + generated
  migration; shared block mapper). A human sets it at creation (a "Technical task" checkbox)
  or via a tri-state inspector toggle (unset / technical / business). An explicit `false`
  (business) is forwarded to the spec-writer, which is then required to produce specs (it is
  told not to claim "no business specs"); `true` tells it the empty outcome is expected.
  Left unset, the engine infers the label from the settled spec phase — `noBusinessSpecs`
  (writer) combined with `technicalCorroborated` (companion) — both when the spec-companion
  converges automatically AND when a human proceeds past its iteration cap. Once a concrete
  label is recorded it is authoritative and not re-inferred (whether set by a human or a
  prior inference); a human re-opens it to inference by clearing it to "unset". When a task
  is technical the implementer treats the task definition / incorporated requirements as the
  primary source of truth and the committed specs as a regression-spotting reference; the
  `build` prompt is bumped to v3 and carries the per-task signal (only the implementer — not
  the architect/reviewer — acts on it).

  Breaking: none for existing data (the new columns default to "not determined").

### Patch Changes

- Updated dependencies [04befe8]
  - @cat-factory/contracts@0.21.0
  - @cat-factory/kernel@0.21.0
  - @cat-factory/agents@0.13.0
  - @cat-factory/integrations@0.16.1
  - @cat-factory/prompt-fragments@0.7.18
  - @cat-factory/spend@0.8.20
  - @cat-factory/workspaces@0.7.26

## 0.15.0

### Minor Changes

- be182e8: Hybrid linked-context delivery to agents, and deterministic reference resolution.

  Linked documents and tracker issues now reach a container agent as a cheap in-prompt
  summary index plus their full bodies materialised into a `.cat-context/` directory in the
  checkout (kept out of the agent's commits via a local git exclude), so the agent reads only
  what it needs on demand — replacing the previous 280-char document excerpt. Inline (no-
  checkout) agent kinds instead get the budgeted full body injected into the prompt.

  The engine also resolves references named explicitly in a block's description or its
  incorporated requirements (Jira keys like `PROJ-123`, fully-qualified GitHub `owner/repo#123`,
  and URLs) against the already-imported corpus, folding those high-confidence items into the
  context set. Each reference is resolved by a **point lookup** (a keyed `get`, or a new
  `getByUrl` repository method) rather than scanning the whole workspace corpus per step. Bare
  `#123` refs are intentionally not resolved: a workspace can hold many repos, so a bare number
  is ambiguous — name the issue as `owner/repo#123` (or by URL) to pull it in. There is no
  speculative relationship graph and no live fetching: everything is prepared backend-side,
  which is required because the container harness cannot reach Jira/Confluence/GitHub itself.

  Documents gain a `content_hash` column (D1 + Drizzle) so a re-import whose body AND title/url
  are unchanged is a no-op, preserving the existing projection and block link; a renamed/moved
  page still re-projects.

  Breaking (pre-1.0): `AgentRunContext.block.contextDocs` items now carry `summary` + `body`,
  `contextTasks` items carry `summary`, and `DocumentRecord` carries `contentHash`. The
  `DocumentRepository`/`TaskRepository` ports gain a `getByUrl` method (implemented on both the
  D1 and Drizzle stores). The executor-harness image gains an optional `contextFiles` job field;
  bump the runner image tag.

### Patch Changes

- Updated dependencies [be182e8]
  - @cat-factory/kernel@0.20.0
  - @cat-factory/agents@0.12.0
  - @cat-factory/integrations@0.16.0
  - @cat-factory/spend@0.8.19
  - @cat-factory/workspaces@0.7.25

## 0.14.0

### Minor Changes

- 2c24da8: Add a **human-testing gate** (`human-test`) pipeline step. When reached it spins up an
  ephemeral environment and PARKS for a person to validate the change in the live URL before
  the run continues. From the dedicated window the human can confirm (tear the env down +
  advance), submit findings to dispatch the Tester's `fixer` (then the env rebuilds for
  re-testing), pull latest main into the PR branch + redeploy (a clean merge rebuilds the env; a
  conflict dispatches the `conflict-resolver`), or recreate / destroy the env on demand. Falls
  back to a degraded manual mode (no live env, still parks for confirmation) when no
  ephemeral-environment provider is wired.

  New opt-in pipeline `pl_human_review` (`coder → reviewer → human-test → conflicts → ci →
merger`) and a palette block; existing default pipelines are unchanged.

  Adds a `GitHubClient.mergeBranch` (the repo Merges API) and a `BranchUpdater` port behind the
  "pull main" action, wired from the GitHub client on every facade (Worker / Node / local), plus
  a `human_test_ready` notification type (in-app + Slack-routable). Both runtimes wire the gate
  identically and the cross-runtime conformance suite asserts the park → request-fix → confirm
  flow.

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/contracts@0.20.0
  - @cat-factory/kernel@0.19.0
  - @cat-factory/integrations@0.15.0
  - @cat-factory/agents@0.11.16
  - @cat-factory/prompt-fragments@0.7.17
  - @cat-factory/spend@0.8.18
  - @cat-factory/workspaces@0.7.24

## 0.13.0

### Minor Changes

- 4120ac5: Nested tasks (epics) + a first-class task dependency graph.

  **Epics** are a new non-structural block level (`level: 'epic'`). An epic groups tasks
  that may live under different services/modules via the tasks' new `epicId` membership
  link (independent of `parentId`, so deleting an epic clears membership but never deletes
  the member tasks). The board draws an epic node linked to all its members, and the epic
  inspector shows the full member tree grouped service → module → task. Add one via
  `POST /workspaces/:ws/epics`; assign/detach a task via `POST /blocks/:id/epic`.

  **Importing a Jira epic / GitHub parent issue** spawns the epic + its children onto the
  board in one shot (`POST /workspaces/:ws/task-sources/:source/epics/spawn`, or the "As
  epic" button in the issue-import modal): an epic node, a board task per child issue
  (joined to the epic), and `dependsOn` edges seeded from the issues' **"blocked by" /
  "depends on"** links. Jira links come from `issuelinks` + `parent`/`subtasks` + epic
  children (JQL); GitHub children come from native **sub-issues** and dependency links are
  parsed from the issue body (`Blocked by #12`, `Depends on owner/repo#34`). The
  `GitHubClient` port gains `listSubIssues` + a `parentRef` on issue detail.

  **Dependency enforcement** is now hard and server-side: `ExecutionService.start()` refuses
  (409) to start a task while any block it `dependsOn` is unfinished — enforced for manual,
  recurring, auto-start and direct-API starts alike. Adding a dependency edge that would
  close a **cycle** is rejected (422).

  **Auto-start**: a preceding task carries an `autoStartDependents` toggle (task inspector).
  When it merges, the engine automatically starts every task that depends on it whose other
  dependencies are also done — skipping any on an individual-usage model (which can't unlock
  unattended).

  **Board UX**: a drag-to-connect handle on task cards creates dependency edges directly on
  the canvas (drag from the prerequisite onto the dependent); the dependency-edge overlay
  also draws epic→member membership links.

  Persisted on both runtimes (D1 migration `0010_epics_dependencies` ⇄ Drizzle
  `epic_id` / `auto_start_dependents` columns); the cross-runtime conformance suite asserts
  the epic + membership round-trip, the cycle rejection, and the dependency start gate on
  each store.

  Breaking (pre-1.0, acceptable): the `blocks` table gains `epic_id` / `auto_start_dependents`
  columns and the `level` enum gains `epic`; no migration shims.

### Patch Changes

- Updated dependencies [4120ac5]
  - @cat-factory/contracts@0.19.0
  - @cat-factory/kernel@0.18.0
  - @cat-factory/integrations@0.14.0
  - @cat-factory/agents@0.11.15
  - @cat-factory/prompt-fragments@0.7.16
  - @cat-factory/spend@0.8.17
  - @cat-factory/workspaces@0.7.23

## 0.12.0

### Minor Changes

- 25efe48: Add UI-configurable provider config + per-user GitHub PAT, with provider self-describe and connection-test.

  - Providers self-describe the config they expect (`describeConfig`) and can be connection-tested (`testConnection`) before saving — added as optional methods on the `EnvironmentProvider` and `RunnerPoolProvider` kernel ports, implemented by the generic HTTP adapters (secret-key fields from the manifest + an authed probe), and surfaced via new `GET …/environments/provider`, `POST …/environments/connection/test`, `GET …/runner-pool/provider`, `POST …/runner-pool/connection/test` endpoints. The SPA renders the descriptor fields generically.
  - New generic, `kind`-discriminated per-user secret store (`user_secrets`, mirrored D1 ⇄ Drizzle) with `UserSecretService` + a kind registry (first kind: `github_pat`). User-scoped `GET/POST/DELETE /user-secrets` + `…/test`; a "My GitHub token" entry under Integrations → Source control.
  - A run you initiate now prefers YOUR stored GitHub PAT over the deployment's GitHub App / env token for the container push token AND the engine CI-gate + merge reads (resolved by the run initiator via an ambient `RunInitiatorScope`), falling back to the existing source when you have none. Wired symmetrically across the Cloudflare, Node and local facades.

  Breaking: none for existing data. The local-mode `GITHUB_PAT` env var still works as a fallback.

### Patch Changes

- Updated dependencies [25efe48]
  - @cat-factory/contracts@0.18.0
  - @cat-factory/kernel@0.17.0
  - @cat-factory/integrations@0.13.0
  - @cat-factory/agents@0.11.14
  - @cat-factory/prompt-fragments@0.7.15
  - @cat-factory/spend@0.8.16
  - @cat-factory/workspaces@0.7.22

## 0.11.1

### Patch Changes

- c7b8012: Improve the requirements-review experience.

  **Auto-save answers (no button).** The requirements-review window no longer has a "Save
  answer" button: an answer is seeded into its textarea from the recorded reply and persisted
  on blur (and flushed before incorporate/proceed), so a value just needs to be typed.

  **"Recommend something" + the Requirement Writer.** A finding can now be marked for a
  grounded recommendation instead of being answered or dismissed. A new second companion of
  the requirements reviewer — the **Requirement Writer** (an inline LLM call, `WRITER_SYSTEM_PROMPT`
  `requirement-writer@v1`) — produces a suggested answer per finding, grounded in this
  precedence order: the block's **best-practice fragments** (team/org standards — checked
  FIRST; a match is flagged as the "current standard" and surfaced with a badge), then the
  in-repo `spec/` + `tech-spec/` (via the checkout-free `RepoFiles` port), then web search
  (provider-hosted on Anthropic/OpenAI models; gateway-RAG wiring lands separately).
  Recommendations are NOT AI-reviewed — the human accepts (it becomes the finding's answer,
  folded into the next incorporation), rejects, or re-requests with a "do it differently"
  note. Recommendations are a first-class collection on the review that survives the re-review
  item churn.

  - Contracts: `recommend_requested` item status, `RequirementRecommendation` +
    `recommendations[]` on `RequirementReview`, and the request schemas.
  - Persistence (both runtimes): a `recommendations` JSON column on `requirement_reviews`
    (new D1 migration `0009` ⇄ Drizzle column + generated migration).
  - Service: `RequirementReviewService.recommend` / `acceptRecommendation` /
    `rejectRecommendation` / `reRequestRecommendation`, with optional `resolveRunRepoContext`
    - best-practice-fragment resolver deps (degrade gracefully when unwired).
  - Controller: `POST /blocks/:blockId/requirement-review/recommend` and the
    `…/recommendations/:recId/{accept,reject,re-request}` routes.

  **Board progress for the review companions.** While the review is incorporating, re-reviewing
  or recommending, the board task card / mini-pipeline / inspector now show a spinning stage
  label (`Recommending…` added alongside the existing `Incorporating…` / `Re-reviewing…`).

- Updated dependencies [c7b8012]
  - @cat-factory/contracts@0.17.1
  - @cat-factory/kernel@0.16.2
  - @cat-factory/agents@0.11.13
  - @cat-factory/integrations@0.12.4
  - @cat-factory/prompt-fragments@0.7.14
  - @cat-factory/spend@0.8.15
  - @cat-factory/workspaces@0.7.21

## 0.11.0

### Minor Changes

- aa06003: Service-level default test environment. A service frame now carries a
  `defaultTestEnvironment` (docker-compose **local** vs **ephemeral**) that a task is
  spawned with; each task can still override it per-task via its `tester.environment`
  agent config. The engine resolves the effective environment at run time (task pin →
  service default → built-in `ephemeral`) and materialises it onto the run context, so
  the Tester job body, the prompt and the start-time infra gate all agree. Set the
  default in the service inspector's Test infrastructure panel; the task inspector shows
  the inherited value and labels it "inherited from service" until overridden.

  The cloud-provider and instance-size controls are now explained as **hints for
  ephemeral-environment provisioning** and tucked into a collapsed-by-default section.

  Persisted on both runtimes (D1 migration `0009_default_test_environment` ⇄ Drizzle
  `default_test_environment` column); the cross-runtime conformance suite asserts the
  inheritance + per-task override on each.

### Patch Changes

- Updated dependencies [aa06003]
  - @cat-factory/contracts@0.17.0
  - @cat-factory/kernel@0.16.1
  - @cat-factory/agents@0.11.12
  - @cat-factory/integrations@0.12.3
  - @cat-factory/prompt-fragments@0.7.13
  - @cat-factory/spend@0.8.14
  - @cat-factory/workspaces@0.7.20

## 0.10.9

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0
  - @cat-factory/agents@0.11.11
  - @cat-factory/integrations@0.12.2
  - @cat-factory/spend@0.8.13
  - @cat-factory/workspaces@0.7.19

## 0.10.8

### Patch Changes

- Updated dependencies [494fb34]
  - @cat-factory/kernel@0.15.1
  - @cat-factory/integrations@0.12.1
  - @cat-factory/agents@0.11.10
  - @cat-factory/spend@0.8.12
  - @cat-factory/workspaces@0.7.18

## 0.10.7

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0
  - @cat-factory/contracts@0.16.0
  - @cat-factory/integrations@0.12.0
  - @cat-factory/agents@0.11.9
  - @cat-factory/spend@0.8.11
  - @cat-factory/workspaces@0.7.17
  - @cat-factory/prompt-fragments@0.7.12

## 0.10.6

### Patch Changes

- Updated dependencies [7d1f829]
  - @cat-factory/agents@0.11.8

## 0.10.5

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/contracts@0.15.0
  - @cat-factory/kernel@0.14.0
  - @cat-factory/integrations@0.11.0
  - @cat-factory/agents@0.11.7
  - @cat-factory/prompt-fragments@0.7.11
  - @cat-factory/spend@0.8.10
  - @cat-factory/workspaces@0.7.16

## 0.10.4

### Patch Changes

- 77b7d31: Migrate the `spec-writer` built-in agent onto the generic, manifest-driven `agent` harness
  kind, continuing the Task-5 strangler (after the read-only kinds, the merger/on-call/fixers,
  the coder, and blueprints).

  `ContainerAgentExecutor` now routes `spec-writer` through `buildMigratedBuiltInBody` →
  `buildRegisteredAgentBody` as a read-only `mode: 'explore'` structured agent that clones the
  per-block WORK branch (`cat-factory/<blockId>` — the coder's branch, created from base when
  absent; the spec-writer runs BEFORE the coder, so it seeds that branch) instead of the
  bespoke `/spec` body. The agent now READS the baseline spec from its own checkout under
  `spec/` (the harness no longer pre-injects it) and returns ONLY the complete spec doc as JSON;
  `toRunResult` coerces that `custom` result into the `spec` channel (via `coerceSpecDoc`) the
  engine already strict-validates + ingests. The `SPEC_WRITER_SYSTEM_PROMPT` is updated to point
  the agent at `spec/overview.md` + the `spec/modules/**` shards, and a new `specWriterUserPrompt`
  carries the task increment + the read-the-baseline / reuse-the-taxonomy guidance the harness
  `buildUserPrompt`/`renderTaxonomyInventory` used to inject.

  The deterministic SHARD + commit of the in-repo `spec/` artifact that used to live in the
  executor-harness `/spec` handler now runs as a BACKEND built-in post-op (`specPostOp`,
  `@cat-factory/agents`), over the checkout-free `RepoFiles` port. It is keyed by the engine's
  own built-in op map in `ExecutionService` — deliberately NOT the agent-kind registry, so the
  built-ins never leak into `customAgentKinds` / the SPA palette. It reproduces the harness
  reconcile exactly: the canonical `service.json` / `overview.md` / `modules/<m>/<g>.{json,md}`
  shards are always rewritten and a removed module/group's shards are PRUNED (the deletion
  channel); the Gherkin `features/<m>/<g>.feature` files are SEEDED-ONCE (committed only when
  absent, never clobbering a polished one); and the pre-sharding monolithic artifacts
  (`spec/spec.json` / `rules.md` / `version.json`) + old flat `features/*.feature` files are
  dropped on sight. Idempotent: the spec has no `version.json` manifest, so the post-op
  byte-compares each rendered shard to the branch and makes NO commit when everything matches
  and there is nothing to seed or prune (durable-driver replay re-commits nothing).

  Because the spec doc is handed onward to be sharded + committed, the migrated kind opts into
  a new `output.failOnUnusableFinal` flag (kernel `AgentOutputSpec`) so the generic explore
  handler FAILS the run LOUDLY when the agent's final answer is cut off at the output ceiling
  (or empty) — restoring the bespoke `/spec` handler's `unusableFinalAnswerCause` gate, which
  the generic `handleAgent` path lacked, so a truncated reply can no longer be laundered into a
  half-baked spec by the structured repair. This is a harness change, so the executor-harness
  image is bumped to `1.12.0` (the `deploy/backend` `image:publish` tag + `wrangler.toml` are
  bumped to match). The dead `/spec` handler is removed in a later sweep step.

  Cross-runtime conformance asserts the post-op shards + commits the `spec/` artifact onto the
  work branch via `RepoFiles` on both runtimes.

  Also fixes a facade-parity gap in the self-hosted runner-pool result coercion
  (`HttpRunnerPoolProvider.coerceRunnerResult`): the generic `agent`-kind structured channel
  `custom` was missing from the pass-through allow-list, so a migrated kind's doc
  (blueprints / spec-writer / merger / on-call) was silently dropped on a runner-pool backend
  while the Cloudflare/local transports — which return the harness view verbatim — kept it.
  `custom` now passes through, and a regression test covers it.

- Updated dependencies [77b7d31]
  - @cat-factory/agents@0.11.6
  - @cat-factory/kernel@0.13.4
  - @cat-factory/integrations@0.10.4
  - @cat-factory/spend@0.8.9
  - @cat-factory/workspaces@0.7.15

## 0.10.3

### Patch Changes

- Updated dependencies [82d771e]
  - @cat-factory/contracts@0.14.0
  - @cat-factory/agents@0.11.5
  - @cat-factory/integrations@0.10.3
  - @cat-factory/kernel@0.13.3
  - @cat-factory/prompt-fragments@0.7.10
  - @cat-factory/spend@0.8.8
  - @cat-factory/workspaces@0.7.14

## 0.10.2

### Patch Changes

- ce27690: Migrate the `blueprints` built-in agent onto the generic, manifest-driven `agent` harness
  kind, and add a checkout-free file-DELETION channel the migration needs.

  `ContainerAgentExecutor` now routes `blueprints` through `buildMigratedBuiltInBody` →
  `buildRegisteredAgentBody` as a read-only `mode: 'explore'` structured agent (cloning the PR
  branch when one is open, else the default branch — exactly its old `prBranch ?? baseBranch`
  clone) instead of the bespoke `/blueprint` body. The agent now returns ONLY the service →
  modules tree as JSON; `toRunResult` coerces that `custom` result into the `blueprintService`
  channel (via `coerceBlueprintService`) the engine already reconciles onto the board.

  The deterministic render + commit of the in-repo `blueprints/` artifact that used to live in
  the executor-harness `/blueprint` handler now runs as a BACKEND built-in post-op
  (`blueprintPostOp`, `@cat-factory/agents`), over the checkout-free `RepoFiles` port. It is
  keyed by the engine's own built-in op map in `ExecutionService` — deliberately NOT the
  agent-kind registry, so the built-ins never leak into `customAgentKinds` / the SPA palette.
  The post-op is idempotent (the `version.json` content hash short-circuits an unchanged tree,
  so a durable-driver replay re-commits nothing) and prunes a removed module's stale deep-dive
  file — the checkout-free analogue of the harness wiping `blueprints/` before writing.

  To support that prune, `commitFilesSchema` / `CommitFilesInput` (and the `RepoFiles` /
  `GitHubClient` `commitFiles` impl in `FetchGitHubClient`) gain an optional `deletions:
string[]`: paths removed in the same commit, built into the Git Data tree as `sha: null`
  entries against the base tree. Additive and non-breaking (absent ⇒ a pure add/update commit).

  The already-shipped executor-harness image serves this via its generic `handleAgent`
  explore-structured handler, so **no image bump is required**. One intentional, low-risk delta:
  the blueprint explore body now carries the shared web-tools fields like every other explore
  agent (gated by `webSearchProxyEnabled`), and the agent reads any existing blueprint from its
  own checkout rather than the harness pre-injecting the baseline tree into the prompt.

  The now-dead `/blueprint` harness handler is removed in a later step of the sweep (which
  bumps the executor image), once parity is confirmed on CI. The cross-runtime conformance
  suite gains an assertion that a `blueprints` step's post-op renders + commits the
  `blueprints/` artifact via `RepoFiles`, identically on both runtimes.

- Updated dependencies [ce27690]
  - @cat-factory/contracts@0.13.1
  - @cat-factory/kernel@0.13.2
  - @cat-factory/agents@0.11.4
  - @cat-factory/integrations@0.10.2
  - @cat-factory/prompt-fragments@0.7.9
  - @cat-factory/spend@0.8.7
  - @cat-factory/workspaces@0.7.13

## 0.10.1

### Patch Changes

- c8bd144: Migrate the next batch of built-in agents — `coder`, `ci-fixer`, `fixer`, `merger` and
  `on-call` — onto the generic, manifest-driven `agent` harness kind, continuing the
  strangler started with the read-only kinds.

  `ContainerAgentExecutor` now routes these through `buildMigratedBuiltInBody` →
  `buildRegisteredAgentBody` (which gained an optional `userPrompt` override) instead of their
  bespoke per-kind bodies:

  - `coder` dispatches `kind: 'agent'` in `mode: 'coding'` (clone the work branch, push it,
    open a PR). `runCodingAgent` already does branch-resume + checkpointing, so this is
    behaviour-equivalent to the old `/run` body.
  - `ci-fixer` / `fixer` dispatch `mode: 'coding'` against the PR branch with
    `noChangesIsError: false` (in-place fixers — a no-op is a clean non-event), matching the
    old `/ci-fix` / `/fix-tests` bodies.
  - `merger` / `on-call` dispatch `mode: 'explore'` with structured output (full clone). The
    conservative JSON coercion that used to live in the harness `/merge` and `/on-call`
    handlers now runs backend-side: `toRunResult` is kind-aware and maps the agent's `custom`
    result into `mergeAssessment` / `onCallAssessment` via `coerceMergeAssessment` /
    `coerceOnCallAssessment`, so the engine's merge resolver and post-release-health gate see
    exactly the same assessment shape as before.

  The already-shipped executor-harness image serves all of these via its generic `handleAgent`
  handler (explore-structured + coding-on-PR/coding-with-PR), so no image bump is required.
  Two intentional, low-risk deltas: the merger/on-call explore bodies now carry the shared
  web-tools fields like every other explore agent (gated by `webSearchProxyEnabled`), and the
  merger's container-side `diffExaminable` guard is replaced by the backend coercion's
  conservative-on-garbage defaults (documented in `coerceMergeAssessment`).

  The now-dead `/run`, `/ci-fix`, `/fix-tests`, `/merge` and `/on-call` harness handlers are
  removed in a later step of the sweep (which bumps the executor image), once parity is
  confirmed on CI.

  Three correctness fixes to the kind-aware mapping itself:

  - The poll site (`ExecutionService.pollAgentJob`) now threads `step.agentKind` into the
    `pollJob` handle. `toRunResult`'s kind-aware coercion keys off `handle.agentKind`, which
    the engine previously never supplied at poll time — so the merger/on-call coercion was
    dead code and `mergeAssessment` / `onCallAssessment` were never set, leaving the merge
    gate and post-release-health gate with no assessment.
  - `clamp01` no longer coerces `null` / `''` / `false` / `[]` to a finite `0` (via `Number()`):
    those now fall back to the conservative default (`1` for the merger → routes to human
    review), so a garbage/null score can't silently read as "trivial/safe" and auto-merge.
  - The coerced `rationale` falls back to a stable `"No rationale provided."` when both the
    agent rationale and the run summary are empty, instead of an empty string.

- Updated dependencies [c8bd144]
  - @cat-factory/kernel@0.13.1
  - @cat-factory/agents@0.11.3
  - @cat-factory/integrations@0.10.1
  - @cat-factory/spend@0.8.6
  - @cat-factory/workspaces@0.7.12

## 0.10.0

### Minor Changes

- 5c915fd: Replace the deployment-level `TASK_SOURCES` env allow-list with a per-workspace,
  UI-driven on/off toggle for each task source (Jira / GitHub Issues), persisted in DB.

  A source is now offered to a workspace when it is **available** AND **enabled**:

  - Availability is intrinsic, not a deployment switch. Jira is always registered (its
    credentials are per-workspace, entered in the UI) and is available once connected.
    GitHub Issues registers whenever the GitHub integration is configured and is available
    once the workspace has installed the GitHub App — it rides that App, so there is nothing
    to "connect" (the credentialless connect path now returns a clear error).
  - `enabled` is the new per-workspace toggle (defaults to on). A workspace can disable
    GitHub Issues to use GitHub repos without offering their issues, or park a connected
    Jira without disconnecting it. A disabled source is hidden from the import/link UI and
    its import/search endpoints are refused (409).

  New surface:

  - `task_source_settings` table, mirrored D1 (migration `0008_task_source_settings.sql`)
    ⇄ Drizzle (`taskSourceSettings` + generated migration), behind a new
    `TaskSourceSettingsRepository` kernel port.
  - `GET /workspaces/:ws/task-sources` now returns each source's descriptor plus
    `available` + `enabled`; `PUT /workspaces/:ws/task-sources/:source/enabled` toggles it.
  - The SPA settings modal hosts the toggle, and import entry points key off the offered
    (available + enabled) set instead of raw connections.

  BREAKING: the `TASK_SOURCES` env var (Cloudflare `wrangler.toml` / Node `.env`) and
  `TasksConfig.sources` are removed. Delete `TASK_SOURCES` from any deployment config —
  which sources a workspace uses is now controlled in the app, not by the operator.

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/contracts@0.13.0
  - @cat-factory/kernel@0.13.0
  - @cat-factory/integrations@0.10.0
  - @cat-factory/agents@0.11.2
  - @cat-factory/prompt-fragments@0.7.8
  - @cat-factory/spend@0.8.5
  - @cat-factory/workspaces@0.7.11

## 0.9.1

### Patch Changes

- Updated dependencies [22d7fff]
  - @cat-factory/agents@0.11.1

## 0.9.0

### Minor Changes

- 128e12e: Custom agents: live pre/post-op execution + data-driven palette + generic result view.

  Registered custom agent kinds now run end to end. A kind's deterministic backend hooks
  fire around its agent step: `ExecutionService` runs its `preOps` before dispatch and its
  `postOps` after the result is recorded, over a per-run, checkout-free `RepoFiles` bound to
  the run's repo. The binding is a new optional engine dependency `resolveRunRepoContext`
  (`CoreDependencies` / `ExecutionServiceDependencies`), composed from a facade's wired
  `GitHubClient` + the executor's `resolveRepoTarget` via the new
  `makeResolveRunRepoContext` (`@cat-factory/server`) and wired symmetrically across ALL
  three facades (Worker `selectGitHubDeps`, Node `githubGateDeps`, local via
  `buildNodeContainer`). When GitHub isn't connected the hooks are skipped, so pipelines run
  unchanged without the feature. `runRepoOps` moved to `@cat-factory/agents` so the
  orchestration engine drives the hooks without importing the server HTTP layer. New kernel
  ports: `RunRepoContext` + `ResolveRunRepoContext`. The cross-runtime conformance suite
  asserts a registered kind's pre-op read + post-op commit on both D1 and Postgres.

  Frontend: the workspace snapshot now carries `customAgentKinds` (kind + presentation +
  container flag), which the SPA merges into its palette catalog
  (`useAgentsStore().registerCustomKinds`) so a registered kind is a first-class palette
  block + result view instead of the generic fallback. A `container-explore` structured
  kind's `result.custom` JSON is recorded on the step (new `PipelineStep.custom`) and
  rendered read-only by a new shared `generic-structured` result view — a custom agent gets
  a usable result window with no bespoke UI.

  The built-in agents are not yet migrated to this model (their rendering still lives in the
  executor-harness); that strangler conversion is sequenced as follow-up work. See
  `backend/docs/custom-agents.md` and the `@cat-factory/example-custom-agent` worked example.

- 4de2f5f: Declutter settings/navbar and make post-release health a pluggable observability integration.

  **Frontend**

  - Workspace settings is now a single tabbed window: **Merge thresholds**, **Issue writeback**
    and **Default service best practices** moved from standalone modals into tabs (their navbar/
    command-bar entries now deep-link to the tab). Fixed the **Mode** select clipping its options.
  - Removed the **Add a block** button and **all** "Add &lt;type&gt; block" command-bar commands
    (services come from Bootstrap / Add-from-repo, tasks from the add-task flow); dropped the
    unsupported `external` / `environment` block types.
  - The new-task form now shows **Context documents** and **Context issues** sections (inspector-
    style) **ungated** — the _Attach_ button is disabled with a tooltip until the relevant
    integration is connected. (`ContextPicker.vue` removed.)
  - Post-release health is no longer a Datadog-named window: the **connection** is an
    **Observability** entry in the Integrations hub (`ObservabilityConnectionPanel`, provider
    picker — Datadog today), and the per-service **monitor/SLO mapping** moved into the **service
    inspector** (`ServiceReleaseHealthConfig`, keyed by the selected frame — no manual block-id
    entry, disabled with a hint until a connection exists).

  **Backend — pluggable observability (Datadog = one adapter)**

  - The `ReleaseHealthProvider` is now served by `RegistryReleaseHealthProvider`, a registry of
    per-vendor adapters; the Datadog logic became `DatadogObservabilityAdapter`. Adding a second
    provider is a new registry entry — the gate, service, routes and persistence are vendor-neutral.

  **Breaking (acceptable per pre-1.0 policy — no migration):**

  - Persistence: the `datadog_connections` table is **dropped** and replaced by
    `observability_connections` (`provider` discriminator + a single sealed `credentials` JSON blob
    - a non-secret `summary`), mirrored D1 ⇄ Drizzle. Existing connections must be re-entered.
  - Kernel: `DatadogConnectionRecord`/`DatadogConnectionRepository` →
    `ObservabilityConnectionRecord`/`ObservabilityConnectionRepository` (+ `ObservabilityProviderKind`).
  - Contracts: `upsertDatadogConnectionSchema` / `datadogConnectionViewSchema` →
    `upsertObservabilityConnectionSchema` / `observabilityConnectionViewSchema` (now `{ provider,
credentials }` / `{ connected, provider, summary }`), plus `observabilityConnectionSummary`.
  - HTTP: `GET|PUT|DELETE /workspaces/:ws/datadog/connection` → `…/observability/connection`.
  - Config/env: `DATADOG_ENABLED` → `OBSERVABILITY_ENABLED`; `AppConfig.datadog` → `AppConfig.releaseHealth`
    (`DatadogConfig` → `ReleaseHealthConfig`); the sealed-secret domain tag `cat-factory:datadog` →
    `cat-factory:observability`.

  Note: the cross-runtime conformance suite does not yet cover the observability connection CRUD
  (it never covered the Datadog connection either); both facades wire the same repos/cipher/provider
  and ship mirrored D1 + Drizzle migrations.

### Patch Changes

- 4de2f5f: Review fixes for the declutter/observability pass:

  - **Board no longer crashes on `external`/`environment` blocks.** Those types stay
    user-uncreatable, but the backend still emits them (the seeded third-party service and
    the environments integration), so they are restored to the frontend `BlockType` union +
    `BLOCK_TYPE_META` for display parity with the contracts `blockTypeSchema`. `blockTypeMeta()`
    adds a safe fallback so an unknown/legacy block type degrades instead of throwing on the board.
  - **Integrations hub gates the Observability row on availability.** The `releaseHealth` store
    now probes an `available` flag (mirroring the other integration stores); the hub hides the
    "Post-release health" entry when `OBSERVABILITY_ENABLED` is off, instead of showing a dead
    row that only 503s.
  - **De-duplicated release-health loads.** `ensureLoaded()` coalesces repeated hub opens /
    frame-inspector mounts so they reuse the resolved connection + configs rather than re-fetching
    the whole configs list on every service selection.
  - **Vendor-neutral gate message.** The post-release-health pipeline guard now says "Connect an
    observability provider" instead of the leftover "Connect Datadog".
  - **Validated credentials at the registry boundary.** `parseDatadogCredentials` validates the
    decrypted blob in the observability registry, so a drifted/corrupted row fails with a clear
    error instead of deep inside the Datadog client during a live probe.

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/agents@0.11.0
  - @cat-factory/contracts@0.12.0
  - @cat-factory/integrations@0.9.0
  - @cat-factory/spend@0.8.4
  - @cat-factory/workspaces@0.7.10
  - @cat-factory/prompt-fragments@0.7.7

## 0.8.1

### Patch Changes

- f8a24e0: Refresh dependencies to latest. Notable major bumps: TypeScript 5→6 (tooling
  packages), vitest 3→4, pino 9→10, `@hono/node-server` 1→2, `@hono/valibot-validator`
  0.5→0.6, happy-dom 15→20, and `@types/node` →26. Patch/minor refreshes for `ai`,
  `hono`, `wrangler`, `pg-boss`, `ws`, `@ai-sdk/*`, `oxlint`, and the Cloudflare
  workers tooling.
- Updated dependencies [f8a24e0]
  - @cat-factory/agents@0.10.1
  - @cat-factory/integrations@0.8.3
  - @cat-factory/kernel@0.11.1
  - @cat-factory/spend@0.8.3
  - @cat-factory/workspaces@0.7.9

## 0.8.0

### Minor Changes

- 1e31cbc: Replace per-agent-kind model defaults with named **model presets**.

  A workspace now keeps a library of model presets instead of a single per-agent-kind
  default map. A preset is one `baseModelId` applied to every agent kind plus optional
  per-kind `overrides`, so "everything Kimi K2.7" is a base with no overrides. Two
  built-ins are seeded for every workspace: **Kimi K2.7** (the default — every agent runs
  on Kimi K2.7) and **GLM-5.2**. A task selects a preset via the new `Block.modelPresetId`
  (the inspector's "Model preset" picker + the new-task form); changing it affects only
  steps that haven't started yet. Resolution precedence is unchanged in spirit: a block's
  pinned model wins, else the task's selected/default preset's mapping for the kind, else
  the env routing.

  - `@cat-factory/contracts`: new `model-presets.ts` (`ModelPreset`, create/update schemas);
    `Block.modelPresetId`; `addTask`/`updateBlock` accept `modelPresetId`; the snapshot
    carries `modelPresets` instead of `modelDefaults`. The `model-defaults` contract is removed.
  - `@cat-factory/kernel`: new `ModelPresetRepository` port (replaces `ModelDefaultsRepository`),
    `DEFAULT_MODEL_PRESETS` seed + `modelForKindFromPreset` helper; `resolveWorkspaceModelDefault`
    resolvers gain an optional `modelPresetId` argument throughout.
  - `@cat-factory/orchestration`: `ModelPresetService` (CRUD + lazy seeding, replaces
    `ModelDefaultsService`) and `resolvePresetModelForKind`; the execution engine threads the
    block's preset into model resolution, the personal-credential gate and the start guard.
  - `@cat-factory/agents`: `StepModelInputs.modelPresetId` + the resolver signature.
  - `@cat-factory/server`: `ModelPresetController` (`GET|POST|PATCH|DELETE
/workspaces/:ws/model-presets`, replaces the model-defaults controller); the block mappers
    persist `model_preset_id`; the snapshot lists `modelPresets`.
  - `@cat-factory/worker` / `@cat-factory/node-server`: the `model_presets` table (D1 migration
    `0006` ⇄ Drizzle) + `blocks.model_preset_id`, replacing `workspace_model_defaults`.

  BREAKING (pre-1.0, no migration): the `workspace_model_defaults` table, the
  `/model-defaults` endpoint, and the snapshot's `modelDefaults` field are removed. Existing
  per-agent-kind default maps are dropped; workspaces fall back to the seeded built-in presets.

### Patch Changes

- Updated dependencies [1e31cbc]
  - @cat-factory/contracts@0.11.0
  - @cat-factory/kernel@0.11.0
  - @cat-factory/agents@0.10.0
  - @cat-factory/integrations@0.8.2
  - @cat-factory/prompt-fragments@0.7.6
  - @cat-factory/spend@0.8.2
  - @cat-factory/workspaces@0.7.8

## 0.7.7

### Patch Changes

- Updated dependencies [d0081e1]
  - @cat-factory/contracts@0.10.0
  - @cat-factory/agents@0.9.0
  - @cat-factory/integrations@0.8.1
  - @cat-factory/kernel@0.10.1
  - @cat-factory/prompt-fragments@0.7.5
  - @cat-factory/spend@0.8.1
  - @cat-factory/workspaces@0.7.7

## 0.7.6

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/contracts@0.9.0
  - @cat-factory/kernel@0.10.0
  - @cat-factory/spend@0.8.0
  - @cat-factory/integrations@0.8.0
  - @cat-factory/agents@0.8.2
  - @cat-factory/prompt-fragments@0.7.4
  - @cat-factory/workspaces@0.7.6

## 0.7.5

### Patch Changes

- Updated dependencies [5c20968]
  - @cat-factory/kernel@0.9.0
  - @cat-factory/agents@0.8.1
  - @cat-factory/integrations@0.7.5
  - @cat-factory/spend@0.7.5
  - @cat-factory/workspaces@0.7.5

## 0.7.4

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/agents@0.8.0
  - @cat-factory/contracts@0.8.0
  - @cat-factory/kernel@0.8.0
  - @cat-factory/integrations@0.7.4
  - @cat-factory/prompt-fragments@0.7.3
  - @cat-factory/spend@0.7.4
  - @cat-factory/workspaces@0.7.4

## 0.7.3

### Patch Changes

- Updated dependencies [a0a1bcc]
  - @cat-factory/kernel@0.7.3
  - @cat-factory/spend@0.7.3
  - @cat-factory/agents@0.7.3
  - @cat-factory/integrations@0.7.3
  - @cat-factory/workspaces@0.7.3

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.
- Updated dependencies [4fa5ed9]
  - @cat-factory/agents@0.7.2
  - @cat-factory/contracts@0.7.2
  - @cat-factory/integrations@0.7.2
  - @cat-factory/kernel@0.7.2
  - @cat-factory/prompt-fragments@0.7.2
  - @cat-factory/spend@0.7.2
  - @cat-factory/workspaces@0.7.2

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
- Updated dependencies [7463cf2]
  - @cat-factory/agents@0.7.1
  - @cat-factory/contracts@0.7.1
  - @cat-factory/integrations@0.7.1
  - @cat-factory/kernel@0.7.1
  - @cat-factory/prompt-fragments@0.7.1
  - @cat-factory/spend@0.7.1
  - @cat-factory/workspaces@0.7.1

## 0.7.0

### Minor Changes

- fe53445: Add an existing GitHub repository to the board as a service, with no bootstrap
  run. A new "Add from existing repo" button (sidebar, Repositories section) opens
  a picker of repos the GitHub App can access — including ones the workspace
  doesn't track yet — plus a link to grant the App access to more repos. Importing
  links + syncs the repo into the workspace (if needed), creates a `ready` service
  frame titled after the repo, and links the repo projection to it so tasks dropped
  on the frame target that repo. Backed by `POST /workspaces/:ws/blocks/from-repo`
  (`BoardService.addServiceFromRepo` + `GitHubSyncService.linkRepo`).
- d94e75c: Agent step-detail overlay, with execution timing.

  Clicking any agent — in the inspector's pipeline list (`TaskExecution`) or the
  zoomed-in pipeline (`PipelineProgress`) — now opens a full-screen detail overlay
  for that step instead of expanding a cramped inline teaser. The overlay resolves
  the step live from the execution store and always shows its metadata: state,
  **execution duration** (counting up live while the step runs), started/finished
  timestamps, model, step position, the live subtask breakdown, applied standards,
  and any decision/approval. When the agent produced prose (architect, researcher,
  reviewer, …) the overlay also renders it as markdown (via `markdown-it`,
  `html: false` so raw HTML is escaped), split into **collapsible sections** at each
  heading with an **auto-generated table-of-contents sidebar**; clicking an entry
  expands and scrolls to its section, and the in-view section stays highlighted as
  you scroll.

  To support this, pipeline steps now track timing: `PipelineStep` gains
  `startedAt` / `finishedAt` (epoch ms), stamped by `ExecutionService` when a step
  transitions to `working` / `done`. Both are set-once so a Workflows replay or an
  approval-gate re-assertion preserves the agent's true execution window; an explicit
  "request changes" re-run clears them so the fresh attempt is timed from scratch.
  Steps persist as JSON, so no migration is required.

- 3d9a9d8: Requirements incorporation + re-review now run asynchronously instead of freezing the
  review window.

  Previously, clicking "Incorporate answers" fired two sequential LLM calls (fold the answers,
  then re-review) inside the HTTP request, locking the user in the modal until the round
  resolved. Now the request records the human's intent on the parked run, signals the durable
  driver, and returns at once with the review in a new transient `incorporating` status. The
  fold + re-review run in the same durable driver the rest of the pipeline uses (where the
  initial reviewer pass already runs), so the user goes straight back to the board. They are
  summoned again — via the existing `requirement_review` notification — only when the
  re-review raises new findings (`ready`) or hits the iteration cap (`exceeded`); a converged
  re-review (`incorporated`) just advances the pipeline with no interruption.

  - **Engine.** The `requirements-review` gate is now re-entrant: a parked gate carrying a
    `pendingIncorporation` marker re-evaluates on wake, runs `incorporate()` + `reReview()`,
    then advances or re-parks. New `ExecutionService.incorporateRequirements` validates the
    findings are settled, flags the review `incorporating`, and signals the driver. An
    off-path inspector review with no parked run still incorporates inline (there is no driver
    to offload to).
  - **Live event.** New optional `ExecutionEventPublisher.requirementReviewChanged` +
    `{ type: 'requirements' }` `WorkspaceEvent`, so an open window/inspector tracks the status
    transitions live (Cloudflare pushes via the DO hub; Node reconciles on poll, as today).
  - **API.** Incorporation moves to the block-scoped `POST
/blocks/:blockId/requirement-review/incorporate` (was the reviewId-scoped
    `/requirement-reviews/:reviewId/incorporate`) and returns the `incorporating` review
    rather than `{ review }`.
  - **Conformance.** A new cross-runtime assertion proves the async-incorporate route is
    mounted on every facade and refuses incorporation while a finding is unanswered.

  Breaking (pre-1.0, no migration): the new `incorporating` review status, the `requirements`
  event variant, the transient `pendingIncorporation` field on a pipeline step, and the moved
  incorporate endpoint are new wire shapes. Old clients and any in-flight review rows on the
  old endpoint shape simply break; stale state is acceptable per the no-backwards-compat
  policy.

- 3bc8c79: Capture the model's reasoning / "thinking" trace in LLM observability. A reasoning
  model (e.g. `@cf/moonshotai/kimi-k2.7-code`) can spend its whole output budget in a
  separate reasoning channel and return an empty completion — previously those output
  tokens were unaccounted for (`response_text` empty, no trace), which made an empty
  spec-writer/blueprint failure undiagnosable. The LLM proxy now records `reasoningText`
  alongside `responseText`: the Workers AI in-process path reads it from the AI SDK
  (`generateText`'s `reasoningText`), and the OpenAI-compatible buffered + streamed paths
  read `reasoning_content` / `reasoning`. Stored in the new `reasoning_text` column
  (`llm_call_metrics`, D1 migration `0002_llm_reasoning_text` ⇄ Drizzle), surfaced in the
  metrics export and the Observability panel, and used as the Langfuse trace output when
  the response text is empty.

  Breaking: the `llm_call_metrics` table gains a non-null `reasoning_text` column (old
  rows default to `''`).

- 8d11833: Companion agents + acceptance-test rework (the structured spec replaces the
  client-only scenario surface), plus a vocabulary split so "requirements" (the
  linked-prose context review) and "spec" (the structured in-repo document) are no
  longer the same word.

  - **Companion agents.** A companion grades a prior producer step's output, returns
    an overall quality rating (0..1), and — below the step's threshold (default 0.8) —
    loops the producer back for automatic rework BEFORE a human is asked, failing the
    run (`companion_rejected`) once the rework budget is spent. Companions declare an
    allow-list of target kinds and are placed as their own chain step in the pipeline
    builder (with a per-step `thresholds` array, parallel to `gates`). Built-ins:
    `architect-companion`, `spec-companion`, and `reviewer` reframed as the coder's
    companion. Wired into `ExecutionService` (`evaluateCompanion` + a unified rework
    revision path shared with the human "request changes" flow).
  - **Companion-gated requirements rework.** The per-block requirements review's
    rework step is now gated by a quality companion: below threshold the reworked doc
    is NOT accepted (the review stays `ready`), and the companion's challenge is
    surfaced in the review window and fed into the next rework. Persisted on
    `requirement_reviews.companion` (D1 migration 0036 + Drizzle).
  - **Acceptance tests via the spec.** The client-only scenarios store/UI is removed;
    the structured Given/When/Then acceptance scenarios live in the service spec
    (authored by the `spec-writer`, reviewed on its gated step) and are derived into
    Gherkin. The redundant `acceptance` polish agent is dropped; `playwright` still
    writes the runnable tests. `spec-writer`'s prompt now treats complete
    acceptance-scenario coverage as a first-class deliverable.
  - **`architect` is now a container agent** that explores the repo (read-only, like
    `analysis`) before proposing. Both read-only kinds share one reusable execution
    path: a new harness `/explore` endpoint (dispatch kind `explore`) clones the branch,
    runs the agent read-only and returns its prose report/proposal — making no commit,
    opening no PR, and (unlike `/run`) NOT treating an edit-free run as a failure. A
    shared read-only guardrail is appended to their system prompts.
  - **Companion rework correctness.** When a companion loops a producer back, EVERY step
    between the producer and the companion is now reset and re-run (clearing stale
    container job handles), so an intermediate container step re-dispatches fresh work
    instead of re-attaching to its evicted job. The automatic rework budget now counts
    only automatic attempts (`companion.attempts`); a human "request changes" on a
    companion's gate re-runs the producer without consuming it.
  - **Rename: requirements → spec** for the structured family. In-repo `requirements/`
    → `spec/` (`spec.json`, `spec/features/*.feature`; legacy `requirements/`
    relocated on first run); `RequirementsDoc` → `SpecDoc`; `requirements-writer` →
    `spec-writer`; the pipeline analyst `requirements` → `requirements-review`;
    `pl_requirements` → `pl_spec`. The context-review family (`RequirementReview*`,
    `requirement_reviews`) keeps the `requirements` name.

  The harness image changed (the `/requirements` endpoint + `requirements/` paths
  became `/spec` + `spec/`), so `@cat-factory/executor-harness` and the
  `deploy/backend` image tag are bumped to 1.0.6 and must be re-published + rolled out.

- 8065fed: Make the CI / conflicts gates observable. The gate window now shows the run id
  (copyable, with a jump into observability), a per-attempt history of every
  ci-fixer / conflict-resolver run (what each tried and how it ended), and — for
  the conflicts gate — the resolver's own account of which files it left
  conflicting (GitHub's API exposes mergeability as a single bit, so this comes
  from the resolver, plus a link to inspect the PR on GitHub). Failing CI checks
  now link straight to their GitHub run logs.

  Mechanically: `GateStepState` gains an append-only `attemptLog`; the engine
  records each gate-helper attempt when its job finishes (previously discarded the
  moment the gate re-probed) and sets the conflicts gate's `lastFailureSummary`
  from the resolver's output. `CiCheck` / `gateFailingCheckSchema` /
  `githubCheckRunSchema` carry the check run's `html_url` so the UI can link to it
  (populated on the live check-runs read; not persisted to the projection). The
  conflict-resolver result mapping now surfaces the still-conflicting file list
  (its `error`) instead of dropping it.

  Also tightens the conflict-resolver prompt: lockfiles (`package-lock.json`,
  `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, …) must be regenerated via the package
  manager rather than hand-merged — large generated files are what exhausted the
  resolver's context window and left big conflict sets unresolved.

- 385bd93: Add an optional consensus-orchestration framework + a core Task Estimator.

  A new opt-in `@cat-factory/consensus` package lets an eligible agent step run through
  a multi-model **consensus** process — a specialist panel, a debate, or ranked
  voting/scoring — to produce a higher-quality result of the same shape the single-actor
  agent would have (a polished document, an aggregate of observations, an estimate). It
  integrates via the `AgentExecutor` seam: a `ConsensusAgentExecutor` wraps the standard
  composite and delegates to it when a step isn't consensus-enabled or gating marks the
  task ineligible. Eligibility is surfaced through a new group of assignable capability
  traits (`specialist-panel-capable` / `debate-capable` / `ranked-voting-capable`); the
  pipeline builder shows an "Enable Consensus" toggle (strategy, participants + models,
  optional risk/impact gating) on eligible steps. Each session persists a full transcript
  (`consensus_sessions`, both runtimes) rendered in a dedicated Consensus Session window
  and streamed live via a new `consensus` workspace event; every sub-call flows to
  `llm_call_metrics`. Wired per facade behind `CONSENSUS_ENABLED` (off ⇒ unchanged).

  A new **core** `task-estimator` agent rates a task's Complexity/Risk/Impact (0..1) after
  requirements are clarified; the engine persists it on `block.estimate` (new column on
  both stores) and the inspector shows the ratings. It gates the expensive consensus step
  and is useful standalone for triage.

  BREAKING (pre-1.0, no migration): `Block` gains `estimate`, the pipeline + pipeline-step
  shapes gain `consensus`, `AgentRunContext` gains `consensus` + `block.estimate`, and the
  `WorkspaceEvent` union + `ExecutionEventPublisher` gain a consensus variant. Stale rows /
  shapes simply re-create.

- e9b9356: Create board tasks directly from imported GitHub issues or Jira tickets.

  Previously an imported issue could only be attached to an _existing_ task block as
  agent context. The task-source integration now also materialises an issue as a
  brand-new board task: `TaskLinkService.createTaskFromIssue` seeds a leaf block
  (title `KEY: summary`, description = a source-reference line + the issue body)
  inside a chosen service frame or module via `BoardService.addTask`, then links the
  issue to the new task so every agent step still sees the full issue (description,
  comments, metadata) as context. The issue stays the source of truth — re-importing
  refreshes it. Backed by `POST /workspaces/:ws/tasks/create-block`
  (`{ source, externalId, containerId }` → `{ block, task }`). In the UI, the
  task-source import modal gains a "create tasks in" container picker and a per-issue
  "Create task" action.

  The new task carries `createdBy` (the signed-in user, threaded through the widened
  `BoardWritePort.addTask`) for notification routing, the container is resolved in the
  request workspace so the workspace-scoped issue link always resolves at execution
  time, and creating a second task from an already-linked issue is refused (`409`)
  rather than silently re-pointing the single issue→block link. The shared
  cross-runtime conformance suite now asserts the whole create-task-from-issue flow
  (seeded over a deterministic task source) against BOTH the Cloudflare/D1 and the
  Node/Postgres facades.

  Also closes two cross-runtime parity gaps in the task-source layer so the feature
  works identically on both facades:

  - **GitHub issues as a task source now work on the Node runtime.** The
    runtime-neutral `GitHubIssuesProvider` (it depends only on the `GitHubClient` /
    `GitHubInstallationRepository` ports) moved from the Cloudflare package into the
    shared `@cat-factory/integrations`, the Node facade wires it whenever a GitHub
    client is available (the App is configured) — mirroring the Worker's
    `config.github.enabled` gate — AND `github` was added to the Node facade's
    task-source allow-list (it had been omitted, so the provider could never register).
    Previously only the Worker offered GitHub issues.
  - **Jira search now works on the Node runtime.** The duplicated per-runtime
    `JiraProvider` was hoisted into the shared `@cat-factory/integrations` (it is a thin
    runtime-neutral `fetch` shell, like `GitHubIssuesProvider`), so both facades now
    compose the SAME class — including `search()`, which the legacy Node copy had
    silently dropped.

- e8005ba: Datadog post-release-health gate + Agent-On-Call.

  After a release ships, a new **`post-release-health`** polling gate watches the team's
  Datadog **monitors/SLOs** over a monitoring window. It reuses the existing gate machinery
  (`ci`/`conflicts`): a clean window advances with nothing spun up; a regression escalates —
  Datadog credentials stay on the backend and never enter containers.

  The gate is **opt-in**: it is NOT in any default pipeline. A user adds it deliberately in
  the pipeline builder, and it only appears in the palette — and is only accepted by the
  backend — once the workspace has an **observability integration connected** (today a
  Datadog connection). `PipelineService` rejects a `create`/`update` that adds an enabled
  `post-release-health` step otherwise.

  - **No blind revert.** On a regression the gate dispatches an **`on-call`** container agent
    that clones the base branch (the merged release; the work branch is deleted on merge),
    locates the merged commit and correlates its diff with the regression evidence (alerting
    monitors/SLOs + recent error logs), returning a JSON assessment (culprit confidence +
    `revert`/`hold`/`monitor` recommendation). It makes no commits and reverts nothing — the
    engine raises a **`release_regression`** notification for a human to decide. The gate only
    engages once the PR actually merged, attributes only post-release alerts (not pre-existing
    ones) to the release, and honours the full configured watch window even when it outlasts a
    single poll budget.
  - **Datadog connection + monitor/SLO mapping** are per-workspace (keys sealed at rest under
    a `cat-factory:datadog` cipher, write-only), managed in a new settings panel and the
    `GET|PUT|DELETE /workspaces/:ws/datadog/connection` + `/release-health-configs/:blockId`
    API. The gate maps a run's repo to its service-frame config (monitor + SLO ids + env tag).
  - **Merge-preset knobs**: `releaseWatchWindowMinutes` (default 30) and `releaseMaxAttempts`
    (default 1) bound the watch window + on-call dispatches.
  - **Incident enrichment (optional, additive):** PagerDuty / incident.io are NOT used to
    re-alert (they already page off the same monitors/SLOs) — instead the on-call
    investigation is posted onto an incident they already opened (annotate, never duplicate),
    behind a new `IncidentEnrichmentProvider` port. Slack + the in-app inbox carry the
    human-facing `release_regression` notification.
  - Runtime-symmetric: D1 (`datadog_connections`, `release_health_configs` + the two preset
    columns) ⇄ Drizzle/Postgres, wired in both the Cloudflare Worker and Node/local facades.
  - New harness route `POST /on-call`; the executor-harness image is bumped to `1.7.1`.

  **Breaking (pre-1.0, acceptable):** `merge_threshold_presets` gains two columns — stale rows
  are re-seeded with the defaults.

- 3a12f15: Store LLM observability prompts as a delta instead of the full re-sent conversation.

  A container agent re-sends its whole growing message history on every model call, so
  storing each call's full prompt was hugely redundant — in a real 30-call run the
  serialised prompts were ~21× larger than storing the conversation once. The
  observability sink now stores only the messages a call APPENDED beyond
  `promptPrefixCount`, with a `promptHash` of the full array so the next call can verify
  it genuinely extends the previous one before its prefix is elided (a fresh
  conversation on retry, or a context-compacted prompt, safely falls back to storing the
  full array). The full prompt is rebuilt from the chain's deltas on export, and the
  drill-down panel shows just the new messages per call (with an "N earlier omitted"
  note) — less noise as well as far less storage.

  `LlmCallMetric` gains `promptPrefixCount` + `promptHash`; `LlmCallMetricRepository`
  gains `latestChainTip(...)`. D1 migration `0027` and a Drizzle migration add the two
  columns to `llm_call_metrics`. The cross-runtime conformance suite asserts the delta
  round-trip and chain-tip lookup against both real stores.

- 084bf43: Widen the env-provisioning + runner-pool surface so an external orchestration adapter
  (e.g. an in-house PR-environment platform) can be written on top of our ports and wired
  into a stock facade build, without forking the facades.

  - `EnvironmentProvider` provision requests now carry a typed `provisionContext`
    (branch / PR number+url / repo owner+name, derived from the block's PR ref) and the same
    values are flattened into `{{input.*}}` for the manifest path. The deployer step supplies
    it. A PR-environment provider needs the git ref + repo to target the right environment.
  - New `UrlSafetyPolicy` (kernel) + `resolveUrlSafetyPolicy` (server): the env + runner-pool
    URL/host guard is now policy-driven. The default stays strict (https-only, no
    private/internal hosts); a TRUSTED operator can widen it per facade to reach an internal
    platform on a private/VPN host. The two integrations are scoped **independently** — each
    resolves its own policy from its own config slice, so widening one (`ENVIRONMENTS_*`) does
    not widen the other's (`RUNNERS_*`) SSRF guard. Config: `ENVIRONMENTS_ALLOW_URL_HOSTS` /
    `ENVIRONMENTS_ALLOW_HTTP_URLS` and `RUNNERS_ALLOW_URL_HOSTS` / `RUNNERS_ALLOW_HTTP_URLS`
    (Node env vars + the matching Worker `[vars]`).
  - The Node facade's `buildNodeContainer` gains a documented `environmentProvider` seam (the
    Worker injects via `buildContainer`'s `overrides`); a custom adapter replaces the default
    manifest-driven `HttpEnvironmentProvider` while the env repos + secret cipher still wire
    from config. The local facade inherits the seam through `buildNodeContainer`.

  No backwards-incompatible changes: every addition is optional and defaults to today's
  behaviour.

- db77061: Add an **individual-usage restricted mode** for subscriptions licensed for personal
  use only (`claude`, `glm` and `codex` — see their terms of service). Such vendors are no
  longer poolable on a workspace; instead each user stores their OWN credential and only
  that user's runs may use it.

  - **Per-user, double-encrypted storage.** A personal subscription's token is sealed
    under a key derived from the user's personal **password** (PBKDF2 → AES-GCM, never
    stored) and then encrypted again with the system key, so it cannot be recovered
    without BOTH the system key AND the password. New `personal_subscriptions` table on
    both runtimes (D1 migration `0039` ⇄ Drizzle), `PersonalSubscriptionService`, and
    `GET/POST/DELETE /personal-subscriptions` (user-scoped).
  - **One password per user.** All of a user's individual-usage subscriptions must share a
    single personal password (enforced at store time), since a run unlocks every vendor it
    touches with one password. Passwords are restricted to printable ASCII so they are
    HTTP-header-safe.
  - **Per-run activation, short TTL, transparently extended.** At task start/retry the user
    supplies their password — carried on the ambient `X-Personal-Password` header (never a
    body field), cached client-side (~40h) so it usually rides along transparently — to mint a
    short-lived (~12h), system-encrypted, per-run activation (`subscription_activations`
    table) that the asynchronous container steps lease, so the whole step chain authenticates
    without the user present. The activation is **re-minted from the cached password on each
    interaction** (resolve a decision / approve a step / retry), so an actively-tended run
    never lapses under the short TTL; the user is only re-prompted once the password cache
    expires. Activations are deleted when the run finishes (or its block's run is replaced)
    and swept on TTL expiry.
  - **No recurring runs.** A recurring schedule whose block resolves to an individual-usage
    model — by pin **or** workspace per-kind default — is refused at fire time (it can't be
    unlocked unattended).
  - **Gating.** Starting/retrying a run that resolves to individual-usage model(s)
    requires a signed-in user with the stored subscription(s); a missing password returns
    `428 credential_required` so the client prompts. The gate mirrors dispatch's model
    precedence (block pin → workspace per-kind default) across the pipeline's steps, so a
    block with no pin but an individual-usage workspace default is gated up-front instead
    of failing at dispatch. The container executor leases the initiator's activation and
    fails clearly (retryable) if it has lapsed. Expiry/renewal is surfaced in advance.

  **Breaking (no migration — backwards compatibility is a non-goal here):** `glm` and `codex`
  join `claude` as individual-only, and individual-only vendors are no longer poolable on ANY
  workspace. Any existing **pooled** `claude`/`glm`/`codex` workspace tokens become orphaned
  (no longer leased or listed) — reconnect them as personal subscriptions.

  See `backend/docs/individual-subscription-usage.md` for the full model + safeguards.

- 57d70fa: Issue-tracker writeback: comment on a task's linked tracker issue when its PR
  opens, and comment + close the issue as resolved when the PR merges.

  Two independent toggles configured at the **workspace** level (on the existing
  tracker settings) and overridable **per task** in the inspector
  (`commentOnPrOpen`, `resolveOnMerge`; each task override is `inherit`/`on`/`off`).
  The linked issue(s) come from the existing task projection (`linkedBlockId`), so
  writeback targets whatever GitHub/Jira issue is attached to the task. All writeback
  is best-effort — a tracker outage never fails a run.

  GitHub issues close natively (`state_reason: completed`); Jira issues transition to
  the first status in their standard **Done** category (no manual status mapping). The
  new `IssueWritebackService` mirrors `TicketTrackerService`'s per-facade seams and is
  wired on both the Cloudflare and Node runtimes; the `GitHubClient` port gains a
  `closeIssue` method.

  **Breaking (pre-1.0, no migration):** the `tracker_settings` table gains
  `writeback_comment_on_pr_open` / `writeback_resolve_on_merge` columns and `blocks`
  gains `tracker_comment_on_pr_open` / `tracker_resolve_on_merge` (D1 migration `0005`
  ⇄ a generated Drizzle migration). Both default to off/inherit, so existing data is
  unaffected.

- 918764f: Add optional, opt-in **Langfuse** LLM observability. A new fetch-based
  `@cat-factory/observability-langfuse` package implements a runtime-neutral
  `LlmTraceSink` (new kernel port) against Langfuse's ingestion API — no Node SDK or
  OpenTelemetry, so it runs unchanged on BOTH the Cloudflare Worker (workerd) and Node
  facades.

  Proxied container-agent calls and inline (non-proxied) calls — requirements
  review/rework, document planner, fragment selector, the inline agent — flow through the
  SAME sink path: the orchestration `LlmObservabilityService` fans every recorded proxied
  call out as a generation, and an `InstrumentedModelProvider` wraps every resolved model
  so inline `generateText` calls surface the identical `LlmGenerationEvent`. Calls are
  grouped under one trace per run (`executionId`); inline single-shot calls become their
  own standalone trace.

  Off unless `LANGFUSE_ENABLED=true` and both keys are set; wired symmetrically in both
  runtime containers. Honours the existing `LLM_RECORD_PROMPTS` switch (prompt/response
  bodies are omitted from Langfuse too when disabled). The sink never throws into the LLM
  path — failures are swallowed and logged. The existing local metric store, spend gating
  and board rollups are unchanged; Langfuse is an additive external sink, not a
  replacement.

- fe0b7f8: Live model-activity: push per-call LLM activity over the workspace event stream.

  The "Model activity" panel fetched once when it opened and never updated, so a running
  step's calls only appeared on a manual reopen — and when a durable driver was evicted
  mid-run the board badge (which rides the poll loop) froze too, making a stalled driver
  look identical to a wedged agent. But the proxy records every call the moment it
  returns, independent of the execution driver, so the data was live the whole time;
  only the read side was stale.

  The proxy now emits a compact `llmCall` event per model call, sourced where the metric
  is already recorded:

  - New `LlmCallActivity` contract + `llmCall` `WorkspaceEvent` variant — the per-call
    summary (id, run, agent kind, provider/model, tokens, finish reason, ok/status, the
    latency split) WITHOUT the prompt/response bodies, so the stream payload stays small.
  - `ExecutionEventPublisher` gains an optional `llmCallObserved`; the proxy mints the
    call id (so the live row and the persisted metric share it) and pushes through the
    same realtime publisher execution events use. `DurableObjectEventPublisher` fans it
    to the `WorkspaceEventsHub` on Cloudflare; `FanOutEventPublisher` forwards it; Node's
    no-op publisher leaves it inert until Node gains a real-time transport. The emit is
    best-effort and fires even when the persistence sink is off.
  - SPA: `useWorkspaceStream` folds the event into the observability store, so an open
    panel updates in real time and keeps updating during a driver eviction. Live-appended
    rows carry no bodies; the panel lazy-loads those (by id) from the persisted metrics
    endpoint when a row is expanded.

  Both runtimes' real Hono apps are covered by a proxy-emit integration test asserting
  the identical compact activity event (each over its own app), so the shared controller's
  emit can't silently work on one runtime and not the other. The Cloudflare-specific
  publish leg — `DurableObjectEventPublisher.llmCallObserved` fanning the event to a live
  socket as an `llmCall` `WorkspaceEvent` — has its own dedicated hub spec.

- f73652c: LLM key management overhaul: DB-backed, multi-scope, pooled provider API keys;
  opt-in Cloudflare AI; provider-gated pipelines; account roles.

  - **Direct-provider API keys move from env to the DB** (BREAKING). The
    OpenAI/Anthropic/Qwen/DeepSeek/Moonshot keys that were read from
    `*_API_KEY` env vars are now onboarded via the UI and stored encrypted (the
    shared `WebCryptoSecretCipher`, HKDF info `cat-factory:provider-api-keys`).
    They are pooled and leased with usage-aware rotation, and scoped to an
    **account, workspace, or user** — within a workspace the candidate pool merges
    the workspace's keys, its owning account's keys, and the run initiator's own
    user keys. Operators must re-enter their keys via the app after upgrading.
  - **Cloudflare Workers AI is no longer assumed available.** It becomes a separate
    opt-in provider lib (like `provider-bedrock`), explicitly registered per
    deployment (the Worker `AI` binding; Node REST account/token). The unconditional
    `workers-ai` fallback is removed, so a bare deployment exposes no models until a
    key is added or the Cloudflare lib is enabled.
  - **Model selectability is derived from what is configured**, and starting a
    pipeline is blocked when any step's canonical model has no usable provider
    (no direct key, no subscription, no registered registry).
  - **Account roles** (admin / developer / product, combinable) layered on the
    membership model: only admins may modify org-account settings; a product member
    can be set as a task's responsible person and is notified when requirement review
    raises findings.

- db336b1: LLM observability for container-based agent execution.

  Every container agent talks to models only through the runtime-neutral LLM proxy, so
  that single chokepoint now records one rich metric per call — the full prompt and
  response, token usage, how close the call ran to its output-token limit (truncation),
  and the latency split between transport/proxy overhead and actual model execution —
  plus errors and warnings (non-2xx, in-process failures, spend-gate refusals,
  `finish_reason: length`/`content_filter`).

  - New `LlmCallMetricRepository` kernel port + `LlmObservabilityService`
    (orchestration), composed only when a metric repository is wired (default-off, so
    tests and unconfigured facades are unaffected). Persisted on both runtimes: a new
    D1 table (`llm_call_metrics`, migration 0026) and a Drizzle/Postgres table, kept in
    lock-step by a cross-runtime conformance repository-parity suite.
  - The proxy is instrumented across the buffered, streaming, and in-process (Workers
    AI) paths; recording is scheduled off the response path so it never adds latency.
  - The execution engine rolls the per-run, per-agent-kind aggregates onto each
    pipeline step (`step.metrics`) and ships them over the existing execution event, so
    the board shows tokens, an output-limit headroom bar, a transport-vs-execution split
    and error/warning badges live — on the step cards, the pipeline timeline and the
    step-detail overlay. A new drill-down panel (`GET …/executions/:id/llm-metrics`)
    lists every call with its full prompt + response, and an LLM-friendly JSON export
    (`…/llm-metrics/export`) bundles totals + per-agent insights + every call (with
    derived ratios) for handing a run straight to a model to analyse.
  - The full request/response bodies make the table heavy, so it is pruned aggressively
    by the retention cron — default 3 days (`LLM_CALL_METRICS_RETENTION_DAYS`).

- f9d3647: Local mode: first-class support for Podman, OrbStack, Colima and Apple `container`
  alongside Docker (for both spinning the per-run harness containers and the Tester's
  ephemeral/local test environments).

  The local runner backend (`LocalDockerRunnerTransport`, now
  `LocalContainerRunnerTransport`) no longer assumes the Docker CLI and Docker Desktop
  networking. HOW it talks to the runtime is delegated to a `ContainerRuntimeAdapter`
  (`backend/runtimes/local/src/runtimes/*`), selected by a new `LOCAL_CONTAINER_RUNTIME`
  env (`docker` | `podman` | `orbstack` | `colima` | `apple`, default `docker`):

  - **Docker / Podman / OrbStack / Colima** share the Docker-CLI adapter (`docker run`,
    publish `:8080` to an ephemeral host port, `cat-factory.runId` label), parameterised by
    binary + host-networking. Per-runtime defaults set the right host alias the harness
    uses to reach the LLM proxy (`host.docker.internal`, `host.lima.internal` for Colima),
    overridable via the new `LOCAL_HARNESS_HOST_ALIAS` / `PUBLIC_URL`. `PUBLIC_URL` now
    derives from the selected runtime's alias.
  - **Apple `container`** (macOS) gets its own adapter: one VM per container, addressed by a
    deterministic name, connected to the container's own IP (no published-port model), via
    `container run | list | inspect | delete`.

  **Tester "limited mode".** Apple `container` has no Docker-in-Docker, so the Tester's
  **Local** infra mode (`docker compose up` inside the job container) can't run there. Each
  adapter exposes a `localDind` capability that the local facade threads into the engine as
  `localTestInfraSupported`; `ExecutionService` now refuses a local-infra Tester pipeline at
  start on an incapable runtime (`tester-infra.logic.ts`), with an actionable message. The
  Tester still runs there via the **Ephemeral** test environment (offloaded to a configured
  environment provider — e.g. a custom container pool) or a **No infra dependencies**
  service. This gate defaults to permissive (`localTestInfraSupported` defaults `true`), so
  Cloudflare, Node and tests are unchanged.

  `startLocal()` now logs the resolved runtime + capabilities + host alias and probes that
  the CLI is installed, so a misconfiguration fails loudly at boot rather than on the first
  agent job. The executor-harness image is unchanged.

- 9be11e1: Add an automated merge-conflict resolver, and converge the container coding agents
  onto a shared base.

  **Conflict resolver.** Previously a PR that conflicted with its base degraded to a
  manual `merge_review` handoff. A new pre-merge `conflicts` gate now sits before the
  `ci`/`merger` steps in the standard pipelines (mirroring the CI gate): it reads the
  PR's mergeability (`PullRequestMergeabilityProvider` → GitHub `mergeable_state`) and,
  on a real conflict, dispatches a `conflict-resolver` container agent that clones the
  PR branch, merges the base in, has the agent resolve the conflicts, and pushes back
  onto the same branch — looping (bounded by the merge preset's attempt budget) until
  the PR is mergeable, or failing the run for a human if it can't. Pass-through when no
  mergeability provider is wired (e.g. tests / no GitHub), so existing behaviour is
  unchanged. The resolver never pushes a half-resolved tree (it guards on remaining
  unmerged paths).

  **Shared base.** The container agents were near-duplicates of one clone → write
  context → run Pi → push flow. They now share `runCodingAgent` (implement + ci-fix +
  conflict-resolve) on top of a thinner `withWorkspace` / `runAgentInWorkspace` base
  (also used by bootstrap / blueprint / merger), plus shared no-op-reason helpers — so
  fixes like the "judge the whole run, counting the agent's own commits" change apply
  everywhere instead of being re-derived per agent.

  Bumps `@cat-factory/executor-harness` (new `/resolve-conflicts` endpoint + shared-base
  refactor change its image).

- 5ec0d25: Real merge lifecycle: CI gate + CI-fixer, merger agent, and notifications.

  A task now becomes `done` only when its pull request is **actually merged** on
  GitHub — fixing the bug where a task showed "merged" (and a green board) from a
  confidence score alone, while CI was red and the PR still open.

  - **CI gate (`ci` step)** — auto-inserted before the merger in the standard
    pipelines. It polls the PR head's GitHub check runs and, on failure, dispatches a
    new **`ci-fixer`** container agent that pushes a fix to the PR branch, looping up
    to a configurable budget (default 10) until CI is green; polling stops the moment
    CI goes green. If the budget is spent it raises a `ci_failed` notification.
  - **Merger agent (`merger` step)** — runs last. A container agent scores the PR's
    complexity / risk / impact, and the engine compares those against the task's
    **merge threshold preset** to either auto-merge (a real GitHub merge) or raise a
    `merge_review` notification for a human. Presets are a per-workspace library
    (selectable per task); the CI-fixer attempt budget lives on the preset.
  - **`merger` is appended to the standard pipelines.** A pipeline with no merger now
    raises a `pipeline_complete` notification on completion (confirm + merge) instead
    of silently marking the task done.
  - **Notifications** — a new first-class, human-actionable board surface (inbox +
    events), modelled behind a `NotificationChannel` port so email/Slack delivery can
    be added later without touching the call sites. In-app delivery only for now.

  Adds migration `0024_merge_lifecycle.sql` (notifications + merge-preset tables, the
  `blocks.merge_preset_id` column). The executor-harness image gains `/ci-fix` and
  `/merge` endpoints (version bumped so the GHCR image is re-tagged).

- a691853: Monorepo support: select a subset of a repo's services and pin each to a subdirectory.

  A linked GitHub repository can now be flagged a **monorepo** (`github_repos.is_monorepo`,
  D1 migration `0044` ⇄ Drizzle), which lets it back **more than one** board service —
  each pinned to its own subdirectory (`services.directory`). The "Add service from repo"
  modal gains a monorepo toggle and a **directory browser** (`GET
/workspaces/:ws/github/repos/:id/tree`, served from GitHub's contents API via
  `GitHubSyncService.listRepoDirectory`) so you can explore the repo and pick the
  directory of the service you want — and add several (a subset of the repo's services).
  `PATCH /workspaces/:ws/github/repos/:id` sets the monorepo flag.

  The chosen subdirectory is **fed to the agents that build the service** when the repo is
  a monorepo: `buildResolveRepoTarget` resolves a frame's service (so multiple frames can
  target one repo) and returns its `serviceDirectory`, which flows through the container
  job body into the harness. The implementation agents — **coder, mocker and ci-fixer**
  (everything routed through `runCodingAgent`) — run with their working directory set to
  that subtree and are told, in their AGENTS.md context, that they're in a monorepo and to
  scope their work (and build/test commands) to it. The cross-cutting agents keep operating
  at the repo root by design: the **conflict-resolver** and **merger** act on the whole
  merge / diff, and the **blueprint** and **requirements** agents write repo-root artifacts.
  Non-monorepo repos keep the historical whole-repo behaviour.

  Known limitation: the in-repo blueprint (`blueprints/`) and requirements (`requirements/`)
  artifacts are still written at the repo root, so two services backed by the same monorepo
  share — and would overwrite — those files. Per-service artifact paths are a follow-up.

- 2796a42: Make recording of complete prompts in LLM observability optional, governed by a new
  `LLM_RECORD_PROMPTS` environment variable.

  The LLM observability sink keeps the full prompt sent to the model with each metric.
  That prompt text can contain sensitive content (source, secrets), so some deployments
  must not retain it. `LlmObservabilityService` now takes a `recordPrompts` flag (default
  true, preserving current behaviour); when it is false the numeric telemetry (tokens,
  timing, finish reason, message/tool counts) is still recorded but the prompt body is
  stored empty and the delta-chain read is skipped entirely.

  - New `ObservabilityConfig.recordPrompts` on the shared `AppConfig` contract, threaded
    through `CoreDependencies.recordLlmPrompts` into the service.
  - Both runtime facades read `LLM_RECORD_PROMPTS` (any value other than `false` keeps
    recording on): the Cloudflare Worker via a new `loadObservabilityConfig`, the Node
    service via `loadNodeConfig`. Documented in `deploy/backend/wrangler.toml` and
    `deploy/node/.env.example`.

- 6406c8c: Extract `@cat-factory/orchestration` from `@cat-factory/core`

  The delivery-workflow engine (board, boardScan, bootstrap, execution, pipelines,
  requirements) and the composition root (`createCore`) move to the new
  `@cat-factory/orchestration` package. `@cat-factory/core` is now a thin barrel
  that re-exports the full surface of all split packages for backward compatibility —
  no consumer import paths change.

- 70e8ef0: Associate recurring pipeline schedules with their service (in-org sharing).

  A recurring schedule hangs off a service frame and owns a reused on-board block. With a
  shared service, that schedule and its block must show on every workspace that mounts the
  service — and still fire once per org.

  - `PipelineSchedule` gains `serviceId`; a new schedule (and its reused block) is stamped with
    the frame's service, so the block renders on every mounting board via the board composition.
  - `PipelineScheduleRepository.listByService` (D1 + Drizzle) backs the snapshot, which now
    lists the workspace's own schedules UNION the schedules of every service it mounts.
  - D1 migration `0033` + a Drizzle migration add `pipeline_schedules.service_id`.

  A schedule is still a single row that fires once, so a shared service's scheduled pipeline
  runs once per org (the result renders on all mounting boards), not once per workspace.

- 70e8ef0: Frontend for in-org shared services.

  The board can now mount org services, shows which frames are shared, and lays them out
  per-board.

  - The workspace snapshot carries `mounts` (the services this board mounts, with the
    per-board frame layout) and `serviceCatalog` (the org's services it can mount from, each
    annotated with `mountCount`). `Service` gains a derived `mountCount`.
  - SPA: a `services` Pinia store (mounts + catalog + mount/unmount/updateLayout), hydrated from
    the snapshot; an **"Add service"** menu on the board toolbar that mounts an org service; a
    **"Shared"** badge on a frame mounted on more than one board; and a frame drag now writes
    the **per-board mount layout** (so moving a shared frame doesn't move it on other boards).

- 70e8ef0: Make in-org shared boards fully interactive, and tighten the shared-service model.

  A workspace that MOUNTS a service from another workspace can now edit it like its own: a
  shared service's blocks live in one home workspace, and board mutations resolve them there
  (authorized by the mount) instead of 404ing on the workspace-scoped lookup.

  - `BlockRepository.findById` (D1 + Drizzle) resolves a block by id across the org; `BoardService`
    uses it so `updateBlock`, `moveBlock`, `addTask`, `addModule`, `removeBlock`,
    `toggleDependency` and `reparent` act on the shared copy at its home workspace. A frame move
    writes the requesting board's mount layout (per-workspace), leaving the shared block untouched.
  - Cross-service `reparent` across two services homed in **different** workspaces moves the
    subtree's block rows (and any executions on them) to the destination service's home, re-stamped
    with the destination service — preserving the "a service's blocks live in its home" invariant.
  - **Every** top-level frame now registers as an account-owned service via the shared
    `registerServiceForFrame` helper — including **seeded demo boards** and **repo bootstrap**, which
    previously created unshareable, unbadged frames.
  - Executions and bootstrap runs now stamp `service_id` from their block at write time (D1 +
    Drizzle), so a shared service's **live** runs surface on every board that mounts it — not just
    pre-migration rows. `BootstrapJobRepository.listByService` + `BootstrapService.listJobs` compose
    a mounted service's in-flight bootstrap into the snapshot.
  - Real-time `boardChanged` now carries the affected block, so `FanOutEventPublisher` fans
    structural changes (module materialised, run cancelled, bootstrap finished) out to every
    mounting board live, not just on reload.
  - `services.frame_block_id` is now UNIQUE (D1 + Drizzle), enforcing the 1:1 frame↔service mapping.
  - Removed N+1s on the snapshot hot path (`composeBoard`) and the GitHub sync fan-out
    (`linkedWorkspaces`).

  The Node facade wires the service repos into the engine but, lacking a real-time transport,
  does not yet decorate its publisher with `FanOutEventPublisher` (noted in its container).

- 70e8ef0: Batch the shared-service read paths (remove N+1 queries) + fan-out and mount-UI polish.

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

- 70e8ef0: In-org shared services: schema + domain foundation.

  Introduce the account-owned **service** as the canonical board unit and the
  **workspace mount** that places it onto a workspace's board, so the same service
  can appear on several workspaces in one org without duplicating its subtree, state
  or sync. This is the first (additive) increment:

  - New wire types `Service` + `WorkspaceMount` (`@cat-factory/contracts`) and the
    `ServiceRepository` / `WorkspaceMountRepository` ports (`@cat-factory/kernel`).
  - New `services` + `workspace_services` tables on both runtimes (D1 migration
    `0030`; Drizzle migration for Postgres), with an idempotent backfill that turns
    every existing top-level frame into an account-owned service mounted into its
    current workspace at its current board position.
  - D1 + Drizzle implementations of the two repositories.
  - A `service_id` column denormalised onto `blocks` + `agent_runs` (D1 migration
    `0031`; Drizzle migration), backfilled via a recursive CTE from each block's
    top-level frame, in preparation for re-keying the board's physical scope.
  - A **mount API**: every newly created service frame is registered as an
    account-owned service and mounted onto its workspace; `GET /workspaces/:ws/services`
    (mounts), `GET /workspaces/:ws/services/catalog` (the org's services),
    `POST|DELETE /workspaces/:ws/services/:serviceId` (mount/unmount — within the same
    org only), `PATCH …/layout` (per-workspace frame layout). Backed by the new
    `ServiceMountService` (orchestration `services` module) wired into both runtimes.

  - **Board composition**: a workspace's board snapshot is now composed from the
    services it mounts — its own blocks plus the full subtree of any service mounted
    from another workspace in the same org, so a shared service renders identically on
    every board (one physical copy ⇒ one shared task list + state). Each externally
    mounted frame is positioned by this workspace's mount (the per-workspace layout
    override), while a locally homed frame keeps its own movable position. Block inserts
    stamp `service_id` (the frame's service for a frame; the enclosing frame's service
    for tasks/modules) so the subtree is `listByService`-discoverable everywhere.

  Sync deduplication, real-time fan-out to all mounting workspaces, and the frontend
  land in follow-up increments.

- 5c8ca33: Add per-step human approval gates to pipelines, plus two board polish fixes.

  A pipeline step can now be marked "require approval" when building the pipeline
  (`Pipeline.gates`, parallel to `agentKinds`; persisted via the new `gates` column,
  migration `0023`). When a gated step finishes, the run parks — reusing the durable
  decision wait — and a human reviews the step's proposal in an editable modal, then
  either **Approves** (the edited proposal advances and flows to downstream steps as
  context) or **Requests changes** (the same step re-runs with the human's feedback
  folded into the agent's prompt via `AgentRunContext.revision`). New endpoints
  `POST /executions/:id/steps/:approvalId/{approve,request-changes}`
  (`ExecutionService.approveStep` / `requestStepChanges`). The gate is surfaced on the
  board card, inspector, focus view and the zoomed-in pipeline.

  The **requirements reviewer** is now an automated, inline pipeline step
  (`requirements` agent kind) that runs before the architect instead of a manual
  inspector button. The default "Full build" pipeline seeds it first and gates both
  the requirements review and the architecture proposal.

  Also: the inspector panel now scrolls when its content exceeds the viewport, and
  zoomed-in pipeline steps are clickable to reveal the prose conclusion each agent
  produced (matching the inspector).

- 7cf2a2d: Improve the pipeline builder experience:

  - **Grouped, collapsible agent palette** — archetypes are now organized into
    meaningful categories (Review & triage, Design & research, Implementation,
    Testing, Documentation, Gates & observability) that collapse/expand, with the
    collapsed state remembered across builder opens.
  - **Pipeline labels + archive/unarchive** — pipelines (built-in and custom) carry
    free-form labels and an archived flag for organizing the library: filter by
    label, hide archived behind a toggle, and archive without deleting. Exposed via
    a new `PATCH /workspaces/:ws/pipelines/:id/organize` endpoint (the only mutation
    a read-only built-in accepts). New `pipelines.labels` / `pipelines.archived`
    columns mirror across D1 and Drizzle/Postgres.
  - **Dependent companions are now gated toggles on their producer** — the three
    companions (reviewer→coder, architect-companion→architect, spec-companion→
    spec-writer) leave the free palette and are attached to their producer step in
    the builder. Each can be optionally **gated on the task estimate** (run only when
    complexity/risk/impact ≥ a threshold, OR across axes) via a new per-step
    `gating` array; a gated step is transparently skipped at runtime when the
    estimate falls below the bar. A pipeline with any enabled gating **requires a
    `task-estimator` earlier in the chain** or it refuses to save/start. Gating is
    additionally restricted to **companion steps** (skipping a producer would starve
    its downstream steps) and **requires at least one axis threshold** (an enabled gate
    with none would always skip); both are enforced by the shared `validatePipelineShape`
    at save, clone, and run start. A companion must now run **immediately after** an
    enabled producer it can review — `validatePipelineShape` enforces strict adjacency
    (over the enabled subset) on every facade, matching the builder, which surfaces
    companions as toggles attached to their producer. A pipeline that slips another step
    between a producer and its companion is rejected at save / clone / run start.

  **Breaking (pre-1.0, no migration):** the `Pipeline` wire shape gains optional
  `gating`, `labels`, and `archived` fields, and `PipelineStep` gains `gating` /
  `skipped`. The built-in pipelines are unchanged in behaviour.

- 2d66d34: Pipeline builder: clone pipelines, edit custom ones, and disable steps without
  removing them.

  - **Clone any pipeline** (built-in or custom) into a new, editable copy:
    `POST /workspaces/:ws/pipelines/:id/clone` (`PipelineService.clone`). The copy is
    never `builtin`, so this is how a read-only default template is "made editable".
    The builder shows a Clone action on every saved pipeline.
  - **Edit a custom pipeline in place**: `PATCH /workspaces/:ws/pipelines/:id`
    (`PipelineService.update`, new `PipelineRepository.update` on both stores). The
    builder loads a custom pipeline into the draft and saves changes back to the same id
    (preserving its catalog position). Built-in catalog pipelines are **read-only** —
    the API rejects both editing and deleting them (422) and the UI offers Clone
    instead (no edit/delete affordance on a built-in); pipelines now carry a `builtin`
    flag (true for the `seedPipelines()` catalog) to drive this.
  - **Disable a step without removing it**: a new per-step `enabled[]` array (parallel
    to `agentKinds`, like `gates`/`thresholds`). A step flagged `enabled[i] === false`
    is kept in the saved pipeline (and can be toggled back on) but skipped at run start —
    `ExecutionService` builds the run only from the enabled steps, reading gates/
    thresholds by each kind's original index so they stay aligned. A pipeline must keep
    at least one step enabled, and an enabled companion must still have an enabled
    producer to grade (disabling a producer while leaving its companion on is rejected).
    The builder adds an enable/disable toggle and dims disabled steps.

  Persistence: new `enabled` + `builtin` columns on the `pipelines` table, mirrored on
  both runtimes — folded into the squashed baselines (D1 `0001_init.sql` ⇄ the Drizzle
  schema + a regenerated migration) rather than a standalone migration. Cross-runtime
  conformance asserts a disabled step is skipped at run on every facade.

- 37baa7f: Scheduled recurring pipelines on services.

  A service (a `frame` block) can now carry **recurring pipelines** that re-run a
  pipeline on a cadence — primarily **Dependency updates** and **Tech debt**. A
  schedule runs every `intervalHours`, optionally constrained to an allowed window
  (weekdays + an hour-of-day range, in a chosen IANA timezone), and owns one reused
  on-board task block inside the service that each fire runs the pipeline against
  (skipping any fire while a run is still in flight). Run history is kept ~1 week and
  surfaced in the inspector.

  - **Tech-debt pipeline** adds two agent kinds: a read-only `analysis` container
    agent that audits the repo, then a special non-LLM `tracker` step that files a
    **GitHub issue or Jira ticket** from the analysis before implementation. The
    tracker is a per-workspace selection (`GET|PUT /workspaces/:ws/tracker-settings`);
    `GitHubClient` gains `createIssue`. The runtime-neutral `TicketTrackerService`
    resolves each **tenant's own** connected integration (it is injected with a
    `fileGitHubIssue` filer + a `resolveJiraConnection` resolver, never shared/env
    credentials): on Cloudflare it files GitHub issues through the workspace's GitHub
    App installation against the service's repo, and Jira tickets (markdown→ADF) using
    the workspace's encrypted `task_connections`. Two new seed pipelines:
    `pl_dep_update`, `pl_tech_debt`.
  - **Per-tenant tracker on the Node facade**: both trackers now work on Node, each
    resolving the **workspace's own** integration. Jira: the task-source integration is
    wired on Node (always on; requires the shared `ENCRYPTION_KEY`) — a Drizzle
    `task_connections`/`tasks` store + the runtime-neutral Jira provider — so each tenant
    connects its own Jira through the existing UI (credentials encrypted at rest). GitHub:
    the filer mints a short-lived token from that workspace's own GitHub App installation
    (reusing the per-tenant App infra) and resolves the service's repo from the
    `github_repos` projection — no shared/env credentials.
  - **Persistence + scheduling are symmetric across runtimes**: D1 migration
    `0029_recurring_pipelines.sql` ⇄ Drizzle schema + generated migration; the
    Cloudflare `scheduled` cron fires due schedules (and prunes run history) ⇄ a Node
    `setInterval` sweeper does the same. New ports `PipelineScheduleRepository` /
    `TrackerSettingsRepository` with D1 + Drizzle implementations; the cross-runtime
    conformance suite covers schedule CRUD, `runDue`, and the tracker setting.
  - **UI**: an "Add recurring pipeline" button on the service frame (mirroring "Add
    task") opens a per-frame modal (pipeline + cadence editor; the tracker choice is
    surfaced inline for the tech-debt pipeline). The schedule's block shows a recurring
    badge on the board; selecting it reveals the cadence, run-now/pause, and run
    history in the inspector.

- 553a67d: Remove the standalone "scan repository" command — repository decomposition is now
  only the `blueprints` pipeline agent.

  The manual scan was a separate, UI-exposed operation backed by a synchronous
  Cloudflare-Container-only `RepoScanner` (which had no live harness route) plus a
  `repo_blueprints` persistence store. It duplicated what the `blueprints` agent kind
  already does — decompose a repo into the canonical service → modules tree and
  reconcile it onto the board — except the agent runs through the shared
  `RunnerTransport`, so it already works identically on Cloudflare Containers and on a
  self-hosted runner pool. Keeping the standalone command was the last
  Cloudflare-vs-pool parity gap (and dead code on Cloudflare). Removing it closes the
  gap by deletion.

  Removed:

  - **Ports:** `RepoScanner` (+ `ScanRepoRequest` / `ScannedBlueprint`) and
    `RepoBlueprintRepository` (+ `RepoBlueprintRecord`).
  - **Contracts:** `scanRepoSchema` / `ScanRepoInput`, `scanRepoResultSchema` /
    `ScanRepoResult`, and `repoBlueprintSchema` / `RepoBlueprint`. The blueprint **tree**
    schemas (`BlueprintService` / `BlueprintModule` / `blueprintSource`), the in-repo
    `blueprints/` artifact constants, `parseBlueprintService`, and `BoardScanSpawnResult`
    stay — the `blueprints` pipeline uses them.
  - **HTTP:** the entire `BoardScanController` — `POST /board-scan/scans` and the
    `GET|DELETE /board-scan/blueprints[/:id]` read endpoints.
  - **Service:** `BoardScanService` is now purely the engine's `BlueprintReconciler`
    (`reconcileBlueprint` + its spawn fallback); `scan` / `canScan` / the blueprint
    CRUD / the persisted-blueprint deps are gone. It is wired unconditionally (it needs
    only the board service + block repository).
  - **Persistence:** the `repo_blueprints` table (D1 `0001_init` + Drizzle schema, with
    a generated Postgres drop migration), `D1RepoBlueprintRepository`,
    `DrizzleRepoBlueprintRepository`, and `ContainerRepoScanner`.

  No data migration is provided (pre-1.0; backwards compatibility is a non-goal): an
  existing `repo_blueprints` table is simply orphaned/dropped. The executor harness is
  unchanged — its self-contained blueprint coercion stays — so the runner image is not
  affected.

- 4026793: Requirements review: react to findings + a rework agent that feeds downstream steps.

  The requirements-review flow is now wired into the UI and reworks the requirements
  instead of overwriting the block description:

  - **New review window** (`RequirementsReviewWindow.vue`) modelled on the polished
    prose review window: a human reacts to the reviewer's structured findings —
    answering the relevant ones, dismissing the irrelevant — then runs the
    **requirements-rework** agent. Triggered from the inspector's "Review
    requirements" button (open-finding count badge). The old dormant
    `RequirementReviewModal` is removed.
  - **Rework, not overwrite.** `incorporate()` no longer rewrites
    `block.description`. It folds the answers into ONE standard-format requirements
    document (new versioned `REWORK_SYSTEM_PROMPT`: SHALL statements + MoSCoW +
    Given/When/Then acceptance + domain rules) stored on the review, and returns
    `{ review }`. It runs even with **zero findings**, so every task can carry a
    clean, writer-ready spec.
  - **Downstream consumption.** When a block has an incorporated review,
    `ExecutionService` feeds that reworked document to **every** agent step in place
    of the original description and drops the (already-folded-in) linked docs/tasks;
    the requirements-writer aggregates the reworked text per task instead of the raw
    description. The rework call rejects a length-truncated document instead of
    persisting a silently-incomplete spec.
  - **Both runtimes, enforced.** The requirements feature is wired on the Node facade
    too — a `requirement_reviews` Postgres table (Drizzle schema + migration) and
    `DrizzleRequirementReviewRepository`, plus the review/model deps in the Node
    container — so the review/rework API and the agent-context substitution behave
    identically on Cloudflare and Node. The cross-runtime conformance suite asserts the
    substitution against both stores so the parity can't silently drift.
  - **Frozen description.** Once a task's requirements are reworked, the inspector
    freezes its raw description (read-only, tucked behind an expander) and puts the
    standardized requirements in focus — the description is no longer what agents read.

- f16ae62: Board cleanup, resizable service frames, and an explicit container start-up phase.

  - **No more sample services + no "reset to sample board".** New boards start
    empty: workspace creation no longer seeds the sample architecture blocks (the
    SPA passes `seed: false`), and the toolbar's "Reset board to sample" button (and
    the `workspace.reset()` action behind it) is gone. The built-in **pipeline
    catalog is still always provisioned** — it is product config, not sample data —
    so an empty board can still run pipelines. The `seed` flag (now sample _blocks_
    only, default true) remains for demo boards and the test fixtures.

  - **Resizable service frames (Miro-style).** A frame can be resized by dragging
    its right / bottom edges or the bottom-right corner. `Block` gains an optional
    `size` (`{ w, h }`); when set it is the user's dragged size, used as a floor over
    the frame's content extent so a frame grows but is never dragged smaller than its
    tasks/modules. The size is persisted (new `width`/`height` columns on `blocks` —
    D1 migration `0027`, Drizzle migration for Postgres) and updated via the existing
    `PATCH /blocks/:id` (which now accepts `size`).

  - **Explicit "Spinning up container…" phase.** Container-backed steps (`coder`,
    `mocker`, `playwright`, `blueprints`, `merger`, …) now surface an explicit
    cold-boot phase instead of a blank "working" state. `PipelineStep` gains
    `startingContainer`, set the moment the job is dispatched (the dispatch blocks
    until the per-run container is up and has accepted the job, so it covers the whole
    boot window) and cleared on the first successful poll, when the container is
    provably up. The board shows "Spinning up container…" during that window — an
    accurate signal that does not rely on the absence of subtasks. Steps persist as
    JSON, so this needs no migration.

- 36018cb: Restart a pipeline run from a chosen step.

  Both the run's step-detail overlay (`AgentStepDetail`) and each step on the pipeline
  timeline (`PipelineProgress`, a hover-revealed side button) now offer **"Restart from
  here"**: re-run the pipeline from that step onward — even on a finished run — resetting
  the chosen step plus every later step's iteration counters (companion attempts,
  gate/test attempts, eviction recoveries) and re-driving a fresh run. The steps
  BEFORE the chosen one are preserved verbatim, so their outputs (and resolved
  decisions) still reach the restarted step as its `priorOutputs` handoff context.

  Unlike retry (which resumes at the first FAILURE), restart rewinds to an arbitrary
  human-picked step, so it can re-run steps that already completed. A block's
  incorporated requirements are deliberately NOT touched — they live on the
  requirement-review record, not the run — so a restarted `spec-writer`/`coder`
  still receives the incorporated requirements document (or the base description when
  none was generated). Restarting AT the `requirements-review` gate itself re-runs the
  reviewer, which mints a fresh iteration-1 review (its `review()` replaces the prior
  one) — exactly the "reset the iterations counter from this step" semantics.

  Backed by `POST /workspaces/:ws/executions/:executionId/restart` (`{ fromStepIndex }`,
  `restartFromStepSchema`) → `ExecutionService.restartFromStep`, which tears down any
  still-live driver/container for the run it replaces (so restarting a RUNNING run
  never orphans a container or a parked Workflows/pg-boss driver), then mints a new run
  id and re-drives like a retry. Like start/retry, an individual-usage (Claude/GLM/
  Codex) block needs the initiator's personal password (prompted, then retried, on a
  428). Runtime-neutral (shared `@cat-factory/server` + orchestration), so both facades
  get it; a cross-runtime conformance assertion pins the restart + the requirements
  handoff on every runtime.

- d65c979: Unify the approval gate into the conclusions reader, with GitHub-style review.

  The dedicated approval modal is gone. A pending gate now opens the same polished
  step-detail reader (ToC side nav, rendered markdown), in a new **approval mode**:
  the reviewer can comment on individual blocks of the agent's output (click a block —
  the rendered markdown carries `data-src-start/end` source ranges so the comment
  quotes that block's verbatim raw markdown), leave overall freeform feedback, then
  **Approve** (advance), **Request changes** or **Reject**.

  - **Request changes** re-runs the step with both the freeform feedback and the
    per-block comments folded into the agent's prompt (`AgentRunContext.revision`
    gains `comments`; `requestStepChangesSchema` now takes `feedback?` + `comments?`,
    requiring at least one).
  - **Reject** stops the run entirely — a terminal `rejected` failure
    (`agentFailureKindSchema`), so the board's shared failure banner + retry surfaces
    it (block → `blocked`). New `POST /executions/:id/steps/:approvalId/reject`
    (`ExecutionService.rejectStep`).
  - `stepApprovalSchema` gains the `rejected` status and a persisted `comments` array
    (`stepReviewCommentSchema`). No migration: approvals live in the execution
    `detail` JSON.

  - **Approve with corrections** opens an inline editor over the conclusions; the
    human's edits become the approved proposal carried forward (the existing
    `approveStep` proposal override — no backend change). Manual edits are a distinct
    mode and can't be combined with per-block comments / request-changes — they only
    happen _together with_ approving.

  The review surface is responsive — a right-side rail on wide screens, a bottom
  sheet below `lg` — so a pending gate is always actionable. Reject uses a two-step
  inline confirm (no native dialog). `requestStepChanges`/`rejectStep` reject a stale
  gate id whose step is already being re-run (`changes_requested`) so a double-submit
  can't dispatch duplicate work.

  Cross-runtime conformance gains assertions for reject and comment-driven re-runs.

- 75a0441: Fix the review, testing and merge gates so findings are acted on and a bad merge
  can't slip through.

  - Pipeline order: the `reviewer` companion now runs IMMEDIATELY after `coder`
    (before `blueprints`/`mocker`/`tester`), in `pl_full`, `pl_fullstack`,
    `pl_dep_update` and `pl_tech_debt`, so review + rework happen on freshly written
    code before the map/test tail. The positional `gates` arrays are unchanged (the
    gated slots all sit before `coder`).
  - First review batch always loops back: the FIRST companion pass (reviewer /
    spec-companion / architect-companion) that raises any comments now loops the
    producer back regardless of rating; the configured threshold only governs the
    SECOND pass onward. The same rule applies to the `tester` gate: the first testing
    round hands ANY finding (even a low/medium concern) to the fixer, and low/medium
    concerns become advisory only from the second round.
  - Review results no longer silently pass: a companion whose own JSON verdict can't
    be parsed (e.g. a truncated reply) used to default to a perfect 100% pass and drop
    the real review. The engine now retries once and, if the verdict still won't parse,
    fails the run for human attention. Companions also get a larger output-token budget
    so the verdict JSON doesn't truncate in the first place.
  - Merger can't auto-merge a PR it didn't examine: the merger harness now does a full
    clone (so `git diff origin/<base>...HEAD` actually works — the shallow single-branch
    clone was the root cause of "branch not found" and bogus 0/0/0 scores) and, when it
    still can't examine a real diff, returns a conservative assessment that routes to
    human review. The engine additionally only auto-merges a credible, explained
    (non-empty rationale) within-threshold assessment.

  Bumps the executor-harness image tag (merger clone change) to 1.4.0.

- 7157fd7: Rework run timing, add task types, and add a per-service running-task limit.

  **Run timing.** A run parked waiting for a human is no longer auto-failed after a
  fixed timeout — it waits indefinitely. The old `decision_timeout` machinery is gone
  (the Cloudflare driver re-arms its `waitForEvent` instead of failing; the Node driver
  drops the decision-timeout queue/worker; the `decision_timeout` failure kind is
  removed). Instead, notifications carry a `severity` and a periodic sweep escalates any
  open notification from `normal` (yellow) to `urgent` (red, "Overdue") once it has
  waited past the workspace's `waitingEscalationMinutes` threshold. Every human-input
  park now also guarantees an open notification, so a waiting run is never silently
  stuck. **Breaking:** the `decision_timeout` agent-failure kind is removed.

  **Task types.** Tasks gain a `taskType` (`feature` / `bug` / `document` / `spike` /
  `recurring`) chosen at creation, plus small per-type fields (e.g. a bug's severity /
  repro, a spike's time-box). `recurring` is created through the existing recurring-
  pipeline schedule flow, which now also accepts a free-text prompt for its reused task.

  **Per-service running-task limit.** A new per-workspace settings object
  (`waitingEscalationMinutes` + a task-limit policy) caps how many tasks may run
  concurrently under one service — off, a single shared bucket, or one bucket per task
  type. Starting a task over the limit is refused with a human-readable 409. Managed via
  `GET|PUT /workspaces/:ws/settings` and a new Workspace settings panel. Persisted in a
  new `workspace_settings` table on both runtimes (D1 ⇄ Drizzle), with cross-runtime
  conformance assertions for the task type round-trip and the limit enforcement.

- 8eed95b: Service-scoped best-practice prompt fragments, delivered by agent traits.

  A service (frame block) now owns an explicit selection of best-practice / guideline
  fragments — its programming standards — chosen from the **universal fragment pool**.
  That pool is the built-in catalog plus any fragments a deployment registers at startup
  via the new `registerPromptFragment` seam in `@cat-factory/prompt-fragments` (mirroring
  `registerAgentKind` / the model-provider registry); `GET /prompt-fragments` serves the
  merged pool. A workspace can also configure a **default set new services inherit**
  (`GET|PUT /workspaces/:ws/service-fragment-defaults`), seeded onto a frame's
  `serviceFragmentIds` when it is created (board drop, repo import, or bootstrap).

  Agents gain first-class **capability traits** (`@cat-factory/agents`): a registry of
  standard + custom traits with `traitsFor` / `hasTrait`, assignable to built-in kinds and
  to custom kinds via `AgentKindDefinition.traits`. Two standard traits ship:

  - **`code-aware`** (coder, ci-fixer, fixer, reviewer, architect): the running service's
    selected fragments are folded into the agent's system prompt, unioned with the block's
    own manual pins. Other kinds keep only their block pins.
  - **`spec-aware`** (every code-touching kind): the agent's system prompt gains guidance to
    read the in-repo `spec/` artifact (overview.md → rules.md → features/\*.feature →
    spec.json) and treat it as the source of truth for required behaviour.

  This **replaces the automatic per-run relevance selector**: fragment delivery is now
  explicit (the service's selection) and trait-gated (code-aware) rather than guessed per
  run. Per-block manual pins (`Block.fragmentIds`) still apply to that block's own agents.
  The tenant fragment **library** (account/workspace CRUD + repo sources) remains as a
  management surface but no longer feeds the run path.

  Persistence is mirrored on both runtimes: a `service_fragment_ids` column on `blocks`
  and a `workspace_fragment_defaults` table (Cloudflare D1 migration `0040` +
  `D1ServiceFragmentDefaultsRepository`; Node Drizzle schema/migration +
  `DrizzleServiceFragmentDefaultsRepository`), with the cross-runtime conformance suite
  asserting the workspace-default round-trip, new-service inheritance, and the
  code-aware-only folding on both facades. The UI adds a per-service "Service best
  practices" picker in the inspector and a "Default service best practices" workspace
  settings panel.

  BREAKING (Node facade dev/test only): the Drizzle migration lineage under
  `runtimes/node/drizzle/` was squashed into a single fresh baseline migration — the prior
  incremental migrations had a forked, non-commutative history (left by merging two
  branches) that broke `drizzle-kit generate`/`check`. There are no production Postgres
  deployments, so existing dev/test databases should be dropped and re-created from the
  new baseline rather than migrated. CI now runs `db:check` to keep the lineage honest.

- 0b38aa6: Service selection/deletion UX: browse the repo for the docker-compose path, configure
  a new service inline, send the monorepo flag with the add request, and delete blocks
  optimistically.

  - **docker-compose path picker**: the service inspector's docker-compose field now has a
    "browse" button that opens the GitHub repo tree (the same navigator used for the monorepo
    directory picker, extracted into a reusable `RepoTreeBrowser`) so you pick the compose
    file directly instead of typing it. The path is stored relative to the repo root (the
    Tester runs `docker compose -f <path>` from the clone root), starting the browse inside
    the service's subdirectory for a monorepo service.
  - **Configure a service while adding it**: after adding a service from a repo, the modal now
    shows the same configuration controls as the inspector (test infra + compose path +
    provider/size, and best-practice fragments) bound to the just-created service.
  - **Monorepo flag travels with the add request**: flipping the "this is a monorepo" toggle
    is now modal-local and sent as part of `POST /blocks/from-repo` (`isMonorepo`) instead of
    persisting a separate up-front `PATCH`. The backend persists the flag when the service is
    added. The now-unused frontend `setMonorepo` action + API method are removed (the backend
    PATCH endpoint stays).
  - **Optimistic deletion**: deleting a task, module, service, or recurring pipeline hides it
    immediately and only reappears — with an error toast — if the backend rejects the delete.

- de5a9d7: Add configurable Slack notifications as an additional delivery transport for the
  existing notification mechanism (merge_review / pipeline_complete / ci_failed) —
  not a parallel system. A new `SlackNotificationChannel` implements the same
  `NotificationChannel` port the in-app channel does and is composed alongside it via
  `CompositeNotificationChannel`, so the engine call sites that raise notifications
  are untouched.

  Two scopes, mirroring the GitHub-App precedent:

  - The Slack **connection** (the installed team + its bot token) is bound
    **per-account**. The bot token is multi-tenant data, so it is encrypted at rest
    with `WebCryptoSecretCipher` (HKDF tag `cat-factory:slack`) and never returned on
    the wire — only safe metadata (team name/icon, bot user, scopes) is exposed.
    Onboarding is UI-based: a full OAuth "Add to Slack" flow when the app credentials
    are configured (`SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`/`SLACK_REDIRECT_URL`),
    with manual bot-token paste always available as a fallback.
  - Notification **routing** (which types post, to which channel) is configured
    **per-workspace**.
  - Optional **@-mentions** are **role- and audience-aware**, not a workspace
    broadcast. The per-account member map tags each member `product` or `engineering`,
    and each notification type mentions a specific audience: requirement-review
    findings ping **product** people **plus the task's creator**, while the engineering
    notifications (merge_review / pipeline_complete / ci_failed) ping **only the task's
    creator**. This adds a `requirement_review` notification type (raised by the
    requirements reviewer when it produces findings) and records a `createdBy` on
    blocks (a new nullable column on both runtimes), captured from the authenticated
    user at task creation.

  New surface: the `slack` contracts, the kernel Slack repository ports, the
  `@cat-factory/integrations` Slack module (`SlackNotificationChannel`,
  `SlackConnectionService`, `SlackSettingsService`, `SlackMemberMappingService`,
  `SlackApiClient`), the shared `SlackController` (+ public OAuth callback) and
  `SlackConfig`, and the orchestration `SlackModule`. Persisted on **both** runtimes:
  the Cloudflare D1 tables (migration `0037_slack.sql`) and the Node Postgres tables
  (Drizzle schema + generated migration), with both facades wiring the channel +
  management module. The cross-runtime conformance suite asserts the routing and
  member-map persistence parity on both stores.

  This change also closes a pre-existing parity gap: the Node/Drizzle facade now has
  a `notifications` table + `DrizzleNotificationRepository` and wires
  `notificationRepository`, so the notification subsystem — and any channel composed
  onto it — fires on the Node runtime exactly as on the Worker.

  Opt-in via `SLACK_ENABLED=true` (requires `ENCRYPTION_KEY`); off by default, so
  unconfigured deployments are unaffected.

- a54ada2: Spec-writer now applies ONE task's requirements as an increment, not a service-wide aggregate.

  The spec-writer used to receive `serviceTasks` — every task under the block's service
  frame, merged or not — and fold them all into one document. So a run for a single task
  ("add CRUD for office tables") produced a spec covering five unrelated sibling resources,
  and the spec-reviewer correctly read it as scope contamination. That violates the
  branched-work model: a task's baseline is what's already merged, plus its own increment;
  an unmerged sibling task does not exist for it.

  The spec-writer now reads the spec already committed on its work branch (the baseline)
  and applies ONLY the current task's clarified/reworked requirements as an increment —
  adding what the task introduces and adjusting existing requirements only where the task
  changes their behaviour. It translates the given requirements and does not invent or fill
  gaps (that is the requirements step's job). The in-repo `spec.json` stays the complete
  service spec; only the writer's editing scope narrows.

  - Engine: removed `gatherServiceTasks` and the `serviceTasks` field from
    `AgentRunContext`. The dispatch feeds the single task (the block, whose description is
    already the reworked requirements).
  - Reviewer: the `spec-companion` now judges fidelity to the requirements it was given and
    no longer penalises the writer for requirements it was never handed.
  - Harness (`SpecJob.tasks` → `SpecJob.task`): the prompt is reframed as "baseline plus
    this task's increment". Image retagged 1.6.0 → 1.7.0 (deploy/backend `image:publish` +
    wrangler.toml) so the new digest rolls out.

  Breaking: the `/spec` harness job shape changes (`tasks: []` → `task: {}`) and
  `AgentRunContext.serviceTasks` is gone. No migration — stale in-flight jobs simply break.

- 2dd7e56: Step observability + a discoverable iteration-cap decision.

  - Every pipeline step now carries the `runId` of the run it belongs to, surfaced on
    the step-detail panel (copyable) so a lone step in a log line or view names its run.
    It is a read-time projection (always equals the enclosing run's id), stamped on read
    and on emit; not persisted independently.
  - A step's duration now stops counting once it is terminal OR parked on a human. The
    engine records `pausedAt` when a step parks on an approval / decision / iteration-cap
    gate and clears it when the step resumes or finishes, so elapsed time no longer
    accrues while the run waits for input (the symmetric counterpart of the terminal
    freeze). A step finished directly out of a parked approval is billed to the pause
    instant, not the later human decision.
  - An iterative gate that spends its automatic budget (a quality companion at its rework
    cap, or the requirements reviewer at its iteration cap) now raises a
    `decision_required` notification. Previously the three-choice decision was reachable
    only by drilling into the parked step, so the run looked silently stuck; the inbox
    item now opens that step's decision surface (companion → step detail with the
    iteration-cap prompt; requirements → the review window).

  No DB migration: the step fields ride in the existing execution `detail` JSON, and the
  notification `type` column is free text in both runtimes.

- 5ca8086: Add alternate subscription-backed coding harnesses (Claude Code / Codex) alongside
  the Pi proxy harness.

  - New per-workspace **subscription token pool** (`provider_subscription_tokens`,
    D1 + Postgres, encrypted at rest) with usage-aware rotation, behind a kernel
    port + `ProviderSubscriptionService`, wired into all three runtimes.
  - A guided **LLM Vendors** navbar UI to connect Claude / Codex / GLM (Z.ai) /
    Kimi (Moonshot) / DeepSeek subscription credentials (token pool, write-only).
    GLM / Kimi / DeepSeek all run via Claude Code against the vendor's
    Anthropic-compatible endpoint; the unfiltered credential list covers every vendor.
  - The executor-harness image now bundles the Claude Code and Codex CLIs; the
    harness selects `pi` / `claude-code` / `codex` per job from the model, and the
    subscription harnesses authenticate direct-to-vendor (no proxy) and report token
    usage from the CLI event stream for rotation + telemetry.
  - The model catalog becomes a canonical-model → provider map with precedence
    **subscription > direct > cloudflare** ("subscriptions always win"): latest
    Opus/Sonnet + GPT-5.5/5.4 (subscription-only), GLM-5.2/Kimi gain a Claude-Code
    subscription flavour, and `ModelOption` now carries per-flavour cost, context
    window, and a `quotaBased` flag (subscription usage is flat-rate quota, never
    billed against the spend budget).
  - A block's model is shared by all its pipeline steps, so a pin to a subscription-only
    model (Claude Code / Codex — container-only, no provider key) is degraded to the
    step's env-routing default for every INLINE LLM path through one shared seam
    (`inlineModelRef` / `resolveInlineModelRef`): both the inline agent executor and the
    requirements reviewer/rework, so the inline steps run instead of hard-failing and the
    two paths can't drift. The claude-code subscription harness repairs malformed
    structured output through the vendor's own Anthropic-compatible endpoint (the Pi
    harness still uses the proxy; Codex keeps the graceful no-repair path).
  - Hardening: the per-vendor token pool is capped to bound growth; the leased
    subscription credential is scrubbed from subscription-repair error details (not just
    GitHub-shaped secrets); and Codex token usage is read from its cumulative
    `total_token_usage` so multi-turn runs attribute usage correctly for rotation.

- d0697d1: Surface CI and conflict gate conclusions in the run-detail UI through one universal gate
  window.

  The polling gates (`ci`, `conflicts`) already tracked phase/attempts/headSha on
  `step.gate`, but the frontend type didn't even declare the field, so none of it rendered —
  and the gates' actual conclusion (which CI checks failed, whether the PR conflicts) was
  computed in `evaluateGate` only to be handed to the helper agent and then discarded. A
  user opening a CI or Conflicts step saw a generic prose panel with nothing about why the
  gate was looping.

  Backend: `gateStepStateSchema` now persists the precheck outcome — `lastVerdict`,
  `lastFailureSummary`, and (CI only) the structured `failingChecks` list — written on every
  probe in `evaluateGate` and preserved across the helper dispatch. Gate state lives in the
  execution `steps` JSON, so both runtimes pick this up with no migration. (The conflicts
  gate carries no structured detail because GitHub reports mergeability as a single verdict,
  not a file list.)

  Frontend: a single `GateResultView` window, registered on the shared `resultView` seam for
  both the `ci` and `conflicts` kinds, shows the verdict, the helper attempt budget, the
  gated commit, and — for CI — the failing checks. The two board views (`TaskExecution`,
  `PipelineProgress`) now also render each gate's helper (`ci-fixer` / `conflict-resolver`)
  as a possible/running/completed/skipped sub-node, the same treatment the Tester's fixer
  already had.

- e0230a0: Surface the real reason a run failed instead of a generic "the implementation container
  reported a failure", and stop the cross-runtime conformance suite from hiding driver bugs.

  - **Fix the clobbered failure record.** Two inline gates that already knew the precise
    failure — an unparseable companion (Spec Reviewer) verdict (`companion_rejected`, with
    the companion's raw reply as the detail) and a Tester gate that exhausted its fixer
    budget (`agent`) — recorded a rich `failRun` AND then returned `job_failed`. The durable
    driver (Cloudflare `ExecutionWorkflow` / Node `driveExecution`) treated `job_failed` as
    "fail the run" and fired a SECOND `failRun`, overwriting the good record with a generic
    one: kind `job_failed`, message the literal `"companion_rejected"`, no detail, and the
    misleading "inspect the container logs" hint. Those gates now RETURN the classification +
    detail on the `job_failed` result (`failureKind`/`detail` on `AdvanceResult`), and the
    driver funnels them through the single `failRun` — so the board shows the actual message,
    the precise kind/hint, and the raw reply under "Show detail".

  - **`failRun` is now idempotent.** A run already in a terminal `failed` state keeps its
    first (richest) failure rather than being overwritten, so no future
    record-then-return-`job_failed` path can clobber it.

  - **Share the production driver loop.** The runtime-neutral per-run driver
    (`driveExecution`) moved into `@cat-factory/orchestration` and is now exported; the Node
    service injects a real `setTimeout` sleep, the Cloudflare workflow wraps the same
    advance/poll calls in durable steps. The cross-runtime conformance harnesses no longer
    hand-roll their own advance/poll loop (which never re-called `failRun` on `job_failed`,
    the gap that let this ship) — both drive runs through the SAME `driveExecution` via a
    shared `driveWorkspace` helper, so the suite exercises real production driving logic. The
    companion-rejected conformance assertion now checks the rich message + stored detail.

- 0090313: Surface a step's model the moment it starts, not only once its work finishes.

  A pipeline step's `model` was recorded on the step only after the work returned: a
  container step got its model from the job handle once `startJob` (which blocks for
  the whole cold-boot dispatch) returned, and an inline step from the result once the
  LLM query was over. But the model is fixed the instant its ref resolves (block pin >
  workspace per-kind default > env routing) — well before the container is up or the
  query runs — so the board showed "Spinning up container…" / a working step with no
  model for that whole window.

  The executor port gains an optional, side-effect-free `resolveModel(context)` that
  previews the `provider:model` without dispatching (implemented by the inline
  `AiAgentExecutor` and the `ContainerAgentExecutor`, forwarded by
  `CompositeAgentExecutor`). The execution engine calls it up front and sets
  `step.model` before the first "spinning up container" emit (container steps) and
  before the blocking LLM call (inline steps), so the model rides the same emit that
  shows the step starting. The job handle / result still re-assert the same value, and
  the preview is best-effort (an executor that can't preview, or a resolution failure,
  simply falls back to the old timing). No wire-contract change — the SPA already
  renders `step.model` whenever present, so it now appears immediately. A cross-runtime
  conformance assertion pins that `step.model` is set on the booting/querying emit.

- cc8d96a: Flesh out the Tester agent, add an agent configuration-contribution mechanism, and
  make Mocker always precede Tester.

  - **Pipelines:** every built-in pipeline that runs a `tester` now runs `mocker`
    immediately before it, so the Tester has its external-dependency mocks up.
  - **Config contribution:** agents (built-in or custom, via the agent registry's new
    `configContributions`) declare task-level config parameters. The union over a
    task's pipeline appears on task creation + the inspector and freezes once the
    contributing agent's step starts. Values persist as a sparse `agentConfig` map on
    the block (keys/values length-capped); the catalog rides the workspace snapshot. The
    Tester contributes its `environment` (local vs ephemeral) and Playwright its e2e
    target (CI vs ephemeral). The old fixed `testTarget` block field is dropped — its
    column is dropped on both runtimes too (no backwards-compat shim).
  - **Tester → Fixer loop:** `tester` is now a container agent that runs the project's
    tests — standing infra up locally via the service's docker-compose (rootless
    Docker-in-Docker in the harness) or against an ephemeral environment — and returns
    a structured report (what was tested, outcomes, concerns, greenlight). On a
    withheld greenlight the engine loops a new dedicated `fixer` agent with the report
    and re-tests, up to the task's merge-preset attempt budget. Only **blocking
    (high/critical)** concerns withhold the greenlight — low/medium are advisory, so a
    trivial nit can't burn the whole fixer budget — and the engine re-applies that rule
    defensively over the report. When the budget is spent (or there's no PR branch to
    fix, or the report is unparseable) the run fails for real (the tester step is left
    un-`done`) and raises a human-actionable `test_failed` notification (retry action),
    mirroring the CI gate. New harness `/test` + `/fix-tests` endpoints; reports + fixer
    summaries render in the inspector and step detail.
  - **Service + provisioning config:** a service frame carries the Tester's
    docker-compose path / "no infra dependencies" toggle (a Tester pipeline can't start
    until one is set), plus a cloud provider and abstract instance size that resolve to
    the concrete instance-type id forwarded to the runner. Per-service sizing applies to
    the self-hosted-pool and local-Docker backends; the Cloudflare Container backend has
    a fixed per-class instance type (`wrangler.toml`) with no per-dispatch override, so
    it ignores the hints (pick `cloudflare` when you don't need per-service sizing).
  - **Account default cloud provider (fully wired):** accounts carry a
    `defaultCloudProvider` new services inherit — persisted on both runtimes, settable
    via `PATCH /accounts/:id` (owner-only) and the account menu, returned on the account
    wire, and pre-filled as the service editor's provider default.
  - **Local mode is 100% Docker/Podman:** a new first-class `docker` cloud provider
    represents the local daemon. The local runner backend sizes each per-job container
    from the abstract instance size (`--memory`/`--cpus`) and runs the Tester job
    `--privileged` so it stands its docker-compose infra up with Docker-in-Docker on the
    host daemon — never Cloudflare. A Tester-only pipeline with no PR branch now fails
    cleanly (no fixer to push to) instead of throwing.
  - Mirrored across both runtimes (D1 migration ⇄ Drizzle schema + migration).

- 43f2443: Add a unified, persisted requirements structure stored in each service's GitHub
  repo. A new `requirements-writer` container agent runs before the coder in
  `pl_full` (and standalone via the new `pl_requirements` pipeline): it aggregates
  the clarified requirements of every task under the service frame into one
  PRESCRIPTIVE document, committed to the implementation branch
  (`cat-factory/<blockId>`, created from base when absent) so the spec is present
  before any code is written.

  The harness deterministically renders the document into `requirements/`: the
  canonical `requirements.json` (a `RequirementsDoc`), `overview.md`, `rules.md`
  (cross-cutting domain rules / invariants), a `version.json` staleness manifest,
  and Gherkin `features/*.feature` files (one `Scenario` per acceptance criterion).
  Gherkin is generated two-pass — mechanical render in the harness, then the
  `acceptance` agent polishes the `.feature` files and `playwright` turns each
  scenario into a runnable test. Every container agent reads the requirements via a
  new `REQUIREMENTS_GUIDANCE` block in its global `AGENTS.md`. The in-repo files are
  the source of truth; the engine strictly validates the returned doc
  (`parseRequirementsDoc`) at ingest. Mirrors the blueprint pattern; covered by the
  cross-runtime conformance suite.

- acac735: Unify the pipeline's polling-gate steps (`ci`, `conflicts`) behind one declarative Gate
  framework, and apply the same "skip the work when it isn't needed" idea to the inline
  requirements-incorporation companion.

  The gates already only spun up their helper container agent (`ci-fixer` /
  `conflict-resolver`) on a real red check / actual conflict — a green CI or mergeable PR
  always advanced with nothing spun up. But the two gates were near-identical ~70-line
  methods (`evaluateCi`/`evaluateConflicts`), duplicated `pollCi`/`pollConflicts`, two
  `pollAgentJob` completion branches, two `AdvanceResult` variants, two step-state shapes,
  and two copy-pasted sleep/poll loops in **both** durable drivers. Adding a third gate
  meant copying all of it.

  Now a gate is a `GateDefinition` registry entry (`modules/execution/gates.ts`) supplying
  only its differentiators — `wired()`, `probe()` (→ `pass` / `pending` / `fail`),
  `helperKind`, `onExhausted` — and one generic machine drives every gate:
  `ExecutionService.evaluateGate` / `dispatchGateHelper` / `pollGate`. Both durable drivers
  (Cloudflare `ExecutionWorkflow`, Node `drive.ts`) collapse their two poll loops into one
  `awaiting_gate` branch. Behaviour is unchanged; the duplication is gone, and a new gate
  is now a registry entry rather than a new copy of the machinery.

  **Companion skip.** `hasNotesToIncorporate` short-circuits `runIncorporationCycle` so the
  requirements rework + re-review LLM calls are skipped when the human left nothing to fold
  in (every finding dismissed, no answered replies, no redo feedback): the review settles
  `incorporated` with no LLM call and downstream agents fall back to the original
  description.

  BREAKING (wire + API): the per-step gate state moves from `step.ci` (`CiStepState`) /
  `step.conflicts` (`ConflictsStepState`) to a single `step.gate` (`GateStepState`, phases
  `checking`/`working`); the `awaiting_ci`/`awaiting_conflicts` `AdvanceResult` variants
  become `awaiting_gate`; and `ExecutionService.pollCi`/`pollConflicts` become `pollGate`.
  Steps persist as opaque JSON, so there is no DB migration — in-flight gate runs simply
  re-derive their state. The frontend does not read this state, so the SPA is unaffected.

- 3841315: Tasks are now authored by the user instead of being auto-generated. Removed the
  random `TASK_NAME_BANK` placeholder titles: "Add task" opens a modal where the
  user enters the task's title and description. A new task is created in `planned`
  state and is never launched implicitly — the user starts a pipeline on it
  explicitly, and can keep editing its title and description (in the inspector)
  until it has started, after which those details are locked. `addTask` now
  requires a `title` and accepts an optional `description`.
- 48d2f0d: Add per-workspace, per-agent-kind default model selection. A workspace can choose
  which model each agent kind defaults to (e.g. point `architect` at a strong model
  and `tester` at a cheap one), overriding the env-driven `AGENT_routing` for that
  workspace at run time. New `GET|PUT /workspaces/:workspaceId/model-defaults`
  endpoints (returning/replacing `{ defaults: Record<agentKind, modelId> }`) and the
  selection surfaced on the workspace snapshot as `modelDefaults`. Persisted in
  `workspace_model_defaults` on both runtimes (D1 migration 0028 / a new Postgres
  migration).

  The defaults are applied uniformly through one shared resolver
  (`resolveStepModelRef` in `@cat-factory/agents`) used by **every** executor — the
  inline LLM executor, the container executor and the requirements reviewer, on both
  the Worker and the Node service — so a step's model resolves as block-pinned >
  workspace per-kind default > env routing for the kind > env default for every agent
  kind, not just the container kinds. A stale/unresolvable block pin now falls
  through to the workspace default instead of skipping it. Request keys (agent kinds)
  and values (model ids) are validated as trimmed, non-empty strings.

- 3e6a844: Workspace creation/onboarding overhaul: real users, non-GitHub auth, invites,
  named+described boards.

  - **Persistent identity**: a new `users` + `user_identities` model replaces the
    GitHub-numeric-id identity. Memberships, `blocks.created_by`, personal
    subscriptions, and the session payload are all re-keyed to a generated `usr_*`
    id. (BREAKING: pre-existing personal accounts — keyed by GitHub login with a null
    `owner_user_id` — stop matching and a fresh personal account is created on next
    sign-in; old member-mapping rows keyed by GitHub id are orphaned. No migration,
    per the pre-1.0 policy.)
  - **Non-GitHub auth**: email/password (WebCrypto PBKDF2 hashing) and Google OAuth
    login alongside GitHub. New-user creation is invite-only plus an optional
    `AUTH_ALLOWED_EMAIL_DOMAINS` self-signup allowlist (fail-closed). A user without
    a GitHub account works fully — repo access is via the GitHub App, not a user token.
  - **Email invitations**: invite teammates by email into an org account; the invitee
    redeems a tokened link to gain membership. Email is sent via a pluggable
    `EmailSender` (SendGrid / Resend adapters) whose provider + API key are
    **onboarded per-account in the UI and stored sealed in the DB** (not env), like
    the Slack bot token. New tables: `users`, `user_identities`, `account_invitations`,
    `email_connections` (D1 + Drizzle).
  - **Board name + description**: `Workspace.description` end to end (create + edit).
  - **Onboarding discovery**: org members see and open existing org boards from the
    switcher instead of being forced to create one.
  - Slack member-mapping is re-keyed from `githubUserId` to the internal `userId`.

### Patch Changes

- 8eed38c: Address review findings on the runtime-facades work:

  - **Node durable execution: fix pg-boss dedup.** The advance queue is now created with
    the `exclusive` policy. `singletonKey` alone does NOT deduplicate under pg-boss's
    default `standard` policy (the singleton unique indexes are policy-gated, and the
    policy-independent one needs `singletonSeconds`), so duplicate `signalDecision`/sweeper
    sends could double-drive a healthy run. `exclusive` makes at most one advance job per
    run id live at a time, restoring the documented no-op semantics.
  - **Node decision timeout.** A run parked on a human decision now arms a delayed
    `execution.decision-timeout` job; `ExecutionService.expireDecision` fails it
    `decision_timeout` only if still parked on that exact decision (idempotent, no driving),
    matching the Cloudflare driver's `waitForEvent` timeout instead of waiting forever.
  - **Node Postgres pool** attaches an `'error'` handler so a transient idle-client drop
    (Postgres restart/failover) no longer crashes the process.
  - **Provider registration parity.** The Worker now registers `openai`/`anthropic` only
    when their key is set (like the Node facade), so an unconfigured provider throws a clear
    "Unsupported model provider" error instead of failing deep in the vendor SDK.
  - **Node config fail-fast**: a too-short `AUTH_SESSION_SECRET` with OAuth configured (and
    no dev-open) now refuses to boot with a clear message rather than silently 503-ing.
  - **`BEDROCK_MODELS=""`** (set-but-blank) is treated as "allow all" rather than rejecting
    every model.
  - **LLM proxy** trims the bearer token, matching the auth middleware.
  - The Node `driveExecution` gate handling drains gate→gate transitions (e.g. a CI step
    dispatching a `ci-fixer`) in-iteration rather than relying on the next advance.

- 9d3a956: Clarity reviewer (bug-report triage) + bug investigator: a new bug-fix pipeline front.

  Adds two new agents at the front of a new `pl_bugfix` ("Triage & fix bug") pipeline preset:

  - **`bug-investigator`** — a read-only container agent (it runs the shared `/explore`
    harness path used by `architect`/`analysis`, so no new harness endpoint or image change).
    It clones the repo, reads the codebase from the raw bug report, and returns a prose
    enriched report plus an OPTIONAL working hypothesis — which it omits unless reasonably
    confident, so a low-confidence guess never misdirects the fix. Its output feeds the
    clarity reviewer (the triage subject) and the coder (a non-binding lead, via `priorOutputs`).
  - **`clarity-review`** — an inline engine gate step that triages the bug report for
    _fixability_ (repro steps, expected-vs-actual, environment, affected area), mirroring the
    requirements-review iterative loop (raise findings → answer/dismiss → incorporate into one
    standard-format clarified report → re-review until it converges, with the same per-task
    `maxRequirementIterations` / `maxRequirementConcernAllowed` knobs). The converged clarified
    report substitutes downstream as the task description for the spec-writer/coder (when both
    a requirements and a clarity review exist, the requirements doc wins).

  Persisted as a new `clarity_reviews` table on BOTH runtimes (D1 migration
  `0002_clarity_reviews` + Drizzle migration), wired in both facades' containers with a new
  `clarity` event on the real-time transport and a `clarity_review` notification type. A
  cross-runtime conformance assertion pins the clarified-brief substitution against both
  stores.

- ad9ba9e: Quality companions (Spec Reviewer, coder's Reviewer, Architect Companion) no longer
  get stuck when they spend their automatic rework budget — they park for a human, the
  same way the requirements reviewer does at its iteration cap.

  Previously a companion that stayed below its quality bar after `maxAttempts` automatic
  reworks failed the run (`companion_rejected`), leaving the task stuck with no path
  forward. Now it parks on a shared iteration-cap gate offering the same three choices as
  the requirements reviewer:

  - extra-round — raise the budget by one and loop the producer back for one more pass;
  - proceed — advance the pipeline accepting the producer's current output;
  - stop-reset — cancel the run and return the task to phase zero (editable), the
    producer's latest output preserved on its branch.

  The two gates now share one mechanism rather than duplicating it: the choice contract
  (`iterationCapChoiceSchema` / `resolveIterationCapSchema`), the parking
  (`parkStepOnDecision`), the gate-resume advance (`advancePastResolvedGate`, also used by
  the generic approval gate), the three-way dispatch (`dispatchIterationCap`, where
  stop-reset is uniformly `cancel()`), and the guard that stops the generic
  approve/request-changes/reject resolvers from short-circuiting an iterative gate
  (`assertNotIterativeGate`). The frontend renders both with one `IterationCapPrompt`
  component.

  `companion_rejected` now means only a genuinely unparseable companion verdict (truncated
  / malformed even after a repair retry) — exhausting the rework budget is no longer a
  failure. New `companion.exceeded` flag marks a parked companion gate;
  `POST /executions/:executionId/steps/:approvalId/resolve-exceeded` resolves it. No new
  persistence — the gate reuses the existing execution row + durable decision-wait, so both
  runtime facades get it; the cross-runtime conformance suite asserts the parking and all
  three resolutions against both.

- 3e0d753: Fix the spec-writer ⇄ spec-companion infinite-rework loop that bled tokens on
  every spec task. A companion grades the producer step's `output`, but an
  artifact-producing container agent (the spec-writer, the Blueprinter) returns its
  raw Pi transcript summary there, not the document it committed. The spec-companion
  was therefore grading a 2,000-char transcript fragment, declared every pass
  "unreviewable", and looped the producer to its rework cap (~3 wasted spec-writer
  container runs) on every spec task. Telemetry confirmed the spec itself was valid
  and NOT truncated (`finish_reason='stop'`, well under the output cap) — the bug was
  the handoff, not the model or the output limit.

  The engine now replaces a finished producer step's reviewable output with a
  deterministic rendering of the structured ARTIFACT it emitted (`renderSpecForReview`
  / `renderBlueprintForReview`), via a single universal seam keyed off WHICH artifact
  the result carries (`reviewableArtifactOutput`) rather than a per-agent special
  case — so every artifact-producing agent with a companion, today and future, grades
  the product instead of the transcript. The SPA reader and downstream `priorOutputs`
  see the real document too. A cross-runtime conformance assertion pins this so a
  facade can't drift back to surfacing the transcript.

- 3e7ab89: Make the conflict-resolver actually see the conflict, and stop it churning to 10 attempts.

  Telemetry on a failed run showed the `conflict-resolver` was handed `userPromptFor(context)`
  — the full task brief plus every prior agent's output (~53 KB) — with no mention of which
  files conflicted or that there were conflicts at all. The model drifted onto the original
  feature task (it returned a "test report is ready" answer) and never touched the markers,
  so the gate re-dispatched 10 times with the PR head SHA never moving, then failed the run.

  - Harness: when the base merge surfaces conflicts, build a conflict-focused prompt that
    leads with the exact conflicted files and their `git diff` hunks (new `conflictDiff`
    helper), keeping the task only as a trailing reference. Clean merges and no-op
    "already up to date" cases are now logged distinctly so the "GitHub says conflicting but
    the local merge is clean" loop is diagnosable. Bumps the harness image (1.7.1 -> 1.7.2).
  - Server: the conflict-resolver job body no longer renders `userPromptFor(context)`; it
    sends only a compact task reference (title + description). The harness supplies the
    actual conflict material.
  - Orchestration: the conflicts gate now caps escalations at 3 (was CI's default of 10) via
    its own `attemptBudget` — a conflict retry re-merges the same base with no new signal, so
    it fails fast to a manual-resolution notification instead of burning containers.

- e50e78a: Fill the per-run container reaping gaps and unify the bootstrap flow onto the
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

- b48c455: Internal cleanup — no behavior or API changes. Deduplicates repeated helpers into
  shared modules: the subtask-snapshot comparison (`sameSubtasks`/`sameSubtaskItems`)
  used by the execution + bootstrap flows now lives in `@cat-factory/kernel`
  (`domain/subtasks.logic`), a `getErrorMessage` helper replaces the repeated
  `error instanceof Error ? error.message : String(error)` expression, the shared
  `STANDARDS_FOOTER` prompt line is centralized in `@cat-factory/agents`
  (`agents/prompt-shared`), and the identical document/task in-memory provider
  registries now extend a generic `MapSourceRegistry` exported from
  `@cat-factory/kernel`.
- b40da13: Simplify task granularity and run configuration; open the pipeline-step detail
  overlay from the zoomed-in board.

  - **Open the agent step-detail overlay from the board.** Clicking a pipeline agent
    in a zoomed-in task card now opens the full `AgentStepDetail` overlay (execution
    metadata + the agent's prose output), exactly like clicking it from the inspector
    or the focus-view pipeline — instead of expanding raw text inside the card.
  - **Removed the per-task auto-merge "confidence threshold".** The confidence-score
    auto-merge gate (`Block.confidenceThreshold`, the inspector + task-card UI, the
    `DEFAULT_CONFIDENCE_THRESHOLD` constant) is gone; the `merger` step's merge-policy
    preset (complexity/risk/impact ceilings) is the sole auto-merge gate. (The raw
    `confidence` score is still recorded for transparency.)
  - **Removed "feature" tracking from the board and the service map.** `Block.features`
    (the inspector's "Features implemented" tags and the board/module feature badges)
    is removed, and the in-repo blueprint / board-scan decomposition is now
    service → modules only — the Blueprinter, harness rendering, and reconciliation no
    longer produce a "feature" sub-level or derive tasks from it. Acceptance scenarios
    are now freeform per task (decoupled from features) pending a deeper
    requirements-driven model.
  - **Task creation picks a pipeline + merge policy; model selection removed.** The
    "Add a task" modal now offers a default pipeline (`Block.pipelineId`, which the
    task's Run/Start controls use) and a merge policy preset. The per-task model
    picker is gone — a model is resolved per step, not per task.

  Migration `0025_task_run_config.sql` drops the `confidence_threshold` and `features`
  columns and adds `pipeline_id`. Bumps `@cat-factory/executor-harness` (the blueprint
  rendering inside its image changed).

- ec0c416: Continue decomposing the `ExecutionService` engine by extracting three flow-control
  collaborators (behaviour-preserving):

  - **`MergeResolver`** — resolves a `merger` step's assessment into an auto-merge (within
    the task's threshold preset AND credibly explained) or a `merge_review` notification.
  - **`CompanionController`** — drives a companion (reviewer / spec / architect) step: grade
    the producer, then pass / loop the producer back / park on the iteration-cap gate; an
    unparseable verdict fails the run rather than silently passing.
  - **`TesterController`** — drives the Tester gate's fix loop: apply the report (greenlight →
    advance; withheld + budget → dispatch the fixer and re-test; spent/unparseable → fail).

  Each collaborator owns its cohesive logic; the shared engine primitives they need
  (`resolveMergePreset`, `finalizeMerge`, `parkStepOnDecision`, `loopCompanionProducer`, the
  instance persistence/emit, container reclaim) stay on the engine and are injected. The
  engine's public surface and behaviour are unchanged. Trims ~540 lines from
  `ExecutionService` (now ~3,280, down from ~4,100 at the start of this decomposition).

- 8eed38c: Author relative imports with explicit `.js` extensions across the shared backend
  packages so their emitted `dist` is directly resolvable by Node's ESM loader (no
  bundler required). This lets the Node runtime run the built output on plain Node
  (`node dist/main.js`) — no tsx, no esbuild bundle — and is inert for the Cloudflare
  Worker (wrangler bundles regardless). `handlebars/runtime` is imported as
  `handlebars/runtime.js` for the same reason (its type is sourced from the full
  package, type-only). No behaviour or public-API change.
- 14840ec: Extract `AgentContextBuilder` out of `ExecutionService` (first step of decomposing
  the ~4,100-line engine). The per-step agent-context assembly — the (possibly
  reworked) requirements/clarified-report substitution, linked docs/tracker issues,
  the live environment, the service-frame config + account-default cloud provider, the
  best-practice fragments, and the revision-context — moves into a focused collaborator
  that only reads repositories. It's also the single home for service-frame resolution
  (`resolveServiceFrameId`/`resolveServiceConfig`), which a few other engine paths reuse.
  Pure refactor (methods moved verbatim, dependencies injected); `ExecutionService`'s
  public surface and behaviour are unchanged. Trims ~325 lines from the engine.
- 268c15d: Fix the async requirements incorporation getting stuck "incorporating" forever, and visualize
  the reviewer's two background stages on the board.

  The async incorporate/re-review cycle could hang permanently: `incorporateRequirements`
  signalled the durable driver to wake but left the run `blocked` from the gate park, and
  `advanceInstance` no-ops on any non-`running`/`paused` run — so the woken driver returned
  `noop` and ended WITHOUT running the re-entrant fold + re-review, leaving the review stuck
  `incorporating`. It now re-arms the run to `running` before signalling, exactly like every
  other resume path (e.g. `advancePastResolvedGate`).

  The cycle also now reports its two stages distinctly. A new transient `reviewing` review
  status is set (and pushed via `requirementReviewChanged`) once the answers are folded and
  the reviewer is RE-reviewing the document, so the UI can tell which of the two LLM calls is
  running instead of one conflated "incorporating and re-reviewing" message.

  - **Board / inspector.** A `requirements-review` gate that is mid-cycle (`incorporating` /
    `reviewing`) no longer shows the "Approval needed" badge or the "Review & approve" button
    on the task card, frame badge, or inspector step list — it shows a working indicator
    ("Incorporating answers…" / "Re-reviewing…") instead, since no human action is needed
    until the reviewer comes back.
  - **Review window.** The single background banner is split into two distinct messages keyed
    on the stage, and edits stay frozen during both.

  Breaking (pre-1.0, no migration): the new `reviewing` review status is a new wire value;
  the `status` column is free text on both runtimes, so no schema change is required.

- c9d3f49: Fix the requirements reviewer ignoring its per-workspace default model (it always ran
  on the routing default, e.g. Qwen, even when a model was pinned for it in Default Models).

  The `requirements` → `requirements-review` rename left `RequirementReviewService`'s
  `REQUIREMENTS_AGENT_KIND` constant on the old `'requirements'` key. The Default Models UI
  saves a kind's default under the catalog archetype kind (`requirements-review`), so the
  reviewer looked up the default under a key nothing writes, found nothing, and fell through
  to the deployment routing default. Aligned the constant to `'requirements-review'`, matching
  the catalog, the seeded pipelines' step kind, and the observability tag.

- 794b628: Deleting a board block (service/module/task) is now idempotent and best-effort: a
  block whose row is already gone — e.g. a half-deleted service that left a dangling
  mount, repo-link or execution — no longer fails with `404 Block '…' not found`.
  `BoardService.removeBlock` tolerates an absent block, falling back to cleaning up
  every related entity it can still find (executions, repo links, the account-owned
  service + its mounts, surviving descendants) instead of letting "not existing"
  block the deletion. A block that exists but is homed in another, un-mounted
  workspace still 404s (the visibility boundary is unchanged). The cross-runtime
  conformance suite now asserts the idempotent delete against both facades.
- 1a0686f: Collapse the requirements-review and clarity-review services onto a shared
  `IterativeReviewService` base class. The two services ran the same iterative loop
  (reviewer raises findings → human answers/dismisses → incorporation LLM folds them
  into a standardized document → re-review until convergence or the iteration cap),
  duplicated across ~1,000 lines. The loop now lives in one place; each kind supplies
  only its differentiators (subject + prompts, the persisted document field —
  `incorporatedRequirements` vs `clarifiedReport` — id prefixes, agent-kind tags and
  notification type). Pure refactor: the public method signatures, wire contracts,
  persisted tables and behaviour are unchanged.
- b287996: Give every pipeline step its own runner job id so sibling steps in one run can't read
  back each other's results.

  Every container step of a run was dispatched and polled under the bare execution id,
  which is ALSO the per-run container's address. The harness keys its per-kind job
  registries by that id and `GET /jobs/{id}` checks them in a fixed order, so two steps
  that ran close enough together to share the still-warm container collided: a poll for
  one step returned another step's finished result. The visible symptom was an
  `architect` (`/explore`) step returning the `spec-writer`'s (`/spec`) document verbatim
  with no model call of its own — and, latently, `blueprints`/`mocker` reading back the
  `coder`'s result.

  The fix separates the two conflated identifiers into an explicit `RunnerJobRef`:

  - **`runId`** — the run (execution). On backends that share one container across a run
    (the Cloudflare per-run Container, the local Docker container) this addresses that
    container, and `release` reclaims it.
  - **`jobId`** — the job itself, now UNIQUE PER STEP (`<executionId>-<agentKind>`). The
    harness registers and polls each step's job by it, so siblings never alias.

  `RunnerTransport.dispatch`/`poll`/`release` and `RunnerJobClient` now take the ref;
  `AgentJobHandle` carries the `runId` so the poll/stop site can re-address the per-run
  container. The Cloudflare and local transports key the container by `runId` (one
  container per run, reclaimed as a unit) and read the harness job by the per-step
  `jobId`; a self-hosted pool, being per-job, keys on `jobId` (which already kept its
  steps distinct). Single-job flows (repo bootstrap/scan) use the same value for both.
  The engine reclaims a run by its id and passes the in-flight step's job id so a pool can
  cancel exactly it.

  Breaking: `RunnerTransport` implementers now receive a `RunnerJobRef` instead of a bare
  job-id string. The local container label moves from `cat-factory.jobId` to
  `cat-factory.runId`.

- b156b4b: Personal-password prompt: per-user dual-mode resolution + accurate model context sizes.

  The individual-usage credential gate now prompts for a personal password exactly when
  dispatch will actually lease one, per user:

  - A subscription-only individual model (Claude / Codex) always needs the personal
    credential (no fallback).
  - A DUAL-MODE individual model (GLM, which also has a Cloudflare base) is per-user: a user
    who has connected their own GLM subscription runs on it (gated on their password), while
    a user without one falls back to Cloudflare GLM with no prompt. Dispatch
    (`ContainerAgentExecutor.resolveEffectiveRef`) and the gate now share this decision via a
    new `hasPersonalSubscription(userId, vendor)` seam wired in both runtime facades, so the
    two can't drift. Previously GLM-on-Cloudflare always prompted (the gate keyed off "the
    model has an individual subscription flavour" rather than "this user will use it").
  - A block pinned to any non-subscription model (Cloudflare / Bedrock / direct) is never
    gated just because a workspace per-kind default happens to be an individual model — a
    resolvable block pin wins for every step, mirroring `resolveStepModelRef`.

  The precedence is a pure, unit-tested `resolveIndividualVendors` +
  `personalCredentialVendorForModelId`.

  Frontend: cancelling the personal-password modal now reverts the task's optimistic
  "Starting…" state instead of leaving it stuck until reload. `withCredential` awaits the
  prompt and reports whether the action ran or was cancelled.

  Model catalog context windows corrected from each provider's own docs (the field is now
  documented as the per-flavour served window, which can be larger or smaller per provider):
  Llama 3.1 7,968; Qwen3-30B 32,768; Kimi K2.6 / K2.7 256K on Cloudflare; DeepSeek R1 distill
  80K on Cloudflare; DeepSeek V4 Pro 131,072; GLM-5.2 256K on Cloudflare and the full 1M via a
  Z.ai subscription. The "cut NNK on Cloudflare" wording in the Kimi/GLM/DeepSeek descriptions
  was inaccurate and is rewritten.

  Also: the board shows an empty-state invite (bootstrap a repo / add from an existing repo)
  when it has no service frames.

- 3a12f15: Add prompt caching for container-agent model calls, plus the observability to prove
  it works, and unify how both AI-call paths treat a provider's cache.

  - **Shared cache policy** (`@cat-factory/agents`): `providerCachePolicy` is the single
    source of truth for how each provider caches (`auto-prefix` for OpenAI/DeepSeek/Qwen,
    `explicit-anthropic`, or `none`). Both the in-container proxy path and the inline
    AI-SDK path consult it instead of hard-coding provider ids.
  - **Proxy** (`@cat-factory/server`): routes a run's calls to the same cached prefix via
    `prompt_cache_key` (keyed on the execution id) on providers that support it — the big
    win, since a container agent re-sends its whole growing prefix every turn. It also
    fixes the misleading `requestMaxTokens` metric to record the EFFECTIVE output ceiling
    (it previously logged the client's value before the Workers-AI floor override, so it
    read as `null`).
  - **Measure the hit rate**: `LlmCallMetric` gains `cachedPromptTokens` (read across the
    `prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens` field names), so the
    dashboard shows cached vs total prompt tokens per call. D1 migration `0028` + a Drizzle
    migration add the column.

  Note: the inline path's calls are single-shot (no growing prefix), so caching there is
  marginal; full inline-call observability (recording inline LLM calls through the same
  sink) is a follow-up.

- 311a110: Requirements review: dedicated window + iterative convergence loop, and a universal
  result-view seam.

  The pipeline's `requirements-review` gate step no longer runs as a prose agent behind the
  generic approve/reject panel. It now drives the purpose-built structured review window: the
  reviewer raises findings (each with a severity), the human answers or dismisses them, an
  incorporation companion folds the answers into one standard-format document, and the
  reviewer re-reviews that document. The cycle repeats until the reviewer converges (or every
  remaining finding is dismissed). The human can reject a bad merge and redo the incorporation
  with a freeform "do it differently" comment.

  Two new per-task knobs live on the merge-threshold preset:

  - `maxRequirementIterations` (default 3) — reviewer passes allowed before the run stops on
    its own and the human picks: one more round / proceed anyway (with the last incorporated
    document) / stop and reset the task to phase zero (editable; the last incorporated
    document stays on the inspector as a base).
  - `maxRequirementConcernAllowed` (default `none`) — when every outstanding finding is at or
    below this severity, the findings are recorded but the run advances automatically (no
    human gate, companion skipped).

  Frontend gains a UNIVERSAL result-view seam: an agent archetype can declare a `resultView`
  id and register a window component, and the renderer dispatches to it instead of the generic
  prose panel — requirements review is the first consumer, not a hardcoded special case.

  Breaking (pre-1.0, acceptable): the requirements-rework quality-companion gate is removed
  (convergence is now reviewer-driven), so `RequirementReview` drops `companionVerdicts` and
  gains `iteration`/`maxIterations` and the `merged`/`exceeded` statuses; the
  `requirement_reviews` and `merge_threshold_presets` tables change shape on both runtimes
  (D1 migration `0044` ⇄ a generated Drizzle migration — additive `ALTER`s: `companion` is
  dropped, the new columns take defaults, so existing rows are not lost but their old review
  state is re-created on the next run).

- ba1c0cf: Agent execution now resolves the target GitHub repo by walking the running
  block's ancestry up to its enclosing service frame (where repos are actually
  linked), instead of matching the task block's own id — which never matched and
  silently fell through to the workspace's first repo (alphabetically). That
  fallback is removed entirely: a task under a service with no linked repo now
  throws an actionable error rather than force-pushing into an unrelated
  repository (e.g. a simple-service task targeting butter-spread).

  `BoardScanService.spawnBlueprint` now links the spawned service frame to its
  backing repo projection, so a scanned repo's tasks resolve to the right repo out
  of the box instead of throwing for want of a link.

  Also adds the `workflows: write` permission to the GitHub App manifest (both the
  JSON and the in-repo HTML submitter) so agents may add or update
  `.github/workflows/*` files; without it GitHub rejects pushes that touch workflow
  files. Existing installations of both the default and privileged Apps must approve
  the new permission in GitHub before this takes effect.

- 799be66: Make pipeline runs resilient to a failed/evicted `coder` (or any container) step:

  - **Retry resumes from the failed step.** `ExecutionService.retry` no longer
    restarts the pipeline from step 0 — it re-drives from the step that actually
    failed, preserving the steps that already completed. A `coder` failure in
    `pl_full` no longer re-runs the human-gated `requirements`/`architect` steps
    before it. The failed step and everything after it are reset to a clean,
    re-runnable state and dispatched to a fresh container (a new execution id ⇒ a new
    container). Resume planning lives in the pure, unit-tested `planResumedSteps`.
  - **Automatic single recovery from a container eviction/crash.** When a job poll
    reports the container vanished (`…container evicted or crashed`), the engine now
    re-dispatches the same step to a fresh container **once** instead of failing the
    whole run on the first blip; a second eviction of the same step is treated as
    deterministic and fails the run with the new `evicted` failure kind (its hint
    points at the container logs / a heavier instance type). The recovery count is
    tracked on the step (`PipelineStep.evictionRecoveries`); a genuine agent/job
    failure is never auto-recovered. New `job_evicted` advance result + `job.logic`
    helpers (`isContainerEvictionError`, `MAX_EVICTION_RECOVERIES = 1`).

- cc39497: Extract the requirements-review and clarity-review gate handlers out of
  `ExecutionService` into a shared `ReviewGateController`. The two gates ran the SAME
  control flow (inline reviewer pass → park the run on a durable decision → fold the
  human's answers → re-review until convergence / iteration cap → advance), duplicated
  method-for-method across the engine. The flow now lives in one kind-parameterised
  collaborator; each subject supplies only its differentiators through a `ReviewKind`
  (the review service, the live event, the `agentKind`, and — for clarity — threading the
  upstream `bug-investigator` output into the reviewer context). The shared state-machine
  primitives reused by the generic approval path and the companion iteration-cap gate
  (`parkStepOnDecision`, `advancePastResolvedGate`, `dispatchIterationCap`) stay on the
  engine and are injected. Pure refactor: the public method signatures the HTTP
  controllers call (`reviewRequirements`/`incorporateRequirements`/`reReviewRequirements`/
  `proceedRequirements`/`resolveRequirementsExceeded` and the clarity equivalents), the
  wire contracts, the persisted tables and the durable parked-run/resume behaviour are
  unchanged.
- d5e9141: Fix companion (Spec Reviewer) ratings being silently reported as 100%.

  A companion's structured comments anchor to an item id (`{anchorId, body}`) and
  carry no `quotedSource` — exactly the shape `companionSystemPrompt` asks for. But
  `stepReviewCommentSchema` required `quotedSource`, so `parseCompanionAssessment`
  threw on every real Spec Reviewer reply that included comments, and
  `evaluateCompanion` fell back to its pass-through rating of `1`. The result: a
  reviewer that rated a spec 55% surfaced as "100% ≥ 80%" and the run advanced past
  the quality gate instead of reworking the spec.

  `quotedSource` is now optional on `stepReviewCommentSchema` (the human
  request-changes path still sends it; an anchor-based companion comment omits it),
  so anchor-only assessments parse and the real rating drives the gate. The
  `FakeAgentExecutor` now emits anchor-based comments when it downrates, so the
  cross-runtime conformance suite exercises the actual parse and guards the
  regression (the verdict must carry the critic's real rating, not the fallback `1`).

- 7dc8e57: Link integration context at task creation, GitHub issues as a source, and feed
  all linked context to every agent step.

  - **Linked context now reaches every step.** Documents (Confluence / Notion / …)
    and tracker issues (Jira / GitHub) attached to a task were only rendered into the
    prompts of the generic agent kinds — the four standard phases (architect, coder,
    reviewer, tester) silently dropped them, so the agents doing the work never saw
    the linked requirements/issues. The engine already resolves this context per step
    (`ExecutionService.buildAgentContext`); a shared `linkedContextSection` is now
    appended to every kind's user prompt (`@cat-factory/agents`), standard phases
    included.
  - **Attach context when creating a task.** The "Add a task" modal now lets you
    select already-imported documents and issues and links them to the new task on
    creation (previously only possible from the inspector after the fact).
  - **GitHub Issues as a task source.** A new `github` task source reuses the
    workspace's installed GitHub App (no separate credentials): it resolves the
    installation that owns the issue's repo and fetches the issue body + comments via
    the existing `GitHubClient` (new `getIssue`). Refs accept a full issue URL or the
    `owner/repo#number` shorthand. Wired in when `TASK_SOURCES` includes `github` and
    the GitHub integration is enabled.

- 7c37653: Recover container evictions caused by a deploy rollout instead of failing the run.

  A pipeline run whose per-run container was drained by a Cloudflare new-version
  rollout (the runtime SIGTERMs the sandbox, exit 143, while a deploy rolls out) was
  failing as `evicted`: a rollout can cycle the container two or more times in seconds,
  which exhausted the single crash-eviction recovery budget and tripped the
  "deterministic" path. This is transient infrastructure churn, not a sick run.

  The execution engine now distinguishes a _transient_ eviction from a crash/OOM and
  recovers it on a larger budget (`MAX_TRANSIENT_EVICTION_RECOVERIES`), tracked on its
  own `PipelineStep.transientEvictionRecoveries` counter; recoveries are naturally
  spaced by the job poll interval, so a bounded handful rides out a normal rollout
  window. The engine stays runtime-neutral — it only knows "transient vs crash",
  keyed on a generic `TRANSIENT_EVICTION_MARKER`. The Cloudflare facade owns the
  mapping: `ExecutionContainer` detects the rollout signal (via `onError`/`onStop`,
  persisted to DO storage) and the transport tags the eviction with the neutral marker
  after asking the container whether it was just rolled out. The `evicted` failure hint
  no longer over-points at memory/instance size, since a rollout is the common cause and
  a plain retry succeeds once the deploy finishes.

- b98923c: Deleting a service from the board now unlinks its backing GitHub repo, so the
  repo becomes addable again via "Add from existing repo" instead of dangling to a
  deleted block (which left it invisible yet flagged "already on board").
  `BoardService.removeBlock` clears `github_repos.block_id` for any doomed frame.
  The inspector's delete control now names what it removes — "Delete task",
  "Delete module" or "Delete service" — so deleting a selected task no longer reads
  as removing its whole service.
- Updated dependencies [fe53445]
- Updated dependencies [d94e75c]
- Updated dependencies [6406c8c]
- Updated dependencies [3d9a9d8]
- Updated dependencies [db77061]
- Updated dependencies [a48c620]
- Updated dependencies [3bc8c79]
- Updated dependencies [9d3a956]
- Updated dependencies [8d11833]
- Updated dependencies [ad9ba9e]
- Updated dependencies [3e0d753]
- Updated dependencies [f83ffd7]
- Updated dependencies [8065fed]
- Updated dependencies [385bd93]
- Updated dependencies [e50e78a]
- Updated dependencies [0972696]
- Updated dependencies [b48c455]
- Updated dependencies [e9b9356]
- Updated dependencies [e8005ba]
- Updated dependencies [3a12f15]
- Updated dependencies [3a12f15]
- Updated dependencies [b40da13]
- Updated dependencies [3a12f15]
- Updated dependencies [8eed38c]
- Updated dependencies [084bf43]
- Updated dependencies [4030da2]
- Updated dependencies [268c15d]
- Updated dependencies [8eed38c]
- Updated dependencies [157cd02]
- Updated dependencies [7c37653]
- Updated dependencies [db77061]
- Updated dependencies [f49fa30]
- Updated dependencies [6406c8c]
- Updated dependencies [57d70fa]
- Updated dependencies [6406c8c]
- Updated dependencies [918764f]
- Updated dependencies [918764f]
- Updated dependencies [88b3170]
- Updated dependencies [fe0b7f8]
- Updated dependencies [f73652c]
- Updated dependencies [db336b1]
- Updated dependencies [8807f5c]
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [197264e]
- Updated dependencies [a691853]
- Updated dependencies [f066c59]
- Updated dependencies [c664fe6]
- Updated dependencies [7d5e060]
- Updated dependencies [4a08935]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [b287996]
- Updated dependencies [b156b4b]
- Updated dependencies [5c8ca33]
- Updated dependencies [b156b4b]
- Updated dependencies [7cf2a2d]
- Updated dependencies [2d66d34]
- Updated dependencies [197264e]
- Updated dependencies [56ee67d]
- Updated dependencies [3a12f15]
- Updated dependencies [37baa7f]
- Updated dependencies [c664fe6]
- Updated dependencies [553a67d]
- Updated dependencies [b80d657]
- Updated dependencies [4026793]
- Updated dependencies [311a110]
- Updated dependencies [f16ae62]
- Updated dependencies [36018cb]
- Updated dependencies [799be66]
- Updated dependencies [d65c979]
- Updated dependencies [75a0441]
- Updated dependencies [7157fd7]
- Updated dependencies [2ab06b5]
- Updated dependencies [21ca647]
- Updated dependencies [c4ef995]
- Updated dependencies [8eed95b]
- Updated dependencies [0b38aa6]
- Updated dependencies [a97e485]
- Updated dependencies [de5a9d7]
- Updated dependencies [f647733]
- Updated dependencies [d5e9141]
- Updated dependencies [2dd7e56]
- Updated dependencies [2d66d34]
- Updated dependencies [86a5843]
- Updated dependencies [a54ada2]
- Updated dependencies [6406c8c]
- Updated dependencies [2dd7e56]
- Updated dependencies [5ca8086]
- Updated dependencies [d0697d1]
- Updated dependencies [0090313]
- Updated dependencies [7dc8e57]
- Updated dependencies [cc8d96a]
- Updated dependencies [7c37653]
- Updated dependencies [43f2443]
- Updated dependencies [acac735]
- Updated dependencies [3841315]
- Updated dependencies [48d2f0d]
- Updated dependencies [3e6a844]
- Updated dependencies [6406c8c]
  - @cat-factory/contracts@0.7.0
  - @cat-factory/integrations@0.7.0
  - @cat-factory/kernel@0.7.0
  - @cat-factory/agents@0.7.0
  - @cat-factory/prompt-fragments@0.7.0
  - @cat-factory/spend@0.7.0
  - @cat-factory/workspaces@0.7.0
