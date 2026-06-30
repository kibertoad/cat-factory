# @cat-factory/node-server

## 0.45.1

### Patch Changes

- 6009266: Refresh dependencies to their latest release-age-compliant versions: the Vercel AI
  SDK family within its `workers-ai-provider`-compatible majors (`ai` 6.0.214,
  `@ai-sdk/anthropic` 3.0.89, `@ai-sdk/openai` 3.0.77, `@ai-sdk/openai-compatible`
  2.0.54, `@ai-sdk/amazon-bedrock` 4.0.124), `drizzle-orm`/`drizzle-kit` 1.0.0-rc.4,
  and `yaml` 2.9.0, plus refreshed transitive resolutions.
- Updated dependencies [6009266]
  - @cat-factory/agents@0.23.2
  - @cat-factory/consensus@0.7.85
  - @cat-factory/integrations@0.40.1
  - @cat-factory/kernel@0.57.1
  - @cat-factory/orchestration@0.45.3
  - @cat-factory/provider-bedrock@0.7.85
  - @cat-factory/provider-cloudflare@0.7.85
  - @cat-factory/server@0.51.1
  - @cat-factory/gates@0.2.38
  - @cat-factory/gitlab@0.4.8
  - @cat-factory/observability-langfuse@0.7.81
  - @cat-factory/provider-s3@0.2.31
  - @cat-factory/spend@0.10.42

## 0.45.0

### Minor Changes

- bd23c46: Wire the mothership-mode persistence-RPC endpoint into both runtime facades: each attaches
  its repository registry as `ServerContainer.repositories`, so a Node or Cloudflare deployment
  can act as a mothership and serve `POST /internal/persistence` for mothership-mode local
  nodes. The attachment is symmetric (sourced identically from each facade's `dependencies`),
  and a cross-runtime conformance assertion guards it — a facade that forgot to attach its
  registry would 503 instead of 403 on an unauthenticated machine call and fail the suite.
- 1952d6b: Per-service provision types (slice 1 — additive foundation). Adds the
  `provisionType`/`infraEngine`/`serviceProvisioning`/`infraHandlerConfig` and
  custom-manifest-type contracts, a `provisioning` field on the service-frame `Block`
  (persisted as a JSON column on both runtimes and settable via the block update endpoint),
  and `provisionType`/`engine` fields on the environment handle. Introduces the per-user
  infra handler override table (`environment_user_handlers`, local-mode) and the workspace
  custom-manifest-type catalog (`custom_manifest_types`) — mirrored across D1 and Drizzle
  with a cross-runtime conformance suite — plus `provision_type`/`engine` columns on the
  `environments` registry. No behaviour is wired yet; the single→multi reshape of
  `environment_connections`, the resolver, and the UI follow in later slices. See
  `docs/initiatives/per-service-provision-types.md`.

### Patch Changes

- Updated dependencies [bd23c46]
- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/server@0.51.0
  - @cat-factory/contracts@0.59.0
  - @cat-factory/kernel@0.57.0
  - @cat-factory/integrations@0.40.0
  - @cat-factory/agents@0.23.1
  - @cat-factory/consensus@0.7.84
  - @cat-factory/gates@0.2.37
  - @cat-factory/gitlab@0.4.7
  - @cat-factory/orchestration@0.45.2
  - @cat-factory/prompt-fragments@0.9.12
  - @cat-factory/spend@0.10.41
  - @cat-factory/observability-langfuse@0.7.80
  - @cat-factory/provider-bedrock@0.7.84
  - @cat-factory/provider-cloudflare@0.7.84
  - @cat-factory/provider-s3@0.2.30

## 0.44.3

### Patch Changes

- Updated dependencies [2ac148d]
  - @cat-factory/integrations@0.39.0
  - @cat-factory/orchestration@0.45.1
  - @cat-factory/server@0.50.3

## 0.44.2

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/orchestration@0.45.0
  - @cat-factory/contracts@0.58.0
  - @cat-factory/agents@0.23.0
  - @cat-factory/server@0.50.2
  - @cat-factory/consensus@0.7.83
  - @cat-factory/gates@0.2.36
  - @cat-factory/gitlab@0.4.6
  - @cat-factory/integrations@0.38.1
  - @cat-factory/kernel@0.56.1
  - @cat-factory/prompt-fragments@0.9.11
  - @cat-factory/spend@0.10.40
  - @cat-factory/provider-bedrock@0.7.83
  - @cat-factory/provider-cloudflare@0.7.83
  - @cat-factory/observability-langfuse@0.7.79
  - @cat-factory/provider-s3@0.2.29

## 0.44.1

### Patch Changes

- 1ff013f: Add fail-fast guards that surface invalid state early and loudly instead of letting it
  flow silently into the domain.

  - **Persistence read boundary** (`@cat-factory/server`): a new `decode` helper
    (`decodeEnum`/`decodeEnumOr`/`decodeJson`/`tryDecodeRow`/`tryDecodeRows` + `DataIntegrityError`)
    re-asserts the Valibot wire contract at row→domain mapping time, replacing erased
    `as SomeType` casts. Wired through the shared mappers (block status/level, `depends_on`,
    and `rowToExecution` — which now rejects an empty `block_id` and an out-of-bounds
    `currentStep`) and, symmetrically across both runtimes, the agent-run kind, notification
    type/status/severity, and subscription vendor reads. A corrupt enum/JSON now logs with
    row context and throws a 500 (engine-critical) or degrades (cosmetic) rather than
    smuggling a fake-valid value downstream. Snapshot-facing list reads (block + execution
    `listByWorkspace`/`listByService`/`listByServices` on both runtimes) decode through
    `tryDecodeRows`, so one corrupt row is logged and dropped instead of failing the whole
    board load — the single-row `get`/`getByBlock` point reads keep the loud throw.
  - **Execution engine** (`@cat-factory/orchestration`): `disposeReview` rejects a
    non-positive iteration cap / sub-1 counter; `StepGraph.loopCompanionProducer` replaces
    `companion!`/`steps[-1]!` force-unwraps with diagnostic guards.
  - **Gates** (`@cat-factory/gates`): `warnUnwiredGates(logger)` logs (once per gate per
    process) any built-in gate left as a silent pass-through, so a deployment that forgot to
    wire the GitHub App no longer auto-merges without checking CI. Called at both facades'
    container build.

  Scope notes: lower-severity source-kind casts and deep JSON-blob shape validation are
  deliberately deferred (the primitives are in place to extend to them). No guards were
  added inside the durable drive path (e.g. `finalizeBlock`) where a throw would wedge the
  retry loop, and the intentional Node-vs-Cloudflare container-executor fail-mode asymmetry
  is left unchanged.

- Updated dependencies [1ff013f]
  - @cat-factory/server@0.50.1
  - @cat-factory/orchestration@0.44.1
  - @cat-factory/gates@0.2.35

## 0.44.0

### Minor Changes

- f9a173f: Fix three concurrency hazards in the backend with database-native primitives.

  - **Optimistic concurrency on execution runs.** `agent_runs` gains a monotonic `rev`
    column; the execution repo's `upsert` bumps it on every write and a new
    `compareAndSwap` performs a guarded conditional write. The in-place human-action handlers
    (resolve decision / request changes / reject / request-human-review-fix / resume-paused)
    now go through a `mutateInstance` retry helper, so a double-submit or a write that raced
    the durable driver is re-applied on fresh state instead of silently clobbering the other
    writer (lost update). (`retry` / `restart-from-step` mint a fresh run id, so the same-row
    hazard is structurally absent there.)
  - **Atomic API-key pool lease.** The non-transactional `listForPool → chooseToken →
markLeased` is replaced by a single atomic select-and-mark (`leaseLeastUsed`: Postgres
    `FOR UPDATE SKIP LOCKED`; D1 a single serialised write), so two concurrent dispatches
    can no longer grab the same key before usage is recorded.
  - **Notification open-card dedup.** A partial unique index on
    `(workspace_id, block_id, type) WHERE status='open'` plus an atomic
    `upsertOpenForBlock` replaces the racy `findOpenByBlock` read-before-write, so two
    concurrent raises can't stack duplicate open cards. `upsertOpenForBlock` returns the
    CANONICAL persisted row, so when a concurrent raise wins the insert the loser delivers
    and returns that row's id rather than a phantom id (which would show a duplicate inbox
    card and 404 when acted on).

  BREAKING (pre-1.0, no data migration): `agent_runs` adds a non-null `rev` column and the
  `notifications` table adds a partial unique index, mirrored across the D1 and Drizzle
  migrations. The `ExecutionRepository`, `ProviderApiKeyRepository` and
  `NotificationRepository` ports each gain a method.

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/contracts@0.57.0
  - @cat-factory/kernel@0.56.0
  - @cat-factory/server@0.50.0
  - @cat-factory/orchestration@0.44.0
  - @cat-factory/integrations@0.38.0
  - @cat-factory/agents@0.22.6
  - @cat-factory/consensus@0.7.82
  - @cat-factory/gates@0.2.34
  - @cat-factory/gitlab@0.4.5
  - @cat-factory/prompt-fragments@0.9.10
  - @cat-factory/spend@0.10.39
  - @cat-factory/observability-langfuse@0.7.78
  - @cat-factory/provider-bedrock@0.7.82
  - @cat-factory/provider-cloudflare@0.7.82
  - @cat-factory/provider-s3@0.2.28

## 0.43.12

### Patch Changes

- fdeb466: Eliminate N+1 query loops in the service layer. `ExecutionService.teardownForBlockTree` now
  resolves runs with a single `listByWorkspace` instead of a per-block `getByBlock`;
  `TaskConnectionService.listSourceStates` hoists its installation/connection reads out of the
  per-provider loop; and `BoardService` (`removeBlock` / `addServiceFromRepo`) and
  `AccountService.listForUser` batch their per-item point reads via two new chunked-`IN`
  repository methods, `ServiceRepository.listByFrameBlocks` and `AccountRepository.listByIds`
  (implemented symmetrically on the D1 and Drizzle stores, with cross-runtime conformance
  coverage). Behavior is unchanged.
- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4
  - @cat-factory/orchestration@0.43.4
  - @cat-factory/integrations@0.37.1
  - @cat-factory/agents@0.22.5
  - @cat-factory/consensus@0.7.81
  - @cat-factory/gates@0.2.33
  - @cat-factory/gitlab@0.4.4
  - @cat-factory/observability-langfuse@0.7.77
  - @cat-factory/provider-bedrock@0.7.81
  - @cat-factory/provider-cloudflare@0.7.81
  - @cat-factory/provider-s3@0.2.27
  - @cat-factory/server@0.49.6
  - @cat-factory/spend@0.10.38

## 0.43.11

### Patch Changes

- Updated dependencies [0dd9532]
  - @cat-factory/server@0.49.5

## 0.43.10

### Patch Changes

- 21b2096: Make the environment-backend and runner-backend registries app-owned (DI) instead of
  module-global Maps. This is the pilot for the registry-DI migration
  (`docs/initiatives/registry-di-migration.md`): the composition root now constructs each
  registry instance via `createBackendRegistries()` and injects it through
  `CoreDependencies`; a deployment registers a custom backend by reference
  (`registry.register(provider)`), so registration no longer depends on the adapter and
  server sharing the same `@cat-factory/integrations` module instance.

  BREAKING (`@cat-factory/integrations`): the module-global free functions
  `registerEnvironmentBackend` / `environmentBackend` / `registeredEnvironmentBackendKinds`
  / `environmentBackendKinds` / `findRepairCapableProvider` and their runner-backend
  equivalents (`registerRunnerBackend` / `runnerBackend` / `registeredRunnerBackendKinds`
  / `runnerBackendKinds`) are removed. Use the new `EnvironmentBackendRegistry` /
  `RunnerBackendRegistry` classes (methods `register` / `get` / `kinds` / `labelled`, plus
  `findRepairCapable` on the env registry), the `defaultEnvironmentBackendRegistry()` /
  `defaultRunnerBackendRegistry()` factories, or the unified `createBackendRegistries()`.

- Updated dependencies [21b2096]
  - @cat-factory/integrations@0.37.0
  - @cat-factory/orchestration@0.43.3
  - @cat-factory/server@0.49.4
  - @cat-factory/contracts@0.56.1
  - @cat-factory/agents@0.22.4
  - @cat-factory/consensus@0.7.80
  - @cat-factory/gates@0.2.32
  - @cat-factory/gitlab@0.4.3
  - @cat-factory/kernel@0.55.3
  - @cat-factory/prompt-fragments@0.9.9
  - @cat-factory/spend@0.10.37
  - @cat-factory/provider-bedrock@0.7.80
  - @cat-factory/provider-cloudflare@0.7.80
  - @cat-factory/observability-langfuse@0.7.76
  - @cat-factory/provider-s3@0.2.26

## 0.43.9

### Patch Changes

- Updated dependencies [123336c]
  - @cat-factory/server@0.49.3

## 0.43.8

### Patch Changes

- 7536092: Startup-time optimizations (no behavior change):

  - **Node server boot**: run `migrate()` and `pgBoss.start()` concurrently (they touch
    independent schemas) and start the pure-timer background sweepers after the HTTP
    listener binds, so the server accepts requests sooner. The local facade inherits this
    via the shared `start()`.
  - **SPA workspace init**: fetch the accounts list and workspace list concurrently instead
    of sequentially on first board load.
  - **SPA bundle**: code-split the occasional, store-gated `BlockFocusView`,
    `TaskSourceConnectModal`, `TaskImportModal`, and `RecurringPipelineModal` into their own
    chunks (mounted only while open), matching the existing async-panel pattern.

## 0.43.7

### Patch Changes

- Updated dependencies [4ec514a]
  - @cat-factory/server@0.49.2

## 0.43.6

### Patch Changes

- Updated dependencies [ad5d3e0]
  - @cat-factory/contracts@0.56.0
  - @cat-factory/server@0.49.1
  - @cat-factory/agents@0.22.3
  - @cat-factory/consensus@0.7.79
  - @cat-factory/gates@0.2.31
  - @cat-factory/gitlab@0.4.2
  - @cat-factory/integrations@0.36.1
  - @cat-factory/kernel@0.55.2
  - @cat-factory/orchestration@0.43.2
  - @cat-factory/prompt-fragments@0.9.8
  - @cat-factory/spend@0.10.36
  - @cat-factory/provider-bedrock@0.7.79
  - @cat-factory/provider-cloudflare@0.7.79
  - @cat-factory/observability-langfuse@0.7.75
  - @cat-factory/provider-s3@0.2.25

## 0.43.5

### Patch Changes

- 4897078: Make the ephemeral-environment AND self-hosted runner-pool backend registries extensible to
  custom third-party kinds, so a single-tenant / self-hosted deployment can register a bespoke
  provider **programmatically** (an import side effect via `registerEnvironmentBackend` /
  `registerRunnerBackend`), mirroring custom agent kinds. This restores the capability the
  removed `buildNodeContainer({ environmentProvider })` / `startLocal({ environmentProvider })`
  deployment-wide injection used to provide, and serves both single- and multi-tenant.

  - **Contracts (breaking, additive):** `environmentBackendConfigSchema` /
    `runnerBackendConfigSchema` gain a generic custom-kind member (a lower-kebab `kind` slug,
    guarded to exclude the reserved built-ins, carrying the subsystem manifest body), so a
    custom kind's connect config validates with no new variant. The workspace snapshot gains
    `environmentBackendKinds` / `runnerBackendKinds`, and the describe routes accept an optional
    `kind` query. Existing `manifest`/`kubernetes` rows still parse — no migration.
  - **Registries:** `EnvironmentBackendProvider` / `RunnerBackendProvider` `kind` is now an open
    `string` with an optional `displayLabel`; new `environmentBackendKinds()` /
    `runnerBackendKinds()` accessors. `describeProvider(workspaceId, kind?)` can describe a
    registered kind before it is connected.
  - **Frontend:** the provider-connect backend-kind selector is snapshot-driven (built-in
    fallback) instead of a hardcoded `manifest`/`kubernetes` list; a custom kind's flat-form /
    manifest-editor save is tagged with its slug.
  - A custom kind requires a per-workspace connection (the encrypted-secret + `providerConfig`
    anchor) exactly like the built-ins. The `runnerPoolProvider` facade option is unchanged and
    remains the HTTP-pool override for the manifest backend, NOT the custom-kind seam.

- Updated dependencies [4897078]
  - @cat-factory/contracts@0.55.0
  - @cat-factory/integrations@0.36.0
  - @cat-factory/server@0.49.0
  - @cat-factory/agents@0.22.2
  - @cat-factory/consensus@0.7.78
  - @cat-factory/gates@0.2.30
  - @cat-factory/gitlab@0.4.1
  - @cat-factory/kernel@0.55.1
  - @cat-factory/orchestration@0.43.1
  - @cat-factory/prompt-fragments@0.9.7
  - @cat-factory/spend@0.10.35
  - @cat-factory/provider-bedrock@0.7.78
  - @cat-factory/provider-cloudflare@0.7.78
  - @cat-factory/observability-langfuse@0.7.74
  - @cat-factory/provider-s3@0.2.24

## 0.43.4

### Patch Changes

- d5a0637: Close the GitLab-vs-GitHub provider parity gaps so a GitLab deployment behaves like a GitHub
  one across every runtime facade.

  - **Facade parity (the showstopper):** the engine's CI / mergeability / PR-review gate
    providers, the PR merger, the branch updater and the checkout-free `RepoFiles` resolvers are
    now wired from a GitLab-backed client on the **Node and Cloudflare** facades too — previously
    only local mode bridged GitLab into the gates, so a stock GitLab-only Node/CF deployment did
    not gate on real CI or merge for real. Both facades now build the engine VCS client via the
    shared `buildGitLabEngineClient` (GitHub App wins when both are configured).
  - **Review provider:** `FetchGitLabClient` now implements the human-review reads
    (`getPullRequestBaseRef`, `listRequestedReviewers`, `listPullRequestReviews` +
    `getRequiredApprovingReviewCount` from GitLab approvals, `listReviewThreads` /
    `replyToReviewThread` / `resolveReviewThread` over resolvable MR discussions, plus
    `listIssueComments`).
  - **Branch update:** new optional `VcsClient.rebasePullRequest` / `GitHubClient.rebasePullRequest`
    — GitLab has no server-side merge-branch-into-branch endpoint, so the conflicts / human-testing
    gate's "pull latest base" action advances a GitLab MR branch by rebasing it; `GitHubBranchUpdater`
    prefers rebase when the client exposes it and falls back to `mergeBranch` (GitHub) otherwise.
  - **Conformance:** the cross-provider VCS client suite now asserts GitHub and GitLab normalise the
    human-review gate inputs identically and exposes the correct branch-advancing capability per
    provider; a reusable `FakeVcsClient` drives the real gate / merge / branch-update providers
    through the GitLab-backed adapter.
  - **Rebase verdict robustness:** the GitLab MR-rebase poll now sleeps before each status read (so
    a not-yet-started async rebase is never mistaken for a finished one) and decides the outcome by
    whether the source-branch head actually advanced, ignoring the persisted `merge_error` field
    (shared with merge attempts) unless the branch did not move. Covered by poll-transition,
    stale-`merge_error`, conflict and up-to-date tests.
  - **Accurate required-approval count:** `getRequiredApprovingReviewCount` now reads the effective
    per-MR `approvals_required` (it accounts for the rule on the MR's target branch) when the PR
    number is known, falling back to the project default; the port carries the PR number alongside
    the branch (GitHub still reads branch protection and ignores it).
  - **Node facade wiring:** the GitLab-backed engine client feeds only the gate / merge / RepoFiles
    seams; GitHub-issue-specific consumers (the GitHub Issues task source, issue writeback) stay
    gated on a real GitHub client, so a GitLab-only Node deployment no longer offers a
    non-functional "GitHub Issues" task source (parity with the Worker).

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/gitlab@0.4.0
  - @cat-factory/kernel@0.55.0
  - @cat-factory/server@0.48.4
  - @cat-factory/contracts@0.54.0
  - @cat-factory/orchestration@0.43.0
  - @cat-factory/agents@0.22.1
  - @cat-factory/consensus@0.7.77
  - @cat-factory/gates@0.2.29
  - @cat-factory/integrations@0.35.4
  - @cat-factory/observability-langfuse@0.7.73
  - @cat-factory/provider-bedrock@0.7.77
  - @cat-factory/provider-cloudflare@0.7.77
  - @cat-factory/provider-s3@0.2.23
  - @cat-factory/spend@0.10.34
  - @cat-factory/prompt-fragments@0.9.6

## 0.43.3

### Patch Changes

- Updated dependencies [b76f303]
  - @cat-factory/orchestration@0.42.1
  - @cat-factory/server@0.48.3

## 0.43.2

### Patch Changes

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

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0
  - @cat-factory/contracts@0.53.0
  - @cat-factory/orchestration@0.42.0
  - @cat-factory/server@0.48.2
  - @cat-factory/agents@0.22.0
  - @cat-factory/consensus@0.7.76
  - @cat-factory/gates@0.2.28
  - @cat-factory/gitlab@0.3.9
  - @cat-factory/integrations@0.35.3
  - @cat-factory/observability-langfuse@0.7.72
  - @cat-factory/provider-bedrock@0.7.76
  - @cat-factory/provider-cloudflare@0.7.76
  - @cat-factory/provider-s3@0.2.22
  - @cat-factory/spend@0.10.33
  - @cat-factory/prompt-fragments@0.9.5

## 0.43.1

### Patch Changes

- Updated dependencies [614e985]
  - @cat-factory/integrations@0.35.2
  - @cat-factory/orchestration@0.41.4
  - @cat-factory/server@0.48.1

## 0.43.0

### Minor Changes

- 0577404: feat: move infrastructure configuration into its own top-level navbar menu. Agent-container execution + Tester environments + (local mode) the warm-container pool / checkout reuse now live in a dedicated tabbed "Infrastructure" window reached from the navbar, instead of being buried in the Integrations hub and a separate "Local mode" entry. The old bare "delegate to runner pool" toggle is replaced by a clear execution-backend selector that reflects the backends available for THIS deployment (local Docker host / Cloudflare Containers / self-hosted runner pool) and which is active — driven by a new symmetric `infrastructure` capability descriptor on `GET /auth/config` (set by every facade; asserted by the cross-runtime conformance suite). The raw-JSON runner manifest editor is kept but collapsed behind an "Advanced: custom API-based scheduler" disclosure, since the common backends don't need it.

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/contracts@0.52.0
  - @cat-factory/server@0.48.0
  - @cat-factory/agents@0.21.17
  - @cat-factory/consensus@0.7.75
  - @cat-factory/gates@0.2.27
  - @cat-factory/gitlab@0.3.8
  - @cat-factory/integrations@0.35.1
  - @cat-factory/kernel@0.53.1
  - @cat-factory/orchestration@0.41.3
  - @cat-factory/prompt-fragments@0.9.4
  - @cat-factory/spend@0.10.32
  - @cat-factory/provider-bedrock@0.7.75
  - @cat-factory/provider-cloudflare@0.7.75
  - @cat-factory/observability-langfuse@0.7.71
  - @cat-factory/provider-s3@0.2.21

## 0.42.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/contracts@0.51.0
  - @cat-factory/kernel@0.53.0
  - @cat-factory/integrations@0.35.0
  - @cat-factory/server@0.47.0
  - @cat-factory/orchestration@0.41.2
  - @cat-factory/agents@0.21.16
  - @cat-factory/consensus@0.7.74
  - @cat-factory/gates@0.2.26
  - @cat-factory/gitlab@0.3.7
  - @cat-factory/prompt-fragments@0.9.3
  - @cat-factory/spend@0.10.31
  - @cat-factory/observability-langfuse@0.7.70
  - @cat-factory/provider-bedrock@0.7.74
  - @cat-factory/provider-cloudflare@0.7.74
  - @cat-factory/provider-s3@0.2.20

## 0.41.2

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/contracts@0.50.1
  - @cat-factory/server@0.46.3
  - @cat-factory/orchestration@0.41.1
  - @cat-factory/integrations@0.34.1
  - @cat-factory/agents@0.21.15
  - @cat-factory/consensus@0.7.73
  - @cat-factory/gates@0.2.25
  - @cat-factory/gitlab@0.3.6
  - @cat-factory/observability-langfuse@0.7.69
  - @cat-factory/provider-bedrock@0.7.73
  - @cat-factory/provider-cloudflare@0.7.73
  - @cat-factory/provider-s3@0.2.19
  - @cat-factory/spend@0.10.30
  - @cat-factory/prompt-fragments@0.9.2

## 0.41.1

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/contracts@0.50.0
  - @cat-factory/kernel@0.51.0
  - @cat-factory/integrations@0.34.0
  - @cat-factory/orchestration@0.41.0
  - @cat-factory/agents@0.21.14
  - @cat-factory/consensus@0.7.72
  - @cat-factory/gates@0.2.24
  - @cat-factory/gitlab@0.3.5
  - @cat-factory/prompt-fragments@0.9.1
  - @cat-factory/server@0.46.2
  - @cat-factory/spend@0.10.29
  - @cat-factory/observability-langfuse@0.7.68
  - @cat-factory/provider-bedrock@0.7.72
  - @cat-factory/provider-cloudflare@0.7.72
  - @cat-factory/provider-s3@0.2.18

## 0.41.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/contracts@0.49.0
  - @cat-factory/kernel@0.50.0
  - @cat-factory/integrations@0.33.0
  - @cat-factory/prompt-fragments@0.9.0
  - @cat-factory/server@0.46.1
  - @cat-factory/orchestration@0.40.2
  - @cat-factory/agents@0.21.13
  - @cat-factory/consensus@0.7.71
  - @cat-factory/gates@0.2.23
  - @cat-factory/gitlab@0.3.4
  - @cat-factory/spend@0.10.28
  - @cat-factory/observability-langfuse@0.7.67
  - @cat-factory/provider-bedrock@0.7.71
  - @cat-factory/provider-cloudflare@0.7.71
  - @cat-factory/provider-s3@0.2.17

## 0.40.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/contracts@0.48.0
  - @cat-factory/kernel@0.49.0
  - @cat-factory/integrations@0.32.0
  - @cat-factory/server@0.46.0
  - @cat-factory/orchestration@0.40.1
  - @cat-factory/agents@0.21.12
  - @cat-factory/consensus@0.7.70
  - @cat-factory/gates@0.2.22
  - @cat-factory/gitlab@0.3.3
  - @cat-factory/prompt-fragments@0.8.9
  - @cat-factory/spend@0.10.27
  - @cat-factory/observability-langfuse@0.7.66
  - @cat-factory/provider-bedrock@0.7.70
  - @cat-factory/provider-cloudflare@0.7.70
  - @cat-factory/provider-s3@0.2.16

## 0.39.0

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
  - @cat-factory/server@0.45.0
  - @cat-factory/integrations@0.31.0
  - @cat-factory/orchestration@0.40.0
  - @cat-factory/agents@0.21.11
  - @cat-factory/consensus@0.7.69
  - @cat-factory/gates@0.2.21
  - @cat-factory/gitlab@0.3.2
  - @cat-factory/prompt-fragments@0.8.8
  - @cat-factory/spend@0.10.26
  - @cat-factory/observability-langfuse@0.7.65
  - @cat-factory/provider-bedrock@0.7.69
  - @cat-factory/provider-cloudflare@0.7.69
  - @cat-factory/provider-s3@0.2.15

## 0.38.0

### Minor Changes

- 704c99e: Fill the gaps in Linear support:

  - **Connection pagination**: the Linear task source now walks the `children` and
    `comments` GraphQL connection cursors, so an epic with more than one page of
    sub-issues imports its full child set (no longer silently capped at ~50) — matching
    the Jira provider's epic-children pagination.
  - **Team picker for ticket filing**: a new `GET /workspaces/:ws/task-sources/linear/teams`
    endpoint lists the connected workspace's Linear teams, and the issue-tracker settings
    UI offers a searchable (typeahead) team picker instead of requiring a hand-pasted team
    UUID.
  - **OAuth connect flow**: Linear can now be connected via OAuth ("Connect with Linear")
    in addition to a personal API key. The OAuth app credentials (client id / secret /
    redirect URL) are configured **per account in the UI** (account Deployment settings,
    sealed in the DB and resolved dynamically — mirroring the Slack OAuth model), NOT via
    env vars, so an admin can set/rotate them without a redeploy. Absent ⇒ only the manual
    API-key path is offered. The exchanged access token is stored as the connection and
    used as a `Bearer` token across import, search, ticket filing and PR writeback.
  - **Search exact-ref match**: pasting a Linear issue identifier or URL into search now
    resolves and surfaces that exact issue first (de-duped against the term hits), like the
    GitHub Issues source.

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/integrations@0.30.0
  - @cat-factory/contracts@0.46.0
  - @cat-factory/server@0.44.0
  - @cat-factory/orchestration@0.39.2
  - @cat-factory/agents@0.21.10
  - @cat-factory/consensus@0.7.68
  - @cat-factory/gates@0.2.20
  - @cat-factory/gitlab@0.3.1
  - @cat-factory/kernel@0.47.2
  - @cat-factory/prompt-fragments@0.8.7
  - @cat-factory/spend@0.10.25
  - @cat-factory/provider-bedrock@0.7.68
  - @cat-factory/provider-cloudflare@0.7.68
  - @cat-factory/observability-langfuse@0.7.64
  - @cat-factory/provider-s3@0.2.14

## 0.37.0

### Minor Changes

- 2961b05: Meaningfully widen GitLab support in local mode — a `GITLAB_PAT` deployment now drives the
  real agent workflow, not just sign-in:

  - **`@cat-factory/gitlab`** adds `asGitHubClient(...)`, a `VcsClient`→`GitHubClient` adapter so
    any provider-neutral VCS client (e.g. `FetchGitLabClient`) satisfies the legacy `GitHubClient`
    port the engine's CI gate, merger and repo-read paths still consume.
  - **`@cat-factory/server`** resolves a run's repo origin (clone URL + provider) through an
    injectable `resolveRepoOrigin` seam and stamps the provider onto the dispatched job, instead
    of hardcoding a `github.com` clone URL. The default stays GitHub, so the Worker/Node facades
    are unchanged; a GitLab deployment supplies a GitLab origin so containers clone the right host
    and open merge requests. Without this the clone URL was always github.com, so a GitLab repo
    could never be cloned by an agent container.
  - **`@cat-factory/node-server`** threads `resolveRepoOrigin` through `NodeContainerOptions` to
    the container executor (default GitHub), so a sibling facade can supply a GitLab origin.
  - **`@cat-factory/local-server`** wires a GitLab PAT symmetrically to the GitHub PAT: the agent
    containers' git clone/push token falls back to `GITLAB_PAT`; the CI gate, mergeability, real
    merge and repo-link flows read through a PAT-backed `FetchGitLabClient` (adapted to
    `GitHubClient`); the agent containers clone the configured GitLab host + open merge requests
    (via `resolveRepoOrigin`); and the GitLab host is added to the harness clone/push allow-list
    (`GITHUB_ALLOWED_HOSTS`) so the container doesn't reject the GitLab clone URL. A GitLab-only
    local deployment is now a first-class source-control backend. Set `GITLAB_API_BASE` for a
    self-managed instance. The boot warning and the cross-provider `vcs-conformance` test cover
    both providers.
  - **`@cat-factory/executor-harness`** opens a GitLab **merge request** (not a GitHub PR) when the
    job's `repo.provider` is `gitlab` (set authoritatively by the server, so a self-managed GitLab
    on an arbitrarily-named host is routed correctly), falling back to host inference from the
    clone URL. The REST base + project path are derived from the host, and an already-open MR is
    reused on a resumed run. The GitHub path is unchanged. (The runner image must be republished
    for this to take effect in a deployed worker.)

### Patch Changes

- Updated dependencies [2961b05]
  - @cat-factory/server@0.43.0
  - @cat-factory/gitlab@0.3.0

## 0.36.1

### Patch Changes

- Updated dependencies [5ad45de]
  - @cat-factory/orchestration@0.39.1
  - @cat-factory/server@0.42.1

## 0.36.0

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
  - @cat-factory/server@0.42.0
  - @cat-factory/integrations@0.29.0
  - @cat-factory/orchestration@0.39.0

## 0.35.5

### Patch Changes

- Updated dependencies [c2ec53b]
  - @cat-factory/contracts@0.45.1
  - @cat-factory/server@0.41.1
  - @cat-factory/agents@0.21.9
  - @cat-factory/consensus@0.7.67
  - @cat-factory/gates@0.2.19
  - @cat-factory/gitlab@0.2.2
  - @cat-factory/integrations@0.28.1
  - @cat-factory/kernel@0.47.1
  - @cat-factory/orchestration@0.38.1
  - @cat-factory/prompt-fragments@0.8.6
  - @cat-factory/spend@0.10.24
  - @cat-factory/provider-bedrock@0.7.67
  - @cat-factory/provider-cloudflare@0.7.67
  - @cat-factory/observability-langfuse@0.7.63
  - @cat-factory/provider-s3@0.2.13

## 0.35.4

### Patch Changes

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

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/contracts@0.45.0
  - @cat-factory/integrations@0.28.0
  - @cat-factory/server@0.41.0
  - @cat-factory/orchestration@0.38.0
  - @cat-factory/agents@0.21.8
  - @cat-factory/consensus@0.7.66
  - @cat-factory/gates@0.2.18
  - @cat-factory/gitlab@0.2.1
  - @cat-factory/observability-langfuse@0.7.62
  - @cat-factory/provider-bedrock@0.7.66
  - @cat-factory/provider-cloudflare@0.7.66
  - @cat-factory/provider-s3@0.2.12
  - @cat-factory/spend@0.10.23
  - @cat-factory/prompt-fragments@0.8.5

## 0.35.3

### Patch Changes

- Updated dependencies [0784fe0]
- Updated dependencies [0784fe0]
  - @cat-factory/orchestration@0.37.3
  - @cat-factory/server@0.40.3

## 0.35.2

### Patch Changes

- Updated dependencies [5e54936]
- Updated dependencies [5e54936]
  - @cat-factory/orchestration@0.37.2
  - @cat-factory/server@0.40.2

## 0.35.1

### Patch Changes

- Updated dependencies [cc101a7]
  - @cat-factory/orchestration@0.37.1
  - @cat-factory/server@0.40.1

## 0.35.0

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

- 56e6ce6: Local mode: sign in with a source-control PAT (GitHub or GitLab) or email/password.

  Local mode previously ran fully anonymous (dev-open, no user), so per-user features —
  personal subscriptions, your own API keys — failed with 401 ("Sign in to manage …") with
  no way to sign in. Local mode now establishes a real identity:

  - A new provider-agnostic `VcsIdentityResolver` port (kernel) turns a raw PAT into a
    neutral identity (the provider's stable numeric user id — the SAME subject GitHub OAuth
    uses, so a PAT login and an OAuth login resolve to one canonical user). GitHub and GitLab
    resolvers ship in `@cat-factory/server` / `@cat-factory/gitlab`; adding an Nth provider is
    one more resolver entry, no endpoint or UI changes.
  - A new `POST /auth/pat` endpoint (served only where resolvers are wired — local mode)
    mints a session for the account a PAT belongs to. The local login screen offers one-click
    "Continue with GitHub/GitLab" when a `GITHUB_PAT`/`GITLAB_PAT` is configured, an inline
    "paste a PAT" form otherwise, and email/password sign-in (enabled by default in local
    mode, with open signup on the developer's own machine).
  - The SPA now requires sign-in in local mode (anonymous use can't store per-user
    credentials); the session is honored even though the API otherwise runs dev-open.
  - `'gitlab'` is now an identity provider. Identities remain collision-safe via the
    `(provider, subject)` key: a GitHub user and a GitLab user with the same numeric id, and
    a password account (keyed on email), are always distinct.

  Also adds a guard on the per-user credential forms (personal subscriptions, your own API
  keys): when there is genuinely no signed-in user (a non-local deployment running with auth
  disabled), the inputs are blocked with a clear notice instead of accepting data that can't
  be saved.

  BREAKING (local mode only): existing anonymously-created local boards have no owner, so
  after upgrading they become inaccessible once sign-in is required — recreate them under
  your signed-in account. (Pre-1.0, no data migration.)

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/orchestration@0.37.0
  - @cat-factory/kernel@0.46.0
  - @cat-factory/contracts@0.44.0
  - @cat-factory/integrations@0.27.0
  - @cat-factory/server@0.40.0
  - @cat-factory/provider-s3@0.2.11
  - @cat-factory/gitlab@0.2.0
  - @cat-factory/agents@0.21.7
  - @cat-factory/consensus@0.7.65
  - @cat-factory/gates@0.2.17
  - @cat-factory/observability-langfuse@0.7.61
  - @cat-factory/provider-bedrock@0.7.65
  - @cat-factory/provider-cloudflare@0.7.65
  - @cat-factory/spend@0.10.22
  - @cat-factory/prompt-fragments@0.8.4

## 0.34.8

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
  - @cat-factory/observability-langfuse@0.7.60
  - @cat-factory/provider-cloudflare@0.7.64
  - @cat-factory/provider-bedrock@0.7.64
  - @cat-factory/integrations@0.26.5
  - @cat-factory/orchestration@0.36.5
  - @cat-factory/provider-s3@0.2.10
  - @cat-factory/contracts@0.43.3
  - @cat-factory/consensus@0.7.64
  - @cat-factory/kernel@0.45.5
  - @cat-factory/server@0.39.8
  - @cat-factory/agents@0.21.6
  - @cat-factory/gates@0.2.16
  - @cat-factory/gitlab@0.1.7
  - @cat-factory/prompt-fragments@0.8.3
  - @cat-factory/spend@0.10.21

## 0.34.7

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2
  - @cat-factory/agents@0.21.5
  - @cat-factory/consensus@0.7.63
  - @cat-factory/gates@0.2.15
  - @cat-factory/gitlab@0.1.6
  - @cat-factory/integrations@0.26.4
  - @cat-factory/kernel@0.45.4
  - @cat-factory/orchestration@0.36.4
  - @cat-factory/prompt-fragments@0.8.2
  - @cat-factory/server@0.39.7
  - @cat-factory/spend@0.10.20
  - @cat-factory/provider-bedrock@0.7.63
  - @cat-factory/provider-cloudflare@0.7.63
  - @cat-factory/observability-langfuse@0.7.59
  - @cat-factory/provider-s3@0.2.9

## 0.34.6

### Patch Changes

- 7d219ab: Allow the `X-Connection-Id` request header in CORS so the SPA can reach the backend.

  The SPA sends `X-Connection-Id` on every API call (the per-tab connection id for real-time
  self-echo suppression), but the Worker's CORS preflight only allow-listed
  `Content-Type, Authorization, X-Personal-Password`. The browser's preflight asked permission
  for `x-connection-id`, the response omitted it, so the browser dropped every cross-origin
  request with "CORS Missing Allow Header" and the board failed to load ("Can't reach the
  backend"). curl/server-side callers were unaffected because they don't send the header.

  Move the allow-list to a single shared `CORS_ALLOWED_HEADERS` constant in
  `@cat-factory/server` (now including `X-Connection-Id`) and use it in both runtime facades.
  The Node facade previously passed no `allowHeaders` and so let Hono echo the requested
  headers, which silently masked the drift; it now uses the same explicit list as the Worker.

- Updated dependencies [7d219ab]
  - @cat-factory/server@0.39.6

## 0.34.5

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
  - @cat-factory/orchestration@0.36.3
  - @cat-factory/server@0.39.5
  - @cat-factory/agents@0.21.4
  - @cat-factory/consensus@0.7.62
  - @cat-factory/gates@0.2.14
  - @cat-factory/gitlab@0.1.5
  - @cat-factory/integrations@0.26.3
  - @cat-factory/observability-langfuse@0.7.58
  - @cat-factory/provider-bedrock@0.7.62
  - @cat-factory/provider-cloudflare@0.7.62
  - @cat-factory/provider-s3@0.2.8
  - @cat-factory/spend@0.10.19

## 0.34.4

### Patch Changes

- 1a349b5: Drop persisted agent failures carrying a removed kind so a stale row can't brick the board.

  `decision_timeout` was removed from the `AgentFailure` kind picklist when human decisions
  stopped being timeout-limited. A run that failed before then still carries the obsolete kind
  in its persisted failure JSON, which violates the now-closed picklist. Because the server
  ships rows without validating them against the contract, one stale failure made the SPA's
  response validation reject the entire workspace snapshot ("Can't reach the backend").

  The three failure-column parsers (the shared execution mapper plus both runtimes' bootstrap
  repositories) now drop a failure whose kind is no longer known, via the new shared
  `isKnownAgentFailureKind` predicate. The run's `status` + `error` string still describe what
  happened. This repair is temporary and marked for removal after the 2026-07-15 migration
  grace cutoff.

- Updated dependencies [1a349b5]
  - @cat-factory/server@0.39.4

## 0.34.3

### Patch Changes

- Updated dependencies [80e5fc9]
  - @cat-factory/server@0.39.3

## 0.34.2

### Patch Changes

- Updated dependencies [c11a0cc]
- Updated dependencies [c11a0cc]
- Updated dependencies [c11a0cc]
  - @cat-factory/agents@0.21.3
  - @cat-factory/consensus@0.7.61
  - @cat-factory/contracts@0.43.1
  - @cat-factory/gates@0.2.13
  - @cat-factory/integrations@0.26.2
  - @cat-factory/kernel@0.45.2
  - @cat-factory/observability-langfuse@0.7.57
  - @cat-factory/orchestration@0.36.2
  - @cat-factory/prompt-fragments@0.8.1
  - @cat-factory/provider-bedrock@0.7.61
  - @cat-factory/provider-cloudflare@0.7.61
  - @cat-factory/server@0.39.2
  - @cat-factory/spend@0.10.18
  - @cat-factory/gitlab@0.1.4
  - @cat-factory/provider-s3@0.2.7

## 0.34.1

### Patch Changes

- Updated dependencies [5363166]
- Updated dependencies [5363166]
  - @cat-factory/orchestration@0.36.1
  - @cat-factory/kernel@0.45.1
  - @cat-factory/server@0.39.1
  - @cat-factory/agents@0.21.2
  - @cat-factory/consensus@0.7.60
  - @cat-factory/gates@0.2.12
  - @cat-factory/gitlab@0.1.3
  - @cat-factory/integrations@0.26.1
  - @cat-factory/observability-langfuse@0.7.56
  - @cat-factory/provider-bedrock@0.7.60
  - @cat-factory/provider-cloudflare@0.7.60
  - @cat-factory/provider-s3@0.2.6
  - @cat-factory/spend@0.10.17

## 0.34.0

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
  - @cat-factory/orchestration@0.36.0
  - @cat-factory/server@0.39.0
  - @cat-factory/prompt-fragments@0.8.0
  - @cat-factory/agents@0.21.1
  - @cat-factory/consensus@0.7.59
  - @cat-factory/gates@0.2.11
  - @cat-factory/gitlab@0.1.2
  - @cat-factory/spend@0.10.16
  - @cat-factory/observability-langfuse@0.7.55
  - @cat-factory/provider-bedrock@0.7.59
  - @cat-factory/provider-cloudflare@0.7.59
  - @cat-factory/provider-s3@0.2.5

## 0.33.2

### Patch Changes

- Updated dependencies [67c7196]
  - @cat-factory/orchestration@0.35.1
  - @cat-factory/server@0.38.1

## 0.33.1

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/contracts@0.42.0
  - @cat-factory/kernel@0.44.0
  - @cat-factory/agents@0.21.0
  - @cat-factory/orchestration@0.35.0
  - @cat-factory/server@0.38.0
  - @cat-factory/consensus@0.7.58
  - @cat-factory/gates@0.2.10
  - @cat-factory/gitlab@0.1.1
  - @cat-factory/integrations@0.25.2
  - @cat-factory/prompt-fragments@0.7.41
  - @cat-factory/spend@0.10.15
  - @cat-factory/observability-langfuse@0.7.54
  - @cat-factory/provider-bedrock@0.7.58
  - @cat-factory/provider-cloudflare@0.7.58
  - @cat-factory/provider-s3@0.2.4

## 0.33.0

### Minor Changes

- bbafec9: Add `@cat-factory/gitlab`: the opt-in GitLab VCS provider, the proof-of-concept
  second backend for the provider-neutral VCS abstraction. It implements the
  neutral `VcsClient` (repo/branch/MR/issue/CI reads + writes over the GitLab REST
  v4 API), a `VcsWebhookVerifier` + `VcsWebhookMapper` (constant-time
  `X-Gitlab-Token` check; `Merge Request`/`Issue`/`Push`/`Pipeline` hooks →
  neutral events), and a `VcsProvisioningClient`, and registers itself via
  `registerGitLab()` → `registerVcsProvider('gitlab')`. Depends only on
  `@cat-factory/kernel` + `@cat-factory/contracts`. Also refines the kernel
  `VcsWebhookMapper` port to take the resolved connection as a parameter.

  The provider is now WIRED into all runtime facades (single-token model, mirroring
  local-mode's PAT): a `GITLAB_TOKEN` (+ optional `GITLAB_API_BASE` /
  `GITLAB_CONNECTION_ID` / `GITLAB_WEBHOOK_SECRET`) enables it, the Worker + Node
  facades call `registerGitLab()` at container build (local inherits Node), and a
  new provider-neutral webhook receiver `POST /vcs/:provider/webhooks`
  (`@cat-factory/server`) verifies the signature against the registered
  `VcsWebhookVerifier`, maps the delivery via the registered `VcsWebhookMapper`, and
  hands the neutral event to the optional `VcsWebhookSink` kernel port. Adds a
  `GitLabConfig` to `AppConfig` and `vcsWebhookSink` to the server container.

  Bug fixes to the GitLab adapter: mergeability now prefers `detailed_merge_status`
  and only maps a genuine `conflict` to the `dirty` state the conflicts gate
  escalates on (a non-conflict block — CI pending, unresolved discussions, behind
  target — no longer spuriously spawns a conflict-resolver); `commitFiles` pins the
  commit parent via `start_sha` when `baseSha` is given; `getFileContent` resolves
  the project default branch instead of an unreliable `HEAD`; listing truncation at
  the page cap is now surfaced via an optional logger; the webhook mapper takes an
  injected `Clock` (deterministic timestamps) and reads the issue author.

  NOT yet migrated: the existing execution consumers (`resolveRepoTarget`, the
  CI/mergeability/merger/repo-files providers, the `github_*` projection
  persistence) still key on the GitHub installation id — projecting a neutral
  webhook event into provider-aware persistence is the remaining strangler step.

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/gitlab@0.1.0
  - @cat-factory/kernel@0.43.0
  - @cat-factory/server@0.37.0
  - @cat-factory/agents@0.20.3
  - @cat-factory/consensus@0.7.57
  - @cat-factory/gates@0.2.9
  - @cat-factory/integrations@0.25.1
  - @cat-factory/observability-langfuse@0.7.53
  - @cat-factory/orchestration@0.34.1
  - @cat-factory/provider-bedrock@0.7.57
  - @cat-factory/provider-cloudflare@0.7.57
  - @cat-factory/provider-s3@0.2.3
  - @cat-factory/spend@0.10.14

## 0.32.0

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
  - @cat-factory/orchestration@0.34.0
  - @cat-factory/agents@0.20.2
  - @cat-factory/consensus@0.7.56
  - @cat-factory/gates@0.2.8
  - @cat-factory/kernel@0.42.2
  - @cat-factory/prompt-fragments@0.7.40
  - @cat-factory/server@0.36.3
  - @cat-factory/spend@0.10.13
  - @cat-factory/provider-bedrock@0.7.56
  - @cat-factory/provider-cloudflare@0.7.56
  - @cat-factory/observability-langfuse@0.7.52
  - @cat-factory/provider-s3@0.2.2

## 0.31.2

### Patch Changes

- Updated dependencies [6903cd7]
  - @cat-factory/orchestration@0.33.0
  - @cat-factory/server@0.36.2

## 0.31.1

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/contracts@0.40.1
  - @cat-factory/kernel@0.42.1
  - @cat-factory/agents@0.20.1
  - @cat-factory/consensus@0.7.55
  - @cat-factory/gates@0.2.7
  - @cat-factory/integrations@0.24.1
  - @cat-factory/orchestration@0.32.1
  - @cat-factory/prompt-fragments@0.7.39
  - @cat-factory/server@0.36.1
  - @cat-factory/spend@0.10.12
  - @cat-factory/observability-langfuse@0.7.51
  - @cat-factory/provider-bedrock@0.7.55
  - @cat-factory/provider-cloudflare@0.7.55
  - @cat-factory/provider-s3@0.2.1

## 0.31.0

### Minor Changes

- 32c653f: Add a runtime-neutral binary-artifact storage abstraction (the foundation for the
  visual-confirmation gate's UI screenshots + reference design images).

  - New kernel port `BinaryArtifactStore` with a split, mix-and-match seam: a per-runtime
    `BinaryArtifactMetadataStore` (the queryable metadata) + a pluggable `BinaryBlobBackend`
    (the bytes — the "custom adapter interface"), composed by `createBinaryArtifactStore`.
  - Adapters: D1 metadata + R2 blob backend (Cloudflare — D1 can't hold large values, so
    bytes always go to R2); Drizzle/Postgres metadata + a Postgres `bytea` blob backend
    (Node/local, size-guarded); and a new opt-in `@cat-factory/provider-s3` package
    implementing the blob backend over an S3 (or S3-compatible) bucket.
  - Metadata table `binary_artifacts` mirrored D1 ⇄ Drizzle; a Node-only
    `binary_artifact_blobs` `bytea` table backs the `db` backend (no D1 equivalent).
  - `AppConfig.binaryStorage` selects the backend (`db` | `r2` | `s3`); wired in all three
    facades and surfaced on the request container. New workspace-scoped artifact API
    (upload reference / stream blob / list a run's artifacts). Cross-runtime conformance
    suite `defineBinaryArtifactsSuite` asserts store parity on both runtimes.

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
  - @cat-factory/server@0.36.0
  - @cat-factory/provider-s3@0.2.0
  - @cat-factory/contracts@0.40.0
  - @cat-factory/agents@0.20.0
  - @cat-factory/orchestration@0.32.0
  - @cat-factory/integrations@0.24.0
  - @cat-factory/consensus@0.7.54
  - @cat-factory/gates@0.2.6
  - @cat-factory/observability-langfuse@0.7.50
  - @cat-factory/provider-bedrock@0.7.54
  - @cat-factory/provider-cloudflare@0.7.54
  - @cat-factory/spend@0.10.11
  - @cat-factory/prompt-fragments@0.7.38

## 0.30.0

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
  - @cat-factory/orchestration@0.31.0
  - @cat-factory/server@0.35.0
  - @cat-factory/consensus@0.7.53
  - @cat-factory/gates@0.2.5
  - @cat-factory/integrations@0.23.5
  - @cat-factory/prompt-fragments@0.7.37
  - @cat-factory/spend@0.10.10
  - @cat-factory/observability-langfuse@0.7.49
  - @cat-factory/provider-bedrock@0.7.53
  - @cat-factory/provider-cloudflare@0.7.53

## 0.29.0

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
  - @cat-factory/orchestration@0.30.0
  - @cat-factory/server@0.34.0
  - @cat-factory/agents@0.18.5
  - @cat-factory/consensus@0.7.52
  - @cat-factory/gates@0.2.4
  - @cat-factory/integrations@0.23.4
  - @cat-factory/prompt-fragments@0.7.36
  - @cat-factory/spend@0.10.9
  - @cat-factory/observability-langfuse@0.7.48
  - @cat-factory/provider-bedrock@0.7.52
  - @cat-factory/provider-cloudflare@0.7.52

## 0.28.0

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
  - @cat-factory/orchestration@0.29.0
  - @cat-factory/server@0.33.0
  - @cat-factory/agents@0.18.4
  - @cat-factory/consensus@0.7.51
  - @cat-factory/gates@0.2.3
  - @cat-factory/integrations@0.23.3
  - @cat-factory/prompt-fragments@0.7.35
  - @cat-factory/spend@0.10.8
  - @cat-factory/observability-langfuse@0.7.47
  - @cat-factory/provider-bedrock@0.7.51
  - @cat-factory/provider-cloudflare@0.7.51

## 0.27.4

### Patch Changes

- Updated dependencies [efbd910]
  - @cat-factory/contracts@0.36.0
  - @cat-factory/server@0.32.2
  - @cat-factory/agents@0.18.3
  - @cat-factory/consensus@0.7.50
  - @cat-factory/gates@0.2.2
  - @cat-factory/integrations@0.23.2
  - @cat-factory/kernel@0.38.1
  - @cat-factory/orchestration@0.28.3
  - @cat-factory/prompt-fragments@0.7.34
  - @cat-factory/spend@0.10.7
  - @cat-factory/provider-bedrock@0.7.50
  - @cat-factory/provider-cloudflare@0.7.50
  - @cat-factory/observability-langfuse@0.7.46

## 0.27.3

### Patch Changes

- ae7bfcd: Update pg-boss `12.21.0 -> 12.23.0`. Purely a dependency bump — the durable-execution
  wiring (`PgBossWorkRunner` / `PgBossBootstrapRunner`, the `exclusive` advance queues,
  the send options) is unchanged and the public API we use is stable across the bump.

  The two internal pg-boss schema migrations (v33/v34) are applied automatically on
  `boss.start()`: v33 slims the job-fetch index and adds the background flow-resolver
  index (a free query-plan win for our advance queues), and v34 adds dead-letter source
  provenance columns (inert for us — we don't configure dead-letter queues; orphaned runs
  are recovered by the stale-run sweeper).

## 0.27.2

### Patch Changes

- 692ccb4: Centralize OpenAI-compatible provider base-URL resolution.

  The env-override→default base-URL logic (and the "litellm has no public default" rule)
  was reconstructed per facade — a `NODE_BASE_URLS` map plus a `||` lookup on Node and a
  provider `switch` on the Worker. Both now route through a single
  `resolveOpenAiCompatibleBaseUrl(provider, override)` in `@cat-factory/agents`, driven by
  the existing `DEFAULT_OPENAI_COMPATIBLE_BASE_URLS` table, so adding an OpenAI-compatible
  vendor is a one-line table entry both runtimes pick up automatically.

  Minor behavioural alignment: a _blank_ `${PROVIDER}_BASE_URL` override now falls back to
  the built-in default on the Worker too (it previously returned the empty string), matching
  Node's long-standing `||` semantics.

- Updated dependencies [692ccb4]
- Updated dependencies [692ccb4]
  - @cat-factory/server@0.32.1
  - @cat-factory/agents@0.18.2
  - @cat-factory/consensus@0.7.49
  - @cat-factory/orchestration@0.28.2
  - @cat-factory/provider-bedrock@0.7.49
  - @cat-factory/provider-cloudflare@0.7.49

## 0.27.1

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/contracts@0.35.0
  - @cat-factory/kernel@0.38.0
  - @cat-factory/server@0.32.0
  - @cat-factory/agents@0.18.1
  - @cat-factory/consensus@0.7.48
  - @cat-factory/gates@0.2.1
  - @cat-factory/integrations@0.23.1
  - @cat-factory/orchestration@0.28.1
  - @cat-factory/prompt-fragments@0.7.33
  - @cat-factory/spend@0.10.6
  - @cat-factory/observability-langfuse@0.7.45
  - @cat-factory/provider-bedrock@0.7.48
  - @cat-factory/provider-cloudflare@0.7.48

## 0.27.0

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
  - @cat-factory/gates@0.2.0
  - @cat-factory/server@0.31.0
  - @cat-factory/agents@0.18.0
  - @cat-factory/orchestration@0.28.0
  - @cat-factory/integrations@0.23.0
  - @cat-factory/consensus@0.7.47
  - @cat-factory/observability-langfuse@0.7.44
  - @cat-factory/provider-bedrock@0.7.47
  - @cat-factory/provider-cloudflare@0.7.47
  - @cat-factory/spend@0.10.5
  - @cat-factory/prompt-fragments@0.7.32

## 0.26.0

### Minor Changes

- 17adf4c: Local mode: warm container pool + checkout reuse, and optional native (host-process)
  execution of the developer's installed Claude Code / Codex CLI.

  **Warm pool + persistent checkout (default off = unchanged):** the local runner transport
  can keep idle harness containers warm and lease one — preferring a member that already holds
  the run's repo — instead of cold-starting a container per run. A leased member reuses a
  stable per-repo checkout (`git reset --hard` + a keep-list clean sweep that preserves
  dependency caches like `node_modules`, then `fetch` + switch branch) rather than cloning from
  scratch. New harness job field `persistentCheckout` drives this; it is set only by the local
  pool transport, so every other runtime keeps the ephemeral fresh-clone path byte-for-byte.
  Pooling is Docker-family only (the new `capabilities.pooling`); Apple `container` keeps the
  per-run path.

  **Configured in the UI + DB, not env:** the warm-pool sizing (size / pre-warm / max / idle
  timeout) and the per-repo checkout-reuse knobs (workspace root + dep-cache keep list) are a
  new per-deployment singleton (`local_settings`, Postgres/Drizzle only — local-mode-only, so
  no D1 mirror) exposed through a dedicated **"Local mode"** settings panel
  (Integrations → Local mode), served by a new `GET|PUT /local-settings` controller wired only
  on the local facade (503 elsewhere). This REPLACES the env vars `LOCAL_POOL_SIZE`,
  `LOCAL_POOL_MIN_WARM`, `LOCAL_POOL_MAX`, `LOCAL_POOL_IDLE_TTL_MS`, `HARNESS_WORKSPACE_ROOT`,
  `HARNESS_CLEAN_KEEP` (no longer read). The container transport forwards the checkout knobs to
  the harness container as `HARNESS_*` env. Breaking: those env vars are dropped — set the
  values in the UI instead.

  **Native execution (`LOCAL_NATIVE_AGENTS`, default off):** an allow-list of subscription
  harnesses (`claude-code,codex`) to run as a host process (new `LocalProcessRunnerTransport`)
  driving the developer's OWN installed `claude` / `codex` CLI with its ambient login (new
  harness `ambientAuth` mode) — no leased credential, no personal-credential gate for those
  vendors. Native applies ONLY to a listed harness's NATIVE vendor (Anthropic `claude` /
  OpenAI `codex`): a non-native vendor that reuses the `claude-code` harness (GLM/Kimi/DeepSeek
  carries its own base URL) and proxy/`pi` models are NOT run unsandboxed on the host — they
  keep the sandboxed per-run container path (so they still lease their real credential and
  still need `LOCAL_HARNESS_IMAGE`). Gated, local-facade-only, with the explicit no-sandbox /
  own-subscription trade documented. Requires `LOCAL_HARNESS_ENTRY`. The Tester's local
  docker-compose infra is reported unsupported in native mode for now (host-compose +
  git-worktree isolation are a follow-up phase).

  Breaking: none (all paths default off). The executor-harness image is bumped (1.16.0) for
  the new `persistentCheckout` / `ambientAuth` handling.

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/server@0.30.0
  - @cat-factory/integrations@0.22.0
  - @cat-factory/contracts@0.33.0
  - @cat-factory/kernel@0.36.0
  - @cat-factory/orchestration@0.27.1
  - @cat-factory/agents@0.17.2
  - @cat-factory/consensus@0.7.46
  - @cat-factory/gates@0.1.13
  - @cat-factory/prompt-fragments@0.7.31
  - @cat-factory/spend@0.10.4
  - @cat-factory/observability-langfuse@0.7.43
  - @cat-factory/provider-bedrock@0.7.46
  - @cat-factory/provider-cloudflare@0.7.46

## 0.25.0

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

- 518aff7: Surface account & team management in the UI

  The existing per-account management features (members + roles, email invitations, and the
  transactional email sender) are now reachable from a dedicated **Account settings** entry
  in the SideBar Configuration section (and the account switcher), instead of being buried in
  an org-only "Manage team…" dropdown item. On a personal account the panel prompts the user
  to create an organization, since members/roles/invitations are org-scoped.

  Email provider configuration no longer requires the `EMAIL_ENABLED` env var: the email
  module is available whenever an encryption key is set (`ENCRYPTION_KEY`, used to seal the
  per-account provider API key). **Breaking:** the `EMAIL_ENABLED` flag is removed — deployments
  that set it can drop it; email becomes available based on `ENCRYPTION_KEY` presence alone.

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/contracts@0.32.0
  - @cat-factory/kernel@0.35.0
  - @cat-factory/orchestration@0.27.0
  - @cat-factory/agents@0.17.1
  - @cat-factory/consensus@0.7.45
  - @cat-factory/gates@0.1.12
  - @cat-factory/integrations@0.21.7
  - @cat-factory/prompt-fragments@0.7.30
  - @cat-factory/server@0.29.1
  - @cat-factory/spend@0.10.3
  - @cat-factory/observability-langfuse@0.7.42
  - @cat-factory/provider-bedrock@0.7.45
  - @cat-factory/provider-cloudflare@0.7.45

## 0.24.0

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

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/contracts@0.31.0
  - @cat-factory/kernel@0.34.0
  - @cat-factory/agents@0.17.0
  - @cat-factory/orchestration@0.26.0
  - @cat-factory/server@0.29.0
  - @cat-factory/integrations@0.21.6
  - @cat-factory/consensus@0.7.44
  - @cat-factory/gates@0.1.11
  - @cat-factory/prompt-fragments@0.7.29
  - @cat-factory/spend@0.10.2
  - @cat-factory/observability-langfuse@0.7.41
  - @cat-factory/provider-bedrock@0.7.44
  - @cat-factory/provider-cloudflare@0.7.44

## 0.23.1

### Patch Changes

- Updated dependencies [4dd6e97]
  - @cat-factory/agents@0.16.1
  - @cat-factory/server@0.28.1
  - @cat-factory/consensus@0.7.43
  - @cat-factory/orchestration@0.25.1
  - @cat-factory/provider-bedrock@0.7.43
  - @cat-factory/provider-cloudflare@0.7.43

## 0.23.0

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
  - @cat-factory/orchestration@0.25.0
  - @cat-factory/server@0.28.0
  - @cat-factory/consensus@0.7.42
  - @cat-factory/gates@0.1.10
  - @cat-factory/integrations@0.21.5
  - @cat-factory/prompt-fragments@0.7.28
  - @cat-factory/spend@0.10.1
  - @cat-factory/observability-langfuse@0.7.40
  - @cat-factory/provider-bedrock@0.7.42
  - @cat-factory/provider-cloudflare@0.7.42

## 0.22.2

### Patch Changes

- Updated dependencies [18f6b3b]
  - @cat-factory/integrations@0.21.4
  - @cat-factory/server@0.27.2
  - @cat-factory/orchestration@0.24.2

## 0.22.1

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

- Updated dependencies [4849c66]
- Updated dependencies [b82304e]
  - @cat-factory/server@0.27.1
  - @cat-factory/contracts@0.29.0
  - @cat-factory/kernel@0.32.0
  - @cat-factory/spend@0.10.0
  - @cat-factory/orchestration@0.24.1
  - @cat-factory/agents@0.15.2
  - @cat-factory/consensus@0.7.41
  - @cat-factory/gates@0.1.9
  - @cat-factory/integrations@0.21.3
  - @cat-factory/prompt-fragments@0.7.27
  - @cat-factory/observability-langfuse@0.7.39
  - @cat-factory/provider-bedrock@0.7.41
  - @cat-factory/provider-cloudflare@0.7.41

## 0.22.0

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
  - @cat-factory/orchestration@0.24.0
  - @cat-factory/server@0.27.0
  - @cat-factory/agents@0.15.1
  - @cat-factory/consensus@0.7.40
  - @cat-factory/gates@0.1.8
  - @cat-factory/integrations@0.21.2
  - @cat-factory/observability-langfuse@0.7.38
  - @cat-factory/provider-bedrock@0.7.40
  - @cat-factory/provider-cloudflare@0.7.40
  - @cat-factory/spend@0.9.5
  - @cat-factory/prompt-fragments@0.7.26

## 0.21.1

### Patch Changes

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

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0
  - @cat-factory/contracts@0.27.0
  - @cat-factory/agents@0.15.0
  - @cat-factory/orchestration@0.23.0
  - @cat-factory/gates@0.1.7
  - @cat-factory/consensus@0.7.39
  - @cat-factory/integrations@0.21.1
  - @cat-factory/observability-langfuse@0.7.37
  - @cat-factory/provider-bedrock@0.7.39
  - @cat-factory/provider-cloudflare@0.7.39
  - @cat-factory/server@0.26.1
  - @cat-factory/spend@0.9.4
  - @cat-factory/prompt-fragments@0.7.25

## 0.21.0

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
  - @cat-factory/orchestration@0.22.0
  - @cat-factory/server@0.26.0
  - @cat-factory/agents@0.14.9
  - @cat-factory/consensus@0.7.38
  - @cat-factory/gates@0.1.6
  - @cat-factory/observability-langfuse@0.7.36
  - @cat-factory/provider-bedrock@0.7.38
  - @cat-factory/provider-cloudflare@0.7.38
  - @cat-factory/spend@0.9.3
  - @cat-factory/prompt-fragments@0.7.24

## 0.20.1

### Patch Changes

- Updated dependencies [ed3a673]
  - @cat-factory/contracts@0.25.1
  - @cat-factory/orchestration@0.21.1
  - @cat-factory/server@0.25.1
  - @cat-factory/agents@0.14.8
  - @cat-factory/consensus@0.7.37
  - @cat-factory/gates@0.1.5
  - @cat-factory/integrations@0.20.1
  - @cat-factory/kernel@0.28.1
  - @cat-factory/prompt-fragments@0.7.23
  - @cat-factory/spend@0.9.2
  - @cat-factory/provider-bedrock@0.7.37
  - @cat-factory/provider-cloudflare@0.7.37
  - @cat-factory/observability-langfuse@0.7.35

## 0.20.0

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
  - @cat-factory/orchestration@0.21.0
  - @cat-factory/server@0.25.0
  - @cat-factory/contracts@0.25.0
  - @cat-factory/kernel@0.28.0
  - @cat-factory/integrations@0.20.0
  - @cat-factory/agents@0.14.7
  - @cat-factory/consensus@0.7.36
  - @cat-factory/gates@0.1.4
  - @cat-factory/prompt-fragments@0.7.22
  - @cat-factory/spend@0.9.1
  - @cat-factory/observability-langfuse@0.7.34
  - @cat-factory/provider-bedrock@0.7.36
  - @cat-factory/provider-cloudflare@0.7.36

## 0.19.0

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
  - @cat-factory/orchestration@0.20.0
  - @cat-factory/server@0.24.0
  - @cat-factory/agents@0.14.6
  - @cat-factory/consensus@0.7.35
  - @cat-factory/gates@0.1.3
  - @cat-factory/prompt-fragments@0.7.21
  - @cat-factory/observability-langfuse@0.7.33
  - @cat-factory/provider-bedrock@0.7.35
  - @cat-factory/provider-cloudflare@0.7.35

## 0.18.6

### Patch Changes

- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1
  - @cat-factory/orchestration@0.19.2
  - @cat-factory/agents@0.14.5
  - @cat-factory/consensus@0.7.34
  - @cat-factory/gates@0.1.2
  - @cat-factory/integrations@0.18.3
  - @cat-factory/observability-langfuse@0.7.32
  - @cat-factory/provider-bedrock@0.7.34
  - @cat-factory/provider-cloudflare@0.7.34
  - @cat-factory/server@0.23.6
  - @cat-factory/spend@0.8.26

## 0.18.5

### Patch Changes

- Updated dependencies [a0d5efc]
  - @cat-factory/server@0.23.5

## 0.18.4

### Patch Changes

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0
  - @cat-factory/spend@0.8.25
  - @cat-factory/agents@0.14.4
  - @cat-factory/consensus@0.7.33
  - @cat-factory/gates@0.1.1
  - @cat-factory/integrations@0.18.2
  - @cat-factory/observability-langfuse@0.7.31
  - @cat-factory/orchestration@0.19.1
  - @cat-factory/provider-bedrock@0.7.33
  - @cat-factory/provider-cloudflare@0.7.33
  - @cat-factory/server@0.23.4

## 0.18.3

### Patch Changes

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

- Updated dependencies [f4f954b]
  - @cat-factory/gates@0.1.0
  - @cat-factory/kernel@0.25.0
  - @cat-factory/orchestration@0.19.0
  - @cat-factory/agents@0.14.3
  - @cat-factory/consensus@0.7.32
  - @cat-factory/integrations@0.18.1
  - @cat-factory/observability-langfuse@0.7.30
  - @cat-factory/provider-bedrock@0.7.32
  - @cat-factory/provider-cloudflare@0.7.32
  - @cat-factory/server@0.23.3
  - @cat-factory/spend@0.8.24

## 0.18.2

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/contracts@0.23.0
  - @cat-factory/kernel@0.24.0
  - @cat-factory/integrations@0.18.0
  - @cat-factory/agents@0.14.2
  - @cat-factory/consensus@0.7.31
  - @cat-factory/orchestration@0.18.1
  - @cat-factory/prompt-fragments@0.7.20
  - @cat-factory/server@0.23.2
  - @cat-factory/spend@0.8.23
  - @cat-factory/observability-langfuse@0.7.29
  - @cat-factory/provider-bedrock@0.7.31
  - @cat-factory/provider-cloudflare@0.7.31

## 0.18.1

### Patch Changes

- Updated dependencies [7346a4f]
  - @cat-factory/kernel@0.23.0
  - @cat-factory/orchestration@0.18.0
  - @cat-factory/agents@0.14.1
  - @cat-factory/consensus@0.7.30
  - @cat-factory/integrations@0.17.1
  - @cat-factory/observability-langfuse@0.7.28
  - @cat-factory/provider-bedrock@0.7.30
  - @cat-factory/provider-cloudflare@0.7.30
  - @cat-factory/server@0.23.1
  - @cat-factory/spend@0.8.22

## 0.18.0

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
  - @cat-factory/orchestration@0.17.0
  - @cat-factory/server@0.23.0
  - @cat-factory/consensus@0.7.29
  - @cat-factory/prompt-fragments@0.7.19
  - @cat-factory/spend@0.8.21
  - @cat-factory/observability-langfuse@0.7.27
  - @cat-factory/provider-bedrock@0.7.29
  - @cat-factory/provider-cloudflare@0.7.29

## 0.17.0

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
  - @cat-factory/server@0.22.0
  - @cat-factory/orchestration@0.16.0
  - @cat-factory/consensus@0.7.28
  - @cat-factory/integrations@0.16.1
  - @cat-factory/prompt-fragments@0.7.18
  - @cat-factory/spend@0.8.20
  - @cat-factory/observability-langfuse@0.7.26
  - @cat-factory/provider-bedrock@0.7.28
  - @cat-factory/provider-cloudflare@0.7.28

## 0.16.0

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
  - @cat-factory/orchestration@0.15.0
  - @cat-factory/server@0.21.0
  - @cat-factory/consensus@0.7.27
  - @cat-factory/observability-langfuse@0.7.25
  - @cat-factory/provider-bedrock@0.7.27
  - @cat-factory/provider-cloudflare@0.7.27
  - @cat-factory/spend@0.8.19

## 0.15.0

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
  - @cat-factory/orchestration@0.14.0
  - @cat-factory/server@0.20.0
  - @cat-factory/integrations@0.15.0
  - @cat-factory/agents@0.11.16
  - @cat-factory/consensus@0.7.26
  - @cat-factory/prompt-fragments@0.7.17
  - @cat-factory/spend@0.8.18
  - @cat-factory/observability-langfuse@0.7.24
  - @cat-factory/provider-bedrock@0.7.26
  - @cat-factory/provider-cloudflare@0.7.26

## 0.14.1

### Patch Changes

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

- Updated dependencies [4120ac5]
  - @cat-factory/contracts@0.19.0
  - @cat-factory/kernel@0.18.0
  - @cat-factory/orchestration@0.13.0
  - @cat-factory/integrations@0.14.0
  - @cat-factory/server@0.19.0
  - @cat-factory/agents@0.11.15
  - @cat-factory/consensus@0.7.25
  - @cat-factory/prompt-fragments@0.7.16
  - @cat-factory/spend@0.8.17
  - @cat-factory/observability-langfuse@0.7.23
  - @cat-factory/provider-bedrock@0.7.25
  - @cat-factory/provider-cloudflare@0.7.25

## 0.14.0

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
  - @cat-factory/server@0.18.0
  - @cat-factory/orchestration@0.12.0
  - @cat-factory/agents@0.11.14
  - @cat-factory/consensus@0.7.24
  - @cat-factory/prompt-fragments@0.7.15
  - @cat-factory/spend@0.8.16
  - @cat-factory/observability-langfuse@0.7.22
  - @cat-factory/provider-bedrock@0.7.24
  - @cat-factory/provider-cloudflare@0.7.24

## 0.13.4

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
  - @cat-factory/orchestration@0.11.1
  - @cat-factory/server@0.17.2
  - @cat-factory/consensus@0.7.23
  - @cat-factory/integrations@0.12.4
  - @cat-factory/prompt-fragments@0.7.14
  - @cat-factory/spend@0.8.15
  - @cat-factory/observability-langfuse@0.7.21
  - @cat-factory/provider-bedrock@0.7.23
  - @cat-factory/provider-cloudflare@0.7.23

## 0.13.3

### Patch Changes

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

- Updated dependencies [aa06003]
  - @cat-factory/contracts@0.17.0
  - @cat-factory/orchestration@0.11.0
  - @cat-factory/kernel@0.16.1
  - @cat-factory/server@0.17.1
  - @cat-factory/agents@0.11.12
  - @cat-factory/consensus@0.7.22
  - @cat-factory/integrations@0.12.3
  - @cat-factory/prompt-fragments@0.7.13
  - @cat-factory/spend@0.8.14
  - @cat-factory/observability-langfuse@0.7.20
  - @cat-factory/provider-bedrock@0.7.22
  - @cat-factory/provider-cloudflare@0.7.22

## 0.13.2

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0
  - @cat-factory/server@0.17.0
  - @cat-factory/agents@0.11.11
  - @cat-factory/consensus@0.7.21
  - @cat-factory/integrations@0.12.2
  - @cat-factory/observability-langfuse@0.7.19
  - @cat-factory/orchestration@0.10.9
  - @cat-factory/provider-bedrock@0.7.21
  - @cat-factory/provider-cloudflare@0.7.21
  - @cat-factory/spend@0.8.13

## 0.13.1

### Patch Changes

- Updated dependencies [494fb34]
  - @cat-factory/server@0.16.1
  - @cat-factory/kernel@0.15.1
  - @cat-factory/integrations@0.12.1
  - @cat-factory/agents@0.11.10
  - @cat-factory/consensus@0.7.20
  - @cat-factory/observability-langfuse@0.7.18
  - @cat-factory/orchestration@0.10.8
  - @cat-factory/provider-bedrock@0.7.20
  - @cat-factory/provider-cloudflare@0.7.20
  - @cat-factory/spend@0.8.12

## 0.13.0

### Minor Changes

- 0ac64b8: Add a "Create task from issue" button on service frames, and scope issue search to
  the service's repo.

  A service frame header now carries a ticket button (shown when a tracker is offered)
  that opens the tracker-issue modal pinned to that service: the new task is created in
  that frame, and the issue search is scoped to the service's linked GitHub repository
  instead of the whole installation. The same repo scoping applies to the
  attach-an-issue-as-context picker in the add-task form.

  Within a scoped GitHub search:

  - a pasted issue URL (or `owner/repo#n` / `owner/repo/issues/n`) resolves to that exact
    issue and is offered first instead of being fuzzy-matched — but only within the
    searching workspace's own GitHub App installation, so a URL naming another account is
    never fetched across tenants;
  - a bare issue number (`11`) resolves against the service's repo and is offered first;
  - free-text hits are restricted to the service's repo (`repo:owner/name`).

  A service is always created from (or with) a repo, so a GitHub search scoped to a block
  now REQUIRES that link: if the service isn't linked to a repo the search is refused with
  a clear error rather than silently widening to the whole installation. The
  block→service→repo resolver (`resolveRepoTarget`) is surfaced on the request container in
  both runtime facades so the shared task-search controller can resolve the scope.

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0
  - @cat-factory/contracts@0.16.0
  - @cat-factory/integrations@0.12.0
  - @cat-factory/server@0.16.0
  - @cat-factory/agents@0.11.9
  - @cat-factory/consensus@0.7.19
  - @cat-factory/observability-langfuse@0.7.17
  - @cat-factory/orchestration@0.10.7
  - @cat-factory/provider-bedrock@0.7.19
  - @cat-factory/provider-cloudflare@0.7.19
  - @cat-factory/spend@0.8.11
  - @cat-factory/prompt-fragments@0.7.12

## 0.12.3

### Patch Changes

- Updated dependencies [7d1f829]
  - @cat-factory/server@0.15.1
  - @cat-factory/agents@0.11.8
  - @cat-factory/consensus@0.7.18
  - @cat-factory/orchestration@0.10.6
  - @cat-factory/provider-bedrock@0.7.18
  - @cat-factory/provider-cloudflare@0.7.18

## 0.12.2

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/contracts@0.15.0
  - @cat-factory/kernel@0.14.0
  - @cat-factory/integrations@0.11.0
  - @cat-factory/server@0.15.0
  - @cat-factory/agents@0.11.7
  - @cat-factory/consensus@0.7.17
  - @cat-factory/orchestration@0.10.5
  - @cat-factory/prompt-fragments@0.7.11
  - @cat-factory/spend@0.8.10
  - @cat-factory/observability-langfuse@0.7.16
  - @cat-factory/provider-bedrock@0.7.17
  - @cat-factory/provider-cloudflare@0.7.17

## 0.12.1

### Patch Changes

- Updated dependencies [77b7d31]
  - @cat-factory/agents@0.11.6
  - @cat-factory/server@0.14.1
  - @cat-factory/orchestration@0.10.4
  - @cat-factory/kernel@0.13.4
  - @cat-factory/integrations@0.10.4
  - @cat-factory/consensus@0.7.16
  - @cat-factory/provider-bedrock@0.7.16
  - @cat-factory/provider-cloudflare@0.7.16
  - @cat-factory/observability-langfuse@0.7.15
  - @cat-factory/spend@0.8.9

## 0.12.0

### Minor Changes

- 82d771e: Add a "View Requirements" button to a selected service in the inspector that opens a
  structured navigation window over the service's prescriptive spec tree (modules → feature
  groups → requirements + Given/When/Then acceptance criteria + domain rules). When the spec
  is present on the service repo's default branch, a toggle switches to the rendered Gherkin
  scenarios.

  A new read-only endpoint `GET /workspaces/:ws/blocks/:blockId/spec` reassembles the sharded
  `spec/` artifact off the repo default branch via the existing checkout-free `RepoFiles`
  resolver (`resolveRunRepoContext`), now surfaced on the `ServerContainer` and wired
  symmetrically on both runtime facades. It returns `{ present: false }` when GitHub is not
  connected or no spec exists yet, so the window shows an empty state rather than erroring.

### Patch Changes

- Updated dependencies [82d771e]
  - @cat-factory/contracts@0.14.0
  - @cat-factory/server@0.14.0
  - @cat-factory/agents@0.11.5
  - @cat-factory/consensus@0.7.15
  - @cat-factory/integrations@0.10.3
  - @cat-factory/kernel@0.13.3
  - @cat-factory/orchestration@0.10.3
  - @cat-factory/prompt-fragments@0.7.10
  - @cat-factory/spend@0.8.8
  - @cat-factory/provider-bedrock@0.7.15
  - @cat-factory/provider-cloudflare@0.7.15
  - @cat-factory/observability-langfuse@0.7.14

## 0.11.2

### Patch Changes

- Updated dependencies [ce27690]
  - @cat-factory/contracts@0.13.1
  - @cat-factory/kernel@0.13.2
  - @cat-factory/agents@0.11.4
  - @cat-factory/server@0.13.2
  - @cat-factory/orchestration@0.10.2
  - @cat-factory/consensus@0.7.14
  - @cat-factory/integrations@0.10.2
  - @cat-factory/prompt-fragments@0.7.9
  - @cat-factory/spend@0.8.7
  - @cat-factory/observability-langfuse@0.7.13
  - @cat-factory/provider-bedrock@0.7.14
  - @cat-factory/provider-cloudflare@0.7.14

## 0.11.1

### Patch Changes

- Updated dependencies [c8bd144]
  - @cat-factory/server@0.13.1
  - @cat-factory/orchestration@0.10.1
  - @cat-factory/kernel@0.13.1
  - @cat-factory/agents@0.11.3
  - @cat-factory/consensus@0.7.13
  - @cat-factory/integrations@0.10.1
  - @cat-factory/observability-langfuse@0.7.12
  - @cat-factory/provider-bedrock@0.7.13
  - @cat-factory/provider-cloudflare@0.7.13
  - @cat-factory/spend@0.8.6

## 0.11.0

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
  - @cat-factory/orchestration@0.10.0
  - @cat-factory/server@0.13.0
  - @cat-factory/agents@0.11.2
  - @cat-factory/consensus@0.7.12
  - @cat-factory/prompt-fragments@0.7.8
  - @cat-factory/spend@0.8.5
  - @cat-factory/observability-langfuse@0.7.11
  - @cat-factory/provider-bedrock@0.7.12
  - @cat-factory/provider-cloudflare@0.7.12

## 0.10.1

### Patch Changes

- Updated dependencies [22d7fff]
  - @cat-factory/server@0.12.1
  - @cat-factory/agents@0.11.1
  - @cat-factory/consensus@0.7.11
  - @cat-factory/orchestration@0.9.1
  - @cat-factory/provider-bedrock@0.7.11
  - @cat-factory/provider-cloudflare@0.7.11

## 0.10.0

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

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/agents@0.11.0
  - @cat-factory/contracts@0.12.0
  - @cat-factory/orchestration@0.9.0
  - @cat-factory/server@0.12.0
  - @cat-factory/integrations@0.9.0
  - @cat-factory/consensus@0.7.10
  - @cat-factory/observability-langfuse@0.7.10
  - @cat-factory/provider-bedrock@0.7.10
  - @cat-factory/provider-cloudflare@0.7.10
  - @cat-factory/spend@0.8.4
  - @cat-factory/prompt-fragments@0.7.7

## 0.9.1

### Patch Changes

- f8a24e0: Refresh dependencies to latest. Notable major bumps: TypeScript 5→6 (tooling
  packages), vitest 3→4, pino 9→10, `@hono/node-server` 1→2, `@hono/valibot-validator`
  0.5→0.6, happy-dom 15→20, and `@types/node` →26. Patch/minor refreshes for `ai`,
  `hono`, `wrangler`, `pg-boss`, `ws`, `@ai-sdk/*`, `oxlint`, and the Cloudflare
  workers tooling.
- Updated dependencies [f8a24e0]
  - @cat-factory/agents@0.10.1
  - @cat-factory/consensus@0.7.9
  - @cat-factory/integrations@0.8.3
  - @cat-factory/kernel@0.11.1
  - @cat-factory/observability-langfuse@0.7.9
  - @cat-factory/orchestration@0.8.1
  - @cat-factory/provider-bedrock@0.7.9
  - @cat-factory/provider-cloudflare@0.7.9
  - @cat-factory/server@0.11.1
  - @cat-factory/spend@0.8.3

## 0.9.0

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
  - @cat-factory/orchestration@0.8.0
  - @cat-factory/agents@0.10.0
  - @cat-factory/server@0.11.0
  - @cat-factory/consensus@0.7.8
  - @cat-factory/integrations@0.8.2
  - @cat-factory/prompt-fragments@0.7.6
  - @cat-factory/spend@0.8.2
  - @cat-factory/observability-langfuse@0.7.8
  - @cat-factory/provider-bedrock@0.7.8
  - @cat-factory/provider-cloudflare@0.7.8

## 0.8.1

### Patch Changes

- Updated dependencies [d0081e1]
  - @cat-factory/contracts@0.10.0
  - @cat-factory/agents@0.9.0
  - @cat-factory/server@0.10.0
  - @cat-factory/consensus@0.7.7
  - @cat-factory/integrations@0.8.1
  - @cat-factory/kernel@0.10.1
  - @cat-factory/orchestration@0.7.7
  - @cat-factory/prompt-fragments@0.7.5
  - @cat-factory/spend@0.8.1
  - @cat-factory/provider-bedrock@0.7.7
  - @cat-factory/provider-cloudflare@0.7.7
  - @cat-factory/observability-langfuse@0.7.7

## 0.8.0

### Minor Changes

- ae29687: OpenRouter: dynamic multi-tenant catalog + flavour unification.

  **Flavour unification.** A catalog model can now carry an `openrouter` flavour alongside
  `cloudflare`/`direct`/`subscription`. `effectiveVariant` resolves in the precedence
  direct → openrouter → cloudflare (the subscription override still wins in `ModelRouter`),
  so the SAME logical model routes through OpenRouter when only an OpenRouter key is
  configured, and through its native vendor when that key is present. The standalone
  `openrouter-*` catalog entries are folded into their native twins: `deepseek`, `gpt-5.5`
  and `claude-opus` gain an `openrouter` route; Gemini 3 Pro becomes a curated `gemini`
  entry. **Breaking (pre-1.0, acceptable):** the catalog ids `openrouter-claude-opus`,
  `openrouter-gpt`, `openrouter-deepseek`, `openrouter-gemini-pro` and `openrouter-llama`
  are removed — a block pinned to one falls through to default routing.

  **Dynamic catalog.** A workspace can now browse OpenRouter's live `/models` and enable a
  subset in the UI (the new "OpenRouter models" panel), rather than a hardcoded handful.
  Enabled models surface in the per-workspace picker as `openrouter:<slug>` entries with
  their live context window and price (overlaid onto the spend table, so budgets meter
  accurately). Persisted in a new generic per-workspace `provider_model_catalog` table
  (D1 ⇄ Drizzle, keyed by `(workspace_id, provider)` so future gateways like LiteLLM reuse
  it), behind the new kernel `ProviderModelCatalogRepository` port and the
  `OpenRouterCatalogService` (refresh leases the workspace's pooled OpenRouter key). New
  routes: `GET|PUT /workspaces/:ws/openrouter/catalog`, `POST /workspaces/:ws/openrouter/refresh`.
  Cross-runtime conformance asserts the enabled-subset round-trip + catalog surfacing on
  both D1 and Postgres.

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/contracts@0.9.0
  - @cat-factory/kernel@0.10.0
  - @cat-factory/spend@0.8.0
  - @cat-factory/integrations@0.8.0
  - @cat-factory/server@0.9.0
  - @cat-factory/agents@0.8.2
  - @cat-factory/consensus@0.7.6
  - @cat-factory/orchestration@0.7.6
  - @cat-factory/prompt-fragments@0.7.4
  - @cat-factory/observability-langfuse@0.7.6
  - @cat-factory/provider-bedrock@0.7.6
  - @cat-factory/provider-cloudflare@0.7.6

## 0.7.5

### Patch Changes

- Updated dependencies [5c20968]
  - @cat-factory/kernel@0.9.0
  - @cat-factory/server@0.8.0
  - @cat-factory/agents@0.8.1
  - @cat-factory/consensus@0.7.5
  - @cat-factory/integrations@0.7.5
  - @cat-factory/observability-langfuse@0.7.5
  - @cat-factory/orchestration@0.7.5
  - @cat-factory/provider-bedrock@0.7.5
  - @cat-factory/provider-cloudflare@0.7.5
  - @cat-factory/spend@0.7.5

## 0.7.4

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/agents@0.8.0
  - @cat-factory/contracts@0.8.0
  - @cat-factory/kernel@0.8.0
  - @cat-factory/consensus@0.7.4
  - @cat-factory/orchestration@0.7.4
  - @cat-factory/provider-bedrock@0.7.4
  - @cat-factory/provider-cloudflare@0.7.4
  - @cat-factory/server@0.7.4
  - @cat-factory/integrations@0.7.4
  - @cat-factory/prompt-fragments@0.7.3
  - @cat-factory/spend@0.7.4
  - @cat-factory/observability-langfuse@0.7.4

## 0.7.3

### Patch Changes

- a0a1bcc: Add Kimi K2.5 (`@cf/moonshotai/kimi-k2.5`) to the model catalog as a Cloudflare-only
  entry (256K context) with its spend pricing. Cloudflare lists K2.5 at $0.60 in / $3.00
  out per 1M, below the K2.6/K2.7 rate, so without an explicit price entry it would fall
  back to the near-free `workers-ai` neuron rate and meter at ~0.

  Default the `conflict-resolver` agent kind to Kimi K2.5 on both runtimes (Worker + Node).
  The conflict-resolver rewrites conflicted hunks against the base, a focused diff-heavy
  reasoning task the small default MoE handles poorly. Operators can still override via
  `AGENT_MODELS`.

- Updated dependencies [a0a1bcc]
  - @cat-factory/kernel@0.7.3
  - @cat-factory/spend@0.7.3
  - @cat-factory/agents@0.7.3
  - @cat-factory/consensus@0.7.3
  - @cat-factory/integrations@0.7.3
  - @cat-factory/observability-langfuse@0.7.3
  - @cat-factory/orchestration@0.7.3
  - @cat-factory/provider-bedrock@0.7.3
  - @cat-factory/provider-cloudflare@0.7.3
  - @cat-factory/server@0.7.3

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.
- Updated dependencies [4fa5ed9]
  - @cat-factory/agents@0.7.2
  - @cat-factory/consensus@0.7.2
  - @cat-factory/contracts@0.7.2
  - @cat-factory/integrations@0.7.2
  - @cat-factory/kernel@0.7.2
  - @cat-factory/observability-langfuse@0.7.2
  - @cat-factory/orchestration@0.7.2
  - @cat-factory/prompt-fragments@0.7.2
  - @cat-factory/provider-bedrock@0.7.2
  - @cat-factory/provider-cloudflare@0.7.2
  - @cat-factory/server@0.7.2
  - @cat-factory/spend@0.7.2

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
- Updated dependencies [7463cf2]
  - @cat-factory/agents@0.7.1
  - @cat-factory/consensus@0.7.1
  - @cat-factory/contracts@0.7.1
  - @cat-factory/integrations@0.7.1
  - @cat-factory/kernel@0.7.1
  - @cat-factory/observability-langfuse@0.7.1
  - @cat-factory/orchestration@0.7.1
  - @cat-factory/prompt-fragments@0.7.1
  - @cat-factory/provider-bedrock@0.7.1
  - @cat-factory/provider-cloudflare@0.7.1
  - @cat-factory/server@0.7.1
  - @cat-factory/spend@0.7.1

## 0.7.0

### Minor Changes

- e0e89a7: Document- and task-source integrations are now **always on** instead of opt-in, and
  credential encryption is consolidated onto a single shared key.

  The `DOCUMENTS_ENABLED` / `TASKS_ENABLED` flags are gone — tenants connect their own
  Notion/Confluence/Jira sources interactively through the task-creation modal, so there
  is no service-level toggle to forget. A missing encryption key now **fails loudly at
  config load** rather than silently dropping the feature from the UI.

  **Breaking — single encryption key.** The per-integration `DOCUMENTS_ENCRYPTION_KEY`,
  `TASKS_ENCRYPTION_KEY`, `ENVIRONMENTS_ENCRYPTION_KEY` and `RUNNERS_ENCRYPTION_KEY` env
  vars are **removed**. One shared **`ENCRYPTION_KEY`** now backs all four integrations
  (the cipher already domain-separates per integration via its HKDF `info` tag, so a
  single master key is safe). Deployments must set `ENCRYPTION_KEY`; the always-on
  document/task sources refuse to boot without it, and the opt-in environment/runner
  integrations read it too. The Node facade serves task sources only (it ships no
  document providers yet), so it requires `ENCRYPTION_KEY` but no document-source wiring.

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

- 8eed38c: Mandate cross-runtime feature parity with a shared conformance suite, and wire the
  Node facade's durable execution onto pg-boss.

  - New private `@cat-factory/conformance` package: a runtime-neutral suite of the key
    backend behaviour (workspaces, board, the execution engine) parameterised by a
    `ConformanceHarness`, plus the single canonical deterministic `FakeAgentExecutor`.
    The Cloudflare Worker (over D1, inside workerd) and the Node service (over real
    Postgres) both run the IDENTICAL assertions, so any behavioural drift between
    runtimes fails a test instead of shipping silently. The Worker's `FakeAgentExecutor`
    is now a re-export of the shared one.
  - `@cat-factory/node-server` gains a `PgBossWorkRunner` (`WorkRunner`) + `driveExecution`
    loop — the Node analogue of the Worker's Cloudflare Workflows driver — so a started
    run is driven to completion durably over Postgres-backed pg-boss. `start()` boots
    pg-boss and the execution worker; tests cover the full start → queue → drive → done
    path against a real pg-boss instance.
  - CI runs the Node suite against a real Postgres service so parity is enforced on
    every PR.

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

- 8eed38c: The Node runtime now persists to Postgres via Drizzle (the latest 1.0 RC) — the
  single persistence used in dev, test and prod (no test-only in-memory store). It
  implements every core kernel repository port (workspaces, accounts, memberships,
  blocks, pipelines, executions-on-agent_runs, token usage, agent-runs) over a
  node-postgres pool, reusing the SAME row<->domain mappers the Cloudflare D1 repos
  use — which moved into `@cat-factory/server` so both stores share one mapping (the
  Worker re-exports them from their old path). The schema mirrors the D1 tables
  column-for-column; `migrate()` bootstraps it idempotently on boot. `DATABASE_URL`
  selects the database; the in-memory repositories are removed.
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

- f49fa30: Give the inline design/research agents (architect, researcher) provider-hosted web
  search. The `AiAgentExecutor` now attaches the AI SDK's server-executed `web_search`
  tool (Anthropic / OpenAI) to its one-shot call for an allow-listed set of kinds, plus
  a per-kind usage nudge — so those agents can verify current libraries/APIs instead of
  relying on training data, the same way Claude Code and Codex do. Opt-in and a no-op by
  default: enabled per deployment via `INLINE_WEB_SEARCH_ENABLED` (with
  `INLINE_WEB_SEARCH_KINDS` / `INLINE_WEB_SEARCH_MAX_USES` to tune the allow-list and
  cap), and only on providers that expose a hosted search — models on Workers AI / the
  OpenAI-compatible providers run unchanged. Both runtime facades wire it from env.

  The per-kind web-research nudge is data-driven, not a hardcoded switch:
  `AgentKindDefinition` gains an optional `webResearchHint`, so a proprietary/custom
  agent kind registered via `registerAgentKind` supplies its own nudge and the shared
  composer (`webResearchGuidanceFor`) picks it up — the shared surface never needs to
  know the custom kind exists. Built-in kinds carry sensible defaults; unknown kinds get
  a generic hint.

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

- 918764f: Extend the Langfuse observability with **tool spans**: each container agent's tool
  calls now surface as spans under its run's trace, alongside that run's LLM generations
  (both are children of the one run trace, keyed by the execution id).

  The harness buffers a compact, metadata-only `ToolSpan` (`{tool, startedAt, endedAt,
ok}` — never tool args/results) per completed Pi tool call and returns the batch on its
  existing `GET /jobs/{id}` poll with **drain-on-read** semantics (each poll returns the
  spans since the last poll and clears the buffer). No new network from the container, no
  hot-path work — only in-memory accumulation bounded to one poll interval, so OOM risk is
  nil. `ContainerAgentExecutor.pollJob` forwards each drained batch to the trace sink as
  spans under the run trace (`jobId === executionId`, the same trace id the LLM
  generations use). Best-effort and fully isolated — a sink failure never affects the job
  lifecycle.

  Bumps the `@cat-factory/executor-harness` image tag (1.2.0 → 1.3.0); a deploy is needed
  to roll out the harness change. The self-hosted runner-pool path (arbitrary,
  manifest-driven APIs) gracefully yields no tool spans; the Cloudflare-container and
  local-Docker paths carry them through automatically.

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

- 8807f5c: Run agents on locally-hosted LLMs (Ollama, LM Studio, llama.cpp, vLLM, or any
  custom OpenAI-compatible server). Each user configures their own runners in
  Settings → "My local runners" (a runner lives on that person's machine), stored
  per-user in the DB with on-the-fly connection validation that probes the runner's
  `/v1/models` and lists the installed models to enable. The enabled models appear
  in the picker as the `direct` flavour and need no API key — the LLM proxy resolves
  the run initiator's endpoint and skips the DB key lease (new optional
  `LlmUpstreamEndpoint.apiKey` signal / keyless local branch), and inline LLM calls
  register the user's runners as keyless resolvers. Resolution is by the run
  initiator, exactly like personal subscriptions.

  New per-user `local_model_endpoints` table mirrored across both runtimes (D1
  migration `0002` ⇄ Drizzle), a user-scoped `GET|PUT|DELETE /local-model-endpoints`

  - `POST /local-model-endpoints/test` API, and a cross-runtime conformance
    assertion for the store (CRUD + bearer-key encryption round-trip + enabled-models
    JSON). Container kinds (coder/tester/merger/…) and the inline reviewer/planner all
    run on the local model. Breaking only in the pre-1.0 sense: a new table is added,
    no migration of existing data is needed.

  Because the user-supplied base URL is forwarded server-side (the test probe + the
  LLM proxy), it is constrained to a loopback/LAN allow-list (`localRunnerUrlError`):
  `localhost`, `*.local`, and RFC1918/ULA private addresses are accepted, while public
  hosts and the link-local cloud-metadata endpoint (`169.254.169.254` / `fe80::`) are
  rejected at the write boundary and the probe (anti-SSRF). Model usability is gated on
  the specific enabled model id (`localModels` capability), not merely the runner being
  configured, so a stale pin to a since-disabled model is caught at the pipeline-start
  guard.

- f0a847d: Local mode can link GitHub repos with the PAT, lighting up the "Add from existing
  repo" board flow (previously the GitHub integration was App-only, so it returned 503
  and the button stayed hidden — repos could only be linked via the `linkRepo` CLI).

  With a `GITHUB_PAT` set, the local facade now serves the GitHub read/link endpoints
  through the PAT-backed client:

  - `config.github.enabled` is forced on in local mode when a PAT is present (the Node
    loader only enables it for a configured GitHub App).
  - A workspace's installation is auto-provisioned from the PAT on first read
    (`AutoProvisioningInstallationRepository`), so `GET /github/connection` reports
    connected with no connect flow. The synthetic installation id matches the `linkRepo`
    CLI's, so CLI- and UI-linked repos share one installation.
  - The repo picker lists repos via `/user/repos` (`PatGitHubClient.listInstallationRepos`),
    the PAT analogue of the App-only `/installation/repositories` (which 403s for a PAT).
  - The connection reports `workflows: write` granted (the local PAT carries `workflow`
    scope), suppressing the advisory "missing workflows permission" banner.

  `@cat-factory/node-server` gains a `githubInstallationRepository` option on
  `buildNodeContainer` (default unchanged) so the local facade can wrap the repository,
  and re-exports `DrizzleGitHubInstallationRepository`. This is a local-mode differentiator
  (like the Docker runner and PAT token source); the Cloudflare/Node-proper facades keep
  using the GitHub App.

  The "Add from existing repo" picker also gains a search/filter input (filter by
  owner/name, with a "showing X of Y" count), since a PAT or wide App install can expose
  hundreds of repos that overflowed the plain dropdown.

- 0b21ff3: Add a local-mode runtime facade (`@cat-factory/local-server`) so a developer can run
  the whole product on their own machine. It is the Node.js facade
  (`@cat-factory/node-server`: shared Hono app + Drizzle/Postgres + pg-boss) with two
  local differentiators: agent jobs run as per-job local Docker/Podman containers (the
  new `LocalDockerRunnerTransport` — the local analogue of the Worker's per-run
  Cloudflare Container and an org's self-hosted runner pool, driven through the same
  `RunnerTransport` port), and GitHub is reached via a personal access token (`GITHUB_PAT`)
  instead of a GitHub App. `startLocal()` boots the service; `buildLocalContainer()` is
  the composition root. The agent containers clone, push branches and open real PRs on
  github.com with the PAT; pipelines run end to end locally.

  To support this cleanly, `@cat-factory/node-server` gained composition seams used by
  the local facade (all default to the existing Node behaviour): `buildNodeContainer`
  now accepts an injected `resolveTransport`, `mintInstallationToken` and `githubClient`,
  and `start()` accepts an injected `buildContainer` and a `host` bind address (else
  `HOST` from the env, else all interfaces — so a deployment can keep the service off the
  LAN). It also re-exports `createApp`. The local facade runs the shared cross-runtime
  conformance suite (with a fake agent executor) so it can't drift from the Node and
  Cloudflare facades.

  The runtime-neutral fetch-based GitHub client and the CI / merge / mergeability
  providers (`FetchGitHubClient`, `GitHubCiStatusProvider`, `GitHubMergeabilityProvider`,
  `GitHubPullRequestMerger`) move from the Cloudflare runtime into `@cat-factory/server`
  (re-exported from the Worker for existing imports — no behaviour change), so every
  facade can gate on real CI and merge for real. `FetchGitHubClient` now accepts any
  `AppTokenSource` (the App registry or a static PAT). Local mode wires these from a
  PAT-backed client, so a local pipeline gates on real GitHub Actions CI and merges the
  PR for real. The Node facade now also wires these gates when a GitHub App is configured
  — it builds a `FetchGitHubClient` from its own shared App registry — so a stock
  Node-with-App deployment gates on real CI and merges for real too (parity with the
  Worker; previously only local mode did).

  Local-mode robustness: the Docker transport is now constructed lazily, so the service
  boots (to serve the board + inline kinds) even without `LOCAL_HARNESS_IMAGE` — only
  repo-operating kinds then fail, loudly. On boot it reaps per-job containers orphaned by
  a previous crash, and on re-dispatch it removes any lingering container for the same job
  id before starting a fresh one. The `linkRepo` helper clears a stale installation row
  for the workspace before upserting (robust against the `github_installations`
  workspace-unique index), and local mode warns when the auth gate is left open on a
  network-reachable bind.

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

- c664fe6: Run container agent steps on the Node service via a self-hosted runner pool, so the
  Node facade no longer silently degrades repo-operating kinds (coder, mocker,
  playwright, blueprints, ci-fixer, conflict-resolver, merger) to useless one-shot LLM
  calls.

  The container-execution machinery is now shared, not Worker-only:

  - `@cat-factory/server` hosts the runtime-neutral `CompositeAgentExecutor`,
    `ContainerAgentExecutor` and `RunnerJobClient`, plus the Web-Crypto
    `WebCryptoSecretCipher` and GitHub-App auth (`GitHubAppAuth` / `GitHubAppRegistry`).
  - `@cat-factory/integrations` hosts the manifest-driven runner-pool transport
    (`HttpRunnerPoolProvider` / `RunnerPoolTransport`).
  - `@cat-factory/server` also hosts the runtime-neutral `buildResolveRepoTarget` (the
    security-sensitive block→service→repo ancestry walk, with its no-"first-repo"-fallback
    policy), so the Worker and Node service single-source it instead of keeping two
    hand-copied resolvers that could drift. Each facade just binds its own repositories.
  - `@cat-factory/worker` keeps thin re-export shims at the old paths (no API change).

  `@cat-factory/node-server` wires a `CompositeAgentExecutor` (inline + container) whose
  container executor dispatches to a workspace's registered runner pool
  (`RunnerPoolTransport`), resolving the run's repo + minting a short-lived GitHub
  installation token exactly as the Worker does. New Postgres tables
  (`runner_pool_connections`, `github_installations`, `github_repos`) mirror the D1
  schema. It activates when `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`, `PUBLIC_URL`,
  `AUTH_SESSION_SECRET` and `ENCRYPTION_KEY` are configured; otherwise inline
  kinds still work and container kinds fail loudly rather than faking success.

- 8eed38c: Harden and scale the Node runtime's durable execution, and move its schema to a
  drizzle-kit migration lineage.

  - **Parallel execution.** The pg-boss execution worker now drives up to
    `EXECUTION_CONCURRENCY` runs in parallel (independent per-node workers, `batchSize`
    kept at 1 so per-run retry semantics are unchanged). Previously a single worker drove
    one run at a time — and because a drive parks for the whole of a step's poll budget,
    one slow run blocked every other run behind it.
  - **Robust job liveness.** Advance jobs now carry a `heartbeatSeconds` so a crashed/
    evicted worker is detected and its run re-driven within ~1 minute, independent of the
    job-expiry cap. That cap (`expireInSeconds`) is now sized off the full-pipeline
    worst case (one poll budget × `EXECUTION_MAX_DRIVE_STEPS`, covering agent steps plus a
    CI-fixer retry loop) so a healthy long drive is never force-expired and double-driven
    under concurrency. New env knobs: `EXECUTION_CONCURRENCY`, `EXECUTION_HEARTBEAT_SECONDS`,
    `EXECUTION_MAX_DRIVE_STEPS` (`EXECUTION_DRIVE_EXPIRE_MINUTES` still overrides the cap).
  - **drizzle-kit migrations.** The hand-written `CREATE TABLE IF NOT EXISTS` bootstrap is
    replaced by a generated drizzle-kit lineage applied at boot via the drizzle migrator
    (still under an advisory lock for concurrent-boot safety). `src/db/schema.ts` is now the
    single source of truth — additive schema changes ship as new migrations instead of
    silently diverging existing databases. The schema also gains the indexes the Cloudflare
    D1 store has but the Node store was missing — `idx_workspaces_owner`,
    `idx_workspaces_account`, `idx_agent_runs_workspace`, and the **unique** partial
    `idx_accounts_personal` (one personal account per GitHub login, a correctness constraint
    that was absent on Node).

- 7d5e060: Bridge the Cloudflare ⇄ Node/local runtime feature-parity gaps: seven product
  features that worked on the Worker but `503`'d on the Node + local facades (their
  repositories were never wired) now work identically on all three, each landed with
  a cross-runtime conformance assertion.

  - **Merge threshold presets** — `merge_threshold_presets` + `DrizzleMergePresetRepository`.
  - **Board-scan repository blueprints** — `repo_blueprints` + `DrizzleRepoBlueprintRepository`
    (the blueprint reads; the `blueprints` pipeline step already ran on Node).
  - **Document sources** — `document_connections`/`documents` + repos; the Confluence /
    Notion / GitHub-docs provider shells are promoted into `@cat-factory/integrations`
    so both facades compose the same providers.
  - **Ephemeral environments** — `environment_connections`/`environments` + repos;
    `HttpEnvironmentProvider` promoted into `@cat-factory/integrations`; a Node
    `setInterval` TTL-teardown sweeper mirrors the Worker's expiry cron.
  - **GitHub projections + inline sync** — `github_branches`/`github_pull_requests`/
    `github_issues`/`github_commits`/`github_check_runs` + `github_sync_cursors` and the
    full read/write projection repos, so the runtime-neutral `GitHubSyncService`'s inline
    webhook/backfill ingest persists on Node; `WebCryptoWebhookVerifier` promoted into
    `@cat-factory/server`.
  - **Repo bootstrap** — `reference_architectures` + bootstrap runs stored as
    `kind='bootstrap'` rows of `agent_runs`; `ContainerRepoBootstrapper` promoted into
    `@cat-factory/server`; a **pg-boss durable bootstrap driver** (the analogue of the
    Worker's `BootstrapWorkflow`) replaces the previous "bootstrap isn't durable on Node
    yet" gap, and the stale-run sweeper now re-drives orphaned bootstrap runs too. The
    self-hosted runner pool (`RunnerPoolTransport`) now accepts the `bootstrap` dispatch
    kind — the harness `/bootstrap` route needs no Cloudflare primitive, so a pool runner
    serves it just like the local Docker transport — so a real bootstrap run dispatches +
    pushes for real on Node, not just on local.
  - **Prompt-fragment library (ADR 0006)** — `prompt_fragments`/`fragment_sources` +
    `DrizzlePromptFragmentRepository`/`DrizzleFragmentSourceRepository`; the runtime-neutral
    `LlmFragmentSelector` promoted into `@cat-factory/agents`. Opt-in via
    `PROMPT_LIBRARY_ENABLED`/`PROMPT_LIBRARY_SELECTOR`, wired exactly like the Worker's
    `selectFragmentLibraryDeps` (repos + installation resolver + selector), so the managed
    tenant fragment catalog feeding every agent run works identically on all three.

  The Worker keeps the same behaviour (it gains the new conformance assertions and the
  shared promoted classes). **Breaking on Node/local:** these features now require their
  new tables — boot-time `migrate()` applies them; there is no data to preserve.

  The Node/local Drizzle migration lineage was re-baselined to a single fresh
  `drizzle-kit generate` migration off the current `schema.ts` (the prior hand-authored
  folders had no snapshots, which blocked `db:generate`); `db:generate`/`db:check` are
  green again. Safe because no deployed database depends on the old lineage.

  Deferred (still Worker-only, flagged for follow-up): real-time push (Node `realtime`
  gateway still `501`s — needs a WebSocket hub over Postgres `LISTEN/NOTIFY`),
  queue-backed async GitHub ingest (Node ingests inline rather than via a pg-boss queue),
  and GitHub rate-limit telemetry (Node keeps the no-op repository).

- 75bd29d: Implement the real-time WebSocket transport on the Node + local facades, closing the
  last "Worker-only" runtime gap for live board updates. Previously the SPA's
  `ws://…/workspaces/:ws/events` handshake had no server on Node/local (the realtime
  gateway returned null and `@hono/node-server` doesn't upgrade on its own), so the
  browser logged a perpetual `connection refused` and only got updates by reconnect-time
  snapshot refresh.

  - New `runtimes/node/src/realtime.ts`: `NodeRealtimeHub` (in-memory per-workspace
    subscriber registry), `NodeEventPublisher` (mirrors the Worker's
    `DurableObjectEventPublisher` event shapes), and `attachRealtime` — a `ws` server bound
    to the HTTP `upgrade` event. The SPA speaks raw WebSocket (not socket.io), so the
    client is unchanged across runtimes; `@hono/node-ws` was rejected because its
    `upgradeWebSocket` middleware can't compose with the shared, `Response`-returning
    `EventsController`.
  - `start()` creates the hub, wires it into `buildNodeContainer` (as the engine's
    `executionEventPublisher`, decorated with `FanOutEventPublisher` so a shared service's
    events reach every mounting board, plus an `InAppNotificationChannel` composed
    alongside Slack), and attaches it to the HTTP listener. Local mode inherits all of
    this through `buildLocalContainer`'s pass-through, so a developer running locally now
    gets live execution/bootstrap/notification updates.
  - Ticket mint/verify is extracted into the shared `@cat-factory/server`
    `auth/wsTicket.ts` (`mintWsTicket`/`authorizeWsUpgrade`), used by both the Worker's
    `EventsController` and the Node upgrade handler so both handshakes authorise
    identically. `InAppNotificationChannel` is promoted from the Worker into
    `@cat-factory/server` so both facades deliver in-app notifications through one class.

  Single-process only for now: a multi-replica Node deployment would need a shared bus
  (Postgres `LISTEN/NOTIFY`) in front of the in-memory hub. The Worker's behaviour is
  unchanged (it gains the shared ticket/channel helpers).

- 8eed38c: Add `@cat-factory/node-server` — the Node.js runtime facade. It serves the shared
  `@cat-factory/server` Hono app (all controllers + middleware) via `@hono/node-server`,
  proving the runtime-neutral HTTP layer runs unchanged on a second runtime. It wires
  Node implementations of the runtime ports: a `loadNodeConfig` (the Node analogue of
  the Worker's env-driven config), Node gateways (HTTP LLM upstreams; real-time and
  async GitHub ingest fall back to the inline/not-enabled paths for now), a
  `CompositeModelProvider` (direct vendors + Cloudflare-over-REST + opt-in Bedrock via
  `@cat-factory/provider-bedrock`), and a process-local in-memory persistence layer
  behind the core kernel repository ports. `start()` boots an HTTP server;
  `createServer()`/`buildNodeContainer()` are exposed for embedding and tests.

  Persistence is in-memory (non-durable) for now — a Drizzle/Postgres layer and
  pg-boss durable execution implement the same ports as follow-ups.

- 4a08935: Add **OpenRouter** and **LiteLLM** as model providers. Both are OpenAI-compatible, so
  they reuse the existing inlined `openAiCompatibleResolver` path (no new dependency, no
  dedicated package) and work for both inline engine calls and container coding agents via
  the LLM proxy. Keys are onboarded per workspace/user through the UI key pool like the
  other direct vendors; their base URLs are deployment config — OpenRouter defaults to the
  public gateway (`OPENROUTER_BASE_URL` override optional), while LiteLLM is operator-hosted
  so `LITELLM_BASE_URL` is required to enable it. Ships curated, direct-only catalog entries
  (OpenRouter: Claude Opus, Gemini 3 Pro, GPT-5.5, DeepSeek, Llama 3.3; LiteLLM: a generic
  gateway-default entry) with approximate pricing/context, overridable via
  `SPEND_MODEL_PRICES`.

  Catalog selectability now also gates on a **resolvable base URL**: an OpenAI-compatible
  provider (everything but `openai`/`anthropic`) is only offered once its base URL resolves,
  so a LiteLLM model stays unselectable — and a pipeline using it is blocked at start —
  until `LITELLM_BASE_URL` is set, instead of passing the guard and throwing "No base URL
  configured" mid-run. Wired symmetrically into both facades' capability resolution.

  **Wire change:** `apiKeyProviderSchema` is widened with `'openrouter'` and `'litellm'`.

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

- 70e8ef0: Real-time fan-out for shared services.

  A shared service can appear on several workspaces' boards, but the engine pushes a live
  change (run progress, bootstrap, notification) to only the workspace it addresses — so the
  other boards saw the update only on reload. `FanOutEventPublisher` (a decorator over the
  per-workspace publisher) resolves the changed block's service and re-publishes the event to
  **every** workspace that mounts it, so all boards update live.

  - `WorkspaceMountRepository.listWorkspaceIdsMountingBlock(workspaceId, blockId)` (D1 + Drizzle)
    resolves the fan-out's target workspaces — the service owning the block and the boards that
    mount it — in a single join.
  - The Cloudflare facade wraps its `DurableObjectEventPublisher` with `FanOutEventPublisher`.
    Best-effort and self-isolating (the persisted row stays the source of truth); a block with
    no service, or a coarse block-less `boardChanged`, falls back to the originating workspace.

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

- f49fa30: Give container agents (coder, ci-fixer, mocker, blueprints, analysis, …) `web_search` /
  `web_fetch` via the `@juicesharp/rpiv-web-tools` Pi extension installed in the
  executor-harness image — without putting a search-provider key in the sandbox.

  The backend hosts a SearXNG-compatible **web-search proxy** at `${proxyBaseUrl}/web-search`
  (`webSearchProxyController`, mounted under the LLM proxy's public `/v1`). A container
  authenticates with the SAME short-lived, model-locked session token it uses for the LLM
  proxy; the facade verifies it and runs the search server-side through the `webSearch`
  runtime gateway, under the deployment's own provider key. Two upstreams ship: Brave
  (`WEB_SEARCH_BRAVE_API_KEY`, the recommended one-key path, what Claude Code uses) and a
  reverse proxy to a self-hosted SearXNG (`WEB_SEARCH_SEARXNG_URL` [+ `_API_KEY`]). Both
  runtime facades wire it from env, so it works on Cloudflare (where per-run container env
  vars can't be injected) and on the Node self-hosted runner pool alike — no provider
  secret ever enters the container, matching the LLM-proxy posture.

  When the proxy is configured, `ContainerAgentExecutor` sets `webSearch: true` on the
  coding/ci-fixer job body; the harness then points rpiv-web-tools' SearXNG provider at the
  proxy (the token as its bearer) and surfaces a kind-aware usage nudge (via
  `@cat-factory/agents`' `webResearchGuidanceFor`). Self-hosted runner pools may still
  configure a provider key directly in the container env (auto-detected as before); an
  explicit `WEB_SEARCH_PROVIDER` pin now requires that provider's credential to be present
  so the agent is never told about a tool that would error. The two web tools count as
  read-only exploration for the no-edit guard, but a dedicated cap
  (`JOB_MAX_CONSECUTIVE_WEB_CALLS`, default 25) stops a search rabbit-hole.

  Changes the image, so the harness version (its GHCR image tag) bumps.

- b156b4b: Pipeline-builder + default-models UI polish.

  Pipeline builder: saved pipelines no longer render every agent-kind icon inline
  (which overflowed the narrow panel) — each is a collapsed row showing its name and
  step count that expands to the full ordered step list on click. Draft steps now
  truncate their label so the per-step controls (gate / reorder / remove) always stay
  reachable, and a "Configure models" button opens the default-models settings panel
  straight from the builder. The left-nav action buttons are unified on the
  primary-soft style of "Build a pipeline".

  Default-models panel: restyled from a light modal into the dark full-screen window
  used by the agent-output review overlay (readable regardless of the OS colour-mode
  preference), with a filter box that narrows every kind's model picker. A kind left
  on its deployment default now names the model that default actually resolves to
  ("Model · Provider (default)") instead of the opaque "Deployment default".

  To support that, the workspace snapshot now carries `deploymentModelDefaults` — the
  deployment's env-routing defaults as `provider:model` refs (`default` plus the
  per-kind `byKind` overrides) — derived in the shared workspace controller from
  `config.agents.routing`, so it is identical across the Worker and Node facades. A
  cross-runtime conformance assertion guards that both surface it.

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

- 1a0686f: Close a runtime-parity gap: the privileged GitHub App tier (ADR 0005 — repo
  provisioning / create-repo) now works on the Node and local facades, not just the
  Cloudflare Worker. Previously `loadNodeConfig` never parsed `github.privilegedApp`
  and the Node container never built the privileged registry entry or wired
  `repoProvisioningClient`, so a Node deployment with a privileged App configured
  silently fell back to the manual repo-creation flow.

  `FetchGitHubProvisioningClient` moves into the runtime-neutral `@cat-factory/server`
  package (next to `FetchGitHubClient`, which already lived there); the Worker keeps a
  thin re-export at its old path. The Node config loader now reads
  `GITHUB_PRIVILEGED_APP_ID` + `GITHUB_PRIVILEGED_APP_PRIVATE_KEY`, and the Node
  container builds the privileged App auth + the provisioning client under the same
  condition the Worker does.

  **Breaking:** a privileged App is wired on Node only when BOTH
  `GITHUB_PRIVILEGED_APP_ID` and `GITHUB_PRIVILEGED_APP_PRIVATE_KEY` are set; a half-set
  env leaves the tier unconfigured (parity with the Worker).

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

- c664fe6: Let deployments mix in custom agent kinds and predefined pipelines programmatically —
  the same installation-level extension pattern as opt-in model providers
  (`registerModelRegistry` / `@cat-factory/provider-bedrock`).

  `@cat-factory/agents` now exposes an agent-kind registry (`registerAgentKind` /
  `registerAgentKinds`, `AgentKindDefinition`): a registered kind contributes its system
  prompt (string or `(kind) => string`), an optional custom user prompt, and an optional
  `requiresContainer` flag. `systemPromptFor` / `userPromptFor` consult the registry for
  custom kinds — after the built-in tracks (so a registered kind never shadows a
  standard-phase, acceptance, mock or business-logic kind) and before the generic
  fallback. The Worker's `CompositeAgentExecutor` routes a registered
  `requiresContainer: true` kind to the container executor (inline kinds need no harness
  changes and work end-to-end).

  `@cat-factory/kernel` now exposes a pipeline registry (`registerPipeline` /
  `registerPipelines`): registered pipelines are merged into `seedPipelines()` by id
  (appended, or replacing a built-in in place), so every new workspace is seeded with the
  deployment's pipelines alongside the built-in catalog.

  Both runtime facades (`@cat-factory/worker`, `@cat-factory/node-server`) re-export
  `registerAgentKind` / `registerPipeline` (and the test-only `clear*` helpers) next to the
  existing model-provider seam, so a proprietary org package registers everything from one
  place at deployment-assembly startup. The agent-kind id was already an open string
  throughout (pipelines, steps, model defaults), so no schema change is required.

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

- 9c9c1b5: Add two lookup indexes that were missing for hot single-column queries, mirrored
  across both runtimes (D1 migration `0041` ⇄ Drizzle schema + generated migration):

  - `services(frame_block_id)` — `getByFrameBlock` resolves a service by frame block
    id alone, with no `account_id` in hand, so it could not use the composite
    `idx_services_frame (account_id, frame_block_id)`. It runs in a loop while walking
    a block's ancestry on every agent run's repo resolution (`resolveRepoTarget`) and on
    board reads, so the previous full table scan was hot.
  - `blocks(id)` — `findById` looks a block up by id alone (no `workspace_id`), so it
    could not use the `(workspace_id, id)` primary key and scanned the largest table.

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

- 8eed38c: Harden the Node facade and de-duplicate the auth gate (review follow-ups):

  - Extract the default-deny session gate + per-workspace authorization into
    `mountAuthGate(app)` in `@cat-factory/server`, so the security-critical middleware
    has ONE implementation instead of being copy-pasted into each runtime facade (the
    Worker and the Node service now both call it). Behaviour is unchanged.
  - Node durable execution now actually recovers from crashes: the pg-boss advance job
    carries an `expireInSeconds` sized above a full poll budget plus `retryLimit`, and a
    stale-run sweeper re-enqueues runs left `running` in storage (the analogue of the
    Worker's cron `sweepStuckRuns`). Re-enqueues use the run's `singletonKey`, so a run
    still being driven is never double-driven.
  - `start()` shuts down cleanly on SIGTERM/SIGINT: it closes the HTTP server, stops the
    sweeper + pg-boss, releases the pool, then exits (previously the process could hang
    until SIGKILL).
  - `TokenUsageRepository.totalsSince` sums into `bigint` instead of `int4`, fixing an
    overflow past ~2.1B tokens and matching the 64-bit totals the D1 store returns.
  - `migrate()` runs its `CREATE … IF NOT EXISTS` bootstrap under a transaction-scoped
    advisory lock, so concurrent replica boots can't race on DDL.

- f647733: Run the spec-writer before the architect, and give every agent in a pipeline one
  shared work branch created up front.

  - **Pipeline order**: in `pl_full` and `pl_fullstack` the `spec-writer` now runs
    _before_ the `architect` (in `pl_fullstack`, the `spec-writer`/`spec-companion`
    pair moves ahead of `architect`/`architect-companion`). The architect is
    spec-aware, so it now designs against the just-written in-repo `spec/` instead of
    writing the spec only after the design is settled. Human gates are unchanged
    (requirements review, spec, architecture).

  - **Shared work branch**: the per-task work branch (`cat-factory/<blockId>`) is now
    ensured before the container agents run, via a new optional `ensureWorkBranch`
    dependency on `ContainerAgentExecutor` (wired in both the Cloudflare and Node facades
    through `ensureWorkBranchViaRest`). Every agent — including the read-only design agents
    (architect, analysis) — operates on that one branch, so the architect reads what the
    spec-writer committed. The helper probes first (an existing branch is reported ready in
    a single call), and only _writers_ create the branch from base when absent — read-only
    agents probe only, so a code-less pipeline never orphans an empty ref. It is idempotent
    (a 422 race is success) and best-effort, but now logs a warning on every failure path so
    a fallback to the base branch is observable rather than silent; ref names with slashes
    are encoded per path segment. When GitHub is not wired (tests), read-only agents fall
    back to the base branch as before.

- e0f21a0: Squash the migration lineage on both runtime facades into a single init migration.

  Pre-1.0 with no production data to preserve (backwards compatibility is a non-goal),
  so the incremental history is collapsed:

  - Cloudflare D1 (`@cat-factory/worker`): migrations `0001..0041` become one
    `0001_init.sql` that creates the final schema directly.
  - Node Postgres (`@cat-factory/node-server`): the drizzle-kit lineage is regenerated
    from `src/db/schema.ts` into a single migration.

  No schema change in either case: each squashed migration is the exact final state of
  the prior chain. Existing databases are reset (drop + re-apply) rather than migrated.

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

- Updated dependencies [fe53445]
- Updated dependencies [8eed38c]
- Updated dependencies [d94e75c]
- Updated dependencies [6406c8c]
- Updated dependencies [e0e89a7]
- Updated dependencies [3d9a9d8]
- Updated dependencies [db77061]
- Updated dependencies [28d3c28]
- Updated dependencies [a48c620]
- Updated dependencies [3bc8c79]
- Updated dependencies [9d3a956]
- Updated dependencies [8d11833]
- Updated dependencies [ad9ba9e]
- Updated dependencies [3e0d753]
- Updated dependencies [f83ffd7]
- Updated dependencies [3e7ab89]
- Updated dependencies [8065fed]
- Updated dependencies [385bd93]
- Updated dependencies [4ee8a4b]
- Updated dependencies [e50e78a]
- Updated dependencies [0972696]
- Updated dependencies [b48c455]
- Updated dependencies [e9b9356]
- Updated dependencies [e8005ba]
- Updated dependencies [3a12f15]
- Updated dependencies [3a12f15]
- Updated dependencies [8eed38c]
- Updated dependencies [b40da13]
- Updated dependencies [3a12f15]
- Updated dependencies [ec0c416]
- Updated dependencies [8eed38c]
- Updated dependencies [084bf43]
- Updated dependencies [14840ec]
- Updated dependencies [4030da2]
- Updated dependencies [268c15d]
- Updated dependencies [c9d3f49]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [157cd02]
- Updated dependencies [794b628]
- Updated dependencies [7c37653]
- Updated dependencies [db77061]
- Updated dependencies [f49fa30]
- Updated dependencies [6406c8c]
- Updated dependencies [57d70fa]
- Updated dependencies [1a0686f]
- Updated dependencies [6406c8c]
- Updated dependencies [918764f]
- Updated dependencies [918764f]
- Updated dependencies [88b3170]
- Updated dependencies [fe0b7f8]
- Updated dependencies [f73652c]
- Updated dependencies [db336b1]
- Updated dependencies [f9d3647]
- Updated dependencies [8807f5c]
- Updated dependencies [7a9cabf]
- Updated dependencies [0b21ff3]
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [197264e]
- Updated dependencies [a691853]
- Updated dependencies [f066c59]
- Updated dependencies [c664fe6]
- Updated dependencies [7d5e060]
- Updated dependencies [75bd29d]
- Updated dependencies [4a08935]
- Updated dependencies [2796a42]
- Updated dependencies [6406c8c]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [b287996]
- Updated dependencies [b156b4b]
- Updated dependencies [f49fa30]
- Updated dependencies [5c8ca33]
- Updated dependencies [b156b4b]
- Updated dependencies [7cf2a2d]
- Updated dependencies [2d66d34]
- Updated dependencies [197264e]
- Updated dependencies [56ee67d]
- Updated dependencies [1a0686f]
- Updated dependencies [3a12f15]
- Updated dependencies [861d363]
- Updated dependencies [8eed38c]
- Updated dependencies [37baa7f]
- Updated dependencies [c664fe6]
- Updated dependencies [553a67d]
- Updated dependencies [b80d657]
- Updated dependencies [4026793]
- Updated dependencies [311a110]
- Updated dependencies [f16ae62]
- Updated dependencies [ba1c0cf]
- Updated dependencies [36018cb]
- Updated dependencies [799be66]
- Updated dependencies [cc39497]
- Updated dependencies [d65c979]
- Updated dependencies [75a0441]
- Updated dependencies [7157fd7]
- Updated dependencies [2ab06b5]
- Updated dependencies [21ca647]
- Updated dependencies [c4ef995]
- Updated dependencies [8eed95b]
- Updated dependencies [0b38aa6]
- Updated dependencies [861d363]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
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
- Updated dependencies [e0230a0]
- Updated dependencies [0090313]
- Updated dependencies [7dc8e57]
- Updated dependencies [cc8d96a]
- Updated dependencies [7c37653]
- Updated dependencies [43f2443]
- Updated dependencies [acac735]
- Updated dependencies [b98923c]
- Updated dependencies [3841315]
- Updated dependencies [48d2f0d]
- Updated dependencies [3e6a844]
  - @cat-factory/contracts@0.7.0
  - @cat-factory/integrations@0.7.0
  - @cat-factory/orchestration@0.7.0
  - @cat-factory/server@0.7.0
  - @cat-factory/kernel@0.7.0
  - @cat-factory/agents@0.7.0
  - @cat-factory/prompt-fragments@0.7.0
  - @cat-factory/consensus@0.7.0
  - @cat-factory/spend@0.7.0
  - @cat-factory/provider-bedrock@0.7.0
  - @cat-factory/observability-langfuse@0.7.0
  - @cat-factory/provider-cloudflare@0.7.0
