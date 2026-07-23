# @cat-factory/node-server

## 0.111.0

### Minor Changes

- 93496b0: Stream per-call LLM telemetry while a run is in flight, and stop losing the cause of death when a local container dies mid-run.

  A `pr-reviewer` run whose container died 18 minutes in surfaced no slices and no calls — not a subagent-handling regression, but three separate gaps that together made the run unfalsifiable: its telemetry was never written, its container logs were deleted before anyone could read them, and the error it did report described a symptom of the cleanup path rather than the failure.

  - **Per-call telemetry now streams.** The harness buffers each model call as its CLI yields it and drains it on the next poll (`RunnerJobView.callMetrics`, drain-on-read like `spans`/`followUps`); `ContainerAgentExecutor.pollJob` records it immediately. It previously arrived only on the terminal `RunnerJobResult.callMetrics`, so a run that died mid-flight reported ZERO calls no matter how many tokens it had spent — precisely the run worth inspecting. Subagent calls stream too, which matters most: that is where a long review spends its tokens and where the parent stream goes quiet. A call whose tokens are not final yet is the one exception: a CLI that reports only a cumulative total is costed at the end (`attributeCumulativeUsage`), and since a streamed call is already recorded, such a call is withheld until it is complete rather than stored as a zero-token row.

  - **Recording a call twice is now a no-op instead of a duplicate row.** Each metric carries a job-scoped `HarnessCallMetric.seq` stamped by the harness and stable across both channels, so the live drain and the terminal list mint the same `<jobId>-hc-<seq>` id, and `LlmCallMetricRepository.record` ignores an id it already holds (`onConflictDoNothing` on Drizzle, `ON CONFLICT(id) DO NOTHING` on D1 — targeted at the id, so neither store silently swallows a genuinely malformed row). First write wins deliberately — an upsert would recompute a row's stored prompt delta against a chain tip that has since moved on. The executor also skips re-offering a call the live drain already stored, so the terminal write costs one round-trip per NEW call instead of re-walking the whole list. A self-hosted runner pool opts into the live channel with the new `callMetricsPath` response mapping.

  - **A promptless call can no longer break the prompt-delta chain.** `latestChainTip` now ignores rows with `messageCount === 0` (a subagent call carries no re-sendable request transcript). Those interleave with the parent's calls in record order now that telemetry streams live, and a tip that can't be chained onto made every following parent call store its whole prompt instead of a delta — losing the compression the chain exists for on exactly the subagent-heavy runs it matters most for.

  - **An exited container no longer blocks its own replacement (local mode).** `DockerRuntimeAdapter.endpoint()` let `docker port`'s non-zero exit ("no public port '8080/tcp' published for …") escape, but `find()` returns exited containers by design and `resolve()` reads an endpoint-less container as absent. The throw therefore skipped the remove-and-recreate recovery in `dispatchPerRun` and surfaced that CLI line as the run's recorded cause of death. A dead container now resolves to `undefined` per the port contract; a fault against a still-RUNNING container still throws, so the spin-up path keeps its fail-fast diagnostic.

  - **A container that dies mid-run leaves a post-mortem.** The poll now captures the container's exit state (new `ContainerRuntimeAdapter.exitState()`, including whether the runtime OOM-killed it) plus a tail of its own logs onto the failed view's `detail`, and the engine carries that through `recoverContainerEviction` onto the recorded failure. `release()` removes the container as the run settles, so this was the only surviving record of why the harness process went away — and it was being thrown away. Container logs were previously captured only on the spin-up path, never for a container that died after a healthy start. Since a re-dispatch also removes the dead container, the FIRST death's post-mortem is retained on the step (`PipelineStep.firstEvictionDetail`) and folded into the failure alongside the last one — with a crash budget of 1, the first death is usually what explains the run. The text is secret-scrubbed before it is persisted.

  Not addressed here: a PR review's `slices` are still written only when the reviewer job completes, so a killed review still shows none. That is a work-product persistence change, not an observability one.

### Patch Changes

- Updated dependencies [93496b0]
  - @cat-factory/kernel@0.154.0
  - @cat-factory/contracts@0.160.0
  - @cat-factory/orchestration@0.135.0
  - @cat-factory/integrations@0.92.0
  - @cat-factory/server@0.144.0
  - @cat-factory/agents@0.68.4
  - @cat-factory/caching@0.10.33
  - @cat-factory/consensus@0.11.28
  - @cat-factory/eks@0.1.128
  - @cat-factory/gates@0.7.20
  - @cat-factory/gitlab@0.11.20
  - @cat-factory/observability-langfuse@0.7.251
  - @cat-factory/observability-otel@0.2.34
  - @cat-factory/provider-bedrock@0.7.277
  - @cat-factory/provider-cloudflare@0.7.278
  - @cat-factory/provider-s3@0.2.201
  - @cat-factory/spend@0.12.77
  - @cat-factory/prompt-fragments@0.14.7

## 0.110.0

### Minor Changes

- 15249df: Opt-in, per-workspace review-debt friction on task creation.

  When a workspace enables it, authoring a new task is frictioned while finished work sits unreviewed:
  past a soft warn threshold (count of tasks parked on human review) creating a task requires an
  explicit acknowledgement, and in `enforce` mode it is refused outright once too many tasks are in
  review (by count) or one has waited too long (by age). Off by default — zero behaviour change for
  workspaces that don't enable it.

  - **Debt is derived from the existing open-notification signal** — no new "in review" state. A new
    closed `REVIEW_WAIT_NOTIFICATION_TYPES` constant + the pure `assessReviewFriction` verdict live in
    `@cat-factory/contracts`, so the SPA pre-warns with the SAME function the backend enforces with.
  - **Enforced server-side** in `BoardService.addTask` behind optional settings/notifications seams
    (pass-through when unwired or off); a `review_debt_warn` / `review_debt_blocked` 409 drives the
    friction dialog, and an acknowledgement can never tunnel through a hard block.
  - **Four new `workspace_settings` fields** (mode + warn count + two nullable hard-block triggers),
    mirrored across D1 and Drizzle with cross-runtime conformance coverage.
  - **Frontend**: a "Review friction" settings group, the friction dialog (with a "go review" deep
    link), a pre-warn debt badge on the add-task affordance, and copy localized in every locale.

  Full design: `backend/docs/review-debt-friction.md`.

### Patch Changes

- Updated dependencies [15249df]
  - @cat-factory/contracts@0.159.0
  - @cat-factory/kernel@0.153.0
  - @cat-factory/orchestration@0.134.0
  - @cat-factory/agents@0.68.3
  - @cat-factory/consensus@0.11.27
  - @cat-factory/eks@0.1.127
  - @cat-factory/gates@0.7.19
  - @cat-factory/gitlab@0.11.19
  - @cat-factory/integrations@0.91.2
  - @cat-factory/observability-otel@0.2.33
  - @cat-factory/prompt-fragments@0.14.6
  - @cat-factory/server@0.143.2
  - @cat-factory/spend@0.12.76
  - @cat-factory/caching@0.10.32
  - @cat-factory/observability-langfuse@0.7.250
  - @cat-factory/provider-bedrock@0.7.276
  - @cat-factory/provider-cloudflare@0.7.277
  - @cat-factory/provider-s3@0.2.200

## 0.109.1

### Patch Changes

- 8254367: Lint tightening: ratchet oxlint `complexity` from 40 to its step-2 target of 30.

  Refactored every function above complexity 30 along cohesive, behaviour-neutral seams (helper
  extractions / options-object bundles), including the god-file offenders: the Worker
  `buildContainer` registry resolution → a `container-registries.ts` sibling, `RunDispatcher`'s
  settled-poll branch tree → a new `PollCompletionController`, and `ExecutionService.stepInstance`'s
  re-entrancy predicate → a `reentrancy.logic.ts` sibling (both of which also shrink their host
  god-files). The executor-harness image tag is bumped (harness `src/**` changed).

- Updated dependencies [8254367]
  - @cat-factory/orchestration@0.133.2
  - @cat-factory/integrations@0.91.1
  - @cat-factory/server@0.143.1
  - @cat-factory/agents@0.68.2
  - @cat-factory/eks@0.1.126
  - @cat-factory/consensus@0.11.26
  - @cat-factory/provider-bedrock@0.7.275
  - @cat-factory/provider-cloudflare@0.7.276

## 0.109.0

### Minor Changes

- 2323df1: Enable/disable + pinned default for the two credential pools (subscription tokens and
  direct-provider API keys).

  A pool can hold several credentials "for the same thing" — several subscription tokens per
  (workspace, vendor), or several API keys per (scope, provider). Previously the only lever was
  delete, and selection was pure usage-aware rotation. Now each credential carries two lifecycle
  flags, editable via a new `PATCH` endpoint (`{ enabled?, isDefault? }`):

  - **Enable / disable** — a disabled credential stays in the pool (still listed and
    re-enablable) but is never leased and no longer makes its vendor/provider "configured", so
    the model picker and pipeline-start guard treat an all-disabled provider as unconfigured.
  - **Pinned default** — one credential per group can be pinned as the preferred one; it is
    leased in preference to usage-aware rotation. At most one default per group (setting one
    clears the prior), and a disabled default is ignored (leasing falls back to rotation among
    the remaining enabled credentials).

  New wire fields `enabled` / `isDefault` on `apiKeySchema` + `vendorCredentialSchema`; new
  `PATCH /workspaces/:ws/vendor-credentials/:id`, `PATCH …/api-keys/:id` (workspace + `/me` +
  account scopes). Persisted as `enabled` / `is_default` columns mirrored across all three stores
  (D1, Drizzle/Postgres, and the local `node:sqlite` credential store), with the lease/list
  queries filtering disabled and ordering the default first. The **LLM Vendors** UI gains a
  default toggle + an enable/disable switch per credential. A new cross-runtime conformance suite
  asserts the enable/disable + default behaviour against every store.

  This is an additive, backwards-compatible schema change: existing credentials read as enabled
  and not-default, so behaviour is unchanged until an operator opts in.

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/contracts@0.158.0
  - @cat-factory/kernel@0.152.0
  - @cat-factory/integrations@0.91.0
  - @cat-factory/server@0.143.0
  - @cat-factory/agents@0.68.1
  - @cat-factory/consensus@0.11.25
  - @cat-factory/eks@0.1.125
  - @cat-factory/gates@0.7.18
  - @cat-factory/gitlab@0.11.18
  - @cat-factory/observability-otel@0.2.32
  - @cat-factory/orchestration@0.133.1
  - @cat-factory/prompt-fragments@0.14.5
  - @cat-factory/spend@0.12.75
  - @cat-factory/caching@0.10.31
  - @cat-factory/observability-langfuse@0.7.249
  - @cat-factory/provider-bedrock@0.7.274
  - @cat-factory/provider-cloudflare@0.7.275
  - @cat-factory/provider-s3@0.2.199

## 0.108.4

### Patch Changes

- Updated dependencies [71bd63f]
  - @cat-factory/contracts@0.157.0
  - @cat-factory/kernel@0.151.0
  - @cat-factory/agents@0.68.0
  - @cat-factory/orchestration@0.133.0
  - @cat-factory/server@0.142.0
  - @cat-factory/integrations@0.90.0
  - @cat-factory/prompt-fragments@0.14.4
  - @cat-factory/consensus@0.11.24
  - @cat-factory/eks@0.1.124
  - @cat-factory/gates@0.7.17
  - @cat-factory/gitlab@0.11.17
  - @cat-factory/observability-otel@0.2.31
  - @cat-factory/spend@0.12.74
  - @cat-factory/caching@0.10.30
  - @cat-factory/observability-langfuse@0.7.248
  - @cat-factory/provider-bedrock@0.7.273
  - @cat-factory/provider-cloudflare@0.7.274
  - @cat-factory/provider-s3@0.2.198

## 0.108.3

### Patch Changes

- Updated dependencies [da0b83b]
  - @cat-factory/agents@0.67.9
  - @cat-factory/consensus@0.11.23
  - @cat-factory/orchestration@0.132.3
  - @cat-factory/provider-bedrock@0.7.272
  - @cat-factory/provider-cloudflare@0.7.273
  - @cat-factory/server@0.141.3

## 0.108.2

### Patch Changes

- 2cfae1e: Internal refactor (lint complexity/size ratchet — `complexity` 60 → 40): extract cohesive helpers
  from the ten functions above cyclomatic complexity 40 so each lands under the new ceiling, all
  behaviour-neutral. No public API, wire shape, or runtime behaviour changes; verified by the
  server / orchestration / agents unit suites and the node config specs (the cross-runtime
  conformance + worker suites run in CI).

  - `@cat-factory/server`: `buildRegisteredAgentBody` split into `buildCodingAgentBody` /
    `buildExploreAgentBody`; `toRunResult` into `coerceCustomResult` / `mapPushOrPrResult`;
    `ContainerAgentExecutor.pollJob`'s subscription/quota usage feedback moved into
    `recordSubscriptionUsageOnce` / `recordSubscriptionQuotaUsageOnce`; the workspace snapshot
    handler's optional-field spread ladder folded into a `definedFields` helper.
  - `@cat-factory/orchestration`: `AgentContextBuilder.buildContext`'s `block` sub-payload extracted
    into `buildBlockPayload`.
  - `@cat-factory/agents`: `coerceInitiativePlan`'s section loops extracted into
    `coerceInitiativePhases` / `coerceInitiativeItems` / `coerceInitiativeDecisions`.
  - `@cat-factory/node-server`: `buildAuthConfig`'s enablement prelude + fail-fast guards extracted
    into `resolveNodeAuthEnablement`.
  - `@cat-factory/worker`: `loadAuthConfig`'s enablement prelude extracted into `resolveAuthEnablement`.
  - `@cat-factory/executor-harness`: `parseAgentJob` split into `parseAgentOutputSpec` /
    `parseAgentPrSpec` / `assembleAgentJob`. Touches the runner image, so its tag is bumped
    (1.50.11) and the three pins re-synced.
  - `@cat-factory/local-server`: carries the re-synced `RECOMMENDED_HARNESS_IMAGE` pin.

- Updated dependencies [2cfae1e]
  - @cat-factory/server@0.141.2
  - @cat-factory/orchestration@0.132.2
  - @cat-factory/agents@0.67.8
  - @cat-factory/consensus@0.11.22
  - @cat-factory/provider-bedrock@0.7.271
  - @cat-factory/provider-cloudflare@0.7.272

## 0.108.1

### Patch Changes

- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
  - @cat-factory/contracts@0.156.0
  - @cat-factory/integrations@0.89.0
  - @cat-factory/kernel@0.150.0
  - @cat-factory/agents@0.67.7
  - @cat-factory/consensus@0.11.21
  - @cat-factory/eks@0.1.123
  - @cat-factory/gates@0.7.16
  - @cat-factory/gitlab@0.11.16
  - @cat-factory/observability-otel@0.2.30
  - @cat-factory/orchestration@0.132.1
  - @cat-factory/prompt-fragments@0.14.3
  - @cat-factory/server@0.141.1
  - @cat-factory/spend@0.12.73
  - @cat-factory/caching@0.10.29
  - @cat-factory/observability-langfuse@0.7.247
  - @cat-factory/provider-bedrock@0.7.270
  - @cat-factory/provider-cloudflare@0.7.271
  - @cat-factory/provider-s3@0.2.197

## 0.108.0

### Minor Changes

- 916278b: feat(frontend-extension-mechanism slice B): custom task types — a deployment-registered work
  item (an "incident", "pentest", "compliance-audit") is now a first-class create-task choice +
  card badge, symmetric with custom agent kinds, with zero host edits.

  - **Contracts.** `taskTypeSchema` / `createTaskTypeSchema` widen from a closed picklist to
    `picklist ∪ namespaced` (`<ns>:<name>`) — the shape `presentation.resultView` already uses. The
    result-view-only `NAMESPACED_RESULT_VIEW_ID_PATTERN` is generalized into a shared `primitives.ts`
    atom (`NAMESPACED_ID_PATTERN` / `isNamespacedId` / `namespacedIdSchema`) reused across every
    extension surface. New `customTaskTypeSchema` (+ `taskTypeFieldDescriptorSchema`), a sparse
    `taskTypeFields.custom` bag for descriptor values, and `workspaceSnapshot.customTaskTypes`.
  - **Kernel.** App-owned `TaskTypeRegistry` (`defaultTaskTypeRegistry()`, empty), mirroring
    `AgentKindRegistry`/`PipelineRegistry`; `defaultPipelineIdForTaskType` consults it after the
    built-in map.
  - **Orchestration.** `CoreDependencies.taskTypeRegistry` threaded into `BoardService` + re-exposed
    on `Core`; `validateRegistrations` gains task-type checks (namespaced id, `formPanel`,
    `defaultPipelineId` resolves).
  - **Server + all three facades.** Snapshot projects `customTaskTypes` (shared `WorkspaceController`);
    the Worker / Node / local facades build, install, validate, and re-export the registry (a
    `taskTypeRegistry` option on `createApp`/`start`/`startLocal`).
  - **Frontend (`@cat-factory/app`).** A `taskTypes` slot + a `useTaskTypesStore` (cloning the
    agents-store merge → `taskTypeMeta` read-model); `buildAgentCapabilitiesManifest` generalized to
    one `buildWorkspaceCapabilitiesManifest(kinds, taskTypes)` carrying both slots (agents store's
    `hydrateCustomKinds` → `hydrateCapabilities`). `AddTaskModal` merges custom types into its picker
    and renders their descriptor fields (or a `taskTypeFormPanels`-paired section) into
    `taskTypeFields.custom`; `TaskCard` shows a type badge via `taskTypeMeta` (unregistered
    namespaced types degrade to the `feature` presentation).

  Cross-runtime conformance asserts the backend round-trip on both runtimes; the `deploy/frontend`
  `acme:security` module dogfoods a CODE-shipped `acme:incident` task type end to end (e2e).

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/contracts@0.155.0
  - @cat-factory/kernel@0.149.0
  - @cat-factory/orchestration@0.132.0
  - @cat-factory/server@0.141.0
  - @cat-factory/agents@0.67.6
  - @cat-factory/consensus@0.11.20
  - @cat-factory/eks@0.1.122
  - @cat-factory/gates@0.7.15
  - @cat-factory/gitlab@0.11.15
  - @cat-factory/integrations@0.88.18
  - @cat-factory/observability-otel@0.2.29
  - @cat-factory/prompt-fragments@0.14.2
  - @cat-factory/spend@0.12.72
  - @cat-factory/caching@0.10.28
  - @cat-factory/observability-langfuse@0.7.246
  - @cat-factory/provider-bedrock@0.7.269
  - @cat-factory/provider-cloudflare@0.7.270
  - @cat-factory/provider-s3@0.2.196

## 0.107.26

### Patch Changes

- 1bcb223: Internal refactor (lint complexity/size ratchet — `max-lines-per-function` step 1.5, 1000 → 632):
  split the product functions above the new ceiling along cohesive seams, all behaviour-neutral. No
  public API, wire shape, or runtime behaviour changes.

  - `@cat-factory/kernel`: `seedPipelines` split into three module-level catalog builders it composes.
  - `@cat-factory/server`: `publicApiController` / `authController` split into per-route-group registrars
    (mirroring `registerCoreControllers`'s mount groups).
  - `@cat-factory/app`: the `board` Pinia store's write operations extracted into `stores/board/`
    factories (`createBoardMutations` / `createBoardRemoval`) over a shared `BoardWriteContext`.
  - `@cat-factory/node-server`: `buildNodeContainer` split into `assembleNodeCoreDependencies` +
    `projectNodeServerContainer` (the `CoreDependencies` object and the `ServerContainer` projection).
  - `@cat-factory/local-server`: `buildLocalContainer`'s `buildNodeContainer` options extracted into
    `buildLocalNodeOptions`.

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5
  - @cat-factory/server@0.140.7
  - @cat-factory/agents@0.67.5
  - @cat-factory/caching@0.10.27
  - @cat-factory/consensus@0.11.19
  - @cat-factory/eks@0.1.121
  - @cat-factory/gates@0.7.14
  - @cat-factory/gitlab@0.11.14
  - @cat-factory/integrations@0.88.17
  - @cat-factory/observability-langfuse@0.7.245
  - @cat-factory/observability-otel@0.2.28
  - @cat-factory/orchestration@0.131.7
  - @cat-factory/provider-bedrock@0.7.268
  - @cat-factory/provider-cloudflare@0.7.269
  - @cat-factory/provider-s3@0.2.195
  - @cat-factory/spend@0.12.71

## 0.107.25

### Patch Changes

- Updated dependencies [e86e95b]
  - @cat-factory/orchestration@0.131.6
  - @cat-factory/server@0.140.6

## 0.107.24

### Patch Changes

- Updated dependencies [91ea6b7]
  - @cat-factory/contracts@0.154.2
  - @cat-factory/kernel@0.148.4
  - @cat-factory/server@0.140.5
  - @cat-factory/orchestration@0.131.5
  - @cat-factory/integrations@0.88.16
  - @cat-factory/agents@0.67.4
  - @cat-factory/consensus@0.11.18
  - @cat-factory/eks@0.1.120
  - @cat-factory/gates@0.7.13
  - @cat-factory/gitlab@0.11.13
  - @cat-factory/observability-otel@0.2.27
  - @cat-factory/prompt-fragments@0.14.1
  - @cat-factory/spend@0.12.70
  - @cat-factory/caching@0.10.26
  - @cat-factory/observability-langfuse@0.7.244
  - @cat-factory/provider-bedrock@0.7.267
  - @cat-factory/provider-cloudflare@0.7.268
  - @cat-factory/provider-s3@0.2.194

## 0.107.23

### Patch Changes

- Updated dependencies [3999941]
  - @cat-factory/kernel@0.148.3
  - @cat-factory/agents@0.67.3
  - @cat-factory/server@0.140.4
  - @cat-factory/caching@0.10.25
  - @cat-factory/consensus@0.11.17
  - @cat-factory/eks@0.1.119
  - @cat-factory/gates@0.7.12
  - @cat-factory/gitlab@0.11.12
  - @cat-factory/integrations@0.88.15
  - @cat-factory/observability-langfuse@0.7.243
  - @cat-factory/observability-otel@0.2.26
  - @cat-factory/orchestration@0.131.4
  - @cat-factory/provider-bedrock@0.7.266
  - @cat-factory/provider-cloudflare@0.7.267
  - @cat-factory/provider-s3@0.2.193
  - @cat-factory/spend@0.12.69

## 0.107.22

### Patch Changes

- Updated dependencies [b1d1e2c]
  - @cat-factory/prompt-fragments@0.14.0
  - @cat-factory/orchestration@0.131.3
  - @cat-factory/agents@0.67.2
  - @cat-factory/server@0.140.3
  - @cat-factory/consensus@0.11.16
  - @cat-factory/provider-bedrock@0.7.265
  - @cat-factory/provider-cloudflare@0.7.266

## 0.107.21

### Patch Changes

- 021f2a0: Surface + remediate ENCRYPTION_KEY drift (ADR 0026 D6.2/D6.3), building on the D6.1 fingerprint
  and typed `SecretDecryptError`.

  - A new `SealedSecretInventory` kernel port (`listSealed` + `drop`) is implemented per runtime
    (D1 + Drizzle, asserted by `defineSealedSecretInventorySuite`) over `environment_connections`
    and `observability_connections`. Adding a source is a change to the inventory pair, never the
    sweep.
  - `sweepKeyDriftAndRaise` (runtime-neutral) attempts a decrypt of every sealed secret, buckets by
    `reason`, and raises ONE `key_drift` notification per affected workspace — listing the affected
    credentials by source / id / label / reason / seal time (never the value), de-duped on that set
    and auto-cleared when a workspace recovers. It runs at Node boot and on the Worker's daily cron.
  - Remediation (D6.3) is explicit + per-secret: the `key_drift` card's action drops every credential
    it lists, and a `pnpm --filter @cat-factory/node-server key-drift:drop` operator CLI drops one.
    Both flip the owning connection to needs-re-entry (env → soft-delete, observability → row delete)
    and state that restoring the previous ENCRYPTION_KEY recovers the values instead — never automatic.
  - Adds the `key_drift` notification type (contracts) + its inbox card copy across all locales.

- 021f2a0: Detect ENCRYPTION_KEY drift at boot via a master-key fingerprint (ADR 0026 D6.1), and make a
  decrypt failure classifiable (D6.2 foundation).

  - A non-secret `HKDF(masterKey, "cat-factory:key-fingerprint")[:8]` fingerprint is persisted
    once in a new `key_fingerprint` singleton table (D1 + Drizzle, mirrored per runtime) and
    recompared on every boot: the Node facade checks right after `migrate()`, and the Worker on
    its daily cron. A mismatch logs a definitive "the key changed since secrets were last
    sealed" signal before any request touches a stale secret, instead of the old stream of
    opaque per-request decrypt errors.
  - `SecretCipher.decrypt` now throws a typed `SecretDecryptError` carrying a
    `reason: 'key-mismatch' | 'corrupt'` discriminant, so a drift sweep can bucket a failure
    without parsing message text.

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/contracts@0.154.1
  - @cat-factory/kernel@0.148.2
  - @cat-factory/server@0.140.2
  - @cat-factory/integrations@0.88.14
  - @cat-factory/agents@0.67.1
  - @cat-factory/consensus@0.11.15
  - @cat-factory/eks@0.1.118
  - @cat-factory/gates@0.7.11
  - @cat-factory/gitlab@0.11.11
  - @cat-factory/observability-otel@0.2.25
  - @cat-factory/orchestration@0.131.2
  - @cat-factory/prompt-fragments@0.13.48
  - @cat-factory/spend@0.12.68
  - @cat-factory/caching@0.10.24
  - @cat-factory/observability-langfuse@0.7.242
  - @cat-factory/provider-bedrock@0.7.264
  - @cat-factory/provider-cloudflare@0.7.265
  - @cat-factory/provider-s3@0.2.192

## 0.107.20

### Patch Changes

- Updated dependencies [90a0c1b]
  - @cat-factory/orchestration@0.131.1
  - @cat-factory/server@0.140.1

## 0.107.19

### Patch Changes

- Updated dependencies [a14fe03]
  - @cat-factory/contracts@0.154.0
  - @cat-factory/agents@0.67.0
  - @cat-factory/orchestration@0.131.0
  - @cat-factory/server@0.140.0
  - @cat-factory/consensus@0.11.14
  - @cat-factory/eks@0.1.117
  - @cat-factory/gates@0.7.10
  - @cat-factory/gitlab@0.11.10
  - @cat-factory/integrations@0.88.13
  - @cat-factory/kernel@0.148.1
  - @cat-factory/observability-otel@0.2.24
  - @cat-factory/prompt-fragments@0.13.47
  - @cat-factory/spend@0.12.67
  - @cat-factory/provider-bedrock@0.7.263
  - @cat-factory/provider-cloudflare@0.7.264
  - @cat-factory/caching@0.10.23
  - @cat-factory/observability-langfuse@0.7.241
  - @cat-factory/provider-s3@0.2.191

## 0.107.18

### Patch Changes

- Updated dependencies [8053837]
  - @cat-factory/orchestration@0.130.0
  - @cat-factory/contracts@0.153.0
  - @cat-factory/kernel@0.148.0
  - @cat-factory/server@0.139.0
  - @cat-factory/gitlab@0.11.9
  - @cat-factory/agents@0.66.7
  - @cat-factory/consensus@0.11.13
  - @cat-factory/eks@0.1.116
  - @cat-factory/gates@0.7.9
  - @cat-factory/integrations@0.88.12
  - @cat-factory/observability-otel@0.2.23
  - @cat-factory/prompt-fragments@0.13.46
  - @cat-factory/spend@0.12.66
  - @cat-factory/caching@0.10.22
  - @cat-factory/observability-langfuse@0.7.240
  - @cat-factory/provider-bedrock@0.7.262
  - @cat-factory/provider-cloudflare@0.7.263
  - @cat-factory/provider-s3@0.2.190

## 0.107.17

### Patch Changes

- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3
  - @cat-factory/server@0.138.16
  - @cat-factory/agents@0.66.6
  - @cat-factory/caching@0.10.21
  - @cat-factory/consensus@0.11.12
  - @cat-factory/eks@0.1.115
  - @cat-factory/gates@0.7.8
  - @cat-factory/gitlab@0.11.8
  - @cat-factory/integrations@0.88.11
  - @cat-factory/observability-langfuse@0.7.239
  - @cat-factory/observability-otel@0.2.22
  - @cat-factory/orchestration@0.129.11
  - @cat-factory/provider-bedrock@0.7.261
  - @cat-factory/provider-cloudflare@0.7.262
  - @cat-factory/provider-s3@0.2.189
  - @cat-factory/spend@0.12.65

## 0.107.16

### Patch Changes

- Updated dependencies [1614e62]
  - @cat-factory/agents@0.66.5
  - @cat-factory/consensus@0.11.11
  - @cat-factory/orchestration@0.129.10
  - @cat-factory/provider-bedrock@0.7.260
  - @cat-factory/provider-cloudflare@0.7.261
  - @cat-factory/server@0.138.15

## 0.107.15

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/contracts@0.152.2
  - @cat-factory/kernel@0.147.2
  - @cat-factory/server@0.138.14
  - @cat-factory/orchestration@0.129.9
  - @cat-factory/agents@0.66.4
  - @cat-factory/consensus@0.11.10
  - @cat-factory/eks@0.1.114
  - @cat-factory/gates@0.7.7
  - @cat-factory/gitlab@0.11.7
  - @cat-factory/integrations@0.88.10
  - @cat-factory/observability-otel@0.2.21
  - @cat-factory/prompt-fragments@0.13.45
  - @cat-factory/spend@0.12.64
  - @cat-factory/caching@0.10.20
  - @cat-factory/observability-langfuse@0.7.238
  - @cat-factory/provider-bedrock@0.7.259
  - @cat-factory/provider-cloudflare@0.7.260
  - @cat-factory/provider-s3@0.2.188

## 0.107.14

### Patch Changes

- 26f7c18: Lint ratchet: `max-statements` from its pinned baseline (157) down below 60 (no behavioural
  change).

  Every function above 50 statements is split along a cohesive seam so the `.oxlintrc.json`
  `max-statements` ceiling can drop from 157 to 50. All extractions are behaviour-neutral (moved
  code verbatim into well-named helpers, destructured at the top so the remaining bodies are
  unchanged; verified by the package unit suites and the cross-runtime conformance suites on real
  Postgres/workerd in CI):

  - **`createUiModals`** (`app/stores/ui/modals.ts`, 157): the flat bag of modal refs + open/close
    handlers is grouped into cohesive sub-factories (`createHealthAdvisoryModals`,
    `createDocumentTaskModals`, `createIntegrationPanelModals`, `createSettingsModals`,
    `createInfraModals`, `createAiOnboardingModals`, `createMiscModals`) composed behind the shared
    hub came-from markers; the returned public surface is unchanged.
  - **the LLM proxy handler** (`server/modules/llmProxy/LlmProxyController.ts`, 108): the workers-ai
    ceiling, the in-process dispatch, upstream resolution (local runner vs the DB-backed key pool),
    and the response relay are extracted into `applyWorkersAiCeiling` / `dispatchInProcess` /
    `resolveUpstreamTarget` / `relayUpstream` behind a per-call `ProxyCallContext`.
  - **`registerCoreControllers`** (`server/app.ts`, 77): the controller mounts split into
    `registerRootControllers` / `registerWorkspaceControllers` / `registerWebhookControllers`
    (exact mount order preserved).
  - **`resolveAuxiliaryRepos`** (`server/agents/ContainerAgentExecutor.ts`, 75),
    **`checkEntityCallScope`** (`server/persistence/rpc.ts`, 63), and the screenshot handler
    (`server/modules/artifacts/HarnessArtifactController.ts`, 51) are split along their existing
    seams.
  - **`provisionRecipe`** (`integrations/modules/compose/ComposeEnvironmentProvider.ts`, 94):
    decomposed into `preflightRecipe` / `readRecipeComposeFiles` / `materializeRecipeEnvFiles` /
    `runComposeBuildAndUp` / `runRecipeStepsAndGate` / `resolvePreviewUrl`. `bringUp`
    (`SharedStackService.ts`, 60), `buildKubernetesRecommendation` /
    `detectFrontendConfig` (`environments/*-detect.logic.ts`, 58/52) split similarly.
  - **`buildNodeContainer`** (`node/container.ts`, 63), the stale-run sweeper `tick`
    (`node/execution/pgBossRunner.ts`, 54), `bootServer` (`node/server.ts`, 53), and
    `buildLocalContainer` (`local/container.ts`, 51) extract cohesive sub-builders / sweeper
    closures.
  - **the coder container callbacks** (`executor-harness/src/coding-agent.ts`, 67/63) extract
    `prepareCodingCheckout` / `finalizeCodingRun` / `prepareMultiRepoCheckouts` /
    `pushMultiRepoLegs`. The harness image tag is bumped accordingly.
  - **orchestration**: `createCore` (`container.ts`, 71), the `RunDispatcher` step handlers
    (66/60), `SandboxRunService` (59), and `CompanionController` (56) split along cohesive seams.

- Updated dependencies [26f7c18]
  - @cat-factory/server@0.138.13
  - @cat-factory/orchestration@0.129.8
  - @cat-factory/integrations@0.88.9
  - @cat-factory/eks@0.1.113

## 0.107.13

### Patch Changes

- e4efb5f: Lint ratchet: `complexity` step 1 (141 → 60; no behavioural change).

  Every function above cyclomatic-complexity 60 is split along a cohesive seam so the
  `.oxlintrc.json` `complexity` ceiling can drop from its pinned baseline (141) to the first
  real step (60). All extractions are behaviour-neutral (verified by the server + orchestration
  unit suites and the node/local config tests; the cross-runtime conformance suites cover the
  `FakeAgentExecutor` + config paths on real Postgres/workerd in CI):

  - **`loadNodeConfig`** (`node/config.ts`, 141): the giant `AppConfig`-assembly function is
    decomposed into cohesive per-section builders (`resolveProviderCaps`, `buildAgentRouting`,
    `buildGithubConfig`, `buildAuthConfig`, `buildEmailConfig`, `buildEnvironmentsConfig`,
    `buildRunnersConfig`, `buildRetentionConfig`, `buildLangfuseConfig`, `buildOtelConfig`,
    `buildExecutionConfig`).
  - **`dispatchPersistenceCall`** (`server/persistence/rpc.ts`, 101): the scope-rule enforcement
    switch is lifted into `checkCallScope`, then split again into `checkEntityCallScope` (the
    block/service/user/owner resolver kinds) + a shared `checkOwnerPairScope`, keeping the two
    switches jointly exhaustive over `ScopeRule`.
  - **`buildJobBody`** (`server/agents/ContainerAgentExecutor.ts`, 75): the multi-repo fan-out /
    conflict-resolver / merger-combined-diff / reference-repo+branch resolution is extracted into
    `resolveAuxiliaryRepos`.
  - **`FakeAgentExecutor.run`** (conformance, 68): the decision/blueprints/spec-writer/companion
    cluster moves into `runProducerKinds`.
  - **`buildNodeContainer`** (`node/container.ts`, 64): the app-owned registry resolution + EKS
    registration moves into `resolveNodeAppRegistries`.
  - **`buildLocalContainer`** (`local/container.ts`, 66): the provider-agnostic PAT/VCS-client/
    repo-origin resolution moves into `resolveLocalVcs`.
  - **`pollAgentJobInner`** (`orchestration/RunDispatcher.ts`, 61): the running-poll fold becomes
    `applyRunningFold` and the gate-helper re-probe becomes `reprobeGateAfterHelper`.

- Updated dependencies [e4efb5f]
  - @cat-factory/server@0.138.12
  - @cat-factory/orchestration@0.129.7

## 0.107.12

### Patch Changes

- 6a6c6df: Lint ratchet: `max-lines-per-function` step 1 (2453 → 1000; no behavioural change).

  - **Test/product size split:** table-driven test suites (the cross-runtime conformance builders
    - Vitest specs) are carved into an `.oxlintrc.json` `overrides` entry held to their own ratchet
      at 2453 (globs `**/*.test.ts`, `**/*.spec.ts`, `internal/conformance/src/**`,
      `internal/e2e/**`), so the global (product) ceiling tightens without forcing product-code
      function limits onto the legitimately-large describe/it blocks.
  - **Node DI god-builder split:** `buildNodeContainer` (the lone product function above 1000, at
    1616 lines) is split into seven cohesive sibling `container-*-deps.ts` helpers following the
    existing `container-executor-deps.ts` pattern — `container-github-deps.ts` (`selectNodeGitHubDeps`,
    mirroring the Worker's `selectGitHubDeps`), `container-model-deps.ts`,
    `container-run-services-deps.ts`, `container-transport-deps.ts`, `container-account-deps.ts`, and
    `container-realtime-deps.ts` — bringing the composition root to 991 lines. Behaviour-neutral
    (verified against the Node + local cross-runtime conformance suites on real Postgres).

## 0.107.11

### Patch Changes

- 972a1bd: Lint ratchet: complete `max-params` (20 → 6, its final target; no behavioural change).

  Refactored every function above the target from a long positional list to a bundled
  argument, walking the `.oxlintrc.json` ceiling down 20 → 10 → 8 → 6:

  - **DI builders → dependency objects:** the Node `buildNodeContainerExecutor`
    (`NodeContainerExecutorDeps`), the Worker `selectAgentExecutor` / `buildContainerExecutor`
    (a shared `WorkerExecutorDeps`), `buildResolveTransport`, and `selectEnvConfigRepairer`.
  - **Loop-invariant step context → one object:** the deployer fan-out (`DeployerFanOut`
    threaded through `advanceDeployerFrames` / `settleDeployerFrame` / `settleDeployerFailure` /
    `completeDeployerStep`), the companion `applyAssessment` grading bundle, the Tester
    `failTester` failure bundle, and the gate `dispatchGateHelper` helper bundle.
  - **`ExecutionService.start(...)` trailing options → `RunStartOptions`** (new
    `runStartOptions.ts`, keeping `ExecutionService.ts` under the `max-lines` ceiling), updated
    at every call site.
  - **Callback / identity bundles:** `GitHubSyncService.syncResource` handlers,
    `RequirementReviewService.runWriterForChunk` (resolved model + grounding),
    `EnvironmentConnectionService.runProviderValidate` repo target, `SkillSourceService.syncSkillDir`
    dir descriptor, and the executor-harness `streamCli` CLI descriptor.

  The executor-harness bump republishes the runner image (its `streamCli` refactor touches
  `src/**`); the three image-tag pins + `RECOMMENDED_HARNESS_IMAGE` are synced to `1.50.1`.

- Updated dependencies [972a1bd]
  - @cat-factory/orchestration@0.129.6
  - @cat-factory/integrations@0.88.8
  - @cat-factory/agents@0.66.3
  - @cat-factory/server@0.138.11
  - @cat-factory/eks@0.1.112
  - @cat-factory/consensus@0.11.9
  - @cat-factory/provider-bedrock@0.7.258
  - @cat-factory/provider-cloudflare@0.7.259

## 0.107.10

### Patch Changes

- 492d0a2: Lint ratchet: complete `max-depth` (5 → 4, its final target; no behavioural change).

  Refactored the 18 depth-5 sites down to ≤ 4 by hoisting the innermost loop bodies into
  helpers along cohesive seams:

  - Extract a shared `parseSubtasks` into `@cat-factory/kernel` (`domain/subtasks.logic.ts`)
    and replace the four duplicated row→domain copies in the D1 and Drizzle bootstrap /
    env-config-repair repositories (removing the 4× duplication as well as the depth).
  - Split the two Worker `ExecutionWorkflow` poll loops (`drivePollLoop` / `driveGatePollLoop`
    - a shared `pollOnce`), the benchmark harness's per-task fixture dispatch, the seed-dump
      child scan and the env-config bootstrap commit/PR path in `@cat-factory/integrations`, the
      Workers-AI assistant tool-call conversion, and the OTEL conformity metric fold into helpers.
  - Lower `max-depth` to `4` in `.oxlintrc.json`.

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1
  - @cat-factory/integrations@0.88.7
  - @cat-factory/observability-otel@0.2.20
  - @cat-factory/agents@0.66.2
  - @cat-factory/caching@0.10.19
  - @cat-factory/consensus@0.11.8
  - @cat-factory/eks@0.1.111
  - @cat-factory/gates@0.7.6
  - @cat-factory/gitlab@0.11.6
  - @cat-factory/observability-langfuse@0.7.237
  - @cat-factory/orchestration@0.129.5
  - @cat-factory/provider-bedrock@0.7.257
  - @cat-factory/provider-cloudflare@0.7.258
  - @cat-factory/provider-s3@0.2.187
  - @cat-factory/server@0.138.10
  - @cat-factory/spend@0.12.63

## 0.107.9

### Patch Changes

- Updated dependencies [2d97b16]
  - @cat-factory/orchestration@0.129.4
  - @cat-factory/agents@0.66.1
  - @cat-factory/observability-otel@0.2.19
  - @cat-factory/server@0.138.9
  - @cat-factory/consensus@0.11.7
  - @cat-factory/provider-bedrock@0.7.256
  - @cat-factory/provider-cloudflare@0.7.257

## 0.107.8

### Patch Changes

- 8b6fa53: Split the three largest source files along cohesive seams and tighten their file-size ratchet
  allowances (no behavioural change):

  - `RunDispatcher.ts` — the three built-in dispatch registries (step handlers, completion
    interceptors, post-completion/terminal resolvers) move to a new `dispatcher-registries.ts`,
    built from an injected deps seam; the dispatcher keeps ownership via bound call-backs.
  - Node `container.ts` — the container-agent-executor wiring (transport resolver, provisioning-log
    wrapper, container executor + repo bootstrapper + env-config repairer, GitHub-issue filer,
    trace-sink builder) moves to a new `container-executor-deps.ts`; the public seams stay exported
    from `container.ts`.
  - The conformance `suites/execution.ts` sub-splits into `execution-{tester,review,gates}.ts` with
    `execution.ts` as a thin aggregator (private package; no release impact).

- Updated dependencies [8b6fa53]
  - @cat-factory/orchestration@0.129.3
  - @cat-factory/server@0.138.8

## 0.107.7

### Patch Changes

- Updated dependencies [a10bfdf]
- Updated dependencies [a10bfdf]
  - @cat-factory/server@0.138.7
  - @cat-factory/kernel@0.147.0
  - @cat-factory/agents@0.66.0
  - @cat-factory/orchestration@0.129.2
  - @cat-factory/caching@0.10.18
  - @cat-factory/consensus@0.11.6
  - @cat-factory/eks@0.1.110
  - @cat-factory/gates@0.7.5
  - @cat-factory/gitlab@0.11.5
  - @cat-factory/integrations@0.88.6
  - @cat-factory/observability-langfuse@0.7.236
  - @cat-factory/observability-otel@0.2.18
  - @cat-factory/provider-bedrock@0.7.255
  - @cat-factory/provider-cloudflare@0.7.256
  - @cat-factory/provider-s3@0.2.186
  - @cat-factory/spend@0.12.62

## 0.107.6

### Patch Changes

- Updated dependencies [7aab031]
  - @cat-factory/orchestration@0.129.1
  - @cat-factory/agents@0.65.5
  - @cat-factory/server@0.138.6
  - @cat-factory/consensus@0.11.5
  - @cat-factory/provider-bedrock@0.7.254
  - @cat-factory/provider-cloudflare@0.7.255

## 0.107.5

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/orchestration@0.129.0
  - @cat-factory/kernel@0.146.0
  - @cat-factory/contracts@0.152.1
  - @cat-factory/server@0.138.5
  - @cat-factory/agents@0.65.4
  - @cat-factory/caching@0.10.17
  - @cat-factory/consensus@0.11.4
  - @cat-factory/eks@0.1.109
  - @cat-factory/gates@0.7.4
  - @cat-factory/gitlab@0.11.4
  - @cat-factory/integrations@0.88.5
  - @cat-factory/observability-langfuse@0.7.235
  - @cat-factory/observability-otel@0.2.17
  - @cat-factory/provider-bedrock@0.7.253
  - @cat-factory/provider-cloudflare@0.7.254
  - @cat-factory/provider-s3@0.2.185
  - @cat-factory/spend@0.12.61
  - @cat-factory/prompt-fragments@0.13.44

## 0.107.4

### Patch Changes

- Updated dependencies [e679977]
  - @cat-factory/contracts@0.152.0
  - @cat-factory/orchestration@0.128.0
  - @cat-factory/agents@0.65.3
  - @cat-factory/consensus@0.11.3
  - @cat-factory/eks@0.1.108
  - @cat-factory/gates@0.7.3
  - @cat-factory/gitlab@0.11.3
  - @cat-factory/integrations@0.88.4
  - @cat-factory/kernel@0.145.1
  - @cat-factory/observability-otel@0.2.16
  - @cat-factory/prompt-fragments@0.13.43
  - @cat-factory/server@0.138.4
  - @cat-factory/spend@0.12.60
  - @cat-factory/provider-bedrock@0.7.252
  - @cat-factory/provider-cloudflare@0.7.253
  - @cat-factory/caching@0.10.16
  - @cat-factory/observability-langfuse@0.7.234
  - @cat-factory/provider-s3@0.2.184

## 0.107.3

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/contracts@0.151.0
  - @cat-factory/kernel@0.145.0
  - @cat-factory/orchestration@0.127.0
  - @cat-factory/agents@0.65.2
  - @cat-factory/consensus@0.11.2
  - @cat-factory/eks@0.1.107
  - @cat-factory/gates@0.7.2
  - @cat-factory/gitlab@0.11.2
  - @cat-factory/integrations@0.88.3
  - @cat-factory/observability-otel@0.2.15
  - @cat-factory/prompt-fragments@0.13.42
  - @cat-factory/server@0.138.3
  - @cat-factory/spend@0.12.59
  - @cat-factory/caching@0.10.15
  - @cat-factory/observability-langfuse@0.7.233
  - @cat-factory/provider-bedrock@0.7.251
  - @cat-factory/provider-cloudflare@0.7.252
  - @cat-factory/provider-s3@0.2.183

## 0.107.2

### Patch Changes

- Updated dependencies [2138e45]
  - @cat-factory/integrations@0.88.2
  - @cat-factory/eks@0.1.106
  - @cat-factory/orchestration@0.126.1
  - @cat-factory/server@0.138.2

## 0.107.1

### Patch Changes

- 54c44bb: feat: add a selectable `purpose` classifier to pipelines (`build` / `document` / `review` / `research` / `planning`)

  Pipelines now carry an explicit use-case classifier instead of it being inferred from their steps. It is chosen in the pipeline builder (a new selector), stamped on every built-in preset in `seedPipelines()`, and persisted in a new `pipelines.purpose` column (mirrored D1 ⇄ Drizzle).

  Two surfaces key off it, sharing the pure predicates in `@cat-factory/contracts` (`pipelineAllowedForTaskType`, `purposeAllowsAgentCategory`):

  - **Task pickers** — a `document` task now offers ONLY document pipelines (the add-task modal, the task run-settings default, and the focus-view run menu), and the add-task form defaults a document task to the `pl_document` writing pipeline. Every other task type is unrestricted.
  - **Builder palette** — selecting a non-`build` purpose hides the Implementation and Testing agent kinds (a document/review/research/planning pipeline writes no product code and runs no tests).

  Every built-in pipeline's `version` is bumped so existing workspaces are offered a reseed that stamps the new `purpose`. Breaking-change note (pre-1.0, no back-fill): a pipeline persisted before this change reads as unclassified — shown everywhere except a document task — until it is reseeded (built-ins) or re-saved with a purpose (custom).

- Updated dependencies [54c44bb]
  - @cat-factory/contracts@0.150.0
  - @cat-factory/kernel@0.144.0
  - @cat-factory/orchestration@0.126.0
  - @cat-factory/server@0.138.1
  - @cat-factory/agents@0.65.1
  - @cat-factory/consensus@0.11.1
  - @cat-factory/eks@0.1.105
  - @cat-factory/gates@0.7.1
  - @cat-factory/gitlab@0.11.1
  - @cat-factory/integrations@0.88.1
  - @cat-factory/observability-otel@0.2.14
  - @cat-factory/prompt-fragments@0.13.41
  - @cat-factory/spend@0.12.58
  - @cat-factory/caching@0.10.14
  - @cat-factory/observability-langfuse@0.7.232
  - @cat-factory/provider-bedrock@0.7.250
  - @cat-factory/provider-cloudflare@0.7.251
  - @cat-factory/provider-s3@0.2.182

## 0.107.0

### Minor Changes

- 0abcf31: Add an authored `description` to pipelines and preview a pipeline's steps + description when
  selecting one.

  Pipelines now carry an optional prose `description` (seeded for every built-in, editable on custom
  pipelines in the builder), persisted alongside the step list on both runtimes (D1 + Postgres). The
  pipeline pickers — in the add-task modal and the inspector run settings — are replaced with a rich
  master–detail picker: hovering an option reveals that pipeline's description and its ordered agent
  steps (with human-gated steps flagged), so you can see exactly what a pipeline does before choosing
  it.

  Every built-in pipeline's catalog `version` is bumped by one so existing workspaces are offered a
  reseed that adopts the new descriptions (fresh workspaces get them on seed).

- 6709dc4: Migrate the last module-global plugin registries to app-owned DI (the registry-DI initiative):
  pipelines, VCS providers, provider tokens, and agent traits now ride the composition root's
  injected instances instead of a process-wide `Map`, removing the `clear*()` test cruft and the
  phantom-`Map` hazard for separately-published adapter packages (e.g. `@cat-factory/gitlab`).

  **Breaking (pre-1.0, no back-compat):** the following free functions are removed in favour of the
  app-owned registry instances a facade injects:

  - **Pipelines** (`@cat-factory/kernel`): `registerPipeline` / `registerPipelines` /
    `registeredPipelines` / `clearRegisteredPipelines` / `mergeRegisteredPipelines` →
    `PipelineRegistry` (`register` / `registerMany` / `registered` / `merge`) + `defaultPipelineRegistry()`.
    `seedPipelines(registry?)` now takes the registry (the no-arg form returns the built-in catalog).
  - **VCS providers** (`@cat-factory/kernel`): `registerVcsProvider` / `getVcsProvider` /
    `resolveVcsProvider` / `requireVcsProvider` / `isVcsProviderRegistered` / `registeredVcsProviders` /
    `clearVcsProviders` → `VcsProviderRegistry` + `defaultVcsRegistry()` (a required `ServerContainer`
    field, so facade parity is type-enforced). `@cat-factory/gitlab`'s `registerGitLab` now takes the
    registry as its first argument.
  - **Provider tokens** (`@cat-factory/kernel`): `wireProvider` / `getProvider` / `isProviderWired` /
    `requireProvider` / `clearProviders` → `ProviderRegistry` + `defaultProviderRegistry()`, read by the
    gate machine's `GateContext` (which gains `isProviderWired`). The `@cat-factory/gates` `wireX` /
    `applyGateProviders` / `warnUnwiredGates` handles take the registry as their first argument;
    `clearGateProviders` is no longer needed by a facade (a fresh registry per build starts empty).
  - **Agent traits** (`@cat-factory/agents`): `registerAgentTrait` / `registerAgentTraits` /
    `registeredAgentTrait` / `clearRegisteredAgentTraits` / `assignAgentTraits` /
    `clearAssignedAgentTraits` are folded onto the app-owned `AgentKindRegistry`
    (`registerTrait` / `registerTraits` / `traitDefinition` / `assignTraits` / `assignedTraitsFor`);
    `traitsFor` / `hasTrait` / `traitGuidanceFor` keep their signatures. `@cat-factory/consensus`'s
    `registerConsensusTraits` now takes the registry as its first argument.

### Patch Changes

- 009bc97: Surface the real cause when a task attachment can't be linked, instead of a bare
  "1 attachment could not be linked".

  - The context-linking path no longer swallows the error: `linkPending` now returns
    each failure with the server's own message, HTTP status, backend code, and the backend
    `details` bag, and the add-task toast shows the specific reason (e.g. a GitHub
    permission/visibility error) with a one-click "Copy details" button that puts a full
    diagnostic report on the clipboard (including the upstream GitHub status, kept distinct
    from the mapped HTTP status).
  - `GitHubDocsProvider` classifies a failed doc read (403 no-access, primary/secondary
    rate-limit, 404/not-found, other) into a specific, actionable domain error carrying the
    repo coordinates + HTTP status, and logs it with full context — so a permission problem
    is no longer masked as an opaque 500 and is diagnosable server-side.
  - `GitHubApiError` now retains the `rateLimited` (`x-ratelimit-remaining: 0`) signal
    structurally, so a GitHub PRIMARY rate-limit (reported as a 403, not a 429) is
    classified as a rate-limit rather than a spurious "missing read access" permission error.
  - Added a reusable `copyAction` toast-action helper on `useCopyToClipboard`.

- Updated dependencies [009bc97]
- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/integrations@0.88.0
  - @cat-factory/server@0.138.0
  - @cat-factory/contracts@0.149.0
  - @cat-factory/kernel@0.143.0
  - @cat-factory/orchestration@0.125.0
  - @cat-factory/agents@0.65.0
  - @cat-factory/gates@0.7.0
  - @cat-factory/gitlab@0.11.0
  - @cat-factory/consensus@0.11.0
  - @cat-factory/eks@0.1.104
  - @cat-factory/observability-otel@0.2.13
  - @cat-factory/prompt-fragments@0.13.40
  - @cat-factory/spend@0.12.57
  - @cat-factory/caching@0.10.13
  - @cat-factory/observability-langfuse@0.7.231
  - @cat-factory/provider-bedrock@0.7.249
  - @cat-factory/provider-cloudflare@0.7.250
  - @cat-factory/provider-s3@0.2.181

## 0.106.11

### Patch Changes

- Updated dependencies [4dbf0fc]
  - @cat-factory/orchestration@0.124.2
  - @cat-factory/server@0.137.10

## 0.106.10

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0
  - @cat-factory/integrations@0.87.0
  - @cat-factory/agents@0.64.2
  - @cat-factory/caching@0.10.12
  - @cat-factory/consensus@0.10.78
  - @cat-factory/eks@0.1.103
  - @cat-factory/gates@0.6.1
  - @cat-factory/gitlab@0.10.22
  - @cat-factory/observability-langfuse@0.7.230
  - @cat-factory/observability-otel@0.2.12
  - @cat-factory/orchestration@0.124.1
  - @cat-factory/provider-bedrock@0.7.248
  - @cat-factory/provider-cloudflare@0.7.249
  - @cat-factory/provider-s3@0.2.180
  - @cat-factory/server@0.137.9
  - @cat-factory/spend@0.12.56

## 0.106.9

### Patch Changes

- f34ddf1: Move the **gate** and **step-resolver** registries onto the app-owned DI seam
  (`docs/initiatives/registry-di-migration.md`), the same pattern as the agent-kind /
  backend registries. The two engine-extension registries the `RunDispatcher` reads are no
  longer module-global `Map`s populated by import side effect.

  - **kernel** now exposes `GateRegistry` / `defaultGateRegistry()` and `StepResolverRegistry`
    / `defaultStepResolverRegistry()` classes. The free functions `registerGate` /
    `registeredGateFactories` / `clearRegisteredGates` and `registerStepResolver` /
    `registeredStepResolverFactories` / `clearRegisteredStepResolvers` are **removed**
    (breaking — pre-1.0, no shim). Registration is now `registry.register(kind, factory)` on
    the app-owned instance the composition root injects.
  - **`@cat-factory/gates`** — `registerBuiltinGates(registry)` now takes the app-owned
    `GateRegistry` and the **module-load side-effect registration is gone** (the
    `registerBuiltinGates()` band-aid the registry-DI initiative called out). A new
    `gateRegistryWithBuiltins()` factory returns a fresh registry pre-loaded with the suite in one
    call — the seam a facade uses (`overrides.gateRegistry ?? gateRegistryWithBuiltins()`) so the
    empty-default hazard is unrepresentable; `registerBuiltinGates` stays for installing into an
    already-held instance.
  - **orchestration** threads `gateRegistry` + `stepResolverRegistry` through
    `CoreDependencies` → `ExecutionService` → `RunDispatcher` (defaulted so existing
    construction sites don't break), re-exposes `gateRegistry` on `Core`, and
    `validateRegistrations` now takes the gate registry to cross-check.
  - The three **facades** build the registries, install the built-in gates, and inject the
    same instance into `createCore` + the boot-time validation — kept symmetric and covered by
    the cross-runtime conformance suite (the custom-gate + step-resolver assertions now inject
    the registries via `makeApp`).

  Provider tokens and the pipeline registry remain module-global (the next slices of the
  initiative). Deployment packages that registered gates/resolvers via the free functions must
  switch to registering by reference on the injected instances (see
  `@cat-factory/example-custom-agent`'s `registerExampleCustomAgents`).

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0
  - @cat-factory/gates@0.6.0
  - @cat-factory/orchestration@0.124.0
  - @cat-factory/agents@0.64.1
  - @cat-factory/caching@0.10.11
  - @cat-factory/consensus@0.10.77
  - @cat-factory/eks@0.1.102
  - @cat-factory/gitlab@0.10.21
  - @cat-factory/integrations@0.86.6
  - @cat-factory/observability-langfuse@0.7.229
  - @cat-factory/observability-otel@0.2.11
  - @cat-factory/provider-bedrock@0.7.247
  - @cat-factory/provider-cloudflare@0.7.248
  - @cat-factory/provider-s3@0.2.179
  - @cat-factory/server@0.137.8
  - @cat-factory/spend@0.12.55

## 0.106.8

### Patch Changes

- Updated dependencies [37c642f]
  - @cat-factory/agents@0.64.0
  - @cat-factory/server@0.137.7
  - @cat-factory/orchestration@0.123.8
  - @cat-factory/consensus@0.10.76
  - @cat-factory/provider-bedrock@0.7.246
  - @cat-factory/provider-cloudflare@0.7.247

## 0.106.7

### Patch Changes

- Updated dependencies [ea64461]
  - @cat-factory/agents@0.63.0
  - @cat-factory/server@0.137.6
  - @cat-factory/consensus@0.10.75
  - @cat-factory/orchestration@0.123.7
  - @cat-factory/provider-bedrock@0.7.245
  - @cat-factory/provider-cloudflare@0.7.246

## 0.106.6

### Patch Changes

- 6ad20d0: Fix the N+1 in linked-context resolution: `AgentContextBuilder` batch-resolves the tracker
  issues a task's description names explicitly via a new `TaskRepository.listByRefs` port
  method (one chunked-`IN` read per source, keyed by `(source, externalId)` refs) instead of a
  `taskRepo.get` point-read per reference inside `Promise.all`. Implemented on both facades (D1
  `D1TaskRepository` ⇄ Drizzle `DrizzleTaskRepository`) with a cross-runtime conformance
  assertion. The `'jira'`/`'github'` source literals are de-hardcoded out of the engine into
  `extractReferences`' typed `taskRefs`, the single place a reference shape binds to a task
  source.

  The new port method is also added to the mothership persistence-RPC allow-list
  (`@cat-factory/server`), since `AgentContextBuilder` invokes `listByRefs` on every
  container-agent dispatch — without the entry a no-Postgres mothership node fails every run
  with `unknown_method`.

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1
  - @cat-factory/integrations@0.86.5
  - @cat-factory/orchestration@0.123.6
  - @cat-factory/server@0.137.5
  - @cat-factory/agents@0.62.13
  - @cat-factory/caching@0.10.10
  - @cat-factory/consensus@0.10.74
  - @cat-factory/eks@0.1.101
  - @cat-factory/gates@0.5.58
  - @cat-factory/gitlab@0.10.20
  - @cat-factory/observability-langfuse@0.7.228
  - @cat-factory/observability-otel@0.2.10
  - @cat-factory/provider-bedrock@0.7.244
  - @cat-factory/provider-cloudflare@0.7.245
  - @cat-factory/provider-s3@0.2.178
  - @cat-factory/spend@0.12.54

## 0.106.5

### Patch Changes

- Updated dependencies [edfd2f8]
- Updated dependencies [d675cc5]
  - @cat-factory/orchestration@0.123.5
  - @cat-factory/server@0.137.4

## 0.106.4

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0
  - @cat-factory/orchestration@0.123.4
  - @cat-factory/contracts@0.148.1
  - @cat-factory/agents@0.62.12
  - @cat-factory/caching@0.10.9
  - @cat-factory/consensus@0.10.73
  - @cat-factory/eks@0.1.100
  - @cat-factory/gates@0.5.57
  - @cat-factory/gitlab@0.10.19
  - @cat-factory/integrations@0.86.4
  - @cat-factory/observability-langfuse@0.7.227
  - @cat-factory/observability-otel@0.2.9
  - @cat-factory/provider-bedrock@0.7.243
  - @cat-factory/provider-cloudflare@0.7.244
  - @cat-factory/provider-s3@0.2.177
  - @cat-factory/server@0.137.3
  - @cat-factory/spend@0.12.53
  - @cat-factory/prompt-fragments@0.13.39

## 0.106.3

### Patch Changes

- efa3345: chore(deps): in-range dependency sweep + transitive upgrade and dedupe

  Update all dependencies within their existing semver ranges across the
  workspace (including the harness packages), run a transitive upgrade and
  `pnpm dedupe`, and re-adopt `@modular-vue/journeys@1.2.0` now that its neutral
  engine (`@modular-frontend/journeys-engine@1.8.0`) is published.

  - The Vercel AI SDK stays on `ai@6` / `@ai-sdk/*@3`: the newest
    `workers-ai-provider` (3.3.1) still peer-requires `ai@^6`, so a v7 bump
    remains blocked (moves within the pinned majors only).
  - `@modular-frontend/core` is pinned to a single `0.3.0` via a pnpm override:
    the 1.8.0 journeys engine hard-depends on `0.3.0` while the sibling
    `@modular-vue/*` bindings still range `^0.2.0`, which otherwise bundles two
    copies and splits the `JourneyRuntime` type. 0.3.0 is a strict superset
    (adds `discard`). Drop the override once the bindings widen their peer range.
  - `@cat-factory/executor-harness` runtime deps (`hono`, `@hono/node-server`)
    moved within range, so the runner-image tag is bumped and the three pins are
    re-synced (image publish/deploy is a maintainer follow-up).

- Updated dependencies [efa3345]
  - @cat-factory/agents@0.62.11
  - @cat-factory/consensus@0.10.72
  - @cat-factory/integrations@0.86.3
  - @cat-factory/kernel@0.139.3
  - @cat-factory/observability-otel@0.2.8
  - @cat-factory/orchestration@0.123.3
  - @cat-factory/provider-bedrock@0.7.242
  - @cat-factory/provider-cloudflare@0.7.243
  - @cat-factory/provider-s3@0.2.176
  - @cat-factory/server@0.137.2
  - @cat-factory/eks@0.1.99
  - @cat-factory/caching@0.10.8
  - @cat-factory/gates@0.5.56
  - @cat-factory/gitlab@0.10.18
  - @cat-factory/observability-langfuse@0.7.226
  - @cat-factory/spend@0.12.52

## 0.106.2

### Patch Changes

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0
  - @cat-factory/orchestration@0.123.2
  - @cat-factory/agents@0.62.10
  - @cat-factory/consensus@0.10.71
  - @cat-factory/eks@0.1.98
  - @cat-factory/gates@0.5.55
  - @cat-factory/gitlab@0.10.17
  - @cat-factory/integrations@0.86.2
  - @cat-factory/kernel@0.139.2
  - @cat-factory/observability-otel@0.2.7
  - @cat-factory/prompt-fragments@0.13.38
  - @cat-factory/server@0.137.1
  - @cat-factory/spend@0.12.51
  - @cat-factory/provider-bedrock@0.7.241
  - @cat-factory/provider-cloudflare@0.7.242
  - @cat-factory/caching@0.10.7
  - @cat-factory/observability-langfuse@0.7.225
  - @cat-factory/provider-s3@0.2.175

## 0.106.1

### Patch Changes

- 7c3d245: Workspace RBAC (slice 7): close the enforcement side doors.

  - **`/me/environment-handlers/:workspaceId`** — this per-user infra-override surface is mounted
    at `/` and previously bypassed the workspace gate entirely (any signed-in user could address any
    workspace id). It now resolves access through the SAME shared `loadWorkspaceAccess` the gate uses
    and requires `runs.execute`: a caller with no access at all gets a 404 (existence stays hidden,
    exactly as the gate hides a board), while a caller who sees the board but lacks the capability
    gets a 403. Authorization runs before the local-only service-availability 503, so the verdict is
    identical on every facade regardless of whether the handler service is wired.
  - **WS event-stream ticket gains `userId`** — the ticket minted at `POST …/events/ticket` now
    carries the minting user for audit. Verification stays membership-blind (the claim is never
    consulted on upgrade); it is provenance only, absent in dev-open.
  - **`public_api_keys.created_by_user_id`** (both runtimes: D1 migration `0054` ⇄ Drizzle column) —
    a minted public-API key records the acting user for audit + UI attribution, surfaced on the wire
    (`PublicApiKey.createdByUserId`) and in the API-tokens panel ("created by …"). Minting is already
    gated under `secrets.manage` (slice 6). A key is a workspace-scoped SERVICE credential that
    intentionally outlives its minter's access — the column is never an authorization input (no FK),
    so revocation stays an explicit admin action.

  The cross-runtime RBAC conformance suite gains assertions for the side-door 404/403 and the
  `created_by_user_id` round-trip on both stores.

- Updated dependencies [7c3d245]
  - @cat-factory/server@0.137.0
  - @cat-factory/contracts@0.147.1
  - @cat-factory/kernel@0.139.1
  - @cat-factory/integrations@0.86.1
  - @cat-factory/agents@0.62.9
  - @cat-factory/consensus@0.10.70
  - @cat-factory/eks@0.1.97
  - @cat-factory/gates@0.5.54
  - @cat-factory/gitlab@0.10.16
  - @cat-factory/observability-otel@0.2.6
  - @cat-factory/orchestration@0.123.1
  - @cat-factory/prompt-fragments@0.13.37
  - @cat-factory/spend@0.12.50
  - @cat-factory/caching@0.10.6
  - @cat-factory/observability-langfuse@0.7.224
  - @cat-factory/provider-bedrock@0.7.240
  - @cat-factory/provider-cloudflare@0.7.241
  - @cat-factory/provider-s3@0.2.174

## 0.106.0

### Minor Changes

- bae59a7: Platform-operator observability: threshold alerting (initiative slice 5). A periodic,
  runtime-symmetric sweep (Worker cron ⇄ Node interval) evaluates each account's aggregate
  run-health projection — the same read the operator dashboard renders, so no new SQL — against
  operator-configured thresholds (failure rate, p99 run duration, live backlog depth) and raises a
  new `platform_health` notification through the existing NotificationChannel seam (in-app + Slack)
  when one is crossed, auto-clearing when the account recovers. The card de-dupes on the firing
  reason set, so a persistently-unhealthy deployment re-notifies only on state change, not every
  sweep. Opt-in via `PLATFORM_ALERTS=true` (thresholds/window/interval tunable via
  `PLATFORM_ALERTS_*`). Adds block-less `NotificationRepository.findOpenByType` (single-workspace
  dedup) and `listOpenByType` (batched across workspaces, so the sweep avoids a point-read per
  workspace) lookups (D1 ⇄ Drizzle + conformance) and threads `platform_health` through the Slack
  transport and the SPA notification inbox (routable/action labels localized in all 10 locales).

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/contracts@0.147.0
  - @cat-factory/kernel@0.139.0
  - @cat-factory/orchestration@0.123.0
  - @cat-factory/integrations@0.86.0
  - @cat-factory/server@0.136.0
  - @cat-factory/agents@0.62.8
  - @cat-factory/consensus@0.10.69
  - @cat-factory/eks@0.1.96
  - @cat-factory/gates@0.5.53
  - @cat-factory/gitlab@0.10.15
  - @cat-factory/observability-otel@0.2.5
  - @cat-factory/prompt-fragments@0.13.36
  - @cat-factory/spend@0.12.49
  - @cat-factory/caching@0.10.5
  - @cat-factory/observability-langfuse@0.7.223
  - @cat-factory/provider-bedrock@0.7.239
  - @cat-factory/provider-cloudflare@0.7.240
  - @cat-factory/provider-s3@0.2.173

## 0.105.1

### Patch Changes

- Updated dependencies [60c0a1e]
- Updated dependencies [f444062]
  - @cat-factory/contracts@0.146.0
  - @cat-factory/orchestration@0.122.0
  - @cat-factory/integrations@0.85.4
  - @cat-factory/server@0.135.0
  - @cat-factory/agents@0.62.7
  - @cat-factory/consensus@0.10.68
  - @cat-factory/eks@0.1.95
  - @cat-factory/gates@0.5.52
  - @cat-factory/gitlab@0.10.14
  - @cat-factory/kernel@0.138.1
  - @cat-factory/observability-otel@0.2.4
  - @cat-factory/prompt-fragments@0.13.35
  - @cat-factory/spend@0.12.48
  - @cat-factory/provider-bedrock@0.7.238
  - @cat-factory/provider-cloudflare@0.7.239
  - @cat-factory/caching@0.10.4
  - @cat-factory/observability-langfuse@0.7.222
  - @cat-factory/provider-s3@0.2.172

## 0.105.0

### Minor Changes

- c47dfe1: Workspace RBAC (slice 5): the member-management API.

  Adds the workspace-membership roster + access-mode management surface that lets an account
  admin restrict a board to an explicit member list. New `WorkspaceMemberService`
  (`@cat-factory/workspaces`) owns `list` / `add` / `setRole` / `remove` + `setAccessMode`,
  built in `createCore` whenever the workspace-member repository is wired (both facades wire it;
  absent ⇒ the controller reports 503). The one rule beyond wire validation is that a member must
  already belong to the board's owning account — a `restricted` board narrows WITHIN an account,
  never grants across it — so scoping an outsider is a `ValidationError` (422).

  Legacy (`account_id IS NULL`) boards are no longer a supported dead end: rather than refusing
  member management, the service AUTO-HEALS the board by adopting it into its owner's account (the
  new `WorkspaceRepository.linkAccount` port, mirrored on D1 and Drizzle), then proceeds — an
  unscoped board is invisible to resolution's account tier, so a roster/restriction on it would
  otherwise be a silent no-op. The adopt target is the owner's SOLE account (on a legacy board the
  owner is the only principal that can reach member management); if that is ambiguous (no owner, or
  the owner belongs to several accounts) the write is a `ValidationError` (422) telling the caller
  to link the board explicitly. The heal also (re)asserts the owner's `admin` member row so a
  follow-up flip to `restricted` can't lock the owner out. `add` now preserves an existing member's
  original grant metadata (`createdAt`/`addedBy`) on a re-add instead of re-stamping it (the upsert
  updates only `role`), and `list` 404s a non-existent board.

  New routes under `/workspaces/:ws` (`@cat-factory/contracts` + `@cat-factory/server`):
  `GET/POST/PATCH/DELETE /members` and `PUT /access-mode`. The roster GET is open to any resolved
  role (`workspace.read`, satisfied by the gate resolution itself); every write requires
  `members.manage`, enforced by the new `requirePermission(c, permission)` helper
  (`http/workspaceAccess.ts`) — it consumes the access the gate published (never re-derives
  membership), allows the dev-open path, and throws `ForbiddenError` (403) on insufficiency.

  Every roster/access-mode write invalidates the board's `workspaceAccess` cache group right after
  it commits (the group-invalidation slice 4 deferred to the member service), so a live grant,
  role change, or access-mode flip is visible on the immediately-following request rather than
  riding the TTL. Cross-runtime conformance asserts the full lifecycle over HTTP — restrict → add
  viewer → promote to member → remove — with live cache coherence on each step, plus the
  `members.manage` 403s and the only-account-members 422, identically on D1 and Postgres.

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/contracts@0.145.0
  - @cat-factory/orchestration@0.121.0
  - @cat-factory/server@0.134.0
  - @cat-factory/kernel@0.138.0
  - @cat-factory/agents@0.62.6
  - @cat-factory/consensus@0.10.67
  - @cat-factory/eks@0.1.94
  - @cat-factory/gates@0.5.51
  - @cat-factory/gitlab@0.10.13
  - @cat-factory/integrations@0.85.3
  - @cat-factory/observability-otel@0.2.3
  - @cat-factory/prompt-fragments@0.13.34
  - @cat-factory/spend@0.12.47
  - @cat-factory/caching@0.10.3
  - @cat-factory/observability-langfuse@0.7.221
  - @cat-factory/provider-bedrock@0.7.237
  - @cat-factory/provider-cloudflare@0.7.238
  - @cat-factory/provider-s3@0.2.171

## 0.104.0

### Minor Changes

- 5924903: Public API: notification inbox (`/api/v1/notifications`).

  The external `/api/v1` surface gains the notification inbox, completing the operational tail
  of the task lifecycle so an external CI/bot can resolve the human-gated ends of a run:

  - `GET /api/v1/notifications` (read) — list the workspace's open notifications.
  - `POST /api/v1/notifications/:id/act` (admin) — run the notification's typed side-effect:
    merge the PR for real (`merge_review` / `pipeline_complete`) or retry the run
    (`ci_failed` / `test_failed`). It requires an `admin`-scoped key because it can perform a
    real GitHub merge. Only these automated-action types are actionable headlessly; a
    notification that parks a run on an interactive human decision has no automated action and
    is refused (`409 notification_not_actionable`) — dismiss it instead. An `act` that would
    retry a run on an individual-usage model is likewise refused
    (`409 individual_model_unsupported`), matching the task retry endpoint (a headless key has
    no personal-credential unlock).
  - `POST /api/v1/notifications/:id/dismiss` (write) — dismiss a card without acting on it.

  Every route is scoped to the key's workspace via the existing per-key scope ladder
  (`read` ⊂ `write` ⊂ `admin`) and delegates to the same `NotificationService` the SPA inbox
  uses — no new persistence or machinery, so it is runtime-symmetric by construction and
  covered by the cross-runtime conformance suite. The merge/retry side-effect is now shared
  between the SPA and public controllers. The OpenAPI spec (`docs/openapi.json`) is regenerated.

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0
  - @cat-factory/server@0.133.0
  - @cat-factory/agents@0.62.5
  - @cat-factory/consensus@0.10.66
  - @cat-factory/eks@0.1.93
  - @cat-factory/gates@0.5.50
  - @cat-factory/gitlab@0.10.12
  - @cat-factory/integrations@0.85.2
  - @cat-factory/kernel@0.137.1
  - @cat-factory/observability-otel@0.2.2
  - @cat-factory/orchestration@0.120.2
  - @cat-factory/prompt-fragments@0.13.33
  - @cat-factory/spend@0.12.46
  - @cat-factory/provider-bedrock@0.7.236
  - @cat-factory/provider-cloudflare@0.7.237
  - @cat-factory/caching@0.10.2
  - @cat-factory/observability-langfuse@0.7.220
  - @cat-factory/provider-s3@0.2.170

## 0.103.1

### Patch Changes

- 74c21ab: feat: repo-sourced Claude Skills — freshness automation (slice 4)

  Keep a running pipeline from ever executing a stale skill, without the management
  surface having to resync by hand (docs/initiatives/repo-skills.md, final slice):

  - **Push-webhook fan-out.** A verified `push` webhook to a repo that skill sources are
    linked to now enqueues a targeted `skill-source-resync` job per affected source, so its
    skills are refreshed shortly after the upstream change. One indexed
    `SkillSourceRepository.listByRepo(owner, name)` lookup (new port method, D1 ⇄ Drizzle
    with a conformance assertion; the `skill_sources(repo_owner, repo_name)` index was
    already in place) drives the fan-out; the enqueue rides the existing GitHub-sync queue
    through a new `GitHubWebhookIngest.queueSkillResync` seam (Cloudflare Queue ⇄ Node
    pg-boss), and the async consumer runs `SkillSourceService.sync` for the one source
    (a source unlinked between enqueue and processing is swallowed, not retried forever).
  - **Dispatch-time self-verifying probe.** At skill-step dispatch, `SkillRunResolver` now
    probes the source dir's head commit; if it advanced since the last sync it re-syncs so
    the run uses current instructions. It never fails the run — any probe/re-sync error
    degrades to the last-synced record (a run may be at most one push behind, never broken),
    and it's a no-op on the common unchanged path (one `latestCommitSha` read).

  Together with the push fan-out this is the layered freshness story: the webhook keeps the
  account catalog warm, and the dispatch probe is the correctness backstop for deployments
  with no sync queue (local/dev) or a missed delivery. Backend-only; no harness/image change.

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0
  - @cat-factory/server@0.132.0
  - @cat-factory/agents@0.62.4
  - @cat-factory/integrations@0.85.1
  - @cat-factory/orchestration@0.120.1
  - @cat-factory/caching@0.10.1
  - @cat-factory/consensus@0.10.65
  - @cat-factory/eks@0.1.92
  - @cat-factory/gates@0.5.49
  - @cat-factory/gitlab@0.10.11
  - @cat-factory/observability-langfuse@0.7.219
  - @cat-factory/observability-otel@0.2.1
  - @cat-factory/provider-bedrock@0.7.235
  - @cat-factory/provider-cloudflare@0.7.236
  - @cat-factory/provider-s3@0.2.169
  - @cat-factory/spend@0.12.45

## 0.103.0

### Minor Changes

- 27f0ea2: Expose the deployment-level (platform-operator) observability aggregates via OpenTelemetry.

  A periodic, runtime-symmetric sweep (Worker `scheduled` cron ⇄ Node interval, like the
  retention sweeps) now pushes the same run-health projection the operator dashboard renders —
  run outcomes by status, the failure-kind taxonomy, live/parked depth, and the avg/min/max +
  p50/p90/p99 duration percentiles — to any OTLP/HTTP backend as OpenTelemetry **gauge**
  metrics (`cat_factory.platform.*`), per account (the bounded tenant scope) and stamped with
  the projection's `generatedAt`. The OTel backend builds trends from the gauge series, so the
  sweep exports the shortest trailing window (`1h` default).

  `@cat-factory/observability-otel` gains a fetch-based `PlatformMetricsOtelExporter`
  (`createPlatformMetricsOtelExporter`) — the workerd-safe transport used on BOTH runtimes
  (the platform push is a stateless snapshot POST, so it needs no SDK, mirroring the Langfuse
  sink's fetch-on-both shape). The runtime-neutral `sweepPlatformMetrics` driver + the
  `distinctAccountIds` account enumeration live in `@cat-factory/orchestration`.

  Opt-in on top of the base OTel exporter (it adds recurring DB rollup load): off unless
  `OTEL_ENABLED=true` + an endpoint AND `OTEL_PLATFORM_METRICS=true`. `OTEL_PLATFORM_METRICS_WINDOW`
  (`1h`/`24h`/`7d`) and, on Node, `OTEL_PLATFORM_METRICS_INTERVAL_MS` tune it. A deployment
  that hasn't opted in emits nothing and runs no sweep.

### Patch Changes

- Updated dependencies [27f0ea2]
  - @cat-factory/observability-otel@0.2.0
  - @cat-factory/orchestration@0.120.0
  - @cat-factory/server@0.131.0

## 0.102.0

### Minor Changes

- f5ddc02: Public API: per-key permission scopes + task deletion.

  Inbound public-API keys now carry a `scope` on the `/api/v1` surface — an inclusive ladder
  (`read` ⊂ `write` ⊂ `admin`) the controller enforces per endpoint: reads need `read`,
  non-destructive mutations (create/start/stop/retry/edit a task, start an initiative run)
  need `write`, and destructive operations need `admin`. A valid key whose scope is too low
  gets `403 insufficient_scope` (distinct from the `401` an unknown key gets).

  This unblocks the first destructive endpoint: `DELETE /api/v1/tasks/:taskId` (admin-scoped)
  deletes a task and its run history, completing the Tier-1 task lifecycle.

  The workspace token UI gains a scope selector on create; a minted key defaults to `write`.

  Breaking (pre-1.0, external surface): `publicApiKeySchema` gains a required `scope` field
  and the `public_api_keys` table gains a `scope` column (D1 ⇄ Drizzle). Existing keys backfill
  to `write` — they keep every capability the surface shipped before scopes existed but do not
  auto-gain the new destructive power, which must be minted `admin` explicitly.

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/contracts@0.143.0
  - @cat-factory/kernel@0.136.0
  - @cat-factory/integrations@0.85.0
  - @cat-factory/server@0.130.0
  - @cat-factory/caching@0.10.0
  - @cat-factory/orchestration@0.119.0
  - @cat-factory/agents@0.62.3
  - @cat-factory/consensus@0.10.64
  - @cat-factory/eks@0.1.91
  - @cat-factory/gates@0.5.48
  - @cat-factory/gitlab@0.10.10
  - @cat-factory/prompt-fragments@0.13.32
  - @cat-factory/spend@0.12.44
  - @cat-factory/observability-langfuse@0.7.218
  - @cat-factory/observability-otel@0.1.12
  - @cat-factory/provider-bedrock@0.7.234
  - @cat-factory/provider-cloudflare@0.7.235
  - @cat-factory/provider-s3@0.2.168

## 0.101.0

### Minor Changes

- 720539f: Add duration percentiles (p50/p90/p99) to the platform-operator dashboard.

  `PlatformMetricsRepository.durationStatsSince` now returns the discrete (nearest-rank)
  p50/p90/p99 wall-clock duration percentiles alongside the existing avg/min/max, computed
  over the same terminal-run set in one aggregate query per dialect — Postgres via
  `percentile_disc`, D1/SQLite via a `row_number()/count()` cumulative-fraction
  order-statistic workaround (SQLite has no percentile aggregate). The cross-runtime
  conformance suite pins that the two dialects agree. The `GET /accounts/:accountId/observability/platform`
  projection carries the new fields, and the operator dashboard's "Run duration" panel
  renders them (internationalized across all locales), so tail-latency outliers the average
  hides are visible.

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0
  - @cat-factory/contracts@0.142.0
  - @cat-factory/orchestration@0.118.0
  - @cat-factory/agents@0.62.2
  - @cat-factory/caching@0.9.5
  - @cat-factory/consensus@0.10.63
  - @cat-factory/eks@0.1.90
  - @cat-factory/gates@0.5.47
  - @cat-factory/gitlab@0.10.9
  - @cat-factory/integrations@0.84.12
  - @cat-factory/observability-langfuse@0.7.217
  - @cat-factory/observability-otel@0.1.11
  - @cat-factory/provider-bedrock@0.7.233
  - @cat-factory/provider-cloudflare@0.7.234
  - @cat-factory/provider-s3@0.2.167
  - @cat-factory/server@0.129.2
  - @cat-factory/spend@0.12.43
  - @cat-factory/prompt-fragments@0.13.31

## 0.100.1

### Patch Changes

- Updated dependencies [e618bf5]
  - @cat-factory/contracts@0.141.0
  - @cat-factory/server@0.129.1
  - @cat-factory/agents@0.62.1
  - @cat-factory/consensus@0.10.62
  - @cat-factory/eks@0.1.89
  - @cat-factory/gates@0.5.46
  - @cat-factory/gitlab@0.10.8
  - @cat-factory/integrations@0.84.11
  - @cat-factory/kernel@0.134.1
  - @cat-factory/orchestration@0.117.1
  - @cat-factory/prompt-fragments@0.13.30
  - @cat-factory/spend@0.12.42
  - @cat-factory/provider-bedrock@0.7.232
  - @cat-factory/provider-cloudflare@0.7.233
  - @cat-factory/caching@0.9.4
  - @cat-factory/observability-langfuse@0.7.216
  - @cat-factory/observability-otel@0.1.10
  - @cat-factory/provider-s3@0.2.166

## 0.100.0

### Minor Changes

- be6e109: Workspace RBAC (slice 3): resolve effective workspace access in the shared auth gate.

  `mountAuthGate` now resolves a signed-in caller's effective workspace role once (via the
  new `loadWorkspaceAccess` helper over the kernel `resolveWorkspaceAccess` decision) and
  publishes it on the request context as `workspaceAccess`. A denied board returns the
  existing 404 shape (existence is never leaked); a resolved-but-insufficient write hits the
  **viewer write floor** — any non-GET method requires at least `member`, with the read-only
  `POST /workspaces/:ws/events/ticket` mint allowlisted — returning `403 forbidden`. The
  account-admin escape hatch and the legacy owner-only board are preserved byte-for-byte.

  `WorkspaceVisibility` is extended (unrestricted account boards, an admin-account escape
  hatch, an explicit-membership branch, and legacy-owned boards) and enforced SQL-side in
  both the D1 and Drizzle `listVisible`; `AccountService.accessibleAccountScopes` derives the
  member/admin account sets from the single existing membership read. `GET /workspaces`
  annotates each board with the caller's effective `viewerRole` via one batched member-row
  read, and the board snapshot (GET + create) carries the resolved `access` (role +
  permissions). `WorkspaceService.create` auto-enrolls the creator as a workspace admin. The
  `workspace_members` repository is now wired into both runtime facades' containers. Cross-
  runtime conformance asserts the 404 invisibility, the viewer floor + ticket allowlist, the
  escape hatch, and list filtering over the real HTTP gate on both D1 and Postgres.

### Patch Changes

- 54e117e: GitLab UI parity (pre-slice): carry a `provider` VCS discriminator on the repo/connection
  projection.

  The GitLab-parity SPA work (provider-aware labels, icons, host/URL shapes) needs a
  `provider: VcsProvider` (`'github' | 'gitlab'`) it can read off the data. This adds that
  field to the `GitHubRepo` / `GitHubConnection` / `GitHubAvailableRepo` wire types and the
  kernel `GitHubInstallation`, and persists it symmetrically on both runtimes' projection
  tables (D1 migration `0051_vcs_provider.sql` + a Drizzle migration + both sets of mappers).
  The tables keep their GitHub names — the entity-rename fold is separate, acknowledged Phase-1
  work.

  `provider` is a per-connection fact: a connection records it (`GitHubInstallationService.connect`
  → `'github'`; local mode's `AutoProvisioningInstallationRepository` → the deployment's provider,
  `'gitlab'` for a GitLab-PAT deployment), and the repos reached through it inherit it (the sync
  service stamps `installation.provider`, the bootstrapper and CLI `linkRepo` stamp their own).
  Rows written before the column default to `'github'`. A cross-runtime conformance suite
  (`defineVcsProviderSuite`) asserts the round-trip on both stores. No SPA behaviour changes yet;
  this unblocks the presentation-switch slices.

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/contracts@0.140.0
  - @cat-factory/kernel@0.134.0
  - @cat-factory/agents@0.62.0
  - @cat-factory/orchestration@0.117.0
  - @cat-factory/server@0.129.0
  - @cat-factory/integrations@0.84.10
  - @cat-factory/consensus@0.10.61
  - @cat-factory/eks@0.1.88
  - @cat-factory/gates@0.5.45
  - @cat-factory/gitlab@0.10.7
  - @cat-factory/prompt-fragments@0.13.29
  - @cat-factory/spend@0.12.41
  - @cat-factory/caching@0.9.3
  - @cat-factory/observability-langfuse@0.7.215
  - @cat-factory/observability-otel@0.1.9
  - @cat-factory/provider-bedrock@0.7.231
  - @cat-factory/provider-cloudflare@0.7.232
  - @cat-factory/provider-s3@0.2.165

## 0.99.0

### Minor Changes

- 6564507: Add platform-operator observability: a deployment-level operator dashboard.

  A new `PlatformMetricsRepository` kernel port exposes SQL rollups over `agent_runs`
  (run outcomes, failure-kind taxonomy, live/parked depth, duration stats, and a
  time-bucketed outcome trend), scoped to an account and implemented on both the D1
  (Cloudflare) and Drizzle (Postgres/Node) stores with cross-runtime conformance. The
  admin-gated `GET /accounts/:accountId/observability/platform` endpoint returns a
  windowed (1h / 24h / 7d) projection, surfaced in the SPA as an operator dashboard
  panel (outcome tiles + success rate, an outcome-trend sparkline, the failure
  breakdown, live depth, and duration stats), reachable from the sidebar by account
  admins. Fully internationalized.

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0
  - @cat-factory/contracts@0.139.0
  - @cat-factory/orchestration@0.116.0
  - @cat-factory/server@0.128.0
  - @cat-factory/agents@0.61.2
  - @cat-factory/caching@0.9.2
  - @cat-factory/consensus@0.10.60
  - @cat-factory/eks@0.1.87
  - @cat-factory/gates@0.5.44
  - @cat-factory/gitlab@0.10.6
  - @cat-factory/integrations@0.84.9
  - @cat-factory/observability-langfuse@0.7.214
  - @cat-factory/observability-otel@0.1.8
  - @cat-factory/provider-bedrock@0.7.230
  - @cat-factory/provider-cloudflare@0.7.231
  - @cat-factory/provider-s3@0.2.164
  - @cat-factory/spend@0.12.40
  - @cat-factory/prompt-fragments@0.13.28

## 0.98.1

### Patch Changes

- b12d7a8: feat(rbac): workspace-RBAC vocabulary + membership persistence (initiative slices 1–2)

  Lay the foundation for workspace-level access control below the account tier — no enforcement
  yet (that is a later slice), just the shared vocabulary and the persistence both facades need.

  - **Contracts**: `workspaceRoleSchema` (`admin | member | viewer`), `workspacePermissionSchema`
    (the seven-permission capability catalog), `workspaceAccessModeSchema` (`account | restricted`),
    and the `WorkspaceMember` wire shape; `workspaceSchema` gains an optional `accessMode`.
  - **Kernel**: `domain/workspace-access.ts` — the static `WORKSPACE_ROLE_PERMISSIONS` map plus the
    pure `resolveWorkspaceAccess` / `workspaceRoleAtLeast` / `permissionsForRole` helpers (with a
    decision-table test); a new `ForbiddenError` (`DomainErrorCode 'forbidden'`, mapped to 403); and
    the `WorkspaceMemberRepository` port (batch-shaped: `getRolesForUserInWorkspaces`,
    `removeByAccountMembership`) plus `WorkspaceRepository.accessRowOf` / `setAccessMode`.
  - **Persistence (both runtimes)**: a new `workspace_members` table + a `workspaces.access_mode`
    column (D1 migration `0052_workspace_rbac.sql` ⇄ Drizzle), the D1 and Drizzle repository impls,
    and a cross-runtime conformance suite asserting the roster CRUD, the batched role annotation, the
    account-membership cascade, and the access-mode round-trip on both stores. The default access
    mode is `account`, so every existing board is unchanged (no data migration).

- Updated dependencies [b12d7a8]
  - @cat-factory/contracts@0.138.0
  - @cat-factory/kernel@0.132.0
  - @cat-factory/server@0.127.1
  - @cat-factory/agents@0.61.1
  - @cat-factory/consensus@0.10.59
  - @cat-factory/eks@0.1.86
  - @cat-factory/gates@0.5.43
  - @cat-factory/gitlab@0.10.5
  - @cat-factory/integrations@0.84.8
  - @cat-factory/orchestration@0.115.1
  - @cat-factory/prompt-fragments@0.13.27
  - @cat-factory/spend@0.12.39
  - @cat-factory/caching@0.9.1
  - @cat-factory/observability-langfuse@0.7.213
  - @cat-factory/observability-otel@0.1.7
  - @cat-factory/provider-bedrock@0.7.229
  - @cat-factory/provider-cloudflare@0.7.230
  - @cat-factory/provider-s3@0.2.163

## 0.98.0

### Minor Changes

- 5b1cbbf: feat: repo-sourced Claude Skills library — data + sync core (slice 1)

  Land the persistence + sync foundation for the repo-sourced Claude Skills
  initiative (docs/initiatives/repo-skills.md):

  - New account-tier tables `skill_sources` + `account_skills` (D1 migration 0052
    ⇄ Drizzle schema + migration), with matching kernel ports
    (`SkillSourceRepository`, `AccountSkillRepository`) and both D1 and Drizzle
    repositories, asserted by a new cross-runtime conformance suite.
  - A shared `repo-source-sync` helper extracted from the fragment library's sync
    mechanics (commit-pin-before-read, id-keyed tombstone sweep, invalidate-only-on-
    change, the status probe) plus a shared frontmatter parser; `FragmentSourceService`
    is refactored onto it, and the new `SkillSourceService` reuses it for the
    directory-per-skill (`<skill>/SKILL.md` + resources) sync unit.
  - `SkillCatalogService` (the account skill-catalog read) backed by a new
    `AppCaches.skillCatalog` cache slice (pass-through on the Worker, like
    `fragmentCatalog`).
  - Contracts + an account-scoped `SkillLibraryController` (list skills; link / list /
    sync / status / unlink sources), wired into all runtime facades. Opt-in behind the
    existing prompt-library flag.

  `RepoContentEntry` gains an optional `size` (populated from the GitHub contents API)
  so the skill resource manifest can record file sizes.

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0
  - @cat-factory/contracts@0.137.0
  - @cat-factory/caching@0.9.0
  - @cat-factory/agents@0.61.0
  - @cat-factory/orchestration@0.115.0
  - @cat-factory/server@0.127.0
  - @cat-factory/consensus@0.10.58
  - @cat-factory/eks@0.1.85
  - @cat-factory/gates@0.5.42
  - @cat-factory/gitlab@0.10.4
  - @cat-factory/integrations@0.84.7
  - @cat-factory/observability-langfuse@0.7.212
  - @cat-factory/observability-otel@0.1.6
  - @cat-factory/provider-bedrock@0.7.228
  - @cat-factory/provider-cloudflare@0.7.229
  - @cat-factory/provider-s3@0.2.162
  - @cat-factory/spend@0.12.38
  - @cat-factory/prompt-fragments@0.13.26

## 0.97.4

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/contracts@0.136.0
  - @cat-factory/kernel@0.130.0
  - @cat-factory/agents@0.60.0
  - @cat-factory/server@0.126.0
  - @cat-factory/orchestration@0.114.0
  - @cat-factory/consensus@0.10.57
  - @cat-factory/eks@0.1.84
  - @cat-factory/gates@0.5.41
  - @cat-factory/gitlab@0.10.3
  - @cat-factory/integrations@0.84.6
  - @cat-factory/prompt-fragments@0.13.25
  - @cat-factory/spend@0.12.37
  - @cat-factory/caching@0.8.8
  - @cat-factory/observability-langfuse@0.7.211
  - @cat-factory/observability-otel@0.1.5
  - @cat-factory/provider-bedrock@0.7.227
  - @cat-factory/provider-cloudflare@0.7.228
  - @cat-factory/provider-s3@0.2.161

## 0.97.3

### Patch Changes

- Updated dependencies [06a094a]
  - @cat-factory/contracts@0.135.0
  - @cat-factory/server@0.125.0
  - @cat-factory/agents@0.59.2
  - @cat-factory/consensus@0.10.56
  - @cat-factory/eks@0.1.83
  - @cat-factory/gates@0.5.40
  - @cat-factory/gitlab@0.10.2
  - @cat-factory/integrations@0.84.5
  - @cat-factory/kernel@0.129.2
  - @cat-factory/orchestration@0.113.2
  - @cat-factory/prompt-fragments@0.13.24
  - @cat-factory/spend@0.12.36
  - @cat-factory/provider-bedrock@0.7.226
  - @cat-factory/provider-cloudflare@0.7.227
  - @cat-factory/caching@0.8.7
  - @cat-factory/observability-langfuse@0.7.210
  - @cat-factory/observability-otel@0.1.4
  - @cat-factory/provider-s3@0.2.160

## 0.97.2

### Patch Changes

- 6dc444e: feat(mothership): expose member-display user reads over the persistence RPC

  A mothership-mode local node delegates org/durable state to the mothership, but the account members
  panel could not enrich its roster with real display details — `userRepository.get`/`listByIds` were
  not remotely callable, so names/emails/avatars came back empty. This allow-lists those two
  member-display reads.

  - A new scope-rule pair **`user`/`userList`** in the persistence RPC (`src/persistence/rpc.ts`).
    A userId is neither an account nor a workspace, so it is bound by CO-MEMBERSHIP: a user's display
    record is readable iff they are a member of one of the machine token's in-scope accounts, resolved
    server-side from the account rosters via a new `resolveAccountMemberIds` dispatch resolver (bounded
    by the token's account scope, not the requested user list — no N+1). A user in no in-scope account
    fails closed (404, no existence leak), like every other entity scope.
  - The shared `PersistenceController` wires `resolveAccountMemberIds` from
    `membershipRepository.listByAccount`, so both facades (Node + Cloudflare mothership) pick it up.

  Safe because the reads carry only the presentational `UserRecord` (id/name/email/avatarUrl/createdAt);
  the password `secret` lives on `UserIdentityRecord`, reachable only via `getIdentity`/`listIdentities`,
  which — with the `update` profile write and `findByIdentity`/`findByEmail` — stay off the machine API
  (the account-lifecycle / login surface). See `docs/initiatives/mothership-mode.md`.

  The `@cat-factory/node-server` patch is a test-only change: its mothership-allowlist drift guard moves
  `userRepository.get`/`listByIds` out of `pending` to reflect the new remote surface.

- Updated dependencies [6dc444e]
  - @cat-factory/server@0.124.0

## 0.97.1

### Patch Changes

- Updated dependencies [bd0a42a]
  - @cat-factory/server@0.123.1

## 0.97.0

### Minor Changes

- 745de02: feat(mothership): real-time upstream publish (the outbound half of PR 2's real-time both directions)

  A mothership-mode local node runs the engine on the laptop but delegates org/durable state to the
  mothership. Until now its engine events (a run advancing, a board change, a notification) never
  reached the mothership's real-time fan-out, so a hosted teammate watching the same shared board
  couldn't see the local node's activity live. This adds the upstream channel.

  - `@cat-factory/server`: a new machine-authed `POST /internal/events/publish` endpoint
    (`eventsRelayController`) + the `MachineEventRelay` seam on `ServerContainer` + the
    `HttpMachineEventClient`. Mounted on both facades; account-scoped and default-deny exactly like
    the persistence RPC (a workspace outside the token's scope is a uniform 404). The verbatim-forwarded
    payload is size-capped (413 above the ceiling) so a compromised node can't inject an unbounded frame.
  - `@cat-factory/node-server`: `LocalMachineEventRelay` delivers a relayed event into the facade's
    own real-time sink (the hub / layered propagator); attached whenever a realtime sink is wired.
  - `@cat-factory/worker`: `DurableObjectMachineEventRelay` delivers a relayed event into the
    per-workspace `WorkspaceEventsHub` Durable Object — the symmetric Cloudflare side.
  - `@cat-factory/local-server`: `MothershipWebSocketPropagator` (a `WebSocketPropagator` adapter,
    reusing the existing cross-node seam) forwards the local node's engine events upstream; it is
    layered over the hub in mothership mode so every event fans to the laptop's own SPA AND the
    mothership.

  Scope: this is the OUTBOUND direction only. The INBOUND subscribe leg (the local node receiving org
  events raised on the mothership / by peer laptops) is a distinct, runtime-shaped follow-up — see
  `docs/initiatives/mothership-mode.md`.

### Patch Changes

- 6108525: perf(db): index `password_reset_tokens.expires_at` so the token-expiry sweep is index-driven instead of a full-table scan (performance initiative item 21). Lands symmetrically on both runtimes — a D1 migration and the mirrored Drizzle `idx_password_reset_tokens_expiry`.
- Updated dependencies [745de02]
- Updated dependencies [6108525]
  - @cat-factory/server@0.123.0
  - @cat-factory/orchestration@0.113.1
  - @cat-factory/kernel@0.129.1
  - @cat-factory/caching@0.8.6
  - @cat-factory/agents@0.59.1
  - @cat-factory/consensus@0.10.55
  - @cat-factory/eks@0.1.82
  - @cat-factory/gates@0.5.39
  - @cat-factory/gitlab@0.10.1
  - @cat-factory/integrations@0.84.4
  - @cat-factory/observability-langfuse@0.7.209
  - @cat-factory/observability-otel@0.1.3
  - @cat-factory/provider-bedrock@0.7.225
  - @cat-factory/provider-cloudflare@0.7.226
  - @cat-factory/provider-s3@0.2.159
  - @cat-factory/spend@0.12.35

## 0.96.1

### Patch Changes

- 6227908: refactor(node): split the monolithic `repositories/drizzle.ts` into per-domain files

  The ~5,000-line `repositories/drizzle.ts` (39 repository classes in one module) is broken
  into per-domain files under `repositories/drizzle/` (`board`, `execution`, `accounts`,
  `telemetry`, `settings`, `reviews`, `kaizen`, `initiatives`, `sandbox`, `connections`, plus
  a shared helper), mirroring the Cloudflare D1 per-repository layout. `drizzle.ts` stays as a
  thin barrel that assembles `CoreRepositories` and re-exports the directly-consumed classes,
  so every importer is unchanged. Pure code movement — no schema or behavioural change.

## 0.96.0

### Minor Changes

- 1b90387: Mothership mode: expose the Slack integration management surface over the persistence RPC.

  Adds a new `accountField` persistence-RPC scope rule (the account-owned mirror of `workspaceField`,
  binding on an `upsert(record)`'s `accountId` field) and allow-lists the Slack settings repositories
  so the connect / route / member-map panels persist in mothership mode:
  `slackConnectionRepository` (`getByAccount`/`upsert`/`softDelete` — the bot token rides a sealed
  `tokenCipher`, so only ciphertext crosses the machine API), `slackSettingsRepository`
  (`getByWorkspace`/`upsert`) and `slackMemberMappingRepository` (`getByAccount`/`upsert`). The Node
  facade routes the three Slack repos through the `pickRepoSource` seam inside `selectNodeSlackDeps`,
  so both the management services and the `SlackNotificationChannel` read the remote-backed repos.
  `slackConnectionRepository.getByTeam` (the global inbound-OAuth teamId lookup) stays
  mothership-internal, and mothership-side Slack delivery for a hosted teammate remains a later
  secrets-delegation slice.

### Patch Changes

- Updated dependencies [1b90387]
  - @cat-factory/server@0.122.0

## 0.95.2

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/agents@0.59.0
  - @cat-factory/kernel@0.129.0
  - @cat-factory/contracts@0.134.0
  - @cat-factory/orchestration@0.113.0
  - @cat-factory/server@0.121.0
  - @cat-factory/gitlab@0.10.0
  - @cat-factory/consensus@0.10.54
  - @cat-factory/provider-bedrock@0.7.224
  - @cat-factory/provider-cloudflare@0.7.225
  - @cat-factory/caching@0.8.5
  - @cat-factory/eks@0.1.81
  - @cat-factory/gates@0.5.38
  - @cat-factory/integrations@0.84.3
  - @cat-factory/observability-langfuse@0.7.208
  - @cat-factory/observability-otel@0.1.2
  - @cat-factory/provider-s3@0.2.158
  - @cat-factory/spend@0.12.34
  - @cat-factory/prompt-fragments@0.13.23

## 0.95.1

### Patch Changes

- Updated dependencies [9e9127f]
  - @cat-factory/contracts@0.133.0
  - @cat-factory/orchestration@0.112.0
  - @cat-factory/server@0.120.0
  - @cat-factory/agents@0.58.1
  - @cat-factory/consensus@0.10.53
  - @cat-factory/eks@0.1.80
  - @cat-factory/gates@0.5.37
  - @cat-factory/gitlab@0.9.1
  - @cat-factory/integrations@0.84.2
  - @cat-factory/kernel@0.128.1
  - @cat-factory/prompt-fragments@0.13.22
  - @cat-factory/spend@0.12.33
  - @cat-factory/provider-bedrock@0.7.223
  - @cat-factory/provider-cloudflare@0.7.224
  - @cat-factory/caching@0.8.4
  - @cat-factory/observability-langfuse@0.7.207
  - @cat-factory/observability-otel@0.1.1
  - @cat-factory/provider-s3@0.2.157

## 0.95.0

### Minor Changes

- d68e3a8: Add opt-in OpenTelemetry (OTLP) observability. A new `@cat-factory/observability-otel`
  package implements the kernel `LlmTraceSink` port and exports LLM generations (+ container
  tool spans) and metrics to any OTLP/HTTP backend — a workerd-safe fetch exporter on the
  Cloudflare Worker facade and the official `@opentelemetry/*` SDK exporter on Node, kept
  conformant by a shared mapping layer + a conformity test.

  - **kernel:** new `CompositeTraceSink` + `composeTraceSinks` so multiple external trace
    destinations (Langfuse and/or OTLP) fan out through the single sink slot.
  - **server:** new `OtelConfig` on `AppConfig`.
  - **worker / node-server:** wire the OTLP exporter (fetch on the Worker, SDK on Node)
    everywhere the Langfuse sink is wired, composed alongside Langfuse. Enabled with
    `OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT` (`OTEL_EXPORTER_OTLP_HEADERS` /
    `OTEL_SERVICE_NAME` optional).
  - **cli:** advertise the `OTEL_*` vars in the generated `.env`.

  Refinements: the Node facade shares ONE trace-sink instance across the core, the container
  executor and the inline model-provider (so the SDK exporter's batch processors/timers aren't
  duplicated) and flushes + shuts it down on graceful shutdown (via `LlmTraceSink.shutdown` /
  `CompositeTraceSink` fan-out) so the final batch isn't dropped. Metric data points carry only
  the low-cardinality `gen_ai.*` dimensions — the unbounded workspace id stays on spans, off
  metrics — to keep metric-backend cardinality bounded.

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/observability-otel@0.1.0
  - @cat-factory/kernel@0.128.0
  - @cat-factory/server@0.119.0
  - @cat-factory/contracts@0.132.0
  - @cat-factory/agents@0.58.0
  - @cat-factory/orchestration@0.111.0
  - @cat-factory/gitlab@0.9.0
  - @cat-factory/caching@0.8.3
  - @cat-factory/consensus@0.10.52
  - @cat-factory/eks@0.1.79
  - @cat-factory/gates@0.5.36
  - @cat-factory/integrations@0.84.1
  - @cat-factory/observability-langfuse@0.7.206
  - @cat-factory/provider-bedrock@0.7.222
  - @cat-factory/provider-cloudflare@0.7.223
  - @cat-factory/provider-s3@0.2.156
  - @cat-factory/spend@0.12.32
  - @cat-factory/prompt-fragments@0.13.21

## 0.94.8

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/contracts@0.131.0
  - @cat-factory/kernel@0.127.0
  - @cat-factory/agents@0.57.0
  - @cat-factory/orchestration@0.110.0
  - @cat-factory/integrations@0.84.0
  - @cat-factory/server@0.118.0
  - @cat-factory/consensus@0.10.51
  - @cat-factory/eks@0.1.78
  - @cat-factory/gates@0.5.35
  - @cat-factory/gitlab@0.8.1
  - @cat-factory/prompt-fragments@0.13.20
  - @cat-factory/spend@0.12.31
  - @cat-factory/caching@0.8.2
  - @cat-factory/observability-langfuse@0.7.205
  - @cat-factory/provider-bedrock@0.7.221
  - @cat-factory/provider-cloudflare@0.7.222
  - @cat-factory/provider-s3@0.2.155

## 0.94.7

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/contracts@0.130.0
  - @cat-factory/kernel@0.126.0
  - @cat-factory/agents@0.56.0
  - @cat-factory/orchestration@0.109.0
  - @cat-factory/server@0.117.0
  - @cat-factory/gitlab@0.8.0
  - @cat-factory/consensus@0.10.50
  - @cat-factory/eks@0.1.77
  - @cat-factory/gates@0.5.34
  - @cat-factory/integrations@0.83.3
  - @cat-factory/prompt-fragments@0.13.19
  - @cat-factory/spend@0.12.30
  - @cat-factory/caching@0.8.1
  - @cat-factory/observability-langfuse@0.7.204
  - @cat-factory/provider-bedrock@0.7.220
  - @cat-factory/provider-cloudflare@0.7.221
  - @cat-factory/provider-s3@0.2.154

## 0.94.6

### Patch Changes

- Updated dependencies [d38d6c2]
  - @cat-factory/integrations@0.83.2
  - @cat-factory/eks@0.1.76
  - @cat-factory/orchestration@0.108.1
  - @cat-factory/server@0.116.1

## 0.94.5

### Patch Changes

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/contracts@0.129.0
  - @cat-factory/kernel@0.125.0
  - @cat-factory/agents@0.55.0
  - @cat-factory/orchestration@0.108.0
  - @cat-factory/server@0.116.0
  - @cat-factory/caching@0.8.0
  - @cat-factory/integrations@0.83.1
  - @cat-factory/consensus@0.10.49
  - @cat-factory/eks@0.1.75
  - @cat-factory/gates@0.5.33
  - @cat-factory/gitlab@0.7.71
  - @cat-factory/prompt-fragments@0.13.18
  - @cat-factory/spend@0.12.29
  - @cat-factory/observability-langfuse@0.7.203
  - @cat-factory/provider-bedrock@0.7.219
  - @cat-factory/provider-cloudflare@0.7.220
  - @cat-factory/provider-s3@0.2.153

## 0.94.4

### Patch Changes

- 806811c: Node/local boot de-serialization (app-startup initiative, items 2/5/6). The Node facade brings up its five pg-boss consumers (execution / bootstrap / env-config-repair / env-test / github-sync) as one `Promise.all` wave instead of awaiting them serially — each is an independent queue with no ordering dependency, so this collapses ~10 back-to-back DB round trips on the boot path to ~2 (kept after `boss.start()` and before listen, invariant unchanged). The best-effort Redis reachability probe (`warnIfRedisUnreachable`) and local mode's GitHub PAT probe are now fire-and-forget (`warnIfRedisUnreachableInBackground` / `warnOnGitHubPatProblemInBackground`) rather than awaited, so a set-but-down Redis bus no longer stalls boot for ~3.5s and a slow github.com round-trip no longer precedes `start()`. Both probes still log their single warning if/when they resolve; the local runtime `--version` preflight stays awaited (it gates limited mode).

## 0.94.3

### Patch Changes

- Updated dependencies [3f3031a]
  - @cat-factory/orchestration@0.107.10
  - @cat-factory/server@0.115.1

## 0.94.2

### Patch Changes

- Updated dependencies [ca9ea20]
  - @cat-factory/integrations@0.83.0
  - @cat-factory/server@0.115.0
  - @cat-factory/eks@0.1.74
  - @cat-factory/orchestration@0.107.9

## 0.94.1

### Patch Changes

- e5cd022: Speed up the "add service from an existing repo" picker's typeahead, which stalled for
  ~17s per keystroke when a broad personal access token (PAT) backed the results.

  The personal-repo branch re-walked the viewer's entire `GET /user/repos` set — up to ten
  sequential GitHub pages — on every keystroke and only applied the query as an in-memory
  filter afterwards, with nothing cached. Three changes:

  - **Cache the enumeration.** New `AppCaches.viewerRepos` slice (grouped/keyed by user id):
    the picker's typeahead now filters a cached complete set in memory instead of forcing a
    fresh full walk per keystroke. Invalidated when the user's stored `github_pat` changes;
    a short (60s) TTL backstops repos created straight on GitHub. Pass-through on the Worker's
    isolate-safe profile (external state, not self-verifying), so it caches on Node/local
    where the PAT picker is the primary flow.
  - **Parallelize the cold walk.** `FetchGitHubClient.listReposForToken` reads page 1, learns
    the page count from its `Link: rel="last"` header, and fetches the remaining pages
    concurrently — turning ~10 serial round-trips into ~2.
  - The blank browse-all path (and its fail-closed access-projection refresh) is unchanged and
    stays uncached.

  No repos are dropped: a literal GitHub `/search/repositories` call was deliberately avoided
  because it can't reproduce the enumeration's `owner,collaborator,organization_member`
  affiliation scope and would bury a low-star private repo in global results.

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0
  - @cat-factory/caching@0.7.0
  - @cat-factory/integrations@0.82.0
  - @cat-factory/server@0.114.0
  - @cat-factory/orchestration@0.107.8
  - @cat-factory/agents@0.54.12
  - @cat-factory/consensus@0.10.48
  - @cat-factory/eks@0.1.73
  - @cat-factory/gates@0.5.32
  - @cat-factory/gitlab@0.7.70
  - @cat-factory/observability-langfuse@0.7.202
  - @cat-factory/provider-bedrock@0.7.218
  - @cat-factory/provider-cloudflare@0.7.219
  - @cat-factory/provider-s3@0.2.152
  - @cat-factory/spend@0.12.28

## 0.94.0

### Minor Changes

- c28f89e: Add boot-phase timers to the backend startup path (app-startup initiative, item 1). `bootServer`
  now brackets each phase (config, migrate, pg-boss start, container build, bus, worker registration,
  listen) with `performance.now()` and logs one structured `cat-factory node server ready in N ms`
  line with the per-phase breakdown; local mode times its own preflights (container-runtime probe,
  GitHub PAT probe) the same way. New `startBootClock` helper is exported from `@cat-factory/node-server`.
  Pure instrumentation — no behavioural change.

## 0.93.9

### Patch Changes

- 6c4bcef: fix(infra-setup): stop the false "test environment not configured" nag in local mode, and make the remaining nag actionable

  Local mode on a Docker-family runtime stands the Tester's dependencies up with the
  zero-config in-container `local-compose` backend, so a missing ephemeral-environment
  _provider_ connection is not actually a setup gap there. The infra-setup projection
  now gates the `ephemeralEnvironments` area on a new
  `ephemeralEnvironmentsRequireProvider` container flag (derived from the deployment's
  test-env capability via `testEnvHasZeroConfigDefault`) — exactly like
  `agentExecutorRequiresRunnerPool` gates the executor area — so the banner stays quiet
  where docker-compose already works and only fires where a provider is genuinely
  mandatory (the Worker, stock Node, and local Apple `container`).

  Where the nag still applies, its copy now tells the user what to do: open Test
  environments and connect a Kubernetes cluster or a custom HTTP environment provider.

- Updated dependencies [6c4bcef]
- Updated dependencies [6c4bcef]
  - @cat-factory/contracts@0.128.2
  - @cat-factory/kernel@0.123.3
  - @cat-factory/integrations@0.81.20
  - @cat-factory/server@0.113.9
  - @cat-factory/agents@0.54.11
  - @cat-factory/consensus@0.10.47
  - @cat-factory/eks@0.1.72
  - @cat-factory/gates@0.5.31
  - @cat-factory/gitlab@0.7.69
  - @cat-factory/orchestration@0.107.7
  - @cat-factory/prompt-fragments@0.13.17
  - @cat-factory/spend@0.12.27
  - @cat-factory/caching@0.6.46
  - @cat-factory/observability-langfuse@0.7.201
  - @cat-factory/provider-bedrock@0.7.217
  - @cat-factory/provider-cloudflare@0.7.218
  - @cat-factory/provider-s3@0.2.151

## 0.93.8

### Patch Changes

- Updated dependencies [b34ab46]
  - @cat-factory/server@0.113.8
  - @cat-factory/orchestration@0.107.6

## 0.93.7

### Patch Changes

- Updated dependencies [90a7fb3]
  - @cat-factory/integrations@0.81.19
  - @cat-factory/server@0.113.7
  - @cat-factory/eks@0.1.71
  - @cat-factory/orchestration@0.107.5

## 0.93.6

### Patch Changes

- Updated dependencies [c1028cc]
  - @cat-factory/orchestration@0.107.4
  - @cat-factory/server@0.113.6

## 0.93.5

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2
  - @cat-factory/contracts@0.128.1
  - @cat-factory/agents@0.54.10
  - @cat-factory/caching@0.6.45
  - @cat-factory/consensus@0.10.46
  - @cat-factory/eks@0.1.70
  - @cat-factory/gates@0.5.30
  - @cat-factory/gitlab@0.7.68
  - @cat-factory/integrations@0.81.18
  - @cat-factory/observability-langfuse@0.7.200
  - @cat-factory/orchestration@0.107.3
  - @cat-factory/provider-bedrock@0.7.216
  - @cat-factory/provider-cloudflare@0.7.217
  - @cat-factory/provider-s3@0.2.150
  - @cat-factory/server@0.113.5
  - @cat-factory/spend@0.12.26
  - @cat-factory/prompt-fragments@0.13.16

## 0.93.4

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/orchestration@0.107.2
  - @cat-factory/kernel@0.123.1
  - @cat-factory/server@0.113.4
  - @cat-factory/agents@0.54.9
  - @cat-factory/caching@0.6.44
  - @cat-factory/consensus@0.10.45
  - @cat-factory/eks@0.1.69
  - @cat-factory/gates@0.5.29
  - @cat-factory/gitlab@0.7.67
  - @cat-factory/integrations@0.81.17
  - @cat-factory/observability-langfuse@0.7.199
  - @cat-factory/provider-bedrock@0.7.215
  - @cat-factory/provider-cloudflare@0.7.216
  - @cat-factory/provider-s3@0.2.149
  - @cat-factory/spend@0.12.25

## 0.93.3

### Patch Changes

- 85bf0ef: Warn when a numeric env knob is set to a non-numeric value (error-message initiative A8).

  Numeric knobs are read as `num(env.SOME_VAR) ?? default`. A garbage value (`JOB_MAX_POLLS=abc`,
  a stray unit like `30s`, a trailing comma) used to coerce silently to `undefined`, so the
  caller's `?? default` swallowed the typo with no signal — the operator saw the built-in default
  in effect and no clue their override was ignored.

  - New shared `parseNumericEnv(name, value)` in `@cat-factory/server` emits ONE structured
    warning (var name, rejected value, docs link) when a PRESENT value is not a finite number,
    before falling back to the default. An unset/blank var stays silent (the default is the
    intended behaviour there), and a valid value is unchanged.
  - Both facades' local `num()` helpers (Node `config.ts` + `execution/config.ts`, Worker
    `infrastructure/config/utils.ts` — the Worker's `retentionMs` too) now delegate to it, so the
    warning reads identically across runtimes. The message lives in one shared place per the
    "keep the runtimes symmetric" rule.
  - The two knobs read at every model-config site (`AGENT_DEFAULT_TEMPERATURE`,
    `AGENT_MAX_OUTPUT_TOKENS`) are now parsed ONCE per facade and reused, so a single garbage value
    emits one warning rather than one per read site.
  - Node's retention days now go through a local `retentionMs` helper mirroring the Worker's,
    including the `days >= 0` clamp — a negative override falls back to the default on both facades
    instead of yielding a negative window on Node only.

- Updated dependencies [85bf0ef]
  - @cat-factory/server@0.113.3

## 0.93.2

### Patch Changes

- Updated dependencies [17c6808]
  - @cat-factory/server@0.113.2

## 0.93.1

### Patch Changes

- Updated dependencies [e4c5abe]
- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0
  - @cat-factory/orchestration@0.107.1
  - @cat-factory/server@0.113.1
  - @cat-factory/integrations@0.81.16
  - @cat-factory/agents@0.54.8
  - @cat-factory/caching@0.6.43
  - @cat-factory/consensus@0.10.44
  - @cat-factory/eks@0.1.68
  - @cat-factory/gates@0.5.28
  - @cat-factory/gitlab@0.7.66
  - @cat-factory/observability-langfuse@0.7.198
  - @cat-factory/provider-bedrock@0.7.214
  - @cat-factory/provider-cloudflare@0.7.215
  - @cat-factory/provider-s3@0.2.148
  - @cat-factory/spend@0.12.24

## 0.93.0

### Minor Changes

- 1e684b7: Add a "Test environment creation" diagnostic to the service inspector. A developer can now
  run the whole ephemeral-environment lifecycle against a throwaway branch — create branch →
  provision → tear down → delete branch — and see the live stage plus the final success/failure
  (and the stage it failed at), with guaranteed cleanup even on error.

  Modelled as a durable, observable run (its own `environment_test_runs` table on both facades)
  driven by a Cloudflare Workflow on the Worker and pg-boss on Node, with live `envTest` events
  pushed to the SPA. Adds the `RepoFiles.deleteBranch` port method (implemented once in the shared
  server layer) so the throwaway branch is reclaimed through the existing checkout-free seam.

  The always-cleans-up contract is enforced on every path: the branch is persisted before
  dispatch (a dispatch failure can't orphan it), a failed deploy view releases the runner and
  finalizes so cleanup tears down partial infra, a stop mid-provision aborts the in-flight
  deploy job, and the run's synthetic environment-registry row is always reclaimed. The
  provisioning config is pinned on the run record at dispatch, terminal writes are guarded
  (`updateIfRunning`, first-writer-wins vs the stop button), and both runtimes gain an env-test
  stale-run sweep plus self-finalization on poll-budget exhaustion so a run whose driver dies
  can never show `running` forever. The SPA store reconciles snapshots and live events by
  `updatedAt` so a stale refresh can't regress or drop a run's state.

  Schema change (no backwards-compatible migration, per project policy): a new
  `environment_test_runs` table is added to both the D1 (`0050_environment_test_runs.sql`) and
  Postgres/Drizzle schemas.

- 1e684b7: Mothership-mode GitHub support + remote persistence for environment self-test runs.

  **GitHub token delegation.** The mothership now serves a machine-authed
  `POST /internal/github/installation-token` (mounted on both facades, like the persistence
  RPC): a mothership-mode local node presents its machine token and an installation id, the
  call is rate-limited per node (fixed window on the token's signed `nodeId`) and
  account-scoped off the installation's own account binding (live row + `accountId` in the
  token scope, uniform 404 otherwise), and the mothership's GitHub App mints a short-lived
  installation token **repo-scoped via `repository_ids`** to the live App-linked
  `github_repos` projection for that installation (`user_pat`-linked rows excluded; no
  linked repos ⇒ 404) — never an installation-wide token, and never served from or written
  into the engine's unscoped token cache. Every mint/denial/failure is audit-logged with
  the node + user ids (the new kernel port method backing the scoping read is
  `RepoProjectionRepository.listByInstallation`, mirrored D1 ⇄ Drizzle). A mothership-mode
  local node with no `GITHUB_PAT` now consumes these tokens through the new
  `DelegatedAppTokenSource` — wiring the push/clone token mint AND a full `FetchGitHubClient`
  (gates, merge, repo-link, `resolveRunRepoContext`/RepoFiles) off the org's GitHub App, with
  the App private key never leaving the mothership. An explicitly configured PAT still wins;
  `GITHUB_PAT` is now optional in mothership mode.

  **Environment self-test remote persistence.** The `environment_test_runs` store is now on
  the mothership persistence allow-list (`get`/`update`/`listRunningByWorkspace` workspace-
  scoped, record-based `insert` bound on the run's `workspaceId` field), so a mothership-mode
  node persists and lists its self-test runs remotely instead of failing with
  `unknown_method`. Its former blocker — the self-test's GitHub branch create/delete — is
  served by the delegation endpoint above. A FULL mothership-mode self-test still waits on
  the provisioning writes (`environmentRegistryRepository.insert`/`update`, the
  secrets-delegation slice); until then the run fails cleanly at the provisioning stage with
  cleanup.

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/contracts@0.128.0
  - @cat-factory/kernel@0.122.0
  - @cat-factory/orchestration@0.107.0
  - @cat-factory/integrations@0.81.15
  - @cat-factory/server@0.113.0
  - @cat-factory/agents@0.54.7
  - @cat-factory/consensus@0.10.43
  - @cat-factory/eks@0.1.67
  - @cat-factory/gates@0.5.27
  - @cat-factory/gitlab@0.7.65
  - @cat-factory/prompt-fragments@0.13.15
  - @cat-factory/spend@0.12.23
  - @cat-factory/caching@0.6.42
  - @cat-factory/observability-langfuse@0.7.197
  - @cat-factory/provider-bedrock@0.7.213
  - @cat-factory/provider-cloudflare@0.7.214
  - @cat-factory/provider-s3@0.2.147

## 0.92.21

### Patch Changes

- 5a3fe5d: Elaborate the two `REDIS_URL` failure modes (error-message initiative A7).

  - **`ioredis` missing** (REDIS_URL set, optional dep not installed): both Node Redis consumers
    (real-time cross-node propagation and distributed cache invalidation) now throw the shared
    `missingIoredisProblem` — a `ConfigValidationError` naming `REDIS_URL`, the install-or-unset
    remedy, and the docs — instead of a bare `Error` deep in boot, so it lands on the misconfigured
    fallback screen. A `REDIS_URL` entry is added to the server `ENV_HELP` registry.
  - **Bus unreachable** (REDIS_URL set, Redis down): a best-effort, timeout-bounded boot probe
    (`warnIfRedisUnreachable`, mirroring local mode's `probeGitHubPat`) now logs ONE elaborate,
    credential-free warning naming the host, the silent degradation, how to verify
    (`redis-cli -u <REDIS_URL> ping`), and the docs — instead of ioredis retrying silently while
    cross-node realtime and cache coherence are quietly degraded. Never blocks or crashes boot.

- 2a13ece: Route `AccountSettingsService.resolve` through the app cache seam (performance initiative item 8).
  The service's legacy homebrew 30s `{ value, expiresAt }` `Map` — the anti-pattern CLAUDE.md names
  explicitly — is replaced by a new `accountSettings` `AppCaches` slice (grouped and keyed by account
  id, holding the decrypted `ResolvedAccountSettings`). `resolve` now reads through it and `write`
  invalidates the account's entry after the upsert commits, so an integration-credential change is
  coherent across replicas (the invalidation bus carries only keys, never the decrypted secrets, so
  plaintext still never leaves the process). `ResolvedAccountSettings` moved to the kernel
  account-settings port (the caching port now names it) and is re-exported from
  `@cat-factory/integrations`, so its consumers are unchanged. Pass-through on the Worker's
  isolate-safe profile (our own mutable D1 state, no cross-isolate bus); both facades wire the slice.
- Updated dependencies [5a3fe5d]
- Updated dependencies [2a13ece]
  - @cat-factory/server@0.112.10
  - @cat-factory/kernel@0.121.8
  - @cat-factory/caching@0.6.41
  - @cat-factory/integrations@0.81.14
  - @cat-factory/agents@0.54.6
  - @cat-factory/consensus@0.10.42
  - @cat-factory/eks@0.1.66
  - @cat-factory/gates@0.5.26
  - @cat-factory/gitlab@0.7.64
  - @cat-factory/observability-langfuse@0.7.196
  - @cat-factory/orchestration@0.106.8
  - @cat-factory/provider-bedrock@0.7.212
  - @cat-factory/provider-cloudflare@0.7.213
  - @cat-factory/provider-s3@0.2.146
  - @cat-factory/spend@0.12.22

## 0.92.20

### Patch Changes

- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7
  - @cat-factory/orchestration@0.106.7
  - @cat-factory/server@0.112.9
  - @cat-factory/integrations@0.81.13
  - @cat-factory/agents@0.54.5
  - @cat-factory/caching@0.6.40
  - @cat-factory/consensus@0.10.41
  - @cat-factory/eks@0.1.65
  - @cat-factory/gates@0.5.25
  - @cat-factory/gitlab@0.7.63
  - @cat-factory/observability-langfuse@0.7.195
  - @cat-factory/provider-bedrock@0.7.211
  - @cat-factory/provider-cloudflare@0.7.212
  - @cat-factory/provider-s3@0.2.145
  - @cat-factory/spend@0.12.21

## 0.92.19

### Patch Changes

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6
  - @cat-factory/caching@0.6.39
  - @cat-factory/spend@0.12.20
  - @cat-factory/orchestration@0.106.6
  - @cat-factory/server@0.112.8
  - @cat-factory/agents@0.54.4
  - @cat-factory/consensus@0.10.40
  - @cat-factory/eks@0.1.64
  - @cat-factory/gates@0.5.24
  - @cat-factory/gitlab@0.7.62
  - @cat-factory/integrations@0.81.12
  - @cat-factory/observability-langfuse@0.7.194
  - @cat-factory/provider-bedrock@0.7.210
  - @cat-factory/provider-cloudflare@0.7.211
  - @cat-factory/provider-s3@0.2.144

## 0.92.18

### Patch Changes

- f8f1aa8: Update workspace dependencies (direct + transitive) to the newest versions published before the
  `minimumReleaseAge` supply-chain cutoff. No source changes — dependency ranges + the lockfile only.

  - Refreshed direct deps to their newest cooldown-compliant releases: `wrangler` 4.110.0, `hono`
    4.12.29, `vitest` / `@vitest/coverage-v8` 4.1.10, `oxlint` 1.73.0, `knip` 6.26.0, `msw` 2.15.0,
    `pg-boss` 12.26.0, `sherif` 1.13.0, `turbo` 2.10.4, `vue-tsc` 3.3.7, `@types/node` 26.1.1,
    `@nuxtjs/i18n` 10.4.1, `@aws-sdk/client-s3` 3.1085.0.
  - `typescript` moved off the `7.0.1-rc` prerelease to the stable `7.0.2` release across every
    package that used the RC (the TS-6 world — the frontend layer and the two runner harnesses —
    stays on `^6.0.3`).
  - Vercel AI SDK family held to the `ai@6`-compatible majors that `workers-ai-provider@3.3.1` peers
    require (`ai` 6.0.224, `@ai-sdk/anthropic|openai|provider` on 3.x, `@ai-sdk/openai-compatible` on
    2.x, `@ai-sdk/amazon-bedrock` 4.x) — no v7/v5 major bumps.
  - Coding (`executor-harness`) and deploy runner harnesses updated too, including the pinned
    in-container coding-agent CLIs (Pi 0.80.6, Claude Code 2.1.207, Codex 0.144.1; the Pi todo /
    web-tools extensions stay at their lockstep 1.20.0). Their image tags and the three
    hand-maintained pins were bumped in lockstep, so the runner images must be re-published +
    deployed for the new tags to roll out.

- Updated dependencies [f8f1aa8]
  - @cat-factory/agents@0.54.3
  - @cat-factory/caching@0.6.38
  - @cat-factory/consensus@0.10.39
  - @cat-factory/contracts@0.127.1
  - @cat-factory/eks@0.1.63
  - @cat-factory/gates@0.5.23
  - @cat-factory/gitlab@0.7.61
  - @cat-factory/integrations@0.81.11
  - @cat-factory/kernel@0.121.5
  - @cat-factory/observability-langfuse@0.7.193
  - @cat-factory/orchestration@0.106.5
  - @cat-factory/prompt-fragments@0.13.14
  - @cat-factory/provider-bedrock@0.7.209
  - @cat-factory/provider-cloudflare@0.7.210
  - @cat-factory/provider-s3@0.2.143
  - @cat-factory/server@0.112.7
  - @cat-factory/spend@0.12.19

## 0.92.17

### Patch Changes

- 5dd16d3: Elaborate two boot-time connectivity failures with actionable remedies (error-message coverage
  A11/A12):

  - **A11 (Node):** a loopback Postgres connection that's refused or reset at boot now reports the
    fix on the misconfigured screen — including the Windows/Docker-Desktop `localhost`→IPv6 `::1`
    footgun and the `127.0.0.1` workaround — instead of dying with a raw `ECONNRESET`. A non-loopback
    (remote) database being briefly unreachable is deliberately left to crash-and-retry.
  - **A12 (Local):** a set-but-invalid `GITHUB_PAT` is validated once at boot (a best-effort
    `GET /user`) and, when it's expired/revoked/under-scoped, warned about with the same pre-scoped
    token-creation link the missing-PAT warning already uses — instead of failing opaquely on the
    first clone/push/PR later.

## 0.92.16

### Patch Changes

- e68c958: feat(errors): UI-first remedies for runner-backend / runner-pool / Datadog failures (D2/D3/D4)

  Continues the error-message-coverage initiative through Section D — runtime provider failures now
  name their fix (the UI location first) and link the relevant docs, instead of surfacing a terse,
  opaque condition.

  - **D3 — `No runner backend available for workspace 'X'`** (both the Node and Cloudflare transport
    resolvers) now throws a `ConflictError` carrying the machine `reason` `agent_backend_unconfigured`
    instead of a plain `Error`. Synchronously it is a clean 409; on the async dispatch path
    `classifyDispatchFailure` lifts the reason onto the run's `AgentFailure`, so the SPA renders the
    existing "Agent backend not configured" title + jump (no new locale keys) rather than the
    misleading "container failed to start". The remedy names the UI path first (Settings → Self-hosted
    runner pool) and links `backend/docs/runner-pool-integration.md` via the new `DOCS.runnerPool`
    entry. The load-bearing `No runner backend available for workspace '<id>'` prefix is preserved.
  - **D2 — runner-pool provider errors** (`RunnerPoolApiError`: a scheduler non-2xx, a missing
    manifest secret, an OAuth-token rejection) now append a shared UI-first remedy naming where the
    pool is registered / re-tested, while preserving the raw `<method> → <status>` / `Missing secret`
    detail ahead of it (still greppable + still matched by the transport's DispatchError re-wrap).
  - **D4 — Datadog auth failure**: a `401`/`403` from the Datadog API now appends a UI-first remedy
    pointing at Integrations → Observability connection (the keys are UI-configured — no env var for
    this connection), preserving the raw `HTTP <status>` diagnostic. A non-auth status (5xx / mapping
    error) is unchanged.

  `@cat-factory/integrations` keeps its own `docs.ts` (repo-doc + vendor-URL helpers) since it sits
  below the server layer and cannot import `@cat-factory/server`'s `config/docs.ts`.

- 90553c8: perf(node): batch the sweeper's execution.advance re-drives into one pg-boss insert

  The Node stale-run sweeper re-enqueued each run it decides to re-drive with an individual
  `boss.send()` — one round-trip per stale run and per resumed spend-paused run, every tick.
  It now gathers every `execution.advance` re-drive of a tick (the stale re-drives and the
  under-budget spend-paused resumes alike) and flushes them as a single `boss.insert([...])`,
  replacing N round-trips with one. Each batch row carries the identical
  `singletonKey`/`retryLimit`/`retryDelay`/`retryBackoff`/`expireInSeconds`/`heartbeatSeconds`
  options a `send` would, and `insert` dedupes PER ROW against the queue's `exclusive`
  `(name, singleton_key)` unique index — so a run that already has a live advance job is a
  no-op and the sweeper's no-double-drive guarantee is preserved exactly (verified by a new
  real-Postgres test). Bootstrap / env-config-repair re-drives (other queues, typically one at
  a time) are unchanged. First implementation slice of the pg-boss ingestion-optimization
  initiative (items V1 + B2 + B1).

- Updated dependencies [e68c958]
  - @cat-factory/integrations@0.81.10
  - @cat-factory/server@0.112.6
  - @cat-factory/eks@0.1.62
  - @cat-factory/orchestration@0.106.4

## 0.92.15

### Patch Changes

- Updated dependencies [e61c980]
  - @cat-factory/server@0.112.5

## 0.92.14

### Patch Changes

- 327a1ef: feat(node): add a `/ready` readiness probe distinct from liveness `/health` (audit item 9)

  `/health` was a static 200 regardless of downstream health, so a replica whose Postgres pool
  had died or whose pg-boss worker had stopped still reported healthy and a load balancer could
  not drain it. Adds a PUBLIC `GET /ready` that round-trips the app's Postgres pool (a bounded
  `SELECT 1`) and checks a pg-boss `running` flag, answering `200 {status:'ready'}` /
  `503 {status:'not_ready'}` with per-dependency `checks`. It also drains the instant graceful
  shutdown begins — `bootServer` flips a `draining` flag at the top of `shutdown()`, so a
  SIGTERM'd node reports not-ready immediately and new traffic stops arriving while in-flight
  requests finish. `/health` stays a static 200 (liveness: a restart can't fix a dead pool). The
  verdict is a pure `checkReadiness` in `readiness.ts`; `createApp` gained an optional `readiness`
  probe (wired by `start()` from the live pool + boss). Node-facade-specific by design — the
  Worker has no long-lived process and local mothership mode has no local Postgres/pg-boss, so
  both wire no probe and `/ready` falls back to a bare `ready`.

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4
  - @cat-factory/orchestration@0.106.3
  - @cat-factory/integrations@0.81.9
  - @cat-factory/agents@0.54.2
  - @cat-factory/caching@0.6.37
  - @cat-factory/consensus@0.10.38
  - @cat-factory/eks@0.1.61
  - @cat-factory/gates@0.5.22
  - @cat-factory/gitlab@0.7.60
  - @cat-factory/observability-langfuse@0.7.192
  - @cat-factory/provider-bedrock@0.7.208
  - @cat-factory/provider-cloudflare@0.7.209
  - @cat-factory/provider-s3@0.2.142
  - @cat-factory/server@0.112.4
  - @cat-factory/spend@0.12.18

## 0.92.13

### Patch Changes

- 6fc42ed: Elaborate GitHub App authentication failures (error-message coverage initiative, items A3/C3). A
  malformed `GITHUB_APP_PRIVATE_KEY` and a failed installation-token mint used to surface opaquely —
  long after boot, deep in a pipeline — instead of naming the cause and the fix.

  - **A3** — new shared validator `requireGitHubAppPrivateKey` (`@cat-factory/server`
    `config/problems.ts`) checks the App private key's SHAPE at config load whenever the App is
    configured: present, a PKCS#8 PEM (not the PKCS#1 key GitHub hands out), with a base64-decodable
    body. A malformed key now fails on the misconfigured screen with the exact `openssl pkcs8 -topk8`
    conversion remedy and a docs link, rather than as an opaque `crypto.subtle.importKey` rejection or
    an `atob` `InvalidCharacterError` at the first token mint. Wired into BOTH facade config loaders
    (Node `loadNodeConfig`, Worker `loadGitHubConfig`) for the default and privileged App keys, with a
    new `GITHUB_APP_PRIVATE_KEY` `ENV_HELP` entry so the message reads identically across facades.
    `GitHubAppAuth.importKey` additionally wraps the residual "valid base64 but not a real key" case
    (which slips past the shape check) with the same actionable message.
  - **C3** — `GitHubAppAuth.mintInstallationToken` now throws an elaborated message via the exported
    `explainInstallationTokenMintFailure`: 401 → wrong/rotated App private key; 404/410 → the App was
    uninstalled or the workspace points at a stale installation (reconnect GitHub); 403 → rejected /
    rate-limited (check App id + key + clock). The load-bearing first line
    (`Failed to mint installation token for <id> (HTTP <status>)`) is preserved verbatim so the
    stale-installation reconcile regexes still classify correctly — the cause + remedy is only
    appended. Unit-tested for both the elaboration and the regex compatibility.

  No behaviour changes beyond error message text and boot-time validation of an already-required key.

- b7ca24a: feat(node): pg-boss-backed async GitHub ingest (audit item 5)

  The Node facade ran GitHub backfills, webhook deliveries and repo resyncs **inline in the
  HTTP request handler** — the `githubBackfill` / `githubWebhook` gateway seams returned
  `false`, so a large initial backfill or a webhook burst blocked the request and risked
  timeouts / dropped deliveries, while the Worker enqueued the same work. Adds pg-boss-backed
  implementations of both seams (`PgBossGitHubBackfillScheduler` / `PgBossGitHubWebhookIngest`)
  that enqueue onto a new `github.sync` queue so the request acks fast (GitHub gets its prompt
  2xx), plus `startGitHubSyncWorker` — the analogue of the Worker's `GITHUB_SYNC_QUEUE` consumer
  and `GitHubBackfillWorkflow` — which drains the queue and applies each job via the SAME
  `GitHubSyncService` / `WebhookService` the inline path used (idempotent, retried with backoff).
  A container built with no boss (a pure-logic test) keeps the inline fallback. Closes the
  "Async GitHub ingest still falls back to the inline paths" caveat in CLAUDE.md.

- Updated dependencies [6fc42ed]
  - @cat-factory/server@0.112.3

## 0.92.12

### Patch Changes

- edad6e6: feat(engine): batch the notification-escalation settings read (audit item 8)

  The periodic notification-escalation sweep loaded every workspace's settings with a `get`
  point-read inside the per-workspace loop — an N+1 that runs every couple of minutes on both
  facades, and one the perf-item-9 settings cache can't fix (that slice is pass-through on the
  Worker's own-mutable-D1-state profile). Adds a batched `listByWorkspaceIds` (chunked `IN`) to
  the `WorkspaceSettingsRepository` port, mirrored in both the D1 and Drizzle repos, plus
  `WorkspaceSettingsService.getMany` (defaults-filled) which `escalateStaleNotifications` now
  calls ONCE before the loop. A `defineWorkspaceSettingsSuite` cross-runtime parity assertion
  (seed → get → batched read, absent workspace absent, empty input → empty map) runs against
  both facades' real stores; the batch read stays mothership-internal (a global sweeper read).

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3
  - @cat-factory/orchestration@0.106.2
  - @cat-factory/server@0.112.2
  - @cat-factory/agents@0.54.1
  - @cat-factory/caching@0.6.36
  - @cat-factory/consensus@0.10.37
  - @cat-factory/eks@0.1.60
  - @cat-factory/gates@0.5.21
  - @cat-factory/gitlab@0.7.59
  - @cat-factory/integrations@0.81.8
  - @cat-factory/observability-langfuse@0.7.191
  - @cat-factory/provider-bedrock@0.7.207
  - @cat-factory/provider-cloudflare@0.7.208
  - @cat-factory/provider-s3@0.2.141
  - @cat-factory/spend@0.12.17

## 0.92.11

### Patch Changes

- Updated dependencies [3b3bdc8]
  - @cat-factory/server@0.112.1
  - @cat-factory/integrations@0.81.7
  - @cat-factory/eks@0.1.59
  - @cat-factory/orchestration@0.106.1

## 0.92.10

### Patch Changes

- 6a4feb9: test(conformance): assert cross-runtime prune parity for four un-asserted retention prunes (audit item 7)

  Four equally-swept retention prunes had no cross-runtime conformance assertion, so a D1 ⇄
  Drizzle drift (wrong column, `<` vs `<=`, missing WHERE) could silently delete live data or
  never reclaim. Adds a focused parity suite per store — `defineTokenUsageSuite`,
  `defineCommitProjectionSuite`, `defineScheduleRunSuite`, `defineSubscriptionActivationSuite`
  (`@cat-factory/conformance`) — each driving the same seed → read → prune assertions through
  both facades' real repositories, and wires them into both the Worker (D1) and Node (Postgres)
  test suites. Test-only; no runtime behaviour changes.

## 0.92.9

### Patch Changes

- Updated dependencies [d1a4129]
  - @cat-factory/contracts@0.127.0
  - @cat-factory/agents@0.54.0
  - @cat-factory/orchestration@0.106.0
  - @cat-factory/server@0.112.0
  - @cat-factory/consensus@0.10.36
  - @cat-factory/eks@0.1.58
  - @cat-factory/gates@0.5.20
  - @cat-factory/gitlab@0.7.58
  - @cat-factory/integrations@0.81.6
  - @cat-factory/kernel@0.121.2
  - @cat-factory/prompt-fragments@0.13.13
  - @cat-factory/spend@0.12.16
  - @cat-factory/provider-bedrock@0.7.206
  - @cat-factory/provider-cloudflare@0.7.207
  - @cat-factory/caching@0.6.35
  - @cat-factory/observability-langfuse@0.7.190
  - @cat-factory/provider-s3@0.2.140

## 0.92.8

### Patch Changes

- df7a489: De-duplicate the GitHub reconcile pass across the two facades, and make every Node
  periodic sweep non-overlapping through a single seam.

  **Reconcile hoist (audit item 4).** `reconcileStaleRepos` and its two gone-installation
  classifiers were duplicated verbatim between the Worker's `sync-consumer.ts` and the Node
  `githubReconcile.ts` (the Node copy's own comment said "Mirrors the Worker's classification"),
  with no shared test — so a change to one would silently diverge (one runtime stops tombstoning
  dead installations while the other keeps working). The pass now lives once in
  `@cat-factory/server` (`reconcileStaleRepos` + `GitHubReconcileDeps`), and each facade supplies
  only its per-repo driver: the Worker enqueues on `GITHUB_SYNC_QUEUE` (or direct-syncs when
  unbound), Node direct-syncs inline. The classifiers moved verbatim (their regex→structured-code
  conversion is tracked separately as error-message-coverage I7). The 30-minute staleness window
  is now the shared exported `GITHUB_RECONCILE_STALE_MS` (previously defined independently per
  facade), and all reconcile logs — the per-repo lines AND the Worker's cron summary — now use a
  single `sweep: 'github-reconcile'` field on both facades. The Worker's queue-less direct-sync
  fallback also builds its DI container once per pass instead of once per stale repo.

  **Non-overlapping Node sweepers (audit item 6).** The DB-heavy `initiativeLoop`, `recurring`,
  and notification-escalation sweeps ran unguarded `setInterval` timers, so a pass that outlasted
  its interval could be stacked — and two concurrent `runDue` passes could both observe "no active
  run" and double-spawn. All eight Node sweeps (kaizen, github-reconcile, initiative loop,
  recurring, notification escalation, environment TTL, and both retention sweeps) now go through
  one `startSweeper` helper built on `toad-scheduler`: `preventOverrun` is the non-overlap guard,
  `runImmediately` the run-once-first behaviour, and the `AsyncTask` error handler the best-effort
  logging (each sweep names its task, so scheduler-surfaced errors identify their sweep), and
  `unref` keeps the sweep timers from holding the process alive — the same contract as the
  hand-rolled `setInterval(...).unref()` timers this replaced. A new sweeper physically cannot
  forget the guard. Adds a `toad-scheduler` (^4.1.0) dependency to `@cat-factory/node-server`.

- Updated dependencies [df7a489]
  - @cat-factory/server@0.111.0

## 0.92.7

### Patch Changes

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1
  - @cat-factory/server@0.110.5
  - @cat-factory/gitlab@0.7.57
  - @cat-factory/orchestration@0.105.6
  - @cat-factory/agents@0.53.6
  - @cat-factory/caching@0.6.34
  - @cat-factory/consensus@0.10.35
  - @cat-factory/eks@0.1.57
  - @cat-factory/gates@0.5.19
  - @cat-factory/integrations@0.81.5
  - @cat-factory/observability-langfuse@0.7.189
  - @cat-factory/provider-bedrock@0.7.205
  - @cat-factory/provider-cloudflare@0.7.206
  - @cat-factory/provider-s3@0.2.139
  - @cat-factory/spend@0.12.15

## 0.92.6

### Patch Changes

- f4482c7: Reclaim a deleted board's binary artifacts (screenshots + reference images) — BOTH the
  metadata rows AND the heavy blob bytes — so they no longer leak forever.

  The artifact retention sweeps only ever iterate LIVE workspaces (`listVisible`), and
  `binary_artifacts` is deliberately excluded from the SQL workspace-delete cascade (dropping
  the metadata row without the bytes would strand the blob in object storage forever — the row
  is the only handle on its key). So before this change, deleting a board orphaned both the
  metadata rows and their backing R2 / S3 / filesystem bytes with nothing to reclaim them —
  unbounded object-storage cost with no surfacing.

  `BinaryArtifactStore` gains `deleteByWorkspace(workspaceId)` (backed by new
  `listByWorkspace` / `deleteByWorkspace` metadata-store methods, mirrored D1 ⇄ Drizzle),
  reusing the same fail-safe blobs-first-then-rows ordering as `pruneOlderThan`: a blob whose
  delete throws keeps its metadata row so a later retry can still reach the bytes rather than
  orphaning them. `WorkspaceService.delete` now purges through this port (best-effort — a
  storage outage can't wedge the board delete) before the row cascade runs. The cross-runtime
  binary-artifact conformance suite asserts the reclaim removes every artifact's rows + bytes,
  scoped to the workspace, on both D1 and Postgres. (system-audit-improvements initiative,
  item 3.)

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0
  - @cat-factory/server@0.110.4
  - @cat-factory/agents@0.53.5
  - @cat-factory/caching@0.6.33
  - @cat-factory/consensus@0.10.34
  - @cat-factory/eks@0.1.56
  - @cat-factory/gates@0.5.18
  - @cat-factory/gitlab@0.7.56
  - @cat-factory/integrations@0.81.4
  - @cat-factory/observability-langfuse@0.7.188
  - @cat-factory/orchestration@0.105.5
  - @cat-factory/provider-bedrock@0.7.204
  - @cat-factory/provider-cloudflare@0.7.205
  - @cat-factory/provider-s3@0.2.138
  - @cat-factory/spend@0.12.14

## 0.92.5

### Patch Changes

- Updated dependencies [cc6d554]
  - @cat-factory/agents@0.53.4
  - @cat-factory/provider-bedrock@0.7.203
  - @cat-factory/server@0.110.3
  - @cat-factory/consensus@0.10.33
  - @cat-factory/orchestration@0.105.4
  - @cat-factory/provider-cloudflare@0.7.204

## 0.92.4

### Patch Changes

- 22a4d9e: Complete the workspace-delete cascade so a board delete no longer orphans rows forever.
  Both facades' `WorkspaceRepository.delete` previously cleared only ~7 tables
  (blocks/pipelines/agent_runs/environments/services/mounts), leaving every other
  workspace-scoped table (`notifications`, `requirement_reviews`, the review / session /
  settings / connection / preset tables, the GitHub projection, …) permanently orphaned on
  a normal board delete — invisible today, unbounded cost tomorrow.

  The cascade is now driven by a single shared kernel list, `WORKSPACE_SCOPED_TABLES`, that
  both the D1 (Cloudflare) and Drizzle (Node/local) facades iterate, so the two runtimes
  cannot drift and a newly-added workspace-scoped table can't silently miss the cascade.
  Per-facade static completeness guards make a new table impossible to forget: the Node guard
  introspects the Drizzle/Postgres schema and the Worker guard introspects the real migrated
  D1, each failing if any `workspace_id` table is neither listed nor explicitly acknowledged
  as a special case (the D1 guard also covers the Cloudflare-only `live_containers` table the
  Drizzle schema can't see). A cross-runtime conformance assertion proves a deleted board
  leaves no rows behind on both D1 and Postgres.

  Deliberately out of scope (unchanged): `binary_artifacts` (its blob bytes must be reclaimed
  through the `BinaryBlobBackend` port at the service layer — a follow-up slice), the
  bespoke `services` / mount re-home handling, and the isolated `telemetry` / `sandbox` /
  `provisioning` schemas (separate stores reclaimed by their own retention sweeps; telemetry
  is a physically separate D1 database on the Worker). (system-audit-improvements initiative,
  item 2.)

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0
  - @cat-factory/agents@0.53.3
  - @cat-factory/caching@0.6.32
  - @cat-factory/consensus@0.10.32
  - @cat-factory/eks@0.1.55
  - @cat-factory/gates@0.5.17
  - @cat-factory/gitlab@0.7.55
  - @cat-factory/integrations@0.81.3
  - @cat-factory/observability-langfuse@0.7.187
  - @cat-factory/orchestration@0.105.3
  - @cat-factory/provider-bedrock@0.7.202
  - @cat-factory/provider-cloudflare@0.7.203
  - @cat-factory/provider-s3@0.2.137
  - @cat-factory/server@0.110.2
  - @cat-factory/spend@0.12.13

## 0.92.3

### Patch Changes

- dbfe2e8: Boot-time structured warnings for three previously-silent misconfigurations (error-message
  coverage initiative, items A5/A9/A10). Each is a single greppable WARN naming the offending
  var, its consequence, and a doc link — behaviour is unchanged (the conditions were, and stay,
  non-fatal); they were just invisible until the first dispatch failed.

  - **A5** — the Node facade's container agent executor is disabled when a prerequisite is
    missing (`PUBLIC_URL`, `AUTH_SESSION_SECRET`, a runner backend, or a GitHub token source),
    but the service still boots "healthy" and repo-operating steps (coder/mocker/tester/merger/…)
    failed only at dispatch, deep in a request. It now logs at boot exactly which prerequisite is
    missing, so the gap is visible up front (the Worker already throws a `configProblem` here).
  - **A9** — an unrecognised `LOCAL_CONTAINER_RUNTIME` value silently fell back to `docker`; the
    local preflight now names the rejected value, the accepted set
    (`docker`/`podman`/`orbstack`/`colima`/`apple`), and the fallback taken.
  - **A10** — a half-set `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` pair silently disabled
    Cloudflare Workers AI (over REST) on the Node facade; config load now names which half is set
    and which is missing.

  Adds a `localMode` section anchor to `@cat-factory/server`'s `ENV_VARS_ANCHORS` so the A9
  warning deep-links the local-mode env-var docs.

- Updated dependencies [dbfe2e8]
  - @cat-factory/server@0.110.1

## 0.92.2

### Patch Changes

- 8d65179: Boot-time configuration validation for three previously-opaque failures (error-message
  coverage initiative, items A2/A4/A6):

  - **A2** — the system `ENCRYPTION_KEY` is now validated at config load on every facade
    (present, valid base64, decoding to a full AES-256 key) via a shared
    `requireEncryptionKey` helper in `@cat-factory/server`, wired into the Node and Worker
    config loaders and reused by local mode. A malformed key fails with an actionable,
    doc-linked message on the misconfigured screen instead of lazily deep inside the first
    cipher build (a bare "must decode to at least 32 bytes" or an opaque `atob` error).
  - **A4** — the Cloudflare Worker's primary `DB` binding is guarded by `requireDb` at
    container build, mirroring `requireTelemetryDb`, so an unbound/misnamed binding fails
    fast with a `[[d1_databases]]` remedy rather than NPE-ing deep in the first repository
    call.
  - **A6** — an invalid `DB_SCHEMA` / `DB_MIGRATIONS_SCHEMA` on the Node facade now throws a
    `ConfigValidationError`, so it reaches the "backend misconfigured" fallback screen
    instead of hard-crashing the process with an opaque message.

- a5dcf7d: Prune resolved notifications on the retention sweep. The `notifications` table was
  never pruned on either facade (upsert/escalate only, no delete), so resolved
  (acted/dismissed) cards accumulated without bound on a table read on the snapshot hot
  path. A new `NotificationRepository.deleteResolvedOlderThan(cutoff)` port method
  (mirrored D1 ⇄ Drizzle) is wired into both facades' retention sweeps under a new
  `RetentionConfig.notificationsMs` window (`NOTIFICATION_RETENTION_DAYS`, default 90
  days). Only terminal rows past the window are deleted — `open` cards (the actionable
  inbox) are never touched. Covered by a new cross-runtime notification conformance
  suite. (system-audit-improvements initiative, item 1.)
- Updated dependencies [8d65179]
- Updated dependencies [a5dcf7d]
  - @cat-factory/server@0.110.0
  - @cat-factory/kernel@0.119.0
  - @cat-factory/agents@0.53.2
  - @cat-factory/caching@0.6.31
  - @cat-factory/consensus@0.10.31
  - @cat-factory/eks@0.1.54
  - @cat-factory/gates@0.5.16
  - @cat-factory/gitlab@0.7.54
  - @cat-factory/integrations@0.81.2
  - @cat-factory/observability-langfuse@0.7.186
  - @cat-factory/orchestration@0.105.2
  - @cat-factory/provider-bedrock@0.7.201
  - @cat-factory/provider-cloudflare@0.7.202
  - @cat-factory/provider-s3@0.2.136
  - @cat-factory/spend@0.12.12

## 0.92.1

### Patch Changes

- 5072999: Boot-time configuration problems now carry a documentation link. Each `ENV_HELP`
  entry embeds a stable in-repo doc URL (built through a new centralized `DOCS`
  helper in `@cat-factory/server`), the operator log appends a `Docs:` line, and the
  "backend misconfigured" screen renders a "View documentation" link per problem.
  This establishes the doc-URL convention for the error-message coverage initiative
  (item A1).
- Updated dependencies [5072999]
  - @cat-factory/contracts@0.126.0
  - @cat-factory/server@0.109.0
  - @cat-factory/agents@0.53.1
  - @cat-factory/consensus@0.10.30
  - @cat-factory/eks@0.1.53
  - @cat-factory/gates@0.5.15
  - @cat-factory/gitlab@0.7.53
  - @cat-factory/integrations@0.81.1
  - @cat-factory/kernel@0.118.1
  - @cat-factory/orchestration@0.105.1
  - @cat-factory/prompt-fragments@0.13.12
  - @cat-factory/spend@0.12.11
  - @cat-factory/provider-bedrock@0.7.200
  - @cat-factory/provider-cloudflare@0.7.201
  - @cat-factory/caching@0.6.30
  - @cat-factory/observability-langfuse@0.7.185
  - @cat-factory/provider-s3@0.2.135

## 0.92.0

### Minor Changes

- 25ac984: Export the Drizzle GitHub projection repositories (`DrizzleRepoProjectionRepository` and the
  branch / pull-request / issue / commit / check-run siblings) from the package entry, so a test
  harness can wire the GitHub module through `buildNodeContainer`'s `overrides` seam with no real
  GitHub App. Used by the e2e backend to fake the GitHub integration ON (connection + repos +
  branches served from real Postgres projections).

## 0.91.1

### Patch Changes

- 2eb0cfd: Make database migrations fail safe and recover cleanly.

  Motivated by a `0.63 → 0.64` upgrade that bricked boot: a database whose drizzle-kit 1.0
  migration ledger (in its own `drizzle` schema) had outlived its `public` tables — the classic
  ledger↔schema split left by a hand `DROP SCHEMA public CASCADE` — hit a bare
  `42P01 relation "accounts" does not exist` deep inside the new FK migration, with no
  remediation path.

  - **Boot drift-guard + wrapped errors (Node).** `migrate()` now probes for the ledger↔schema
    split up front (ledger non-empty but anchor tables `public.accounts`/`public.workspaces`
    missing) and throws a clear `DbSchemaInconsistentError`, and wraps any apply failure in a
    `MigrationFailedError` mapping the pg code (`42P01`/`23503`/`42P07`) to a human cause + the
    recovery command. Boot runs `migrate()` before `boss.start()` (no longer racing them in a
    `Promise.all`) so the migration error is the clean top-level rejection.
  - **`db:reset` recovery command (Node).** `pnpm --filter @cat-factory/node-server db:reset`
    drops all app-owned schemas together — the app schema, `telemetry`, `sandbox`,
    `provisioning`, the migration ledger, and pg-boss's queue schema — so the ledger can never
    outlive the data. This is the sanctioned recovery; never hand-drop `public` alone (that is
    what causes the split). **DESTRUCTIVE** — it deletes all data in `DATABASE_URL`.
  - **Configurable schemas for a shared database (Node).** New optional env vars, all defaulting
    to the prior behaviour: `DB_SCHEMA` relocates the default (`public`) app tables via the
    connection `search_path` (for databases with no usable `public`); `DB_MIGRATIONS_SCHEMA` moves
    the drizzle migration ledger off the top-level `drizzle` schema so it can't collide with
    another drizzle-using service's `drizzle.__drizzle_migrations`; `DB_PGBOSS_SCHEMA` moves
    pg-boss's queue schema. `db:reset` honours the same vars. The named app schemas
    (`telemetry`/`sandbox`/`provisioning`) remain fixed.
  - **Self-healing FK migrations (both runtimes).** The `ON DELETE RESTRICT` FK migrations now
    delete/NULL pre-existing orphans before `ADD CONSTRAINT`, so a database old enough to predate
    the FKs migrates instead of hard-failing on `23503`. Applied symmetrically to the Postgres
    `20260709061125_old_santa_claus` migration and the D1
    `0046_user_identity_foreign_keys.sql` rebuild. **Breaking:** editing these already-shipped
    migrations changes their content; a database that already applied the originals should recover
    via `db:reset` (only experimental installs exist pre-1.0). Orphaned rows are deleted — losing
    that stale data is acceptable (backwards compatibility is a non-goal).
  - **Test-pollution hardening.** The Node/local/mothership test harnesses now require a
    per-vitest-worker database (they refuse to run against the base `DATABASE_URL`) and use the
    `postgres` maintenance database for the admin `CREATE DATABASE` connection, so running the
    suite can never pollute or desync a developer's dev database.

## 0.91.0

### Minor Changes

- 4f936de: Add the optional implementation-fork decision phase on the Coder step. Before the Coder
  writes code, a read-only `fork-proposer` explore agent can aggressively surface the materially
  different ways to implement a task; the run parks for a human to pick a proposed fork or enter
  their own approach, and the chosen approach is folded into the Coder's prompt as a binding
  directive. The phase is gated per-task by a tri-state (`auto`/`always`/`off`) and, in `auto`,
  by an estimate gate on the workspace risk policy (`riskPolicy.forkDecision`, disabled by
  default). All state rides the run's coder step (`step.forkDecision`), so it is
  runtime-symmetric across the Cloudflare and Node facades (D1 ⇄ Drizzle: the new
  `merge_threshold_presets.fork_decision` column). This slice ships propose → park → choose →
  Coder plus the single-path auto-advance; grounded chat about the forks lands in a follow-up.

  Breaking: the built-in merge-threshold preset catalog version is bumped (Balanced /
  Manual review only → v3) to seed the new `forkDecision` gate; workspaces are advised to reseed.
  The `build` Coder prompt is bumped to v4 and a new `fork-proposer` v1 prompt is added.

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/contracts@0.125.0
  - @cat-factory/kernel@0.118.0
  - @cat-factory/agents@0.53.0
  - @cat-factory/orchestration@0.105.0
  - @cat-factory/integrations@0.81.0
  - @cat-factory/server@0.108.0
  - @cat-factory/consensus@0.10.29
  - @cat-factory/eks@0.1.52
  - @cat-factory/gates@0.5.14
  - @cat-factory/gitlab@0.7.52
  - @cat-factory/prompt-fragments@0.13.11
  - @cat-factory/spend@0.12.10
  - @cat-factory/caching@0.6.29
  - @cat-factory/observability-langfuse@0.7.184
  - @cat-factory/provider-bedrock@0.7.199
  - @cat-factory/provider-cloudflare@0.7.200
  - @cat-factory/provider-s3@0.2.134

## 0.90.11

### Patch Changes

- Updated dependencies [4b8fc5f]
  - @cat-factory/server@0.107.10

## 0.90.10

### Patch Changes

- Updated dependencies [e254ef5]
  - @cat-factory/orchestration@0.104.1
  - @cat-factory/server@0.107.9

## 0.90.9

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/orchestration@0.104.0
  - @cat-factory/contracts@0.124.1
  - @cat-factory/kernel@0.117.6
  - @cat-factory/server@0.107.8
  - @cat-factory/agents@0.52.9
  - @cat-factory/consensus@0.10.28
  - @cat-factory/eks@0.1.51
  - @cat-factory/gates@0.5.13
  - @cat-factory/gitlab@0.7.51
  - @cat-factory/integrations@0.80.6
  - @cat-factory/prompt-fragments@0.13.10
  - @cat-factory/spend@0.12.9
  - @cat-factory/caching@0.6.28
  - @cat-factory/observability-langfuse@0.7.183
  - @cat-factory/provider-bedrock@0.7.198
  - @cat-factory/provider-cloudflare@0.7.199
  - @cat-factory/provider-s3@0.2.133

## 0.90.8

### Patch Changes

- 774908c: Perf: project live execution runs instead of loading every run's `detail` (performance-optimizations item 3).

  - New `ExecutionRepository.listLive(workspaceId)` port method returns a lean
    `{ id, blockId, status }` projection of a workspace's LIVE runs (`running`/`blocked`/`paused`)
    without decoding the heavy serialized `detail` column. Implemented on both the D1 and Drizzle
    repos and asserted by the cross-runtime conformance suite.
  - `ExecutionService`'s per-service task-concurrency dispatch guard and `resumePaused` now use
    `listLive` instead of `listByWorkspace`, which previously loaded and JSON-decoded EVERY
    historical run in the workspace just to keep the handful of live rows — so the cost now scales
    with concurrency, not unbounded run history.
  - Adds the supporting `idx_agent_runs_ws_kind_status` index on `(workspace_id, kind, status)` to
    both runtimes (D1 migration `0048_agent_runs_ws_kind_status.sql` ⇄ Drizzle schema + migration).
  - Exposes `listLive` on the mothership-mode persistence allow-list (workspace-scoped read).

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5
  - @cat-factory/server@0.107.7
  - @cat-factory/orchestration@0.103.1
  - @cat-factory/agents@0.52.8
  - @cat-factory/caching@0.6.27
  - @cat-factory/consensus@0.10.27
  - @cat-factory/eks@0.1.50
  - @cat-factory/gates@0.5.12
  - @cat-factory/gitlab@0.7.50
  - @cat-factory/integrations@0.80.5
  - @cat-factory/observability-langfuse@0.7.182
  - @cat-factory/provider-bedrock@0.7.197
  - @cat-factory/provider-cloudflare@0.7.198
  - @cat-factory/provider-s3@0.2.132
  - @cat-factory/spend@0.12.8

## 0.90.7

### Patch Changes

- 08a7da2: Apriori branches (slice 1): data model + write-boundary + persistence.

  A task (`Block`) can now name pre-existing branches of its primary target repo via a new
  optional `aprioriBranches` field — an array of `{ name, mode: 'reference' | 'working' }`.
  `reference` branches are read-only context; the single optional `working` branch is the one
  the run keeps building inside (later slices). See `docs/initiatives/apriori-branches.md`.

  - **Contracts**: `aprioriBranchSchema` + `AprioriBranch`, the `aprioriWorkingBranch` /
    `aprioriReferenceBranches` helpers, an `isSafeGitBranchName` git-ref-safety check, the new
    `blockSchema` field, and `aprioriBranches` on `updateBlockSchema` (capped at 20). Re-exported
    from `@cat-factory/kernel`.
  - **Persistence**: a shared `apriori_branches` JSON text column mirroring `reference_repos`
    (empty-array-is-NULL) — D1 migration `0048_apriori_branches.sql` ⇄ Drizzle schema column +
    generated migration, picked up by both stores through the shared `blockFields` mapper.
  - **Write boundary**: `BoardService.updateBlock` drops the field on non-task blocks and enforces
    the cross-entry invariants via `aprioriBranchesError` — at most one `working` entry, no
    duplicate names, the working entry frozen once a PR exists, and no working entry on a
    multi-repo (`involvedServiceIds`) task.
  - **Conformance**: a cross-runtime round-trip asserting the column survives PATCH + snapshot
    read on both stores, clears to absent, and rejects the invalid shapes.

- Updated dependencies [08a7da2]
  - @cat-factory/contracts@0.124.0
  - @cat-factory/orchestration@0.103.0
  - @cat-factory/kernel@0.117.4
  - @cat-factory/server@0.107.6
  - @cat-factory/agents@0.52.7
  - @cat-factory/consensus@0.10.26
  - @cat-factory/eks@0.1.49
  - @cat-factory/gates@0.5.11
  - @cat-factory/gitlab@0.7.49
  - @cat-factory/integrations@0.80.4
  - @cat-factory/prompt-fragments@0.13.9
  - @cat-factory/spend@0.12.7
  - @cat-factory/caching@0.6.26
  - @cat-factory/observability-langfuse@0.7.181
  - @cat-factory/provider-bedrock@0.7.196
  - @cat-factory/provider-cloudflare@0.7.197
  - @cat-factory/provider-s3@0.2.131

## 0.90.6

### Patch Changes

- Updated dependencies [87f835a]
  - @cat-factory/server@0.107.5

## 0.90.5

### Patch Changes

- 6b968bb: fix(notifications): claim a notification atomically before acting (race-audit 3.1)

  Acting on a human-actionable notification (confirm+merge a `merge_review`/`pipeline_complete`,
  retry a `ci_failed`/`test_failed`) now atomically claims the open card (`open` → `acted`)
  BEFORE running its side effect, so two concurrent acts — a double-click, two members' inboxes,
  an HTTP retry — can no longer both fire the merge/retry. The new
  `NotificationRepository.claimForAction` is a single conditional `UPDATE … WHERE status='open'
RETURNING *` (the `PasswordResetTokenRepository.consume` shape) mirrored on both runtimes
  (D1 ⇄ Drizzle); only the writer that wins the flip runs the side effect. A failing side effect
  reverts the card to `open` so the action stays retryable, without the double-fire window.

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3
  - @cat-factory/orchestration@0.102.8
  - @cat-factory/server@0.107.4
  - @cat-factory/agents@0.52.6
  - @cat-factory/caching@0.6.25
  - @cat-factory/consensus@0.10.25
  - @cat-factory/eks@0.1.48
  - @cat-factory/gates@0.5.10
  - @cat-factory/gitlab@0.7.48
  - @cat-factory/integrations@0.80.3
  - @cat-factory/observability-langfuse@0.7.180
  - @cat-factory/provider-bedrock@0.7.195
  - @cat-factory/provider-cloudflare@0.7.196
  - @cat-factory/provider-s3@0.2.130
  - @cat-factory/spend@0.12.6

## 0.90.4

### Patch Changes

- Updated dependencies [a650396]
  - @cat-factory/orchestration@0.102.7
  - @cat-factory/server@0.107.3

## 0.90.3

### Patch Changes

- eeadc97: Share services across boards, archive services with unfinished tasks, and stop board deletion from
  orphaning or destroying shared services.

  - **Importing a repo that already backs an org service now MOUNTS the shared service** onto the
    current board (one shared subtree + task list) instead of failing with "already linked". Two teams
    in one organization can therefore work on the same service. Re-adding a repo already on the board
    is an idempotent no-op; a repo whose service lives on another board becomes addable (it mounts).
  - **Deleting a board no longer destroys a service another board still mounts.** The delete cascade
    now RE-HOMES each shared service (its blocks + run history) to a surviving mounting board, so it
    lives on there. A service no other board mounts is still fully reclaimed, so its repo is
    re-addable — mirrored across the Cloudflare (D1) and Node (Drizzle) facades (new
    `WorkspaceRepository.delete(id, rehome)` + `WorkspaceMountRepository.listByServiceIds`).
  - **Board (workspace) deletion reclaims its account-owned services** (the un-shared ones). A dangling
    service — account-scoped, looked up by `(installation_id, repo_github_id)` — used to keep the SAME
    repo from being re-added on any other board. The cascade removes the workspace's un-shared homed
    services, every board's mount of them, this board's own mounts, and its environments.
  - **Services with unfinished tasks can no longer be deleted — they are archived instead.**
    Archiving hides a service (its frame + whole subtree) from the board while preserving every row;
    it can be restored at any time with no expiry. New `POST /blocks/:id/archive` and
    `POST /blocks/:id/restore` endpoints, an `archived` column on `blocks` (both runtimes), an
    `archivedServices` list in the workspace snapshot, and inspector/toolbar affordances in the SPA.
    An archived shared service is now correctly hidden on every board that mounts it (not just its
    home) and restorable from any of them.
  - The acting tab now drops a deleted service from its local catalog after the delete commits, so a
    repo becomes re-addable immediately without waiting for a full refresh (the tab is not echoed its
    own board event).

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2
  - @cat-factory/contracts@0.123.1
  - @cat-factory/orchestration@0.102.6
  - @cat-factory/server@0.107.2
  - @cat-factory/agents@0.52.5
  - @cat-factory/caching@0.6.24
  - @cat-factory/consensus@0.10.24
  - @cat-factory/eks@0.1.47
  - @cat-factory/gates@0.5.9
  - @cat-factory/gitlab@0.7.47
  - @cat-factory/integrations@0.80.2
  - @cat-factory/observability-langfuse@0.7.179
  - @cat-factory/provider-bedrock@0.7.194
  - @cat-factory/provider-cloudflare@0.7.195
  - @cat-factory/provider-s3@0.2.129
  - @cat-factory/spend@0.12.5
  - @cat-factory/prompt-fragments@0.13.8

## 0.90.2

### Patch Changes

- cb7fd14: Validate the personal-subscription password cache against an 8h expiry buffer on every
  gated action (start / confirm / retry), so the user is prompted to re-enter early — while
  they are present at the action — instead of the key lapsing mid-pipeline and surfacing as a
  broken run that asks for a retry.

  - Frontend (`@cat-factory/app`): a cached key with under 8h of runway left is withheld on
    the first attempt of a gated action, so the server's existing `428 credential_required`
    gate re-challenges and the modal refreshes the full window. The mid-run confirm actions
    (resolve decision / approve step / request changes / resolve-exceeded) now flow through
    the same `withCredential` prompt path as start/retry.
  - Backend (`@cat-factory/server`): **behavior change** — the run-interaction endpoints
    (resolve decision / approve / request changes / resolve-exceeded) now hard-gate for
    individual-usage runs (mint a fresh activation via `personalGateForRun`, 428 when the
    password is needed but absent/withheld) instead of a silent best-effort re-mint, so an
    early re-entry can be surfaced mid-run. The `remintActivations` helper is removed.
  - `@cat-factory/integrations`: removed the now-unused `PersonalSubscriptionService.refreshActivations`.
  - `@cat-factory/kernel` + the runtime facades (`@cat-factory/worker`, `@cat-factory/node-server`,
    `@cat-factory/local-server`): dropped the now-dead `SubscriptionActivationRepository.refresh`
    port method and its D1 / Drizzle / SQLite implementations — its only caller
    (`refreshActivations`) is gone, so activations are now only ever minted at full TTL via
    `activateForRun`, never TTL-extended in place.

- Updated dependencies [cb7fd14]
  - @cat-factory/server@0.107.1
  - @cat-factory/integrations@0.80.1
  - @cat-factory/kernel@0.117.1
  - @cat-factory/eks@0.1.46
  - @cat-factory/orchestration@0.102.5
  - @cat-factory/agents@0.52.4
  - @cat-factory/caching@0.6.23
  - @cat-factory/consensus@0.10.23
  - @cat-factory/gates@0.5.8
  - @cat-factory/gitlab@0.7.46
  - @cat-factory/observability-langfuse@0.7.178
  - @cat-factory/provider-bedrock@0.7.193
  - @cat-factory/provider-cloudflare@0.7.194
  - @cat-factory/provider-s3@0.2.128
  - @cat-factory/spend@0.12.4

## 0.90.1

### Patch Changes

- c5d8fa1: Modularisation split #4 (first sub-slice): extract the sealed credential /
  subscription / provider-key service builders out of each facade's oversized
  `container.ts` into a per-concern `wireCredentialServices.ts` helper, re-imported at
  their original call sites. Pure move — identical signatures, bodies and wiring on both
  runtimes; behaviour, public API and DI are unchanged. Establishes the `wire*.ts` target
  pattern for the remaining container concern groups (GitHub, merge/notifications, content
  sources, infrastructure).

## 0.90.0

### Minor Changes

- be54a32: Subscription quota-cycle tracking, Part B1 (usage-and-quota-tracking): model "how much of a
  subscription's quota cycle is left" for the flat-rate harnesses (Claude Code / Codex / GLM /
  pooled Kimi & DeepSeek), which the spend ledger excludes.

  Adds the `SubscriptionQuotaProvider` port + `SubscriptionQuotaCycleRepository` and the
  `subscription_quota_cycles` table (mirrored across D1 and Drizzle/Postgres), plus
  `RegistrySubscriptionQuotaProvider` — a vendor-neutral composite (mirroring
  `RegistryReleaseHealthProvider`) that folds each finished subscription run's tokens into rolling
  `5h` + `weekly` windows anchored at first observed use, and reports the cycle either from a real
  per-vendor adapter or the MODELED fallback (persisted counters measured against per-vendor config
  ceilings). The adapter registry is empty today — the real Claude/GLM reads land in Part B2 (an
  executor-harness image bump), so every vendor currently reports modeled. `ContainerAgentExecutor`
  records usage for BOTH pooled runs (scope = the leased pool token) and personal runs (scope = the
  run initiator); it's wired into every facade, and covered by a cross-runtime conformance suite.
  Modeled numbers are illustrative and NEVER billed — the metered-only spend gate is unchanged.

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0
  - @cat-factory/integrations@0.80.0
  - @cat-factory/server@0.107.0
  - @cat-factory/agents@0.52.3
  - @cat-factory/caching@0.6.22
  - @cat-factory/consensus@0.10.22
  - @cat-factory/eks@0.1.45
  - @cat-factory/gates@0.5.7
  - @cat-factory/gitlab@0.7.45
  - @cat-factory/observability-langfuse@0.7.177
  - @cat-factory/orchestration@0.102.4
  - @cat-factory/provider-bedrock@0.7.192
  - @cat-factory/provider-cloudflare@0.7.193
  - @cat-factory/provider-s3@0.2.127
  - @cat-factory/spend@0.12.3

## 0.89.3

### Patch Changes

- Updated dependencies [51869b8]
- Updated dependencies [2924e32]
  - @cat-factory/kernel@0.116.0
  - @cat-factory/spend@0.12.2
  - @cat-factory/orchestration@0.102.3
  - @cat-factory/agents@0.52.2
  - @cat-factory/caching@0.6.21
  - @cat-factory/consensus@0.10.21
  - @cat-factory/eks@0.1.44
  - @cat-factory/gates@0.5.6
  - @cat-factory/gitlab@0.7.44
  - @cat-factory/integrations@0.79.3
  - @cat-factory/observability-langfuse@0.7.176
  - @cat-factory/provider-bedrock@0.7.191
  - @cat-factory/provider-cloudflare@0.7.192
  - @cat-factory/provider-s3@0.2.126
  - @cat-factory/server@0.106.3

## 0.89.2

### Patch Changes

- ddb0b68: Fix account/identity orphaning on a dangling identity, and add referential integrity for the
  user-identity lineage.

  **Login no longer silently forks a new account.** `UserService.findOrCreateByIdentity` resolves
  a user by inner-joining `users` onto `user_identities`, so it returned `null` for BOTH "never
  seen this identity" and "identity row present but its `users` row is gone". The two were
  conflated: a dangling identity (a `users` row removed out from under a still-present
  identity/account/subscription) made login create a fresh, empty user + personal account,
  silently stranding the original account and everything on it (subscriptions, secrets, settings)
  with no error surfaced. It now distinguishes the two via the join-free `getIdentity` read and
  **fails loudly** (logged, 500) on a dangling identity instead of forking, so the corruption is
  caught and healed rather than masked.

  **DB-level referential integrity (both runtimes).** Previously nothing referenced `users(id)` at
  the schema level, so an unsafe delete orphaned dependent rows with no complaint. Add
  `ON DELETE RESTRICT` foreign keys so a `users` row can no longer be dropped while any of these
  still reference it:

  - `user_identities.user_id → users(id)`
  - `accounts.owner_user_id → users(id)`
  - `personal_subscriptions.user_id → users(id)`
  - `memberships.user_id → users(id)`
  - `subscription_activations.user_id → users(id)`

  Node/Postgres: five validating `ADD CONSTRAINT` FKs (Drizzle schema + generated migration).
  Cloudflare/D1: migration `0046_user_identity_foreign_keys.sql` rebuilds the five tables with the
  FKs (deferring FK enforcement to commit via `PRAGMA defer_foreign_keys`, like `0001_init`) and
  also corrects `user_id` on `personal_subscriptions`, `memberships`, and `subscription_activations`
  from `INTEGER` to `TEXT` (matching the canonical `usr_*` id and the Postgres columns).

  No data migration. On a database that already contains orphaned rows, the validating Postgres
  constraint (or the D1 table-copy) will fail at boot — that is the intended loud surfacing of
  pre-existing corruption; re-point or remove the orphaned rows and re-run.

  - @cat-factory/orchestration@0.102.2
  - @cat-factory/server@0.106.2

## 0.89.1

### Patch Changes

- a51a498: fix(execution): route the durable driver's writes through optimistic concurrency (race-audit 2.2 driver-half + 2.3)

  The durable driver (`RunDispatcher`) loaded a run, made a long outbound call (a container poll up
  to 30s / a GitHub gate probe / a deploy provision), then blind-`upsert`ed the whole snapshot — so a
  concurrent human action (a CAS'd `requestHumanReviewFix`/`approveStep`/`resolveDecision`) landing in
  that window was silently clobbered, and a `cancel()`-deleted run was re-inserted as a zombie.

  Every driver write now goes through `RunStateMachine.casPersist` (a `compareAndSwap`, which never
  inserts) and throws the internal `RunContendedError` on a lost race; the four driver entry points
  (`advanceInstance`/`pollAgentJob`/`pollGate`/`resolveGatePollExhaustion`) catch it and re-drive on
  fresh state. The `pollAgentJob` running-fold and `RunDispatcher`'s own follow-up human actions use
  `mutateInstance` (reload + re-apply). The terminal-state clobber is closed in both directions on
  both runtimes: `RunStateMachine.failRun` now treats `done` as terminal and `markFailed` is
  SQL-guarded (`status NOT IN ('done','failed')`), so a `stopRun` racing a just-merged run can't
  re-mark it `failed`; and `markFailed` bumps `rev`, so an in-flight driver `casPersist` that loaded
  the run before the `stopRun` holds a stale `rev`, misses its CAS guard, re-drives, and no-ops on the
  now-`failed` run — it can't resurrect a stopped run as a zombie `running` row. Cross-runtime
  conformance asserts the driver can't clobber a concurrent write, resurrect a cancelled run, re-fail a
  merged run, or resurrect a stopped run.

- Updated dependencies [a51a498]
  - @cat-factory/orchestration@0.102.1
  - @cat-factory/kernel@0.115.1
  - @cat-factory/server@0.106.1
  - @cat-factory/agents@0.52.1
  - @cat-factory/caching@0.6.20
  - @cat-factory/consensus@0.10.20
  - @cat-factory/eks@0.1.43
  - @cat-factory/gates@0.5.5
  - @cat-factory/gitlab@0.7.43
  - @cat-factory/integrations@0.79.2
  - @cat-factory/observability-langfuse@0.7.175
  - @cat-factory/provider-bedrock@0.7.190
  - @cat-factory/provider-cloudflare@0.7.191
  - @cat-factory/provider-s3@0.2.125
  - @cat-factory/spend@0.12.1

## 0.89.0

### Minor Changes

- b83bcc8: Requirements review: auto-recommend answers for findings that don't need a business decision.

  The requirements reviewer now classifies each finding it raises as `autoAnswerable` — answerable
  confidently from universal engineering/product best practice or the context already provided
  (vs. needing a genuine business/product decision). For the `autoAnswerable` findings, the
  Requirement Writer AUTO-generates a grounded recommendation and it is auto-accepted as the
  finding's **default answer** (pre-filled, editable, dismissable), so the human only hand-answers
  the findings that genuinely need their input. Findings needing a business decision are left blank
  and flagged "needs your input"; the human still drives incorporation. The reviewer prompt is
  bumped to `requirement-review@v3`.

  The behaviour is configurable per pipeline step: a new **auto-recommendation** toggle on the
  `requirements-review` step in the pipeline builder (**on by default**). Disabling it reverts to
  the fully-manual flow (answer or request recommendations for every finding).

  This introduces the extensible per-step **`stepOptions`** seam — a single JSON bag
  (`pipelines.step_options`, parallel to `agentKinds`) that is the going-forward home for new
  per-step pipeline parameters, replacing the "one array + one column per knob" pattern
  (`autoRecommend` is its pilot field). See `docs/initiatives/pipeline-step-options.md` for
  folding the legacy per-step arrays (`gates`/`thresholds`/`enabled`/`consensus`/`gating`/
  `followUps`/`testerQuality`) into it.

  Persistence: a new nullable `step_options` column on `pipelines`, mirrored across the D1 and
  Drizzle stores (no data migration — absent ⇒ all defaults). Requirement-review items and
  recommendations gain optional `autoAnswerable` / `auto` fields (stored in the existing JSON
  columns, no migration).

- b83bcc8: Requirements review UX + per-task risk policy rename + document default pipeline.

  **Requirements review — per-finding recommendation guidance & inline recommendations.** Each
  finding now has an explicit 3-way selector (Answer / Dismiss / Recommend) in place of the old
  button row. Typing an answer marks the finding "You answered"; choosing **Recommend** carries
  whatever you typed over as **per-finding guidance** that steers the Requirement Writer's
  suggestion (shown on-screen as guidance, not saved as the answer). Recommendations now render
  **inline inside their source finding card** — generating spinner, the ready suggestion with
  accept/reject/re-request — instead of a separate section below. The request-recommendations wire
  contract changes from `{ itemIds, note }` to `{ items: [{ itemId, note? }] }` so each finding in a
  batch can steer the Writer differently.

  **Auto-recommendation on every round.** Auto-recommendation now also runs after an off-path
  re-review (not only the pipeline-driven incorporation cycle), so every iteration round that
  introduces new questions gets its auto-answerable findings pre-answered.

  **"Merge threshold preset" renamed to "Risk policy".** The per-task/per-workspace preset governs
  merge ceilings, CI-fixer attempts, requirement/tester iteration caps and release-health watch — a
  broader risk-management surface than "merge". It is renamed to **Risk policy** across the wire
  contracts, kernel/domain types, services, HTTP routes (`/workspaces/:ws/merge-presets` →
  `/risk-policies`), repositories, and the SPA (store/util/panel/i18n). `Block.mergePresetId` →
  `Block.riskPolicyId`. Iteration caps stay on the policy (per your risk-management model) — no
  functional change. The physical DB table/column names are retained internally (mapped to the new
  domain names), so there is no data migration.

  **Document tasks default to the document pipeline.** A `taskType: 'document'` task now defaults to
  the document-authoring pipeline (`pl_document`) instead of the full-build pipeline, which produces
  no code and needs no spec/tests. Overridable per task as before.

- a0c6934: Token-usage tracking for BOTH metered API traffic and flat-rate subscription harnesses
  (usage-and-quota-tracking initiative, Part A). The `token_usage` spend ledger gains a
  `billing` discriminator (`metered` | `subscription`) + `vendor` column, and subscription
  harness usage (Claude Code / Codex / GLM / pooled Kimi & DeepSeek) — previously kept out of
  the ledger entirely — is now recorded durably for reporting. The budget gate is unchanged:
  every spend rollup (`status` / `isOverBudget` / the account & user tiers) filters
  `billing = 'metered'`, so a flat-rate quota call is counted for the usage report but never
  inflates spend or trips a budget.

  New `GET /workspaces/:ws/usage` returns the current period's usage broken down by
  `(billing, vendor, provider, model)`, surfaced in a new "Usage" tab in Workspace Settings
  (both metered and subscription usage, with per-model progress bars). Subscription cost is
  illustrative (the equivalent metered-API cost), never billed.

  D1 migration `0044_usage_billing.sql` ⇄ the Drizzle schema + generated migration; the
  cross-runtime conformance suite pins the metered-vs-subscription split on both stores. No
  data migration — existing rows default to `metered`.

  (The `@cat-factory/executor-harness` bump is a test-only type fix — its fake
  `TokenUsageRepository` gains the new `usageBreakdownForWorkspace` method; nothing in the
  runner image changed.)

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/contracts@0.123.0
  - @cat-factory/kernel@0.115.0
  - @cat-factory/agents@0.52.0
  - @cat-factory/orchestration@0.102.0
  - @cat-factory/server@0.106.0
  - @cat-factory/spend@0.12.0
  - @cat-factory/consensus@0.10.19
  - @cat-factory/eks@0.1.42
  - @cat-factory/gates@0.5.4
  - @cat-factory/gitlab@0.7.42
  - @cat-factory/integrations@0.79.1
  - @cat-factory/prompt-fragments@0.13.7
  - @cat-factory/caching@0.6.19
  - @cat-factory/observability-langfuse@0.7.174
  - @cat-factory/provider-bedrock@0.7.189
  - @cat-factory/provider-cloudflare@0.7.190
  - @cat-factory/provider-s3@0.2.124

## 0.88.0

### Minor Changes

- 0f3c88b: feat(testing): sealed sensitive test credentials, delivered to the Tester out of band

  Add a SEALED per-service store for sensitive testing credentials (e.g. a third-party API
  token a Tester needs), the sibling of the non-sensitive test-credential pools. Values are
  encrypted at rest by the facade `SecretCipher` (info tag `cat-factory:test-secrets`, mirroring
  `observability_connections`) and delivered to the Tester container **out of band**: decrypted at
  dispatch, carried on a dedicated job-body field the agent-context snapshot allow-list omits, and
  injected by the harness as container environment variables the agent reads (`$KEY`). The tester
  prompt advertises only each secret's key + description (never the value). Per service frame,
  resolved up the frame chain like release-health config; mirrored across both runtimes (D1 +
  Drizzle) with a cross-runtime conformance assertion.

  New API: `GET|PUT|DELETE /workspaces/:ws/services/:blockId/test-secrets` (values write-only).

  This is Slice C of the tester-environment-access initiative; the Test Data Seeder agent
  (Slice D) is a tracked follow-up. See docs/initiatives/tester-environment-access.md.

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/contracts@0.122.0
  - @cat-factory/kernel@0.114.0
  - @cat-factory/agents@0.51.0
  - @cat-factory/integrations@0.79.0
  - @cat-factory/orchestration@0.101.0
  - @cat-factory/server@0.105.0
  - @cat-factory/consensus@0.10.18
  - @cat-factory/eks@0.1.41
  - @cat-factory/gates@0.5.3
  - @cat-factory/gitlab@0.7.41
  - @cat-factory/prompt-fragments@0.13.6
  - @cat-factory/spend@0.11.24
  - @cat-factory/caching@0.6.18
  - @cat-factory/observability-langfuse@0.7.173
  - @cat-factory/provider-bedrock@0.7.188
  - @cat-factory/provider-cloudflare@0.7.189
  - @cat-factory/provider-s3@0.2.123

## 0.87.10

### Patch Changes

- ed77be6: Initiative-preset registry → app-owned DI (slice 5 of the custom-initiative-definitions
  initiative; registry-DI-migration "Initiative presets" row). The module-global initiative-preset
  registry is replaced by an app-owned `InitiativePresetRegistry` instance the composition root news,
  threads through `CoreDependencies`, and re-exposes on `Core` — mirroring the agent-kind registry.
  This removes the shared process state and the external-adapter module-identity gotcha: a deployment
  registers its own presets by reference on the instance the facade injects.

  BREAKING: the free `@cat-factory/kernel` exports `registerInitiativePreset`,
  `registerInitiativePresets`, `getInitiativePreset`, `allInitiativePresets`,
  `initiativePresetDescriptors`, and `clearRegisteredInitiativePresets` are removed. Use the new
  `InitiativePresetRegistry` class (kernel) + `defaultInitiativePresetRegistry()` factory
  (`@cat-factory/agents`, preloads the built-in generic / docs-refresh / tech-migration presets)
  instead, and inject it via the facade's composition seam — `createApp({ overrides: {
initiativePresetRegistry } })` on the Worker, or the `initiativePresetRegistry` option on `start()`
  / `startLocal()`. `registerDocsRefreshPreset` / `registerTechMigrationPreset` now take the registry
  as a parameter (no bottom-of-module self-registration). No data migration — pre-1.0, no back-compat.

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0
  - @cat-factory/agents@0.50.0
  - @cat-factory/orchestration@0.100.2
  - @cat-factory/server@0.104.2
  - @cat-factory/contracts@0.121.2
  - @cat-factory/caching@0.6.17
  - @cat-factory/consensus@0.10.17
  - @cat-factory/eks@0.1.40
  - @cat-factory/gates@0.5.2
  - @cat-factory/gitlab@0.7.40
  - @cat-factory/integrations@0.78.8
  - @cat-factory/observability-langfuse@0.7.172
  - @cat-factory/provider-bedrock@0.7.187
  - @cat-factory/provider-cloudflare@0.7.188
  - @cat-factory/provider-s3@0.2.122
  - @cat-factory/spend@0.11.23
  - @cat-factory/prompt-fragments@0.13.5

## 0.87.9

### Patch Changes

- 7ee2530: Internal cleanup: prune dead/needless exports flagged by knip (no runtime behaviour
  change). ~110 findings resolved — genuinely-dead symbols deleted (e.g. the unused
  `ENVIRONMENT_ANALYSIS_PIPELINE_ID` / `INITIATIVE_BREAKDOWN_PIPELINE_ID` pipeline-id
  constants, `isCiStatusProviderWired`, `parseApiKeyProvider`, unused re-export members of
  the runtime facade barrels), and the `export` keyword dropped from symbols only used
  inside their own module (repository classes, config constants, helper types). Also tidied
  stale `knip.jsonc` baseline entries (removed no-longer-needed `ignore` / `ignoreDependencies`
  and dead entry-glob patterns).

  The residual knip warnings are now all DELIBERATE: the neutral `VcsClient` port type
  re-export barrel, the Worker config-type barrel, the `providerEndpoints` base-URL group,
  and a couple of types that must stay exported for declaration emit. Since backwards
  compatibility is a non-goal pre-1.0, the removed exports (which nothing imported) are
  dropped outright rather than deprecated.

- Updated dependencies [7ee2530]
  - @cat-factory/agents@0.49.3
  - @cat-factory/consensus@0.10.16
  - @cat-factory/gates@0.5.1
  - @cat-factory/integrations@0.78.7
  - @cat-factory/kernel@0.112.1
  - @cat-factory/orchestration@0.100.1
  - @cat-factory/server@0.104.1
  - @cat-factory/provider-bedrock@0.7.186
  - @cat-factory/provider-cloudflare@0.7.187
  - @cat-factory/eks@0.1.39
  - @cat-factory/caching@0.6.16
  - @cat-factory/gitlab@0.7.39
  - @cat-factory/observability-langfuse@0.7.171
  - @cat-factory/provider-s3@0.2.121
  - @cat-factory/spend@0.11.22

## 0.87.8

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0
  - @cat-factory/gates@0.5.0
  - @cat-factory/orchestration@0.100.0
  - @cat-factory/server@0.104.0
  - @cat-factory/agents@0.49.2
  - @cat-factory/caching@0.6.15
  - @cat-factory/consensus@0.10.15
  - @cat-factory/eks@0.1.38
  - @cat-factory/gitlab@0.7.38
  - @cat-factory/integrations@0.78.6
  - @cat-factory/observability-langfuse@0.7.170
  - @cat-factory/provider-bedrock@0.7.185
  - @cat-factory/provider-cloudflare@0.7.186
  - @cat-factory/provider-s3@0.2.120
  - @cat-factory/spend@0.11.21

## 0.87.7

### Patch Changes

- Updated dependencies [9aa9e19]
  - @cat-factory/contracts@0.121.1
  - @cat-factory/orchestration@0.99.1
  - @cat-factory/agents@0.49.1
  - @cat-factory/consensus@0.10.14
  - @cat-factory/eks@0.1.37
  - @cat-factory/gates@0.4.34
  - @cat-factory/gitlab@0.7.37
  - @cat-factory/integrations@0.78.5
  - @cat-factory/kernel@0.111.1
  - @cat-factory/prompt-fragments@0.13.4
  - @cat-factory/server@0.103.1
  - @cat-factory/spend@0.11.20
  - @cat-factory/provider-bedrock@0.7.184
  - @cat-factory/provider-cloudflare@0.7.185
  - @cat-factory/caching@0.6.14
  - @cat-factory/observability-langfuse@0.7.169
  - @cat-factory/provider-s3@0.2.119

## 0.87.6

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0
  - @cat-factory/agents@0.49.0
  - @cat-factory/server@0.103.0
  - @cat-factory/orchestration@0.99.0
  - @cat-factory/contracts@0.121.0
  - @cat-factory/caching@0.6.13
  - @cat-factory/consensus@0.10.13
  - @cat-factory/eks@0.1.36
  - @cat-factory/gates@0.4.33
  - @cat-factory/gitlab@0.7.36
  - @cat-factory/integrations@0.78.4
  - @cat-factory/observability-langfuse@0.7.168
  - @cat-factory/provider-bedrock@0.7.183
  - @cat-factory/provider-cloudflare@0.7.184
  - @cat-factory/provider-s3@0.2.118
  - @cat-factory/spend@0.11.19
  - @cat-factory/prompt-fragments@0.13.3

## 0.87.5

### Patch Changes

- Updated dependencies [bcc843d]
  - @cat-factory/orchestration@0.98.1
  - @cat-factory/agents@0.48.5
  - @cat-factory/server@0.102.1
  - @cat-factory/kernel@0.110.1
  - @cat-factory/consensus@0.10.12
  - @cat-factory/provider-bedrock@0.7.182
  - @cat-factory/provider-cloudflare@0.7.183
  - @cat-factory/caching@0.6.12
  - @cat-factory/eks@0.1.35
  - @cat-factory/gates@0.4.32
  - @cat-factory/gitlab@0.7.35
  - @cat-factory/integrations@0.78.3
  - @cat-factory/observability-langfuse@0.7.167
  - @cat-factory/provider-s3@0.2.117
  - @cat-factory/spend@0.11.18

## 0.87.4

### Patch Changes

- 090ca89: Local mode now advertises the `cat-factory env` CLI when it fails to boot for a missing or invalid
  mandatory config value. The misconfiguration fallback (both the terminal log and the SPA's "backend
  misconfigured" screen) prepends a one-step remedy — `npx @cat-factory/cli env` generates a
  ready-to-run local-mode `.env` with every required value at once — above the per-variable remedies,
  so a developer can fix the whole file in one command instead of satisfying each secret/URL by hand.

  It covers every mandatory value: the three crypto secrets validated by `applyLocalDefaults`
  (`AUTH_SESSION_SECRET`, `ENCRYPTION_KEY`, `HARNESS_SHARED_SECRET`) and `DATABASE_URL`, which is
  validated inside the reused Node boot. The Node facade's `start()` gains an optional
  `augmentConfigProblems` seam that layers the facade-specific advice onto the problems it catches
  itself; the hosted Node/Worker facades pass nothing, so their remedies are unchanged.

## 0.87.3

### Patch Changes

- Updated dependencies [a2db337]
- Updated dependencies [a2db337]
  - @cat-factory/orchestration@0.98.0
  - @cat-factory/agents@0.48.4
  - @cat-factory/contracts@0.120.0
  - @cat-factory/kernel@0.110.0
  - @cat-factory/server@0.102.0
  - @cat-factory/consensus@0.10.11
  - @cat-factory/provider-bedrock@0.7.181
  - @cat-factory/provider-cloudflare@0.7.182
  - @cat-factory/eks@0.1.34
  - @cat-factory/gates@0.4.31
  - @cat-factory/gitlab@0.7.34
  - @cat-factory/integrations@0.78.2
  - @cat-factory/prompt-fragments@0.13.2
  - @cat-factory/spend@0.11.17
  - @cat-factory/caching@0.6.11
  - @cat-factory/observability-langfuse@0.7.166
  - @cat-factory/provider-s3@0.2.116

## 0.87.2

### Patch Changes

- 35636d5: Honour `INITIATIVE_LOOP_INTERVAL_MS` when it is supplied through `start({ env })`. The initiative-
  loop sweeper resolved its interval from `process.env` directly, but `start()` takes its config from
  an injected `env` object it never writes back to `process.env` — so a deployment (or the e2e
  backend) that set the knob via the injected env was silently ignored and the loop ran at the 60s
  backstop. `resolveSweepInterval(env)` now reads the passed env and `start()` threads its own `env`
  through. This deflakes an intermittent e2e failure where an initiative's first task spawn (which,
  absent a terminal poke, waits for the sweep) landed ~60s later — past the spec's timeout.
- Updated dependencies [35636d5]
  - @cat-factory/agents@0.48.3
  - @cat-factory/consensus@0.10.10
  - @cat-factory/orchestration@0.97.2
  - @cat-factory/provider-bedrock@0.7.180
  - @cat-factory/provider-cloudflare@0.7.181
  - @cat-factory/server@0.101.2

## 0.87.1

### Patch Changes

- 8319e52: Fix a first-sign-in race in `AccountService.ensurePersonalAccount` that 500'd
  `GET /accounts` ("cannot reach backend") on a fresh DB.

  The method was a non-atomic check-then-act: concurrent first-load requests all read
  "no personal account yet", then all `INSERT`, so all but one failed with a duplicate-key
  violation on the personal-account partial unique index (`idx_accounts_personal`) and the
  error surfaced as an unhandled 500.

  The create path is now atomic. A new `AccountRepository.ensurePersonal(account)` port
  inserts-or-returns the surviving row — D1 via `INSERT OR IGNORE`, Postgres via
  `ON CONFLICT DO NOTHING` — so concurrent first-sign-in callers all converge on the same
  account with no rejection. Both runtimes implement it and a cross-runtime conformance
  assertion fires the concurrent resolution and asserts a single account results.

  The sibling paths are unaffected: `createOrg` is a deliberate non-idempotent create (org
  accounts have no such unique index), and `ensureMembership` already writes through an
  idempotent `upsert`.

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1
  - @cat-factory/agents@0.48.2
  - @cat-factory/caching@0.6.10
  - @cat-factory/consensus@0.10.9
  - @cat-factory/eks@0.1.33
  - @cat-factory/gates@0.4.30
  - @cat-factory/gitlab@0.7.33
  - @cat-factory/integrations@0.78.1
  - @cat-factory/observability-langfuse@0.7.165
  - @cat-factory/orchestration@0.97.1
  - @cat-factory/provider-bedrock@0.7.179
  - @cat-factory/provider-cloudflare@0.7.180
  - @cat-factory/provider-s3@0.2.115
  - @cat-factory/server@0.101.1
  - @cat-factory/spend@0.11.16

## 0.87.0

### Minor Changes

- 7157908: Expose the seeded default model preset as a programmatic override on the deploy-app boot
  seams, so a deployment can change its out-of-the-box default without editing library code.

  - `start({ defaultModelPresetId })` (Node) and `startLocal({ defaultModelPresetId })` (local)
    now accept the catalog id of the built-in preset a fresh workspace is seeded with as its
    default; it is forwarded to `buildNodeContainer` / `buildLocalContainer` (both the Postgres
    and mothership local paths). The Worker already honours `defaultModelPresetId` via
    `createApp`'s / `buildContainer`'s `overrides`; that read is now explicit rather than
    relying on the trailing spread.
  - `MODEL_PRESET_SEED_IDS` and `DEFAULT_MODEL_PRESET_ID` are re-exported from all three facade
    packages, so a wrapper can name a preset (`.kimi` / `.glm` / `.claude`) without a direct
    `@cat-factory/kernel` import.

  Applied only at the first seed of a workspace, so a user's later manual default choice is
  always preserved. Facade defaults are unchanged (Node/Cloudflare → Kimi K2.7, local → Claude
  Opus 4.8). Documented in the `deploy/{node,local,backend}` READMEs.

- 7157908: Model presets now support reseeding, mirroring pipelines and merge presets, plus a new
  built-in "Claude Opus 4.8" preset (everything `claude-opus`).

  - Built-in model presets carry stable catalog ids (`mdp_kimi` / `mdp_glm` / `mdp_claude`)
    and a monotonic `version`. The workspace snapshot ships `modelPresetCatalogVersions`, and
    `POST /workspaces/:ws/model-presets/:id/reseed` restores a built-in to the current catalog
    (adopt an update, repair drift, or materialise a new built-in that appeared). The SPA gains
    a once-per-session "model preset updates" advisory (reseed / add) like the pipeline and
    merge-preset ones.
  - The seeded workspace DEFAULT preset is now a deployment fact: Cloudflare and Node default to
    Kimi K2.7 (Cloudflare-runnable on the bare baseline), local mode defaults to Claude Opus 4.8
    (local runs subscription models via the ambient CLI / a leased personal credential). The
    deployment default is applied only at first seed, so a user's later manual default choice is
    always preserved.

  Breaking (pre-1.0, no migration): model presets gain a nullable `version` column
  (D1 `0043_model_preset_versioning`; Drizzle migration). Workspaces seeded before this change
  hold the old index-based preset ids (`mdp-seed-0/1`); they are treated as custom presets, and
  the three stable built-ins are offered via the reseed advisory rather than migrated in place.

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/contracts@0.119.0
  - @cat-factory/kernel@0.109.0
  - @cat-factory/server@0.101.0
  - @cat-factory/orchestration@0.97.0
  - @cat-factory/integrations@0.78.0
  - @cat-factory/agents@0.48.1
  - @cat-factory/consensus@0.10.8
  - @cat-factory/eks@0.1.32
  - @cat-factory/gates@0.4.29
  - @cat-factory/gitlab@0.7.32
  - @cat-factory/prompt-fragments@0.13.1
  - @cat-factory/spend@0.11.15
  - @cat-factory/caching@0.6.9
  - @cat-factory/observability-langfuse@0.7.164
  - @cat-factory/provider-bedrock@0.7.178
  - @cat-factory/provider-cloudflare@0.7.179
  - @cat-factory/provider-s3@0.2.114

## 0.86.8

### Patch Changes

- 629cf90: Initiative presets slice 9: the E2E baseline + a worked-example deployment preset.

  - `@cat-factory/conformance`: `FakeAgentExecutor` gains an `initiativePlan` option so a
    fake-driven initiative-planner step returns a plan draft (the planner otherwise faults a
    planning run) — the seam an e2e/integration test uses to drive create-with-preset → auto-plan
    → spawn.
  - `@cat-factory/node-server`: the initiative-loop sweep interval is now overridable via
    `INITIATIVE_LOOP_INTERVAL_MS` (default 60s unchanged).
  - `@cat-factory/app`: `TaskCard` exposes a behaviour-neutral `data-task-type` attribute (the e2e
    asserts a spawned document task carries its preset decoration).
  - `@cat-factory/example-custom-agent`: adds `preset_org_audit`, a worked-example initiative preset
    registered through the public `registerInitiativePreset` seam.

## 0.86.7

### Patch Changes

- Updated dependencies [4775c40]
  - @cat-factory/agents@0.48.0
  - @cat-factory/consensus@0.10.7
  - @cat-factory/orchestration@0.96.3
  - @cat-factory/provider-bedrock@0.7.177
  - @cat-factory/provider-cloudflare@0.7.178
  - @cat-factory/server@0.100.2

## 0.86.6

### Patch Changes

- Updated dependencies [f97d5d3]
  - @cat-factory/agents@0.47.0
  - @cat-factory/prompt-fragments@0.13.0
  - @cat-factory/consensus@0.10.6
  - @cat-factory/orchestration@0.96.2
  - @cat-factory/provider-bedrock@0.7.176
  - @cat-factory/provider-cloudflare@0.7.177
  - @cat-factory/server@0.100.1

## 0.86.5

### Patch Changes

- cb088c7: Cap concurrent inline (non-container) LLM calls to a subscription/shared-pool vendor so a burst
  can't overwhelm it. A new `VendorConcurrencyLimiter` + `LimitedModelProvider` decorator
  (`@cat-factory/agents`) gates each resolved subscription-vendor model behind an in-process
  per-vendor semaphore, keyed by `subscriptionVendorForRef(ref)`. It is applied as the outermost
  resolver wrap in every facade via `wrapResolverWithLimiter` (`@cat-factory/server`), mirroring the
  existing `InstrumentedModelProvider` shape, so no inline call site changes. Both the buffered
  (`wrapGenerate`) and streaming (`wrapStream`) inline paths are gated — a stream holds its permit
  until it ends — and a queued call whose request is aborted releases its slot instead of
  head-of-line blocking. Only the five subscription vendors (`claude`/`codex`/`glm`/`kimi`/`deepseek`)
  are capped; API-key vendors and Cloudflare pass through untouched.

  Configured by `LLM_SUBSCRIPTION_MAX_CONCURRENCY` (default 3 per vendor; a
  `LLM_SUBSCRIPTION_MAX_CONCURRENCY_<VENDOR>` overrides that one vendor and always wins). Any value
  `<= 0` is uncapped, so setting the default to `0` uncaps every vendor that has no explicit
  per-vendor override (to turn the feature off entirely, leave the per-vendor overrides unset too).
  The limiter is
  in-process only — one per Node process (per container/tenant) or per Worker isolate, which is the
  scope of a single inline fan-out (a consensus panel, the requirements recommendation writer, a
  sandbox sweep). It bounds in-flight concurrency, not requests-per-minute, and does not coordinate
  across replicas/isolates; global rate-limiting stays out of scope. Because inline subscription
  refs are degraded to a pool/API-key provider before resolve on Node/Worker, the cap primarily
  bites in local mode (the prewarmed-container inline subscription backend keeps the ref) and is a
  wired pass-through elsewhere.

- Updated dependencies [cb088c7]
- Updated dependencies [b3bd653]
  - @cat-factory/agents@0.46.0
  - @cat-factory/server@0.100.0
  - @cat-factory/consensus@0.10.5
  - @cat-factory/orchestration@0.96.1
  - @cat-factory/provider-bedrock@0.7.175
  - @cat-factory/provider-cloudflare@0.7.176

## 0.86.4

### Patch Changes

- Updated dependencies [09a1c85]
  - @cat-factory/agents@0.45.0
  - @cat-factory/orchestration@0.96.0
  - @cat-factory/consensus@0.10.4
  - @cat-factory/provider-bedrock@0.7.174
  - @cat-factory/provider-cloudflare@0.7.175
  - @cat-factory/server@0.99.8

## 0.86.3

### Patch Changes

- Updated dependencies [785576b]
  - @cat-factory/agents@0.44.1
  - @cat-factory/consensus@0.10.3
  - @cat-factory/orchestration@0.95.3
  - @cat-factory/provider-bedrock@0.7.173
  - @cat-factory/provider-cloudflare@0.7.174
  - @cat-factory/server@0.99.7

## 0.86.2

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/agents@0.44.0
  - @cat-factory/kernel@0.108.0
  - @cat-factory/prompt-fragments@0.12.0
  - @cat-factory/consensus@0.10.2
  - @cat-factory/orchestration@0.95.2
  - @cat-factory/provider-bedrock@0.7.172
  - @cat-factory/provider-cloudflare@0.7.173
  - @cat-factory/server@0.99.6
  - @cat-factory/caching@0.6.8
  - @cat-factory/eks@0.1.31
  - @cat-factory/gates@0.4.28
  - @cat-factory/gitlab@0.7.31
  - @cat-factory/integrations@0.77.8
  - @cat-factory/observability-langfuse@0.7.163
  - @cat-factory/provider-s3@0.2.113
  - @cat-factory/spend@0.11.14

## 0.86.1

### Patch Changes

- Updated dependencies [4a7fca0]
  - @cat-factory/prompt-fragments@0.11.0
  - @cat-factory/agents@0.43.1
  - @cat-factory/orchestration@0.95.1
  - @cat-factory/server@0.99.5
  - @cat-factory/consensus@0.10.1
  - @cat-factory/provider-bedrock@0.7.171
  - @cat-factory/provider-cloudflare@0.7.172

## 0.86.0

### Minor Changes

- 44fafa4: Inline subscription LLM steps can now run inside a prewarmed local container on a leased
  subscription credential (initiative phase C2). The executor-harness gains a one-shot `inline`
  job kind that runs `claude -p` / `codex exec` with no checkout and returns the completion text +
  usage; the local `LocalContainerRunnerTransport` leases a warm pool member to serve it. The
  local inline resolver now selects the developer's host CLI when its binary is present (ambient,
  unmetered) and otherwise the container backend on a leased credential — personal per-run
  activation for an individual vendor (Claude/Codex/GLM), a pooled token otherwise (Kimi/DeepSeek).
  This lets a subscription-only preset run its inline reviewers/brainstorm/estimator even when the
  host has no `claude`/`codex` binary and in mothership mode, and extends inline coverage to the
  non-native claude-code vendors.

  Mechanics: `ModelScope` gains an `executionId` run dimension and `resolveScopedModelProvider`
  takes the full scope; the inline callers (the iterative reviewers, the doc/initiative
  interviewers, the tester quality companion, Kaizen, and the AI/consensus agent executors) thread
  the run's execution + initiator so the container backend can lease the right credential.
  `buildNodeContainer`'s `wrapModelProviderResolver` seam now receives the subscription lease
  closures. Bumps the executor-harness image tag (the harness `inline` kind is new image code).

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/orchestration@0.95.0
  - @cat-factory/kernel@0.107.0
  - @cat-factory/agents@0.43.0
  - @cat-factory/consensus@0.10.0
  - @cat-factory/server@0.99.4
  - @cat-factory/caching@0.6.7
  - @cat-factory/eks@0.1.30
  - @cat-factory/gates@0.4.27
  - @cat-factory/gitlab@0.7.30
  - @cat-factory/integrations@0.77.7
  - @cat-factory/observability-langfuse@0.7.162
  - @cat-factory/provider-bedrock@0.7.170
  - @cat-factory/provider-cloudflare@0.7.171
  - @cat-factory/provider-s3@0.2.112
  - @cat-factory/spend@0.11.13

## 0.85.10

### Patch Changes

- Updated dependencies [cd60892]
  - @cat-factory/orchestration@0.94.0
  - @cat-factory/server@0.99.3

## 0.85.9

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/agents@0.42.0
  - @cat-factory/kernel@0.106.0
  - @cat-factory/consensus@0.9.29
  - @cat-factory/orchestration@0.93.1
  - @cat-factory/provider-bedrock@0.7.169
  - @cat-factory/provider-cloudflare@0.7.170
  - @cat-factory/server@0.99.2
  - @cat-factory/caching@0.6.6
  - @cat-factory/eks@0.1.29
  - @cat-factory/gates@0.4.26
  - @cat-factory/gitlab@0.7.29
  - @cat-factory/integrations@0.77.6
  - @cat-factory/observability-langfuse@0.7.161
  - @cat-factory/provider-s3@0.2.111
  - @cat-factory/spend@0.11.12

## 0.85.8

### Patch Changes

- Updated dependencies [f7f9a9e]
  - @cat-factory/orchestration@0.93.0
  - @cat-factory/server@0.99.1

## 0.85.7

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/agents@0.41.0
  - @cat-factory/kernel@0.105.0
  - @cat-factory/integrations@0.77.5
  - @cat-factory/contracts@0.118.0
  - @cat-factory/orchestration@0.92.0
  - @cat-factory/server@0.99.0
  - @cat-factory/consensus@0.9.28
  - @cat-factory/provider-bedrock@0.7.168
  - @cat-factory/provider-cloudflare@0.7.169
  - @cat-factory/caching@0.6.5
  - @cat-factory/eks@0.1.28
  - @cat-factory/gates@0.4.25
  - @cat-factory/gitlab@0.7.28
  - @cat-factory/observability-langfuse@0.7.160
  - @cat-factory/provider-s3@0.2.110
  - @cat-factory/spend@0.11.11
  - @cat-factory/prompt-fragments@0.10.27

## 0.85.6

### Patch Changes

- 8f7af8e: Make ephemeral-environment provisioning DETECTION more universal — so it adapts to repos that
  follow different conventions than the stack-recipes pilot (different names, paths, tech stack). The
  changes are additive in the sense that detection can only ever surface MORE — it never removes or
  changes an existing detection, and a repo with no monorepo service-container dirs resolves exactly
  as before. Note the one behavioural change below: the env-template scan now also looks one level into
  `services/*`/`apps/*`/`packages/*`, so a monorepo that keeps per-service templates there will now
  surface them as low-confidence, user-confirmed `recipe.envFiles` where it previously surfaced none.

  - **Injectable detection conventions (deployment config).** A deployment can extend the built-in
    compose file names/dirs, seed dirs, and env-template dirs via the `ENVIRONMENTS_DETECTION_CONVENTIONS`
    JSON env var, threaded additively (built-ins always win; canonical compose names stay
    highest-priority) through `CoreDependencies.detectionConventions` into BOTH the service-provisioning
    detector (`EnvironmentConnectionService`) and the shared-stack detector (`SharedStackService`). New
    `parseDetectionConventions` + `EnvironmentsConfig.detectionConventions` (`@cat-factory/server`,
    parsed by both facades) and the exported `DetectionConventions` type (`@cat-factory/integrations`).
  - **Env-template detection now scans one level into monorepo service-container dirs** (`services/*`,
    `apps/*`, `packages/*`), so a per-service `*-dist`/`.example` template outside the compose dir (the
    pilot's documented `services/app/` gap) is surfaced — still bounded by the existing read budget.
    This is on by default (not gated behind conventions), so any monorepo with a compose file AND
    per-service templates newly gets those as `recipe.envFiles`; they are low-confidence and confirmed
    in the wizard before anything is materialized.
  - **The environment setup wizard elevates the "run deep analysis" nudge** when a repo ships its own
    imperative bring-up CLI/Makefile the deterministic scan can't read (`@cat-factory/app`), pointing the
    user at the LLM analyst — the intended universality mechanism for stack-specific imperative steps.

- Updated dependencies [8f7af8e]
- Updated dependencies [8f7af8e]
  - @cat-factory/integrations@0.77.4
  - @cat-factory/server@0.98.3
  - @cat-factory/orchestration@0.91.1
  - @cat-factory/eks@0.1.27

## 0.85.5

### Patch Changes

- Updated dependencies [4a3e536]
  - @cat-factory/orchestration@0.91.0
  - @cat-factory/contracts@0.117.0
  - @cat-factory/server@0.98.2
  - @cat-factory/agents@0.40.13
  - @cat-factory/consensus@0.9.27
  - @cat-factory/eks@0.1.26
  - @cat-factory/gates@0.4.24
  - @cat-factory/gitlab@0.7.27
  - @cat-factory/integrations@0.77.3
  - @cat-factory/kernel@0.104.4
  - @cat-factory/prompt-fragments@0.10.26
  - @cat-factory/spend@0.11.10
  - @cat-factory/provider-bedrock@0.7.167
  - @cat-factory/provider-cloudflare@0.7.168
  - @cat-factory/caching@0.6.4
  - @cat-factory/observability-langfuse@0.7.159
  - @cat-factory/provider-s3@0.2.109

## 0.85.4

### Patch Changes

- Updated dependencies [18a9cb5]
  - @cat-factory/contracts@0.116.1
  - @cat-factory/agents@0.40.12
  - @cat-factory/consensus@0.9.26
  - @cat-factory/eks@0.1.25
  - @cat-factory/gates@0.4.23
  - @cat-factory/gitlab@0.7.26
  - @cat-factory/integrations@0.77.2
  - @cat-factory/kernel@0.104.3
  - @cat-factory/orchestration@0.90.1
  - @cat-factory/prompt-fragments@0.10.25
  - @cat-factory/server@0.98.1
  - @cat-factory/spend@0.11.9
  - @cat-factory/provider-bedrock@0.7.166
  - @cat-factory/provider-cloudflare@0.7.167
  - @cat-factory/caching@0.6.3
  - @cat-factory/observability-langfuse@0.7.158
  - @cat-factory/provider-s3@0.2.108

## 0.85.3

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/contracts@0.116.0
  - @cat-factory/orchestration@0.90.0
  - @cat-factory/server@0.98.0
  - @cat-factory/kernel@0.104.2
  - @cat-factory/agents@0.40.11
  - @cat-factory/consensus@0.9.25
  - @cat-factory/eks@0.1.24
  - @cat-factory/gates@0.4.22
  - @cat-factory/gitlab@0.7.25
  - @cat-factory/integrations@0.77.1
  - @cat-factory/prompt-fragments@0.10.24
  - @cat-factory/spend@0.11.8
  - @cat-factory/caching@0.6.2
  - @cat-factory/observability-langfuse@0.7.157
  - @cat-factory/provider-bedrock@0.7.165
  - @cat-factory/provider-cloudflare@0.7.166
  - @cat-factory/provider-s3@0.2.107

## 0.85.2

### Patch Changes

- Updated dependencies [802fc05]
  - @cat-factory/orchestration@0.89.0
  - @cat-factory/integrations@0.77.0
  - @cat-factory/contracts@0.115.0
  - @cat-factory/server@0.97.2
  - @cat-factory/eks@0.1.23
  - @cat-factory/agents@0.40.10
  - @cat-factory/consensus@0.9.24
  - @cat-factory/gates@0.4.21
  - @cat-factory/gitlab@0.7.24
  - @cat-factory/kernel@0.104.1
  - @cat-factory/prompt-fragments@0.10.23
  - @cat-factory/spend@0.11.7
  - @cat-factory/provider-bedrock@0.7.164
  - @cat-factory/provider-cloudflare@0.7.165
  - @cat-factory/caching@0.6.1
  - @cat-factory/observability-langfuse@0.7.156
  - @cat-factory/provider-s3@0.2.106

## 0.85.1

### Patch Changes

- a869ae9: Initiative presets — slice 2: the per-run gate-override engine seam.

  - **orchestration** (`ExecutionService.start`): a new optional `gatesOverride` argument — one
    boolean per pipeline step, indexed by the pipeline's ORIGINAL step index exactly like
    `pipeline.gates` — that REPLACES the pipeline's declared approval gates for a single run. It is
    copied onto the run's steps (`requiresApproval`, `gatesOverride?.[i] ?? pipeline.gates?.[i]`), so
    a retry/restart — which re-drive the STORED steps — preserve it with no extra persistence. A
    length that doesn't match the pipeline's step count is rejected up front (a `ValidationError`)
    before any side effects. Absent ⇒ today's behaviour byte-for-byte.
  - **orchestration** (`InitiativeLoopService`): a spawned item's preset-authored `spawn.gates` is
    threaded straight into `ExecutionService.start` as that run's gate override, so a spawned task
    gates (or doesn't) per the preset's human-review mapping instead of the pipeline default.

  Conformance: a new `startExecution` harness probe (start a run through the real `ExecutionService`
  with an optional gate override — a path no HTTP route exposes) plus shared assertions that an
  override flips a step's approval gate on/off, round-trips `requiresApproval` through each store, and
  rejects a mismatched-length override — run identically on the Cloudflare (D1) and Node/local
  (Postgres) facades.

- Updated dependencies [a869ae9]
  - @cat-factory/orchestration@0.88.0
  - @cat-factory/server@0.97.1

## 0.85.0

### Minor Changes

- 6198b08: Missing mandatory env vars / bindings now produce human-readable, actionable startup errors AND a
  graceful degraded backend instead of an opaque crash.

  - **Shared structured config errors.** A new `ConfigValidationError` (carrying a list of
    `ConfigProblem { key, summary, remedy }`) plus a canonical `ENV_HELP` description table and a
    `requireEnv` helper live in `@cat-factory/server`. Every facade's startup throw for a mandatory
    variable (`DATABASE_URL`, `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`, a configured auth provider,
    `TELEMETRY_DB`, `AGENT_MODELS`, the container-executor prerequisites) now routes through it, so the
    message reads the same across Node, local, and the Worker and always says what the variable is for
    and how to fill it. A `ConfigProblem` never carries a secret value.

  - **Graceful misconfiguration fallback backend.** Instead of exiting (which left the SPA on a generic
    "can't reach the backend" panel with no clue what was wrong), a facade that hits a
    `ConfigValidationError` at boot now serves a minimal fallback app (`createMisconfiguredApp`) on the
    normal port: `GET /auth/config` returns an auth-disabled config carrying the problem list, `/health`
    stays 200 (`status: misconfigured`, so an orchestrator doesn't crash-loop it), and every other route
    503s with the structured problems. Wired symmetrically in all three runtimes — Node/local
    `serveMisconfigured`, the Worker's per-request build (which recovers automatically once bindings are
    fixed).

  - **Dedicated frontend error screen.** The SPA's boot handshake now recognises the `misconfigured`
    field and renders `BackendMisconfiguredScreen` — a per-variable list of name + meaning + remedy with
    a reload button — instead of the login/board. Fully translated across all locales.

- 37d1517: Cache the checkout-free `RepoFiles` reads an agent's pre/post-ops run against a run's
  branch (caching-layer initiative, slice 4). A new `AppCaches.repoFiles` group cache serves
  the `getFile`/`listDirectory` idempotency byte-compares the `blueprints`/`spec-writer`
  post-ops issue every run and durable-driver replay, replacing a live GitHub contents-API
  round-trip per file. It is wired only on the `makeResolveRunRepoContext` (pre/post-op) path;
  the environments repo-validation and doc-quality reads stay live.

  - Grouped per `(installation, owner, repo, branch)` via the new kernel `repoFilesCacheGroup`
    helper and keyed per path (`f:`/`d:` prefixes), so one branch's reads drop together.
  - Self-verifying: each entry remembers the branch head sha it reflects, so an entry entering
    its refresh window re-validates with a single cheap `branchHeadSha` compare (bump on an
    unmoved branch, background reload otherwise) instead of re-fetching every file. A sha-pinned
    read is immutable (no probe). The head sha a cold batch stamps is read once per branch
    (memoised), so caching N files costs one extra head read, not N.
  - Coherence: the owning `commitFiles` self-invalidates the branch group after it commits, and
    the `push` webhook drops a branch it saw move out-of-band (an agent container's git push or a
    human PR-branch edit). Stays enabled on the Worker's isolate-safe profile (like the
    document-body cache, the head-sha probe re-validates without a cross-isolate bus) and in local
    mode (single-node, so `commitFiles` self-invalidation is already fully coherent).

### Patch Changes

- Updated dependencies [6198b08]
- Updated dependencies [37d1517]
  - @cat-factory/contracts@0.114.0
  - @cat-factory/server@0.97.0
  - @cat-factory/kernel@0.104.0
  - @cat-factory/caching@0.6.0
  - @cat-factory/integrations@0.76.0
  - @cat-factory/orchestration@0.87.0
  - @cat-factory/agents@0.40.9
  - @cat-factory/consensus@0.9.23
  - @cat-factory/eks@0.1.22
  - @cat-factory/gates@0.4.20
  - @cat-factory/gitlab@0.7.23
  - @cat-factory/prompt-fragments@0.10.22
  - @cat-factory/spend@0.11.6
  - @cat-factory/observability-langfuse@0.7.155
  - @cat-factory/provider-bedrock@0.7.163
  - @cat-factory/provider-cloudflare@0.7.164
  - @cat-factory/provider-s3@0.2.105

## 0.84.0

### Minor Changes

- 14eac27: Add an account-wide model-family allow/block policy. An account admin can constrain which
  LLM families their teams run (block/allow lists over families like DeepSeek, Qwen, Claude,
  OpenAI), gated to the Cloudflare / remote-Node / mothership runtimes (never plain local
  mode). The policy is evaluated against `(family, effective-route provider)`, so a
  residency-guaranteed route (`trustedProviders`, e.g. Bedrock) can exempt an otherwise-blocked
  family — data-residency risk is a property of the serving route, not the model weights.
  Region-grouped built-in presets (USA / Europe / China / Other) ship as apply-in templates.

  Stored on the existing per-account settings config blob (no migration). Enforced through a
  single choke point (`ProviderCapabilities`): the `/models` catalog flags blocked models
  (`available: false` + `policyBlocked: true`) and the pipeline start guard refuses them
  (`model_policy_blocked`). The per-account policy read is cached via a new `accountModelPolicy`
  slice of the app cache seam (`AppCaches`), invalidated on the account-settings write.

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/contracts@0.113.0
  - @cat-factory/kernel@0.103.0
  - @cat-factory/caching@0.5.0
  - @cat-factory/server@0.96.0
  - @cat-factory/orchestration@0.86.0
  - @cat-factory/agents@0.40.8
  - @cat-factory/consensus@0.9.22
  - @cat-factory/eks@0.1.21
  - @cat-factory/gates@0.4.19
  - @cat-factory/gitlab@0.7.22
  - @cat-factory/integrations@0.75.1
  - @cat-factory/prompt-fragments@0.10.21
  - @cat-factory/spend@0.11.5
  - @cat-factory/observability-langfuse@0.7.154
  - @cat-factory/provider-bedrock@0.7.162
  - @cat-factory/provider-cloudflare@0.7.163
  - @cat-factory/provider-s3@0.2.104

## 0.83.1

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/contracts@0.112.0
  - @cat-factory/kernel@0.102.0
  - @cat-factory/integrations@0.75.0
  - @cat-factory/orchestration@0.85.0
  - @cat-factory/server@0.95.0
  - @cat-factory/agents@0.40.7
  - @cat-factory/consensus@0.9.21
  - @cat-factory/eks@0.1.20
  - @cat-factory/gates@0.4.18
  - @cat-factory/gitlab@0.7.21
  - @cat-factory/prompt-fragments@0.10.20
  - @cat-factory/spend@0.11.4
  - @cat-factory/caching@0.4.22
  - @cat-factory/observability-langfuse@0.7.153
  - @cat-factory/provider-bedrock@0.7.161
  - @cat-factory/provider-cloudflare@0.7.162
  - @cat-factory/provider-s3@0.2.103

## 0.83.0

### Minor Changes

- fdba1ea: Shared stacks now declare their own preflight `prerequisites` (the slice-6 follow-up in the
  stack-recipes-and-shared-stacks initiative). A `SharedStack` carries a
  `prerequisites: PreflightRef[]` — the same machine-prerequisite vocabulary a consumer recipe
  declares — and `SharedStackService` re-runs those checks at the START of every bring-up
  (before clone / networks / `up`), streaming one provisioning-log step per check and failing fast
  with copy-paste remediation when a REQUIRED check is red (a non-required one is advisory). This
  closes the acme-shared-services M-rows (mkcert CA / hosts entries / ECR login) for the shared
  stack itself, not just per-PR consumer recipes.

  The probes are host-bound (local facade); a stack that declares `prerequisites` on a deployment
  with no host-probe runtime fails loudly rather than silently skipping a declared safety gate,
  mirroring the compose provider's `runPreflights` seam. Persistence is fully symmetric: a new
  `prerequisites` text-JSON column mirrored D1 (`0042_shared_stacks_prerequisites.sql`) ⇄ Drizzle,
  asserted by the cross-runtime shared-stack conformance round-trip. Pre-1.0, no data migration —
  existing rows default to `[]` (no prerequisites), unchanged behaviour.

### Patch Changes

- 23f7342: Mothership mode: give the four remaining `local-sqlite` bucket repositories a `node:sqlite` home on
  the laptop, so the subscription features and the local-mode settings panel work in mothership mode
  (previously their services were OFF for lack of a database).

  - The local credential store (`credentialStore.ts`) gains three sealed-credential repositories —
    `SqliteProviderSubscriptionTokenRepository` (the per-workspace pooled Claude Code / Codex / GLM
    subscription tokens), `SqlitePersonalSubscriptionRepository` (per-user individual-usage
    credentials, the outer double-encryption blob), and `SqliteSubscriptionActivationRepository`
    (their short-lived per-run, system-key-only copies). A new `localSettingsStore.ts` holds the
    local-mode operational settings singleton (`SqliteLocalSettingsRepository`), kept out of the
    credential store so its "only credentials" invariant holds.
  - All mirror their `D1*` SQL (D1 is SQLite) and stay LOCAL for the same reason the API-key pool
    does: the tokens are leased + decrypted by the LOCAL container executor with the LOCAL key, so
    they must never traverse the machine API to the mothership.
  - New `NodeContainerOptions` credential-override seams (`providerSubscriptionTokenRepository` /
    `personalSubscriptionRepository` / `subscriptionActivationRepository`, mirroring the existing
    `providerApiKeyRepository` seam) let `buildNodeSubscriptionService` /
    `buildNodePersonalSubscriptionService` build without a `db`; the activation repo is threaded once
    and shared by both its consumers (the personal-subscription service's mint + the engine core's
    clear-on-completion). `localSettingsService` is built in the local facade from the local-sqlite
    repo when there is no `db`.

- Updated dependencies [fdba1ea]
  - @cat-factory/contracts@0.111.0
  - @cat-factory/integrations@0.74.0
  - @cat-factory/orchestration@0.84.0
  - @cat-factory/agents@0.40.6
  - @cat-factory/consensus@0.9.20
  - @cat-factory/eks@0.1.19
  - @cat-factory/gates@0.4.17
  - @cat-factory/gitlab@0.7.20
  - @cat-factory/kernel@0.101.2
  - @cat-factory/prompt-fragments@0.10.19
  - @cat-factory/server@0.94.3
  - @cat-factory/spend@0.11.3
  - @cat-factory/provider-bedrock@0.7.160
  - @cat-factory/provider-cloudflare@0.7.161
  - @cat-factory/caching@0.4.21
  - @cat-factory/observability-langfuse@0.7.152
  - @cat-factory/provider-s3@0.2.102

## 0.82.2

### Patch Changes

- Updated dependencies [6a701ef]
  - @cat-factory/integrations@0.73.6
  - @cat-factory/eks@0.1.18
  - @cat-factory/orchestration@0.83.2
  - @cat-factory/server@0.94.2

## 0.82.1

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/contracts@0.110.1
  - @cat-factory/kernel@0.101.1
  - @cat-factory/orchestration@0.83.1
  - @cat-factory/integrations@0.73.5
  - @cat-factory/agents@0.40.5
  - @cat-factory/consensus@0.9.19
  - @cat-factory/eks@0.1.17
  - @cat-factory/gates@0.4.16
  - @cat-factory/gitlab@0.7.19
  - @cat-factory/prompt-fragments@0.10.18
  - @cat-factory/server@0.94.1
  - @cat-factory/spend@0.11.2
  - @cat-factory/caching@0.4.20
  - @cat-factory/observability-langfuse@0.7.151
  - @cat-factory/provider-bedrock@0.7.159
  - @cat-factory/provider-cloudflare@0.7.160
  - @cat-factory/provider-s3@0.2.101

## 0.82.0

### Minor Changes

- c66362f: Remove the `ENVIRONMENTS_ENABLED` deployment flag; the ephemeral-environment
  integration now assembles wherever the shared `ENCRYPTION_KEY` is set, the same
  "always on where the key is present" model as the document/task sources.

  The flag was a footgun: it defaulted off and its only effect was to make the whole
  integration silently inert (auto-detect 503ing with `unavailable`) even when the real
  prerequisites — an encryption key plus a registered per-workspace connection — were
  present. Whether a workspace provisions anything is already governed by whether it
  connects a provider and whether its pipeline includes a `deployer`/`tester` step, so to
  keep environments out of a pipeline you simply omit those steps. `EnvironmentsConfig`
  drops its `enabled` field and the module gates on `encryptionKey` presence in all three
  runtimes.

  Breaking: `ENVIRONMENTS_ENABLED` is no longer read; remove it from deployment config
  (setting it has no effect). The inspector's dedicated "ephemeral environments aren't
  enabled" auto-detect panel is removed with it, since that off state no longer exists.

### Patch Changes

- Updated dependencies [c66362f]
  - @cat-factory/server@0.94.0

## 0.81.1

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0
  - @cat-factory/kernel@0.101.0
  - @cat-factory/orchestration@0.83.0
  - @cat-factory/server@0.93.0
  - @cat-factory/agents@0.40.4
  - @cat-factory/consensus@0.9.18
  - @cat-factory/eks@0.1.16
  - @cat-factory/gates@0.4.15
  - @cat-factory/gitlab@0.7.18
  - @cat-factory/integrations@0.73.4
  - @cat-factory/prompt-fragments@0.10.17
  - @cat-factory/spend@0.11.1
  - @cat-factory/caching@0.4.19
  - @cat-factory/observability-langfuse@0.7.150
  - @cat-factory/provider-bedrock@0.7.158
  - @cat-factory/provider-cloudflare@0.7.159
  - @cat-factory/provider-s3@0.2.100

## 0.81.0

### Minor Changes

- 9ea1e77: Tiered spend budgets (account / workspace / user) with operator hard caps.

  Budgets are now tracked and enforced across three tiers: the existing per-workspace
  monthly limit, a per-account limit, and a per-user limit. A run pauses when any applicable
  tier is exhausted. All three tiers are configurable and visible in the Budget settings
  screen.

  Two new environment variables (`BUDGET_MAX_MONTHLY_PER_ACCOUNT`,
  `BUDGET_MAX_MONTHLY_PER_USER`), read by the Node and Cloudflare config loaders, set
  operator hard ceilings on the account/user tiers; the UI cannot exceed a configured cap and
  shows it on the budget screen. See `docs/environment-variables.md` and
  `docs/initiatives/tiered-budgets.md`.

  Breaking (pre-1.0, no data migration): the `token_usage` ledger gains nullable
  `account_id`/`user_id` columns (existing rows are unattributed and excluded from the new
  account/user rollups until re-metered); `TokenUsageRecord`, `RecordUsageInput`, and
  `SpendPricing` gained fields; `SpendService.isOverBudget` now takes an optional tier scope.
  A new `user_settings` table and `GET/PUT /user-settings` endpoint carry the user-tier
  budget.

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/contracts@0.109.0
  - @cat-factory/kernel@0.100.0
  - @cat-factory/spend@0.11.0
  - @cat-factory/orchestration@0.82.0
  - @cat-factory/server@0.92.0
  - @cat-factory/agents@0.40.3
  - @cat-factory/consensus@0.9.17
  - @cat-factory/eks@0.1.15
  - @cat-factory/gates@0.4.14
  - @cat-factory/gitlab@0.7.17
  - @cat-factory/integrations@0.73.3
  - @cat-factory/prompt-fragments@0.10.16
  - @cat-factory/caching@0.4.18
  - @cat-factory/observability-langfuse@0.7.149
  - @cat-factory/provider-bedrock@0.7.157
  - @cat-factory/provider-cloudflare@0.7.158
  - @cat-factory/provider-s3@0.2.99

## 0.80.5

### Patch Changes

- Updated dependencies [e66accb]
  - @cat-factory/orchestration@0.81.0
  - @cat-factory/server@0.91.0
  - @cat-factory/contracts@0.108.1
  - @cat-factory/agents@0.40.2
  - @cat-factory/consensus@0.9.16
  - @cat-factory/eks@0.1.14
  - @cat-factory/gates@0.4.13
  - @cat-factory/gitlab@0.7.16
  - @cat-factory/integrations@0.73.2
  - @cat-factory/kernel@0.99.1
  - @cat-factory/prompt-fragments@0.10.15
  - @cat-factory/spend@0.10.109
  - @cat-factory/provider-bedrock@0.7.156
  - @cat-factory/provider-cloudflare@0.7.157
  - @cat-factory/caching@0.4.17
  - @cat-factory/observability-langfuse@0.7.148
  - @cat-factory/provider-s3@0.2.98

## 0.80.4

### Patch Changes

- Updated dependencies [9cc02a0]
  - @cat-factory/integrations@0.73.1
  - @cat-factory/eks@0.1.13
  - @cat-factory/orchestration@0.80.1
  - @cat-factory/server@0.90.3

## 0.80.3

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/orchestration@0.80.0
  - @cat-factory/integrations@0.73.0
  - @cat-factory/contracts@0.108.0
  - @cat-factory/agents@0.40.1
  - @cat-factory/caching@0.4.16
  - @cat-factory/consensus@0.9.15
  - @cat-factory/eks@0.1.12
  - @cat-factory/gates@0.4.12
  - @cat-factory/gitlab@0.7.15
  - @cat-factory/observability-langfuse@0.7.147
  - @cat-factory/provider-bedrock@0.7.155
  - @cat-factory/provider-cloudflare@0.7.156
  - @cat-factory/provider-s3@0.2.97
  - @cat-factory/server@0.90.2
  - @cat-factory/spend@0.10.108
  - @cat-factory/prompt-fragments@0.10.14

## 0.80.2

### Patch Changes

- Updated dependencies [eef8612]
- Updated dependencies [bf31df7]
  - @cat-factory/integrations@0.72.1
  - @cat-factory/contracts@0.107.0
  - @cat-factory/agents@0.40.0
  - @cat-factory/kernel@0.98.0
  - @cat-factory/eks@0.1.11
  - @cat-factory/orchestration@0.79.1
  - @cat-factory/server@0.90.1
  - @cat-factory/consensus@0.9.14
  - @cat-factory/gates@0.4.11
  - @cat-factory/gitlab@0.7.14
  - @cat-factory/prompt-fragments@0.10.13
  - @cat-factory/spend@0.10.107
  - @cat-factory/provider-bedrock@0.7.154
  - @cat-factory/provider-cloudflare@0.7.155
  - @cat-factory/caching@0.4.15
  - @cat-factory/observability-langfuse@0.7.146
  - @cat-factory/provider-s3@0.2.96

## 0.80.1

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/contracts@0.106.0
  - @cat-factory/kernel@0.97.0
  - @cat-factory/integrations@0.72.0
  - @cat-factory/orchestration@0.79.0
  - @cat-factory/server@0.90.0
  - @cat-factory/agents@0.39.4
  - @cat-factory/consensus@0.9.13
  - @cat-factory/eks@0.1.10
  - @cat-factory/gates@0.4.10
  - @cat-factory/gitlab@0.7.13
  - @cat-factory/prompt-fragments@0.10.12
  - @cat-factory/spend@0.10.106
  - @cat-factory/caching@0.4.14
  - @cat-factory/observability-langfuse@0.7.145
  - @cat-factory/provider-bedrock@0.7.153
  - @cat-factory/provider-cloudflare@0.7.154
  - @cat-factory/provider-s3@0.2.95

## 0.80.0

### Minor Changes

- 5490103: Surface web search on container agent run details, and store/display performed search queries as telemetry.

  - Container steps now carry a `search` availability fact (`{ available, provider }`), resolved backend-side at dispatch from the run's account web-search keys (else the deployment default). The observability drill-down shows whether web search was available and which provider (Brave / SearXNG) served the run — a static per-run fact, not gated by prompt-recording.
  - New `agent_search_queries` telemetry sink records every web search a container agent performs through the backend search proxy (query, provider, result count), gated by the same double switch as agent-context snapshots (`LLM_RECORD_PROMPTS` + the workspace `storeAgentContext` setting) and pruned on the same telemetry retention window. Mirrored across the D1 (Cloudflare) and Drizzle/Postgres (Node) stores with a cross-runtime conformance suite, and surfaced on demand via `GET /workspaces/:ws/executions/:executionId/search-queries` in a new "Web search" observability view.

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
- Updated dependencies [dd6df12]
  - @cat-factory/contracts@0.105.0
  - @cat-factory/kernel@0.96.0
  - @cat-factory/server@0.89.0
  - @cat-factory/orchestration@0.78.0
  - @cat-factory/integrations@0.71.0
  - @cat-factory/agents@0.39.3
  - @cat-factory/consensus@0.9.12
  - @cat-factory/eks@0.1.9
  - @cat-factory/gates@0.4.9
  - @cat-factory/gitlab@0.7.12
  - @cat-factory/prompt-fragments@0.10.11
  - @cat-factory/spend@0.10.105
  - @cat-factory/caching@0.4.13
  - @cat-factory/observability-langfuse@0.7.144
  - @cat-factory/provider-bedrock@0.7.152
  - @cat-factory/provider-cloudflare@0.7.153
  - @cat-factory/provider-s3@0.2.94

## 0.79.0

### Minor Changes

- accb8ec: feat(docs): attach read-only reference repositories to a document-authoring task

  Let a document-type task carry a list of **reference repositories** the `doc-writer` agent clones
  READ-ONLY while it drafts, so it can reuse existing solutions in those repos as a reference. The
  writer is already containerized (`container-coding`), so no interim step is needed — the reference
  repos become extra sibling checkouts it may read but can never write to.

  - **Read-only by construction.** Reference repos flow through a NEW `referenceRepos` block field,
    separate from the writable `involvedServiceIds`/`fanOutMultiRepo` path. The harness job spec
    carries no branch/PR fields for a reference, the multi-repo coder clones it at its base branch
    with no work branch, and the push phase skips it — three independent layers, so a reference repo
    is structurally impossible to push to. Its clone URL is host-allowlisted like every other repo.
  - **Any accessible repo, by name fragment.** A reference need not be a board service or in the
    workspace's synced projection: the inspector picker reuses the SAME server-side, debounced repo
    search as the add-service modal (extracted into a shared `useRepoSearch` composable), so any repo
    the workspace's VCS connection or the signed-in user's PAT can reach can be attached.
  - **Provider-neutral by construction.** The `ReferenceRepo` identity mirrors the kernel's VCS
    vocabulary (`repoId` / `owner` / `name` / `defaultBranch` / `connectionId`, per `VcsRepoRef` /
    `VcsConnectionRef`) rather than GitHub-specific names, and the clone URL + provider come from the
    deployment-level `ResolveRepoOrigin` seam the primary already rides — so a GitLab deployment
    clones references from GitLab with no extra wiring.
  - **Deduped against the primary.** A reference pointing at the doc task's own repo (or a duplicate
    attachment) is dropped by the shared sibling-checkout key, so it can't collide with an existing
    clone directory and fail the run.
  - **Symmetric persistence.** New `reference_repos` JSON column on `blocks`, mirrored across the D1
    and Drizzle stores with a cross-runtime conformance round-trip assertion.

  Bumps `@cat-factory/executor-harness` (new read-only reference-leg support in the coding harness) —
  the runner image tag pins and `RECOMMENDED_HARNESS_IMAGE` are bumped in lockstep.

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/contracts@0.104.0
  - @cat-factory/kernel@0.95.0
  - @cat-factory/server@0.88.0
  - @cat-factory/orchestration@0.77.0
  - @cat-factory/agents@0.39.2
  - @cat-factory/consensus@0.9.11
  - @cat-factory/eks@0.1.8
  - @cat-factory/gates@0.4.8
  - @cat-factory/gitlab@0.7.11
  - @cat-factory/integrations@0.70.1
  - @cat-factory/prompt-fragments@0.10.10
  - @cat-factory/spend@0.10.104
  - @cat-factory/caching@0.4.12
  - @cat-factory/observability-langfuse@0.7.143
  - @cat-factory/provider-bedrock@0.7.151
  - @cat-factory/provider-cloudflare@0.7.152
  - @cat-factory/provider-s3@0.2.93

## 0.78.0

### Minor Changes

- cd435d1: Shared stacks (stack-recipes-and-shared-stacks initiative, slice 4): a workspace-scoped,
  long-lived compose stack a per-PR consumer environment attaches to over an external network
  (the acme-shared-services shape). Adds the `SharedStack` contract + `SharedStackRepository`
  port, the D1 ⇄ Drizzle `shared_stacks` table with a cross-runtime conformance round-trip, a
  `SharedStackService` lifecycle (CRUD everywhere + host-Docker `ensureUp`/`teardown` on the local
  facade, reusing the compose recipe-runner), the `GET|POST|PATCH|DELETE /workspaces/:ws/shared-stacks`
  (+ `ensure-up`/`teardown`) controller, and a "Shared stacks" panel in the Infrastructure window.
  Bringing a stack up is local-facade-bound (host daemon), the documented compose exception to
  runtime symmetry; persistence stays fully symmetric.

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/contracts@0.103.0
  - @cat-factory/kernel@0.94.0
  - @cat-factory/integrations@0.70.0
  - @cat-factory/orchestration@0.76.0
  - @cat-factory/server@0.87.0
  - @cat-factory/agents@0.39.1
  - @cat-factory/consensus@0.9.10
  - @cat-factory/eks@0.1.7
  - @cat-factory/gates@0.4.7
  - @cat-factory/gitlab@0.7.10
  - @cat-factory/prompt-fragments@0.10.9
  - @cat-factory/spend@0.10.103
  - @cat-factory/caching@0.4.11
  - @cat-factory/observability-langfuse@0.7.142
  - @cat-factory/provider-bedrock@0.7.150
  - @cat-factory/provider-cloudflare@0.7.151
  - @cat-factory/provider-s3@0.2.92

## 0.77.0

### Minor Changes

- c435c09: Local mode ships an on-by-default self-hosted SearXNG web-search upstream.

  Web search for container agents is a backend proxy (`/v1/web-search/search`) that resolves its
  upstream from the run's per-account settings — so local mode previously had no web search until a
  developer hand-entered keys. This adds a **deployment-level trusted default upstream** the proxy
  falls back to when the account has none, and wires a self-hosted SearXNG as that default in local
  mode (on by default, disable with `LOCAL_WEB_SEARCH=off`).

  - **server**: `SearxngWebSearchUpstream` gains a `trusted` flag that trusts only the deployment's
    own configured origin (its base URL — which may be loopback/LAN — and same-origin redirects)
    while a CROSS-origin redirect stays SSRF-guarded, so a trusted-but-compromised upstream can't
    pivot to an internal/metadata host; redirect/credential-stripping/byte-cap protection is
    unchanged. New `createDefaultWebSearchUpstream(...)` (trusted counterpart to
    `createWebSearchUpstream`). `ServerContainer` gains optional `defaultWebSearchUpstream`, which
    `WebSearchProxyController` uses as the fallback when the account resolves no upstream (the
    account path still wins and stays SSRF-guarded; neither ⇒ the unchanged empty-result degrade).
  - **node-server & worker**: both facades build the default from `WEB_SEARCH_BRAVE_API_KEY` /
    `WEB_SEARCH_SEARXNG_URL` / `WEB_SEARCH_SEARXNG_API_KEY`, surface it on the container, and
    advertise Pi's `web_search` tool whenever a default exists (or the account has keys). A stock
    Node **or Cloudflare** deployment can now set a deployment-wide default (Brave or a public
    self-hosted SearXNG); each facade carries a proxy-fallback parity test.
  - **local-server**: `applyLocalDefaults` points `WEB_SEARCH_SEARXNG_URL` at the local SearXNG
    (`http://localhost:8080`) unless `LOCAL_WEB_SEARCH=off`; the `deploy/local` docker-compose gains a
    pinned `searxng` service (behind a `web-search` profile) + a `settings.yml` enabling the JSON API.

  The only Cloudflare-specific gap is the loopback-SearXNG story (no localhost container on workerd),
  which is inherently local-only; the runtime-neutral Brave/public-SearXNG default is now symmetric.

### Patch Changes

- Updated dependencies [c435c09]
  - @cat-factory/server@0.86.0

## 0.76.0

### Minor Changes

- 076d02f: feat(documents): interactive document-review sessions (doc-task WS5)

  Between the outline and the draft, a document-authoring run now converses with the requester
  instead of a single binary approve/revise gate. A new inline `doc-interviewer` step (inserted
  after `doc-outliner` in `pl_document`, replacing the outline's human gate) asks a small batch of
  clarifying questions about scope, audience and structure, parks the run on the standard durable
  decision-wait while the human answers through a dedicated window, and iterates (up to a round
  cap) until it synthesizes a refined **authoring brief** the `doc-writer`/`doc-finalizer` start
  from (folded into their context via the agent-context builder).

  The park/answer/resume/advance spine is now a shared `InterviewGateController<TEntity>`
  parameterized by an `InterviewGateKind` strategy; both the document interviewer and the
  interactive-planning (initiative) interviewer ride it, so the two gates can't drift. A document
  task has no owning entity row, so its transcript is persisted in its own `doc_interview_sessions`
  table — mirrored across D1 ⇄ Drizzle with a cross-runtime conformance assertion. The interview
  window is wired through the universal result-view seam (`doc-interview`) and updates live over a
  new `docInterview` workspace event. Pass-through when no interviewer model is wired, so document
  pipelines run unchanged.

  Hardening: a re-run of a document task now clears the block's prior session before interviewing
  (so it starts clean instead of reusing a stale, already-converged one), the converged brief is
  folded only into the two kinds that consume it (`doc-writer`/`doc-finalizer`), and a non-final
  interviewer pass that returns neither questions nor a brief fails the run loudly instead of
  silently skipping the interview with an empty brief.

  Breaking: `pl_document` bumps to version 3 (the reseed offer), and its step indices shift (the
  interviewer is inserted at index 2), so in-flight runs on the old shape should be restarted.

### Patch Changes

- 77bc73c: Update dependencies to the latest versions within the supply-chain release-age
  window. The Vercel AI SDK family stays within the `ai@6` / `@ai-sdk/*` majors
  that `workers-ai-provider@^3` peers require (`ai@6.0.219`,
  `@ai-sdk/anthropic@3.0.92`, `@ai-sdk/openai@3.0.80`,
  `@ai-sdk/openai-compatible@2.0.56`, `@ai-sdk/provider@3.0.13`,
  `@ai-sdk/amazon-bedrock@4.0.128`). Other bumps include `@hono/node-server`,
  `pg-boss`, `undici`, `markdown-it`, `@aws-sdk/client-s3`, `@clack/prompts`,
  `@types/node`, and eligible transitive dependencies. `@cloudflare/workers-types`
  is held at `4.x` because `wrangler@4` peers on `^4`.
- Updated dependencies [77bc73c]
- Updated dependencies [076d02f]
  - @cat-factory/agents@0.39.0
  - @cat-factory/caching@0.4.10
  - @cat-factory/consensus@0.9.9
  - @cat-factory/eks@0.1.6
  - @cat-factory/integrations@0.69.1
  - @cat-factory/kernel@0.93.0
  - @cat-factory/observability-langfuse@0.7.141
  - @cat-factory/orchestration@0.75.0
  - @cat-factory/provider-bedrock@0.7.149
  - @cat-factory/provider-cloudflare@0.7.150
  - @cat-factory/provider-s3@0.2.91
  - @cat-factory/server@0.85.0
  - @cat-factory/contracts@0.102.0
  - @cat-factory/gates@0.4.6
  - @cat-factory/gitlab@0.7.9
  - @cat-factory/spend@0.10.102
  - @cat-factory/prompt-fragments@0.10.8

## 0.75.3

### Patch Changes

- Updated dependencies [029a689]
- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1
  - @cat-factory/integrations@0.69.0
  - @cat-factory/kernel@0.92.0
  - @cat-factory/agents@0.38.2
  - @cat-factory/consensus@0.9.8
  - @cat-factory/eks@0.1.5
  - @cat-factory/gates@0.4.5
  - @cat-factory/gitlab@0.7.8
  - @cat-factory/orchestration@0.74.3
  - @cat-factory/prompt-fragments@0.10.7
  - @cat-factory/server@0.84.3
  - @cat-factory/spend@0.10.101
  - @cat-factory/caching@0.4.9
  - @cat-factory/observability-langfuse@0.7.140
  - @cat-factory/provider-bedrock@0.7.148
  - @cat-factory/provider-cloudflare@0.7.149
  - @cat-factory/provider-s3@0.2.90

## 0.75.2

### Patch Changes

- Updated dependencies [f6399cf]
  - @cat-factory/integrations@0.68.0
  - @cat-factory/eks@0.1.4
  - @cat-factory/orchestration@0.74.2
  - @cat-factory/server@0.84.2

## 0.75.1

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0
  - @cat-factory/kernel@0.91.0
  - @cat-factory/agents@0.38.1
  - @cat-factory/consensus@0.9.7
  - @cat-factory/eks@0.1.3
  - @cat-factory/gates@0.4.4
  - @cat-factory/gitlab@0.7.7
  - @cat-factory/integrations@0.67.1
  - @cat-factory/orchestration@0.74.1
  - @cat-factory/prompt-fragments@0.10.6
  - @cat-factory/server@0.84.1
  - @cat-factory/spend@0.10.100
  - @cat-factory/caching@0.4.8
  - @cat-factory/observability-langfuse@0.7.139
  - @cat-factory/provider-bedrock@0.7.147
  - @cat-factory/provider-cloudflare@0.7.148
  - @cat-factory/provider-s3@0.2.89

## 0.75.0

### Minor Changes

- 773695b: feat(documents): workspace-linked template + exemplar documents per DocKind (doc-task WS1 items 2–4)

  A workspace can now point a document kind at its OWN template and example documents, reusing
  the existing documents integration end-to-end (no new fetch machinery). A single `role`
  (`template` | `exemplar`) + `docKind` tag on the projected `documents` row — sitting alongside
  the block-scoped `linkedBlockId` anchor — models both:

  - **Template** (singular per kind): its parsed section headings REPLACE the built-in skeleton
    for that kind. Resolved through one shared seam (`resolveDocTemplate`) that BOTH the
    doc-authoring prompts (via the engine-resolved `block.docTemplateBody`) and the `doc-quality`
    gate provider go through, so the writer and the gate never check against different sections.
  - **Exemplars** (multi-valued per kind): "good examples to emulate" surfaced to the author
    agents alongside a new set of built-in curated exemplars.

  The `documents` table gains nullable `role`/`doc_kind` columns (D1 migration ⇄ Drizzle schema +
  generated migration), with new `DocumentRepository` role methods mirrored across both stores and
  asserted by the cross-runtime conformance suite. The Node facade's Drizzle migration is the
  merge node that collapses the two pre-existing divergent snapshot leaves. New workspace-scoped
  routes (`GET`/`POST /document-role-links`, `POST /document-role-links/remove`) back a
  per-DocKind template/exemplar management panel in the Integrations hub (i18n in all 8 locales).

  Breaking (pre-1.0, acceptable): the `documents` projection wire shape gains `role`/`docKind`
  fields; stale rows simply carry nulls.

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/contracts@0.100.0
  - @cat-factory/kernel@0.90.0
  - @cat-factory/agents@0.38.0
  - @cat-factory/integrations@0.67.0
  - @cat-factory/orchestration@0.74.0
  - @cat-factory/server@0.84.0
  - @cat-factory/consensus@0.9.6
  - @cat-factory/eks@0.1.2
  - @cat-factory/gates@0.4.3
  - @cat-factory/gitlab@0.7.6
  - @cat-factory/prompt-fragments@0.10.5
  - @cat-factory/spend@0.10.99
  - @cat-factory/caching@0.4.7
  - @cat-factory/observability-langfuse@0.7.138
  - @cat-factory/provider-bedrock@0.7.146
  - @cat-factory/provider-cloudflare@0.7.147
  - @cat-factory/provider-s3@0.2.88

## 0.74.1

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0
  - @cat-factory/agents@0.37.2
  - @cat-factory/consensus@0.9.5
  - @cat-factory/eks@0.1.1
  - @cat-factory/gates@0.4.2
  - @cat-factory/gitlab@0.7.5
  - @cat-factory/integrations@0.66.1
  - @cat-factory/kernel@0.89.1
  - @cat-factory/orchestration@0.73.1
  - @cat-factory/prompt-fragments@0.10.4
  - @cat-factory/server@0.83.2
  - @cat-factory/spend@0.10.98
  - @cat-factory/provider-bedrock@0.7.145
  - @cat-factory/provider-cloudflare@0.7.146
  - @cat-factory/caching@0.4.6
  - @cat-factory/observability-langfuse@0.7.137
  - @cat-factory/provider-s3@0.2.87

## 0.74.0

### Minor Changes

- 48f9d97: Add opt-in AWS EKS runner + environment backends as a new standalone package
  `@cat-factory/eks`. An EKS cluster's apiserver is a standard Kubernetes apiserver, so the
  package reuses the native Kubernetes transport/provider from `@cat-factory/integrations`
  verbatim and only supplies the EKS differentiator: a short-lived SigV4-presigned STS (IAM)
  apiserver token, minted with WebCrypto (no runtime AWS SDK dependency).

  - `@cat-factory/contracts`: new first-class `{ kind: 'eks' }` runner + environment backend
    variants (`eksRunnerConfigSchema` / `eksProvisionConfigSchema`), the shared
    `eksClusterFieldsSchema` (`region` / `clusterName` / optional `stsHost`, now shape-validated),
    and the AWS secret-key constants. `'eks'` is now a reserved backend kind. `ProviderConfigField`
    gains `number` / `checkbox` / `textarea` field types, and `ProviderDescriptor` gains
    `configTemplate` / `values` so a native backend's typed config renders as a generic form.
  - `@cat-factory/integrations`: `KubernetesApiClient` gains an optional async token-provider
    seam (behaviour-preserving for the existing Kubernetes backend). `RunnerBackendProvider` gains
    an optional `form` descriptor (the shared apiserver fields live once in
    `kubernetesLogic.KUBERNETES_RUNNER_FORM_FIELDS`), so the Kubernetes/EKS runner backends
    self-describe their connect form.
  - `@cat-factory/node-server` + `@cat-factory/worker`: register the EKS backends by reference on
    BOTH facades (symmetric with the native `kubernetes` backend they extend; a pass-through until
    a workspace connects an `eks` backend). A real EKS cluster's private-CA apiserver is only
    reachable from a runtime that can pin a custom CA (Node/local) — the same constraint a
    private-CA `kubernetes` connection already carries, rejected up front at registration on the
    Worker rather than failing silently.
  - `@cat-factory/app`: the runner-pool connect form is now rendered generically from the backend
    descriptor for every backend kind (built-in `kubernetes`, opt-in `eks`, and custom native
    kinds) — the hardcoded `KubernetesRunnerForm.vue` was removed and the SPA no longer knows which
    optional backends exist. See `docs/initiatives/descriptor-driven-infra-forms.md` for the
    remaining env-axis + manifest-editor work.

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/contracts@0.98.0
  - @cat-factory/orchestration@0.73.0
  - @cat-factory/eks@0.1.0
  - @cat-factory/integrations@0.66.0
  - @cat-factory/agents@0.37.1
  - @cat-factory/caching@0.4.5
  - @cat-factory/consensus@0.9.4
  - @cat-factory/gates@0.4.1
  - @cat-factory/gitlab@0.7.4
  - @cat-factory/observability-langfuse@0.7.136
  - @cat-factory/provider-bedrock@0.7.144
  - @cat-factory/provider-cloudflare@0.7.145
  - @cat-factory/provider-s3@0.2.86
  - @cat-factory/server@0.83.1
  - @cat-factory/spend@0.10.97
  - @cat-factory/prompt-fragments@0.10.3

## 0.73.0

### Minor Changes

- f4c321e: feat(documents): add the `doc-quality` gate (WS4) to the forward document pipelines

  A new deterministic polling gate `doc-quality`, authored through the public `registerGate`
  seam in `@cat-factory/gates`, is inserted into `pl_document` (after `doc-finalizer`) and
  `pl_document_quick` (after `doc-reviewer`). It reads the drafted document on the PR head
  checkout-free via a new `DocQualityProvider` (wired per facade over `RepoFiles`) and checks
  — against the WS1 template (`docTemplateFor`, the single source of truth) — that every
  required section is present, no leftover placeholders remain, the heading hierarchy is sane,
  and in-repo relative links resolve. On a red verdict it escalates to a new `doc-fixer`
  container helper that repairs the document on the PR branch; a green document advances with
  nothing spun up. Both doc pipelines' `version` is bumped (reseed offer).

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0
  - @cat-factory/agents@0.37.0
  - @cat-factory/gates@0.4.0
  - @cat-factory/server@0.83.0
  - @cat-factory/caching@0.4.4
  - @cat-factory/consensus@0.9.3
  - @cat-factory/gitlab@0.7.3
  - @cat-factory/integrations@0.65.3
  - @cat-factory/observability-langfuse@0.7.135
  - @cat-factory/orchestration@0.72.1
  - @cat-factory/provider-bedrock@0.7.143
  - @cat-factory/provider-cloudflare@0.7.144
  - @cat-factory/provider-s3@0.2.85
  - @cat-factory/spend@0.10.96

## 0.72.2

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0
  - @cat-factory/agents@0.36.0
  - @cat-factory/orchestration@0.72.0
  - @cat-factory/server@0.82.0
  - @cat-factory/caching@0.4.3
  - @cat-factory/consensus@0.9.2
  - @cat-factory/gates@0.3.2
  - @cat-factory/gitlab@0.7.2
  - @cat-factory/integrations@0.65.2
  - @cat-factory/observability-langfuse@0.7.134
  - @cat-factory/provider-bedrock@0.7.142
  - @cat-factory/provider-cloudflare@0.7.143
  - @cat-factory/provider-s3@0.2.84
  - @cat-factory/spend@0.10.95

## 0.72.1

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0
  - @cat-factory/agents@0.35.0
  - @cat-factory/consensus@0.9.1
  - @cat-factory/gates@0.3.1
  - @cat-factory/gitlab@0.7.1
  - @cat-factory/integrations@0.65.1
  - @cat-factory/kernel@0.86.1
  - @cat-factory/orchestration@0.71.1
  - @cat-factory/prompt-fragments@0.10.2
  - @cat-factory/server@0.81.1
  - @cat-factory/spend@0.10.94
  - @cat-factory/provider-bedrock@0.7.141
  - @cat-factory/provider-cloudflare@0.7.142
  - @cat-factory/caching@0.4.2
  - @cat-factory/observability-langfuse@0.7.133
  - @cat-factory/provider-s3@0.2.83

## 0.72.0

### Minor Changes

- 49b498a: Bug-triage pipeline, Phase D — issue-intake foundations (ports + persistence).

  The plumbing the upcoming `bug-intake` step (Phase E) drives: a predicate search across the
  three task-source vendors, the per-schedule intake configuration, the "taken by cat-factory"
  pickup writeback, and the replace-link that keeps a recurring block's issue context from
  accumulating across fires. No engine step yet — this phase is ports, vendor implementations,
  and persistence only.

  - **`TaskSourceProvider.searchIssues` + `IssueIntakeQuery`** (kernel port): open issues on one
    vendor board matching every predicate (title fragment / labels / issue type), oldest-first,
    deduped against the already-worked exclusion list. Predicates are pushed into the vendor
    query wherever expressible — Jira compiles ONE JQL (`statusCategory != Done`, `issuetype`,
    `labels`, `summary ~`, `issuekey NOT IN`, `ORDER BY created ASC`; excluded ids validated
    against the key shape so a malformed id can't inject), GitHub compiles search qualifiers
    (`repo:` `is:open` `type:` `label:` `in:title`, the title fragment quoted as a literal phrase
    so it can't inject a qualifier) with the API's `created-asc` sort (a new `order` param on
    `GitHubClient.searchIssues`, honoured by the GitLab-backed client too) and filters the
    exclusion list case-insensitively from a bounded, paged overscan, Linear compiles a GraphQL
    `IssueFilter` (team, state type not completed/canceled, per-label `labels.some`,
    `title.containsIgnoreCase`) asked for oldest-created-first, also paged so a run of
    already-worked issues at the front can't starve the pickup.
  - **`PipelineSchedule.issueIntake`** (contracts + both runtimes, kept symmetric): the
    schedule-scoped intake config (`source`, per-vendor `board` scope, `predicates`, the GitHub
    `inProgressLabel`) as a new `pipeline_schedules.issue_intake` JSON column — D1 migration
    `0038_schedule_issue_intake.sql` ⇄ Drizzle schema + generated migration — parsed/serialized
    by shared `@cat-factory/server` mapper helpers so the column can't drift, accepted on
    schedule create/update (PATCH is tri-state: omitted = unchanged, null = clear), and pinned
    by a cross-runtime conformance round-trip. Requiring it when the pipeline carries a
    `bug-intake` step is Phase E's schedule validation.
  - **`IssueWritebackProvider.onIssuePickedUp`**: comments "Taken by cat-factory" (+ run link)
    on the block's linked issue(s) and marks them in-progress — Jira transitions into the
    `indeterminate` status category (`pickDoneTransition` generalized into
    `pickTransitionByCategory`), Linear transitions to the team's `started` state (the Linear
    state pickers generalized into `pickStateIdByType`), GitHub applies the schedule's
    `inProgressLabel` (default `in-progress`) via a new `GitHubClient.applyIssueLabel` that
    creates the label — with the required colour — when absent.
    Best-effort per issue like the existing hooks, and deliberately NOT gated on the workspace
    writeback settings — claiming the issue is intake semantics. Wired in both facades.
  - **`TaskLinkService.replaceForBlock`** + `TaskRepository.unlinkAllFromBlock`: detach every
    issue linked to the reused block in ONE batched write (D1 ⇄ Drizzle), then link the newly
    picked issue — so linked context never accumulates across recurring fires.

- 49b498a: Registry DI migration — the agent-kind registry becomes app-owned (no module global).

  Continues the [registry-DI initiative](docs/initiatives/registry-di-migration.md): the
  plugin-style agent-kind registry (`registerAgentKind` into a module-level `Map`) is replaced by
  an app-owned **`AgentKindRegistry`** instance the composition root news once
  (`defaultAgentKindRegistry()`, pre-loaded with the built-in `bug-investigator` / document /
  initiative kinds), threads through the single `CoreDependencies` object, and re-exposes on the
  `Core` + `ServerContainer` for the HTTP snapshot projection. Module identity stops mattering, the
  external-adapter "phantom Map" gotcha is gone, and tests get a fresh instance instead of
  `clearRegisteredAgentKinds()`. This also fixes the phase-F worker-shard conformance flake at its
  root: the shared suite's `clearRegisteredAgentKinds()` used to wipe the built-in kinds for the
  rest of a single-module run.

  **BREAKING** — the free module-global seams are removed from `@cat-factory/agents` (and the
  facade re-exports): `registerAgentKind`/`registerAgentKinds`, `registered*` (`registeredAgentKind`,
  `registeredAgentStep`, `registeredKindRequiresContainer`, `registeredSystemPrompt`,
  `registeredUserPrompt`, `registeredConfigContributions`, `registeredPreOps`, `registeredPostOps`,
  `registeredAgentPresentation`, `registeredStructuredOutput`, `registeredWebResearchHint`,
  `registeredAgentTuning`, `registeredAgentKinds`), and `clearRegisteredAgentKinds`. Instead export
  the `AgentKindRegistry` class + `defaultAgentKindRegistry()` factory; the pure prompt/catalog fns
  (`systemPromptFor`/`userPromptFor`/`traitsFor`/`hasTrait`/`agentTuningFor`/`configContributionsFor`/
  `configContributionCatalog`/`webResearchGuidanceFor`/`isInlineModelStep`) now take a `registry`
  argument, and a deployment registers custom kinds **by reference** on the instance it injects into
  `buildContainer` / `start()` / `startLocal()` (the `agentKindRegistry` seam), exactly like the
  backend-registries pilot. The runtimes stay symmetric and the cross-runtime conformance suite
  injects a pre-loaded registry to assert a custom kind resolves identically on every facade.

  Also fixes a warm-pool bug in the executor-harness: the read-only multi-repo explore fan-out
  (`runExploreMode`) was gated on `!job.persistentCheckout`, so a `bug-investigator` dispatched to a
  warm local pool (which injects `persistentCheckout: true` on every job) silently dropped its peer
  repos and only saw the primary. The guard is dropped — `runMultiRepoExplore` uses its own
  ephemeral workspace, so the flag is harmlessly ignored.

- 49b498a: Service connections Phase 3 — multi-repo coding. The implementer now fans a cross-service
  change out across every connected involved-service repo, not just the task's own. A new
  `resolveRepoTargets` resolves the task's own repo PLUS each involved service's repo, deduped
  by repo (two services in one monorepo collapse into a single checkout with both
  subdirectories noted; a service co-located in the primary's own repo rides the own-service
  PR). `ContainerAgentExecutor` builds a `peerRepos` job body + a "Multi-repo workspace" prompt
  section for the `coder` kind and works at the repo root so it can reach every involved
  subtree. The executor-harness clones each peer repo as a SIBLING checkout under one workspace
  root, runs the agent once across all of them, and opens one PR per repo it actually changed.
  The own-service PR stays on `block.pullRequest`; the peer PRs are recorded on the new
  `block.peerPullRequests` (`AgentRunResult.peerPullRequests` → engine → JSON column, mirrored
  on D1 + Drizzle), with an `allPullRequests(block)` helper for the multi-repo-aware readers.
  Peer clone URLs are host-allowlisted exactly like the primary. Bumps the runner image
  (`peerRepos` job field + sibling-checkout flow).

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/contracts@0.96.0
  - @cat-factory/kernel@0.86.0
  - @cat-factory/integrations@0.65.0
  - @cat-factory/orchestration@0.71.0
  - @cat-factory/server@0.81.0
  - @cat-factory/gitlab@0.7.0
  - @cat-factory/agents@0.34.0
  - @cat-factory/consensus@0.9.0
  - @cat-factory/gates@0.3.0
  - @cat-factory/prompt-fragments@0.10.1
  - @cat-factory/spend@0.10.93
  - @cat-factory/caching@0.4.1
  - @cat-factory/observability-langfuse@0.7.132
  - @cat-factory/provider-bedrock@0.7.140
  - @cat-factory/provider-cloudflare@0.7.141
  - @cat-factory/provider-s3@0.2.82

## 0.71.3

### Patch Changes

- 1f6d9fc: Cache the workspace GitHub repo projection through the app caching seam
  (caching-layer initiative, slice 3). A new `AppCaches.repoProjection` group cache
  (grouped and keyed by workspace id) serves the whole-projection re-list that the
  block→repo resolver (`buildResolveRepoTarget`) runs on every agent dispatch and
  every durable poll tick, replacing a live `repoProjectionRepository.list` per
  resolution with a per-workspace cached read.

  Coherence is invalidation-driven: every projection write drops the workspace
  group after it commits — `GitHubSyncService` (repo link / monorepo-flag / the
  exact-set write + tombstone / the link-time full re-stamp, fanned out per
  workspace), `BoardService.addServiceFromRepo` (the monorepo-flag write on the
  import-existing-repo path), `WebhookService` (the `installation_repositories`
  removed tombstone), and `ContainerRepoBootstrapper` (projecting a freshly
  bootstrapped repo). `GitHubSyncService.syncRepo` only invalidates on a `full`
  (link-time) pass — an incremental resync re-stamps `syncedAt` alone, which the
  resolver never reads, so invalidating there would only churn the cache. The
  installation lookup and the tree-depth-bounded block ancestry walk stay live, so
  a block reparent or a service repo-link change needs no cache invalidation.

  The cache is pass-through on the Cloudflare Worker's isolate-safe profile (our own
  mutable D1 state, no cross-isolate invalidation bus), so the Worker reads the
  projection live. Local mode is likewise pass-through: it seeds the projection via
  the out-of-process `link-repo` CLI and runs single-node with no invalidation bus,
  so an in-memory TTL'd entry could serve a pre-link projection. So the cache is
  active on the multi-node-capable Node facade only. Absent a cache (tests /
  harnesses) every resolve lists live, unchanged.

- Updated dependencies [1f6d9fc]
  - @cat-factory/caching@0.4.0
  - @cat-factory/kernel@0.85.0
  - @cat-factory/server@0.80.0
  - @cat-factory/integrations@0.64.0
  - @cat-factory/orchestration@0.70.1
  - @cat-factory/agents@0.33.1
  - @cat-factory/consensus@0.8.34
  - @cat-factory/gates@0.2.88
  - @cat-factory/gitlab@0.6.12
  - @cat-factory/observability-langfuse@0.7.131
  - @cat-factory/provider-bedrock@0.7.139
  - @cat-factory/provider-cloudflare@0.7.140
  - @cat-factory/provider-s3@0.2.81
  - @cat-factory/spend@0.10.92

## 0.71.2

### Patch Changes

- Updated dependencies [8eaa3f2]
  - @cat-factory/prompt-fragments@0.10.0
  - @cat-factory/agents@0.33.0
  - @cat-factory/orchestration@0.70.0
  - @cat-factory/server@0.79.4
  - @cat-factory/consensus@0.8.33
  - @cat-factory/provider-bedrock@0.7.138
  - @cat-factory/provider-cloudflare@0.7.139

## 0.71.1

### Patch Changes

- Updated dependencies [e5ddaa4]
- Updated dependencies [6213771]
  - @cat-factory/caching@0.3.0
  - @cat-factory/kernel@0.84.0
  - @cat-factory/integrations@0.63.0
  - @cat-factory/agents@0.32.0
  - @cat-factory/orchestration@0.69.1
  - @cat-factory/consensus@0.8.32
  - @cat-factory/gates@0.2.87
  - @cat-factory/gitlab@0.6.11
  - @cat-factory/observability-langfuse@0.7.130
  - @cat-factory/provider-bedrock@0.7.137
  - @cat-factory/provider-cloudflare@0.7.138
  - @cat-factory/provider-s3@0.2.80
  - @cat-factory/server@0.79.3
  - @cat-factory/spend@0.10.91

## 0.71.0

### Minor Changes

- 9bac054: Caching initiative pilot (docs/initiatives/caching-layer.md, rows 0-1): introduce the
  app-level caching seam and adopt it for the per-dispatch fragment-catalog resolve.

  - New published package `@cat-factory/caching`: `createAppCaches(options)` builds the
    named, typed in-memory read-through caches (layered-loader `GroupLoader`, LRU + TTL)
    behind the new kernel `AppCaches`/`GroupCacheHandle` port. Redis is only ever an
    invalidation bus, never a data tier; with no notification factory injected the
    loaders are bare in-memory. The package deep-imports only layered-loader's in-memory
    machinery so ioredis never enters the module graph outside the Node facade's
    REDIS_URL-gated wiring.
  - `FragmentLibraryService.resolveCatalog` now reads through the fragment-catalog cache
    (group = workspace id), and every fragment write path — create / update / remove /
    createFromDocument / refresh / the run-time document-body re-resolve / fragment-source
    sync + unlink — invalidates it after commit (`invalidateCatalogTier`). The
    `ResolvedCatalogEntry` type moved to `@cat-factory/kernel` so the port can name it.
  - Node facade: `start()` builds the process-wide cache bag; when `REDIS_URL` is set,
    each cache gets its own `cat-factory:cache:<name>` notification channel (prefix
    overridable via the new `REDIS_CACHE_CHANNEL_PREFIX` env var) over dedicated
    ioredis publisher/subscriber clients, so peers drop their in-memory entries on every
    write — the same gating and resilience pattern as the realtime propagator. Local
    mode stays bare in-memory (single-node by construction).
  - Cloudflare Worker: wired with the ISOLATE-SAFE profile — the fragment catalog (mutable
    cross-instance state) is pass-through, since an isolate has no cross-isolate
    invalidation bus. Documented in the caching package README.
  - Conformance: new `defineCacheSuite` asserts write-then-read coherence of the resolved
    catalog on all three runtimes (Worker/Node/local).
  - Staleness probes for the upcoming git-backed slices, on layered-loader 14.5.3's new
    in-memory `isEntryStillCurrentFn` support: a cache profile may set
    `ttlLeftBeforeRefreshInMsecs`, and `GroupCacheHandle.get` accepts an optional per-read
    `isStillCurrent` probe — entries entering the refresh window get their TTL bumped when
    the probe reports the source unmoved, and fall back to a full background reload
    otherwise. `layered-loader` (maintainer-owned) is now excluded unversioned from the
    `minimumReleaseAge` supply-chain gate, like the `@cat-factory/*` namespace.

### Patch Changes

- Updated dependencies [9bac054]
  - @cat-factory/caching@0.2.0
  - @cat-factory/kernel@0.83.0
  - @cat-factory/agents@0.31.0
  - @cat-factory/orchestration@0.69.0
  - @cat-factory/consensus@0.8.31
  - @cat-factory/gates@0.2.86
  - @cat-factory/gitlab@0.6.10
  - @cat-factory/integrations@0.62.1
  - @cat-factory/observability-langfuse@0.7.129
  - @cat-factory/provider-bedrock@0.7.136
  - @cat-factory/provider-cloudflare@0.7.137
  - @cat-factory/provider-s3@0.2.79
  - @cat-factory/server@0.79.2
  - @cat-factory/spend@0.10.90

## 0.70.1

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0
  - @cat-factory/kernel@0.82.0
  - @cat-factory/integrations@0.62.0
  - @cat-factory/agents@0.30.5
  - @cat-factory/consensus@0.8.30
  - @cat-factory/gates@0.2.85
  - @cat-factory/gitlab@0.6.9
  - @cat-factory/orchestration@0.68.1
  - @cat-factory/prompt-fragments@0.9.55
  - @cat-factory/server@0.79.1
  - @cat-factory/spend@0.10.89
  - @cat-factory/observability-langfuse@0.7.128
  - @cat-factory/provider-bedrock@0.7.135
  - @cat-factory/provider-cloudflare@0.7.136
  - @cat-factory/provider-s3@0.2.78

## 0.70.0

### Minor Changes

- 6edcce0: Personal-PAT repo access + fail-closed board redaction, and removal of the legacy repo→block link.

  - **Expand the repo picker with your own PAT (all facades).** A user's stored GitHub PAT
    (`user_secrets` kind `github_pat`) now surfaces repos it can reach beyond the workspace's GitHub
    App grant — even on the hosted Cloudflare/Node facades. Linking one creates a **personal service**
    (`GitHubRepo.linkedVia === 'user_pat'`); runs against it already use the initiator's PAT.
  - **Fail-closed frame redaction.** A service frame backed by a repo linked via another member's PAT
    is hidden from members who can't reach it: the board snapshot scrubs the frame to just its
    internal id + a "Permission denied" placeholder and drops its subtree. Access is a fail-closed
    per-user projection (`github_user_repo_access`), refreshed when a user enumerates their PAT repos
    and cleared when they remove their PAT — no live GitHub call on the snapshot path.
  - **New:** `github_repos.linked_via` column + `github_user_repo_access` table (mirrored D1 ⇄
    Drizzle, with a cross-runtime conformance suite); kernel `UserRepoAccessRepository` port and
    optional `GitHubClient.listReposForToken`/`getRepoForToken`; `Block.accessDenied` +
    `GitHubAvailableRepo.personal` wire fields.

  **Breaking (pre-1.0, no migration):** the legacy `github_repos.block_id` repo↔frame link is removed
  — the account-owned `Service` (`getByFrameBlock` → `repoGithubId`) is now the SOLE repo↔frame
  linkage. `RepoProjectionRepository.linkBlock` and `GitHubRepo.blockId` are gone; `resolveRepoTarget`
  now requires a `serviceRepository`; the `RepoBootstrapper` port's `linkRepoToBlock` is replaced by
  `projectBootstrappedRepo` (the caller binds the frame's `Service`). Existing rows' `block_id` is
  dropped; repos remain reachable through their `Service`.

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/contracts@0.94.0
  - @cat-factory/kernel@0.81.0
  - @cat-factory/integrations@0.61.0
  - @cat-factory/server@0.79.0
  - @cat-factory/orchestration@0.68.0
  - @cat-factory/gitlab@0.6.8
  - @cat-factory/agents@0.30.4
  - @cat-factory/consensus@0.8.29
  - @cat-factory/gates@0.2.84
  - @cat-factory/prompt-fragments@0.9.54
  - @cat-factory/spend@0.10.88
  - @cat-factory/observability-langfuse@0.7.127
  - @cat-factory/provider-bedrock@0.7.134
  - @cat-factory/provider-cloudflare@0.7.135
  - @cat-factory/provider-s3@0.2.77

## 0.69.1

### Patch Changes

- Updated dependencies [fcc8010]
  - @cat-factory/provider-cloudflare@0.7.134

## 0.69.0

### Minor Changes

- dbde3b8: Cross-node WebSocket propagation for the Node facade (optional Redis adapter).

  The Node facade's real-time transport (`NodeRealtimeHub`) is an in-process, single-node socket
  registry: an event published on the node that processed a run only reaches browsers connected to
  THAT node. A horizontally-scaled Node deployment spreads browsers and background work across
  several nodes, so an event produced on one node has to reach a browser attached to another.

  This adds that reach as a **layered propagator** with pluggable cross-node adapters. Publishing an
  event fans it to the local hub AND to each configured adapter; an adapter carries it to peer nodes,
  which apply it to their own local hubs. **Redis pub/sub is the first adapter** — a Postgres
  LISTEN/NOTIFY or NATS adapter would implement the same `WebSocketPropagator` port with no other
  changes.

  - `ioredis` is an **optional dependency**, imported dynamically only when `REDIS_URL` is set. With
    no bus configured (single-replica Node, and **local mode**, which is always single-node) the
    layer is exactly the bare hub with zero overhead and no extra dependency — the default.
  - Config: `REDIS_URL` enables it; `REDIS_REALTIME_CHANNEL` (default `cat-factory:realtime`) and
    `REALTIME_NODE_ID` (default a random uuid, used to drop a node's own echoes) tune it.
  - The engine's event publisher now writes through a narrow `LocalEventSink` seam that both the bare
    hub and the layered propagator implement, so no other code differs between single- and multi-node.

  The Worker facade needs none of this: its real-time transport is a globally-addressed
  `WorkspaceEventsHub` Durable Object (one per workspace across the whole deployment), so cross-node
  propagation is inherent to the platform — this is a genuine Node-only concern, not a facade gap.

## 0.68.0

### Minor Changes

- ef57cb1: Bug-triage pipeline, Phase A — pipeline `availability` (one-off / recurring / both).

  A library pipeline can now declare HOW it may be launched, so a recurring-only pipeline (the
  upcoming `pl_bug_triage`) can't be started as a manual one-off, and a one-off-only pipeline can't
  be attached to a schedule. Absent means `'both'` (unrestricted) — pre-1.0, no migration/back-fill,
  existing rows read unchanged.

  - **Contract**: `pipelineSchema` gains `availability?: 'one-off' | 'recurring' | 'both'` (+ the
    `PipelineAvailability` type, re-exported from kernel); `createPipeline`/`updatePipeline` accept
    and persist it.
  - **Persistence** (both runtimes, kept symmetric): `availability` is a new `pipelines.availability`
    column — D1 migration `0037_pipeline_availability.sql` ⇄ Drizzle schema + generated migration —
    read/written by the shared `rowToPipeline` mapper and both repos, so the field round-trips
    instead of being silently dropped on save.
  - **Server enforcement** (the pickers are convenience, not the gate): `ExecutionService.start`
    gains an `origin: 'manual' | 'recurring'` option (default `'manual'`), and a start-only
    `assertPipelineLaunchable` gate rejects a manual start of a recurring-only pipeline (and a
    scheduled fire of a one-off-only one). `RecurringPipelineService.fire` passes `'recurring'`; its
    `create`/`update` reject attaching a one-off-only pipeline to a schedule. A retry/restart
    re-drives an already-validated run, so it never re-checks the launch constraint. A pipeline
    carrying an ENABLED `bug-intake` step must be `'recurring'` (validated at builder save + start;
    a disabled step imposes no requirement). The schedule-attach check delegates to the same gate
    (one rule, one `ValidationError`), and `clone` re-runs it so an un-launchable copy can't be
    minted. Editing a pipeline to `'one-off'` while a schedule still references it is rejected
    (`ConflictError`) rather than silently breaking every future fire.
  - **SPA pickers**: the manual-start surfaces (add-task modal, board/inspector Run menus, task
    run-settings default) filter out `'recurring'`-only pipelines, and the recurring-pipeline modal
    filters out `'one-off'`-only ones — composed with the existing `pipelineAllowedForFrame`
    predicate.

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0
  - @cat-factory/kernel@0.80.0
  - @cat-factory/orchestration@0.67.0
  - @cat-factory/server@0.78.0
  - @cat-factory/agents@0.30.3
  - @cat-factory/consensus@0.8.28
  - @cat-factory/gates@0.2.83
  - @cat-factory/gitlab@0.6.7
  - @cat-factory/integrations@0.60.2
  - @cat-factory/prompt-fragments@0.9.53
  - @cat-factory/spend@0.10.87
  - @cat-factory/observability-langfuse@0.7.126
  - @cat-factory/provider-bedrock@0.7.133
  - @cat-factory/provider-cloudflare@0.7.133
  - @cat-factory/provider-s3@0.2.76

## 0.67.0

### Minor Changes

- 1d738f7: feat(recurring): on-demand (manual-only) recurring tasks that can use individual-usage subscriptions

  A recurring pipeline can now be flagged **on-demand**: it has no cadence and is never
  fired by the sweeper — it runs ONLY when a person triggers it via "run now". Because a
  human is present at every fire, an on-demand schedule's block MAY target an individual-usage
  subscription model (Claude / Codex / GLM), unlocked per run-now with the initiator's personal
  password exactly like a manual task start. A cadence schedule still refuses individual-usage
  models (no one is present to unlock them unattended).

  - New `onDemand` flag on `PipelineSchedule` + `createScheduleSchema` (recurrence is now
    optional — an on-demand schedule needs none). Persisted as an `on_demand` column on both
    runtimes (D1 migration `0037` ⇄ Drizzle), with `listDue` filtering `on_demand = 0` so the
    sweeper skips them. Cross-runtime conformance asserts the flag round-trips and run-now fires.
  - `RecurringPipelineService.fire` exempts on-demand schedules from the individual-usage
    refusal and threads the run-now initiator + credential-activation closure into the run;
    the run-now controller resolves the personal-credential gate (428 when a password is needed).
  - Frontend: an "on-demand" toggle in the add-recurring modal (hides the cadence editor), an
    on-demand inspector view (no cadence/pause, just run-now), and run-now now rides the cached
    personal password through the credential modal. i18n in all 8 locales.

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0
  - @cat-factory/orchestration@0.66.0
  - @cat-factory/server@0.77.0
  - @cat-factory/agents@0.30.2
  - @cat-factory/consensus@0.8.27
  - @cat-factory/gates@0.2.82
  - @cat-factory/gitlab@0.6.6
  - @cat-factory/integrations@0.60.1
  - @cat-factory/kernel@0.79.1
  - @cat-factory/prompt-fragments@0.9.52
  - @cat-factory/spend@0.10.86
  - @cat-factory/provider-bedrock@0.7.132
  - @cat-factory/provider-cloudflare@0.7.132
  - @cat-factory/observability-langfuse@0.7.125
  - @cat-factory/provider-s3@0.2.75

## 0.66.0

### Minor Changes

- 47a2975: Initiatives slice 3 — the execution loop.

  An approved initiative plan now RUNS: a new `InitiativeLoopService` drives each `executing`
  initiative — reconciling its spawned tasks, spawning the next wave just-in-time, and completing
  the initiative once every tracker item settles.

  - **The loop** (`orchestration/modules/initiative/InitiativeLoopService.ts`): per-initiative
    `tick` = reconcile (fold each spawned task block's status back onto its item — done + PR link /
    `pr_open` / `blocked` + deviation, one batched block read, no N+1) → complete (all items settled
    → initiative + anchor block `done`, tracker re-commit, notify) → spawn (create task blocks for
    the eligible `pending` items — current phase, deps met, phase not halted — up to the concurrency
    cap, each pipeline chosen by the policy's estimate→pipeline rules). Spawning is CLAIM-FIRST (a
    rev-CAS write records the pre-generated block id before any side effect), so a concurrent ticker
    never orphans a double-spawn. A per-service task-limit conflict leaves the item `pending` for the
    next sweep; a missing pipeline (deleted after ingest) records a deviation + notification and
    blocks the item — the sweep never throws.
  - **Blocked = halt the phase, notify.** A blocked item stops new spawns in its phase (and keeps the
    phase current, so the initiative never advances past it) and raises the new `initiative`
    notification type; in-flight siblings finish. A human retries/skips the item to unblock.
  - **Both cron seams + terminal pokes.** `runDue` is wired into the Worker `scheduled` handler and a
    Node one-minute interval sweeper (symmetric). A settling child run pokes its owning initiative's
    loop immediately (`RunStateMachine.emitInstance` on a terminal run, `ExecutionService.finalizeMerge`
    on a merge), so work advances without waiting for the next sweep.
  - **Controls.** Pause / resume / cancel endpoints + `InitiativeService` CAS transitions; the sweep
    skips a non-`executing` initiative. The tracker window gains a live progress bar and the inspector
    the loop controls (`initiative.inspector.pause/resume/cancel`, all locales).
  - **`listExecuting()` now returns `{ workspaceId, initiative }[]`** (the entity carries no workspace
    id) — mirrored in the D1 + Drizzle repos and asserted, with the persisted loop-state round-trip,
    by the cross-runtime conformance suite.

  No new persistence (the `initiatives` table already exists on both facades) — so no D1/Drizzle
  migration and no executor-harness image bump.

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0
  - @cat-factory/kernel@0.79.0
  - @cat-factory/integrations@0.60.0
  - @cat-factory/orchestration@0.65.0
  - @cat-factory/server@0.76.0
  - @cat-factory/agents@0.30.1
  - @cat-factory/consensus@0.8.26
  - @cat-factory/gates@0.2.81
  - @cat-factory/gitlab@0.6.5
  - @cat-factory/prompt-fragments@0.9.51
  - @cat-factory/spend@0.10.85
  - @cat-factory/observability-langfuse@0.7.124
  - @cat-factory/provider-bedrock@0.7.131
  - @cat-factory/provider-cloudflare@0.7.131
  - @cat-factory/provider-s3@0.2.74

## 0.65.2

### Patch Changes

- 0477068: Mothership mode: widen the persistence-RPC allow-list to four more repository surfaces (the
  prompt-fragment library + two account-onboarding reads) so mothership-mode local nodes can drive
  them against a hosted mothership. Adds two new scope rules, `owner` (an `(ownerKind, ownerId)`
  positional pair) and `ownerField` (the same as record fields on `upsert`), which resolve a
  `workspace` owner to its account and take an `account` owner as the accountId directly — so a
  machine token scoped to one account can never read/write another tenant's rows.

  - `promptFragmentRepository` — the tenant-scoped prompt-fragment library management surface
    (`listByOwner`/`get`/`softDelete` via the `owner` rule, `upsert` via `ownerField`). Rows carry no
    secrets and both tiers are member-level (account-tier routes guard on `requireMember`, not
    `requireAdmin`). The `sourceId`-keyed `listBySource` (repo-sync fan-out) stays mothership-internal.
  - `fragmentSourceRepository` — the fragment-source library list + link (`listByOwner` via `owner`,
    `upsert` via `ownerField`). The `sourceId`-keyed `get`/`updateSyncState`/`softDelete` stay off —
    they back the repo-sync the mothership owns (its source service needs a GitHub client a mothership
    node lacks). Node routes both fragment repos through the `pickRepoSource`/`if (remoteRepos)` seam
    ONLY when the library is configured, so the module isn't spuriously turned on in mothership mode.
  - `invitationRepository.listByAccount` — the account members panel's pending-invite read (member-level,
    `account` rule). Invite `create`/`setStatus` (admin-gated) + the pre-auth `findByTokenHash`/`get`
    accept-invite lookups stay off.
  - `emailConnectionRepository.getByAccount` — the email-settings panel read (member-level, `account`
    rule). Its provider key rides a sealed `apiKeyCipher` blob (the repo never decrypts), so no
    plaintext crosses the machine API. Connect/disconnect (`upsert`/`softDelete`, admin-gated) stay off.

- Updated dependencies [0477068]
  - @cat-factory/server@0.75.2

## 0.65.1

### Patch Changes

- 4a59f45: Mothership mode: widen the persistence-RPC allow-list to three more repository surfaces so
  mothership-mode local nodes can drive them against a hosted mothership.

  - `runnerPoolConnectionRepository` (whole repo) — the self-hosted runner-backend connection
    settings panel (`getByWorkspace`/`softDelete` via the `workspace` rule, the record-based
    `upsert` via `workspaceField`). Credentials ride a sealed `secretsCipher` blob, so no plaintext
    crosses the machine API (the observability/environment-connection precedent).
  - `binaryArtifactMetadataStore` (metadata surface) — the visual-confirmation gate's artifact
    metadata (`insert` via `workspaceField`; `get`/`listByExecution`/`countByExecution`/`listByBlock`/
    `delete` via `workspace`). The blob BYTES stay per-account local; only the metadata is proxied,
    and the retention sweep stays mothership-internal. It is folded into both facades' reflected
    `repositories` registry (it isn't a `CoreDependencies` member).
  - `serviceRepository.listByFrameBlocks` — the batched board-composition / frame-deletion read, via
    the `blockList` scope kind.

- Updated dependencies [4a59f45]
  - @cat-factory/server@0.75.1

## 0.65.0

### Minor Changes

- b928904: Service connections Phase 2 — multi-env provisioning. A `deployer` step now fans out over
  the task's own service frame PLUS each connected involved-service frame, provisioning one
  ephemeral environment per frame (dispatched provider-before-consumer, parked between), each
  keyed per `(blockId, frameId)` so the fan-out no longer clobbers itself. Already-ready peers
  are injected into a later provision as `{{input.peerEnvUrls}}`, the agent context gains
  `involvedServices` (title + connection description + the peer's live env URL, read-time
  stale-filtered), and the Tester infra spec gains a `peerEnvironments` map so a cross-service
  integration test can reach a peer's real environment.

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/orchestration@0.64.0
  - @cat-factory/contracts@0.90.0
  - @cat-factory/kernel@0.78.0
  - @cat-factory/integrations@0.59.0
  - @cat-factory/agents@0.30.0
  - @cat-factory/server@0.75.0
  - @cat-factory/consensus@0.8.25
  - @cat-factory/gates@0.2.80
  - @cat-factory/gitlab@0.6.4
  - @cat-factory/prompt-fragments@0.9.50
  - @cat-factory/spend@0.10.84
  - @cat-factory/observability-langfuse@0.7.123
  - @cat-factory/provider-bedrock@0.7.130
  - @cat-factory/provider-cloudflare@0.7.130
  - @cat-factory/provider-s3@0.2.73

## 0.64.2

### Patch Changes

- f372f4e: Mothership mode: allow-list the ephemeral-environment connection management surface.

  The environment provider-connection + per-type infra-handler settings panels
  (`EnvironmentController` → `EnvironmentConnectionService`: connect / list / disconnect a
  backend, register / test / re-secret / unregister a per-type engine handler) are now
  functional in mothership mode, alongside the workspace-defined custom-manifest-type catalog
  the infra configurator reads + edits.

  - Newly allow-listed in `REMOTE_PERSISTENCE_METHODS`: the whole `environmentConnectionRepository`
    (`listByWorkspace`/`getByWorkspaceAndType`/`softDelete` via the `workspace` rule, the
    record-based `upsert` via the `workspaceField` rule) and the whole `customManifestTypeRepository`
    (`listByWorkspace`/`remove` via `workspace`, `upsert` via `workspaceField`). Member-level,
    workspace-scoped — the same policy as the observability / other settings panels.
  - Safe to expose like the observability connection: the connection record carries handler secrets
    as a **sealed** `secretsCipher` blob (the repo returns it verbatim; sealing/decryption live in
    the service under the local key), so no plaintext credential crosses the machine API and the
    mothership only ever stores ciphertext. Custom-manifest-type rows carry no secrets.
  - `customManifestTypeRepository` (built directly over `db` by `selectNodeEnvironmentsDeps`) is now
    routed through the `pickRepoSource`/`remoteRepos` seam in `buildNodeContainer` so it resolves
    from the remote registry when there is no Postgres (`environmentConnectionRepository` was already
    routed).

  Deliberately still off (a later secrets-delegation slice): actually provisioning an environment
  (`environmentRegistryRepository.insert`/`update`) + decrypting a remotely-sealed access cipher.
  Server-only allow-list change + one routing line, symmetric by construction.

- Updated dependencies [7fa7578]
- Updated dependencies [f372f4e]
  - @cat-factory/contracts@0.89.0
  - @cat-factory/kernel@0.77.0
  - @cat-factory/orchestration@0.63.0
  - @cat-factory/server@0.74.0
  - @cat-factory/agents@0.29.1
  - @cat-factory/consensus@0.8.24
  - @cat-factory/gates@0.2.79
  - @cat-factory/gitlab@0.6.3
  - @cat-factory/integrations@0.58.1
  - @cat-factory/prompt-fragments@0.9.49
  - @cat-factory/spend@0.10.83
  - @cat-factory/observability-langfuse@0.7.122
  - @cat-factory/provider-bedrock@0.7.129
  - @cat-factory/provider-cloudflare@0.7.129
  - @cat-factory/provider-s3@0.2.72

## 0.64.1

### Patch Changes

- Updated dependencies [6917962]
  - @cat-factory/server@0.73.1

## 0.64.0

### Minor Changes

- 55661f4: Add a public, key-authenticated external API (`/api/v1`) whose first use-case is "break down an
  initiative": an external system picks a public, inline pipeline and posts a brief, and the platform
  runs it headlessly and persists the result in the DB for asynchronous retrieval (poll
  `GET /api/v1/jobs/:id` or stream `GET /api/v1/jobs/:id/events` over SSE). Nothing is committed to
  GitHub — the run uses an inline agent (`initiative-breakdown`) with no container/repo.

  - Inbound public-API keys (`public_api_keys`, mirrored D1 ⇄ Drizzle) are revocable and stored as a
    one-way peppered hash (`HMAC-SHA256(secret, ENCRYPTION_KEY)`) — never plaintext, never
    recoverable. Managed per-workspace via `GET|POST|DELETE /workspaces/:ws/public-api-keys`; the raw
    key is shown once on create.
  - Runs are anchored on a headless `internal` block excluded from every board projection, so the
    external runs never appear in the UI.
  - Requires `ENCRYPTION_KEY` (the HMAC pepper); the surface 503s when unconfigured.

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/contracts@0.88.0
  - @cat-factory/kernel@0.76.0
  - @cat-factory/agents@0.29.0
  - @cat-factory/integrations@0.58.0
  - @cat-factory/server@0.73.0
  - @cat-factory/orchestration@0.62.0
  - @cat-factory/consensus@0.8.23
  - @cat-factory/gates@0.2.78
  - @cat-factory/gitlab@0.6.2
  - @cat-factory/prompt-fragments@0.9.48
  - @cat-factory/spend@0.10.82
  - @cat-factory/observability-langfuse@0.7.121
  - @cat-factory/provider-bedrock@0.7.128
  - @cat-factory/provider-cloudflare@0.7.128
  - @cat-factory/provider-s3@0.2.71

## 0.63.0

### Minor Changes

- ca5c3e8: Initiatives (slice 1 of 4): the long-running, multi-task counterpart to a task — see
  `docs/initiatives/initiatives-feature.md` for the full multi-slice plan.

  - **New `initiative` block level** — a container block under a service frame (created via the
    new "Create initiative" button in the frame header, next to add-task/import-task). Tasks a
    later slice's execution loop spawns link back via the new `blocks.initiative_id` membership
    column (epic-style). D1 migration `0035_initiatives.sql` ⇄ Drizzle schema, shared mapper.
  - **New `initiatives` entity + store** — the DB row is the source of truth (phases, items with
    planner-authored estimates + dependencies, the execution policy with estimate→pipeline rules,
    decisions / deviations / follow-ups / caveats), guarded by a `rev` compare-and-swap so the
    loop has a single logical writer. Mirrored D1 ⇄ Drizzle repositories with a cross-runtime
    conformance suite (CRUD, doc round-trip, CAS conflict, `blocks.initiative_id`).
  - **Initiative Planning pipeline skeleton (`pl_initiative`)** — `initiative-planner` (a
    read-only structured container explore that drafts the multi-phase plan, gated for human
    approval) + `initiative-committer` (a deterministic engine step that flips the entity to
    `executing` and commits the rendered tracker to `docs/initiatives/<slug>/` — canonical
    `initiative.json` + human `tracker.md` + `version.json`, hash-short-circuited and
    replay-safe, following the blueprint artifact pattern). A bidirectional guard in the
    engine's shared `assertRunnable` makes `pl_initiative` the ONLY pipeline runnable on an
    initiative block (and vice versa), across start/retry/restart.
  - **API + snapshot + realtime** — `POST/GET /workspaces/:ws/initiatives` (+ by-block read),
    the snapshot's optional `initiatives` field, and a new `initiative` WorkspaceEvent pushed
    from both runtimes' publishers.
  - **Frontend** — the Create Initiative modal + frame-header button, the initiative board card,
    an inspector body (run planning / open tracker) and the read-only Initiative Tracker window
    (`initiative-tracker` result view), with the `initiative.*` i18n namespace across all 8
    locales.

  Later slices add the interactive planning interview, the execution loop (just-in-time task
  spawning with estimate-gated pipeline selection), and follow-up/deviation harvesting.

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/contracts@0.87.0
  - @cat-factory/kernel@0.75.0
  - @cat-factory/agents@0.28.0
  - @cat-factory/orchestration@0.61.0
  - @cat-factory/server@0.72.0
  - @cat-factory/consensus@0.8.22
  - @cat-factory/gates@0.2.77
  - @cat-factory/gitlab@0.6.1
  - @cat-factory/integrations@0.57.2
  - @cat-factory/prompt-fragments@0.9.47
  - @cat-factory/spend@0.10.81
  - @cat-factory/observability-langfuse@0.7.120
  - @cat-factory/provider-bedrock@0.7.127
  - @cat-factory/provider-cloudflare@0.7.127
  - @cat-factory/provider-s3@0.2.70

## 0.62.2

### Patch Changes

- Updated dependencies [cc924a9]
  - @cat-factory/agents@0.27.1
  - @cat-factory/orchestration@0.60.4
  - @cat-factory/consensus@0.8.21
  - @cat-factory/provider-bedrock@0.7.126
  - @cat-factory/provider-cloudflare@0.7.126
  - @cat-factory/server@0.71.2

## 0.62.1

### Patch Changes

- Updated dependencies [803fa76]
  - @cat-factory/server@0.71.1

## 0.62.0

### Minor Changes

- b216fdc: Fragment GitHub-source staleness is now a lightweight commit-version check.

  The full fragment bodies were already cached on our side; the "check for changes"
  probe previously re-listed the whole source directory and hashed every blob sha.
  It now reads only the source directory's current head commit sha and compares it to
  the commit the source was last synced to — a single cheap GitHub/GitLab call, no
  directory listing or file reads.

  Breaking (pre-1.0, no migration): `FragmentSource`/`FragmentSyncResult` now expose
  `lastSyncedCommit` instead of `lastSyncedSha`, and `FragmentSourceStatus` is
  `{ changed, lastSyncedCommit, remoteCommit }` (the per-file `changedCount`/`remoteSha`
  are gone — the resync badge is now a plain "changes available" indicator). A new
  `latestCommitSha` port method is added to `GitHubClient` and `VcsClient`. The physical
  `fragment_sources.last_synced_sha` column is unchanged and reused to store the commit
  sha, so no database migration is required; existing rows re-derive their commit on the
  next sync.

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0
  - @cat-factory/contracts@0.86.0
  - @cat-factory/agents@0.27.0
  - @cat-factory/server@0.71.0
  - @cat-factory/gitlab@0.6.0
  - @cat-factory/consensus@0.8.20
  - @cat-factory/gates@0.2.76
  - @cat-factory/integrations@0.57.1
  - @cat-factory/observability-langfuse@0.7.119
  - @cat-factory/orchestration@0.60.3
  - @cat-factory/provider-bedrock@0.7.125
  - @cat-factory/provider-cloudflare@0.7.125
  - @cat-factory/provider-s3@0.2.69
  - @cat-factory/spend@0.10.80
  - @cat-factory/prompt-fragments@0.9.46

## 0.61.2

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0
  - @cat-factory/server@0.70.0
  - @cat-factory/integrations@0.57.0
  - @cat-factory/gitlab@0.5.0
  - @cat-factory/agents@0.26.18
  - @cat-factory/consensus@0.8.19
  - @cat-factory/gates@0.2.75
  - @cat-factory/observability-langfuse@0.7.118
  - @cat-factory/orchestration@0.60.2
  - @cat-factory/provider-bedrock@0.7.124
  - @cat-factory/provider-cloudflare@0.7.124
  - @cat-factory/provider-s3@0.2.68
  - @cat-factory/spend@0.10.79

## 0.61.1

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0
  - @cat-factory/kernel@0.72.0
  - @cat-factory/gates@0.2.74
  - @cat-factory/orchestration@0.60.1
  - @cat-factory/agents@0.26.17
  - @cat-factory/consensus@0.8.18
  - @cat-factory/gitlab@0.4.45
  - @cat-factory/integrations@0.56.5
  - @cat-factory/prompt-fragments@0.9.45
  - @cat-factory/server@0.69.1
  - @cat-factory/spend@0.10.78
  - @cat-factory/observability-langfuse@0.7.117
  - @cat-factory/provider-bedrock@0.7.123
  - @cat-factory/provider-cloudflare@0.7.123
  - @cat-factory/provider-s3@0.2.67

## 0.61.0

### Minor Changes

- b78adf5: Private package registries: workspace-scoped npm registry credentials (npm private
  orgs + GitHub Packages) that agent containers use to resolve private dependencies on
  checkout.

  - **Storage**: one `package_registry_connections` row per workspace (D1 migration 0034
    ⇄ Drizzle mirror) holding a single sealed JSON array of entries
    (`{ id, ecosystem: 'npm', vendor: 'npmjs' | 'github-packages', scopes, token }`,
    cipher tag `cat-factory:package-registries`) plus a non-secret summary (vendor +
    scopes + token tail). Ecosystem-discriminated so pip/maven/cargo are later additive.
  - **API**: `GET|POST /workspaces/:ws/package-registries`, `DELETE …/:entryId`
    (`PackageRegistriesController`, 503 when the module is unwired). Tokens are
    write-only — the list view never returns them; edit = delete + re-add. Only one
    entry per vendor is allowed (a 409 otherwise): the harness renders a single
    host-keyed `_authToken` per registry, so a duplicate token would be silently
    dropped — put every scope for a vendor on its one entry. Tokens are validated as a
    single opaque printable-ASCII string (no spaces/control characters) so a token can't
    inject extra `~/.npmrc` lines.
  - **Dispatch**: `ContainerAgentExecutor` + `ContainerRepoBootstrapper` accept a
    `resolvePackageRegistries` seam (wired in both facades from the same store) and
    forward the decrypted entries as a `packageRegistries` field on every container job
    body, like `ghToken`. The registry host is derived backend-side from the fixed
    vendor set. A resolution failure fails the dispatch rather than silently running
    without auth. The agent-context snapshot's allow-list projection excludes the field.
  - **UI**: a "Private package registries" panel in the Integrations hub
    (`PackageRegistriesPanel.vue`) — vendor preset + scopes + write-only token, entries
    listed from the redacted summary.
  - **Conformance**: a new suite section asserts add → redacted list → decrypted
    dispatch resolution → remove identically on D1 and Postgres.

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0
  - @cat-factory/orchestration@0.60.0
  - @cat-factory/kernel@0.71.0
  - @cat-factory/server@0.69.0
  - @cat-factory/agents@0.26.16
  - @cat-factory/consensus@0.8.17
  - @cat-factory/gates@0.2.73
  - @cat-factory/gitlab@0.4.44
  - @cat-factory/integrations@0.56.4
  - @cat-factory/prompt-fragments@0.9.44
  - @cat-factory/spend@0.10.77
  - @cat-factory/observability-langfuse@0.7.116
  - @cat-factory/provider-bedrock@0.7.122
  - @cat-factory/provider-cloudflare@0.7.122
  - @cat-factory/provider-s3@0.2.66

## 0.60.2

### Patch Changes

- e0aab3f: Connections between services, phase 1 of the service-connections initiative (see
  `backend/docs/service-connections.md` + `docs/initiatives/service-connections.md`):

  - **Service connections**: a `service`-type frame carries `serviceConnections` — directed
    consumer→provider edges to the other services it uses, each with an optional
    description ("sends transactional email via it"). Stored as a JSON column on the block
    (D1 migration `0034` ⇄ Drizzle), validated at the `updateBlock` write gate (no
    self-connection, no duplicates, targets must be service frames; cycles are deliberately
    legal), pruned when a connected frame is deleted, and drawn as emerald consumer→provider
    edges on the board. A new inspector panel on service frames edits the connections and
    shows the reverse "Used by" list.
  - **Per-task involved services**: a task carries `involvedServiceIds` — the connected
    services directly involved in it beyond its own service, picked (in the task's run
    settings) from the frame's connection neighbors in either direction. Validated at the
    write gate against the neighbor set; a selection whose connection was later removed is
    badged stale in the UI and dropped on the next change. Later phases use the selection
    to provision every involved service as an ephemeral environment and to let the coding
    agent change every involved repo (multi-repo sibling checkouts) — designed in the
    docs, not yet implemented.
  - Cross-runtime conformance now round-trips both JSON columns and asserts the write-gate
    rejections on both stores.

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0
  - @cat-factory/kernel@0.70.2
  - @cat-factory/orchestration@0.59.2
  - @cat-factory/server@0.68.2
  - @cat-factory/agents@0.26.15
  - @cat-factory/consensus@0.8.16
  - @cat-factory/gates@0.2.72
  - @cat-factory/gitlab@0.4.43
  - @cat-factory/integrations@0.56.3
  - @cat-factory/prompt-fragments@0.9.43
  - @cat-factory/spend@0.10.76
  - @cat-factory/observability-langfuse@0.7.115
  - @cat-factory/provider-bedrock@0.7.121
  - @cat-factory/provider-cloudflare@0.7.121
  - @cat-factory/provider-s3@0.2.65

## 0.60.1

### Patch Changes

- 0d51638: Boundary hardening:

  - **Local mode** now enforces a minimum strength on the required crypto secrets at config
    load: `AUTH_SESSION_SECRET` must be ≥32 characters (local mode defaults the auth gate open,
    so a weak secret would leave session/proxy/machine tokens forgeable) and `ENCRYPTION_KEY`
    must decode to a full 32-byte key (surfaced early instead of deep in the first cipher build).
  - **GitHub webhook verifier** fails closed when the webhook secret is unset (previously it would
    import an empty HMAC key and compare), matching the GitLab verifier.
  - **CORS** no longer reflects an arbitrary Origin by default outside development: an unset
    `CORS_ALLOWED_ORIGINS` reflects any origin only when `ENVIRONMENT` is an explicitly
    recognised development value (`development`/`dev`/`test`/`testing`/`local`/`e2e`). An
    unset, unknown, or production `ENVIRONMENT` default-denies (fails safe), so a deployment
    that forgets BOTH `ENVIRONMENT` and `CORS_ALLOWED_ORIGINS` no longer silently reflects.
    An explicit `*` still opts into reflect-all.

- Updated dependencies [0d51638]
- Updated dependencies [0d51638]
- Updated dependencies [0d51638]
  - @cat-factory/integrations@0.56.2
  - @cat-factory/server@0.68.1
  - @cat-factory/kernel@0.70.1
  - @cat-factory/orchestration@0.59.1
  - @cat-factory/agents@0.26.14
  - @cat-factory/consensus@0.8.15
  - @cat-factory/gates@0.2.71
  - @cat-factory/gitlab@0.4.42
  - @cat-factory/observability-langfuse@0.7.114
  - @cat-factory/provider-bedrock@0.7.120
  - @cat-factory/provider-cloudflare@0.7.120
  - @cat-factory/provider-s3@0.2.64
  - @cat-factory/spend@0.10.75

## 0.60.0

### Minor Changes

- eb67d40: Record per-call LLM telemetry for the Claude Code and Codex subscription harnesses,
  so their calls appear in the same `llm_call_metrics` store (and the "Model activity"
  observability panel) as the proxy-metered Pi harness.

  These harnesses talk direct to the vendor and bypass the LLM proxy, so the harness now
  lifts per-call metrics off each CLI's event stream: Claude Code (`stream-json --verbose`)
  carries full request/response bodies, per-turn tokens, model, and finish reason; Codex
  (`exec --json`) is thinner — flat assistant text plus per-turn token counts, with no
  request transcript (a CLI limitation). The executor records these into the SAME
  `LlmObservabilityService` the proxy uses (with zero per-HTTP timing, since the CLIs don't
  expose it), wired symmetrically on the Cloudflare and Node facades. Captured bodies are
  credential-scrubbed and honour the existing `LLM_RECORD_PROMPTS` switch. Telemetry is
  recorded on failed runs too (not only successful ones), so a token-spending run that
  ends with no changes / unusable output stays observable, and each row is minted a
  deterministic id off the job id so a durable-driver replay re-records idempotently.

  Also tightens `LLM_RECORD_PROMPTS`: it now empties the response and reasoning bodies as
  well as the prompt when recording is off (previously only the prompt was suppressed),
  so a deployment that opts out of retaining prompts no longer retains model replies
  either.

  Bumps the executor-harness runner image (harness `src/**` changed).

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/kernel@0.70.0
  - @cat-factory/orchestration@0.59.0
  - @cat-factory/server@0.68.0
  - @cat-factory/agents@0.26.13
  - @cat-factory/consensus@0.8.14
  - @cat-factory/gates@0.2.70
  - @cat-factory/gitlab@0.4.41
  - @cat-factory/integrations@0.56.1
  - @cat-factory/observability-langfuse@0.7.113
  - @cat-factory/provider-bedrock@0.7.119
  - @cat-factory/provider-cloudflare@0.7.119
  - @cat-factory/provider-s3@0.2.63
  - @cat-factory/spend@0.10.74

## 0.59.4

### Patch Changes

- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0
  - @cat-factory/integrations@0.56.0
  - @cat-factory/server@0.67.0
  - @cat-factory/agents@0.26.12
  - @cat-factory/consensus@0.8.13
  - @cat-factory/gates@0.2.69
  - @cat-factory/gitlab@0.4.40
  - @cat-factory/kernel@0.69.8
  - @cat-factory/orchestration@0.58.1
  - @cat-factory/prompt-fragments@0.9.42
  - @cat-factory/spend@0.10.73
  - @cat-factory/provider-bedrock@0.7.118
  - @cat-factory/provider-cloudflare@0.7.118
  - @cat-factory/observability-langfuse@0.7.112
  - @cat-factory/provider-s3@0.2.62

## 0.59.3

### Patch Changes

- 7f9d215: Fix critical/high race conditions from the July 2026 audit:

  - **Spend-resume on Cloudflare (1.1):** a spend-paused run's `ExecutionWorkflow`
    instance no longer returns (going terminal). It now stays alive **parked on a
    `waitForEvent`** (like a human-decision wait, not a busy sleep-loop), so a long pause
    no longer accretes unbounded durable steps. `/spend/resume` wakes it immediately via a
    new `WorkRunner.signalResume` (a `spend-resume` event), and a 24h re-check chunk
    auto-resumes it when the monthly budget frees — instead of the terminal-instance-id
    trap that let the cron sweeper force-fail the "resumed" run.
  - **Spend-resume on Node/local (parity):** Node/local now auto-resume spend-paused runs
    when the monthly budget frees, via a new `agentRunRepository.listPausedExecutions`
    polled by the reclaim sweeper (gated on `isOverBudget`, so a still-exhausted workspace
    causes no churn) — matching the Cloudflare facade. Covered by a conformance assertion.
  - **BootstrapWorkflow re-drive (1.2):** past the poll-read tolerance the workflow no
    longer returns (going terminal, which made the sweeper force-fail a merely-busy
    container). It keeps the instance alive and keeps polling, so a long clone/install
    recovers.
  - **One live execution run per block (2.1):** a new partial unique index on live
    execution rows per block (D1 migration `0033` ⇄ Drizzle) plus an **atomic**
    `ExecutionRepository.insertLive` that deletes the block's terminal rows (and the
    caller's own `replaceId`) and inserts the new run **in one transaction** (D1
    `db.batch` / Drizzle `transaction`). `start`/`retry`/`restartFromStep` no longer
    `deleteByBlock` first, so a genuinely-concurrent double start is rejected with a 409
    instead of the pre-delete wiping a concurrent winner and creating two live runs — two
    drivers, two containers — on one branch. Covered by cross-runtime conformance
    assertions (terminal cleanup + `replaceId` supersede).

- 05d1b08: refactor(integrations): app-own the user-secret-kind registry (registry DI migration)

  Migrates the per-user secret KIND registry off its module-global `Map` onto an app-owned
  instance, the next slice of the registry-DI initiative (see
  `docs/initiatives/registry-di-migration.md`). The composition root now owns the registry and
  injects it, so a deployment-registered custom kind is seen by reference regardless of module
  identity — the same footgun-free pattern as the environment/runner backend registries.

  - New `UserSecretKindRegistry` class (`register`/`get`/`list`) + `defaultUserSecretKindRegistry()`
    pre-loaded with the built-in `github_pat` kind, added to `BackendRegistries` /
    `createBackendRegistries()`. `UserSecretService` reads the injected registry.
  - **Breaking:** the free `registerUserSecretKind` / `getUserSecretKind` / `listUserSecretKinds`
    exports are removed (pre-1.0, no back-compat). The built-in kind is now the exported
    `githubPatUserSecretKind` handler, registered into the default registry.
  - Wired symmetrically into the Worker + Node facades (local inherits via `buildNodeContainer`);
    the cross-runtime conformance suite asserts a programmatically-registered custom kind is
    described identically on every runtime.

- Updated dependencies [7f9d215]
- Updated dependencies [05d1b08]
  - @cat-factory/kernel@0.69.7
  - @cat-factory/orchestration@0.58.0
  - @cat-factory/server@0.66.7
  - @cat-factory/integrations@0.55.0
  - @cat-factory/agents@0.26.11
  - @cat-factory/consensus@0.8.12
  - @cat-factory/gates@0.2.68
  - @cat-factory/gitlab@0.4.39
  - @cat-factory/observability-langfuse@0.7.111
  - @cat-factory/provider-bedrock@0.7.117
  - @cat-factory/provider-cloudflare@0.7.117
  - @cat-factory/provider-s3@0.2.61
  - @cat-factory/spend@0.10.72

## 0.59.2

### Patch Changes

- 9577c4a: Fix a batch of native-mode (`LOCAL_NATIVE_AGENTS`) agent-harness bugs:

  - The harnesses (executor + deploy) now shut down gracefully on SIGTERM/SIGINT:
    every running job is aborted (`JobRegistry.abortAll`) so in-flight `claude`/
    `codex`/git/kubectl children are killed instead of being orphaned. Previously a
    dev-server restart left the agent CLI running unsupervised on the developer's
    login. The abort now targets the child's whole process group (POSIX), so the
    CLI's own grandchildren (a shell tool, a build, its git) die with it rather than
    reparenting to init. Shutdown exits as soon as the aborted jobs settle (capped at
    6s) instead of always waiting the fixed window. Both harness servers also honor a
    new `HARNESS_BIND_HOST` env, which the native transport sets to `127.0.0.1` so the
    unsandboxed agent-spawning API is no longer reachable from the LAN (containers keep
    binding all interfaces).
  - The native host-process transport sanitizes the harness child's environment to an
    allow-list (`LOCAL_HARNESS_ENV_ALLOW` extends it), so the orchestrator's secrets
    (DATABASE_URL, ENCRYPTION_KEY, GITHUB_PAT, provider keys) no longer leak into the
    ambient agent's env; the inline ambient CLI runner is sanitized the same way. The
    allow-list keeps the TLS trust-anchor vars (NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, ...)
    alongside the proxy vars, so a corporate TLS-terminating proxy still works. The
    deploy transport keeps full inheritance (kubectl/helm need ambient cluster env).
  - Process-lifecycle fixes in `LocalProcessRunnerTransport`: a harness that never
    becomes healthy is killed instead of leaking one process per retry, and
    `shutdown()` racing an in-flight lazy start now kills the child instead of
    resurrecting it. The local/Node graceful-shutdown path now invokes the
    container's `onShutdown`, which stops the native harnesses; that call is isolated
    in its own try so a failing pg-boss/pool teardown can't skip it.
  - `NativeRoutingRunnerTransport` no longer reports a blanket eviction for refs it
    doesn't know: after an orchestrator restart both `poll` and `release` fall back to
    the container leg (which re-finds a per-run container by label), so a still-running
    container job is re-attached / torn down instead of spuriously re-driven or leaked.
  - Config typos are no longer silent: unrecognized `LOCAL_NATIVE_AGENTS` tokens and
    an unrecognized/under-configured `LOCAL_DEPLOY_RUNTIME` now log a boot warning
    (behavior still fails safe).

- Updated dependencies [4955639]
  - @cat-factory/agents@0.26.10
  - @cat-factory/orchestration@0.57.7
  - @cat-factory/server@0.66.6
  - @cat-factory/consensus@0.8.11
  - @cat-factory/provider-bedrock@0.7.116
  - @cat-factory/provider-cloudflare@0.7.116

## 0.59.1

### Patch Changes

- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3
  - @cat-factory/server@0.66.5
  - @cat-factory/orchestration@0.57.6
  - @cat-factory/agents@0.26.9
  - @cat-factory/consensus@0.8.10
  - @cat-factory/gates@0.2.67
  - @cat-factory/gitlab@0.4.38
  - @cat-factory/integrations@0.54.3
  - @cat-factory/kernel@0.69.6
  - @cat-factory/prompt-fragments@0.9.41
  - @cat-factory/spend@0.10.71
  - @cat-factory/provider-bedrock@0.7.115
  - @cat-factory/provider-cloudflare@0.7.115
  - @cat-factory/observability-langfuse@0.7.110
  - @cat-factory/provider-s3@0.2.60

## 0.59.0

### Minor Changes

- 4e82496: Enable the prompt-fragment library by default and streamline linking GitHub-backed fragments.

  - The prompt-fragment library (ADR 0006) is now **on by default** in both runtimes; opt out
    with `PROMPT_LIBRARY_ENABLED=false`. Previously it was off unless `PROMPT_LIBRARY_ENABLED=true`
    was set, so linking a GitHub document as a fragment failed with "Prompt-fragment library is
    not configured" on a stock deployment.
  - The fragment-library manager now reuses the same GitHub affordances as the other repo
    windows: a **server-side repo search** (new `GitHubRepoSearchSelect`) plus the
    `RepoTreeBrowser` to browse to a **file** (document-backed fragments) or **directory**
    (repo sources), instead of hand-typing `owner`/`repo`/`path`/`ref`. Manual entry remains as
    a fallback when the GitHub App isn't connected.
  - When the library is explicitly disabled, the manager now shows a clear notice instead of
    offering forms that fail with a raw 503.

### Patch Changes

- Updated dependencies [6347d0e]
- Updated dependencies [6439181]
  - @cat-factory/server@0.66.4

## 0.58.6

### Patch Changes

- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2
  - @cat-factory/integrations@0.54.2
  - @cat-factory/server@0.66.3
  - @cat-factory/agents@0.26.8
  - @cat-factory/consensus@0.8.9
  - @cat-factory/gates@0.2.66
  - @cat-factory/gitlab@0.4.37
  - @cat-factory/kernel@0.69.5
  - @cat-factory/orchestration@0.57.5
  - @cat-factory/prompt-fragments@0.9.40
  - @cat-factory/spend@0.10.70
  - @cat-factory/provider-bedrock@0.7.114
  - @cat-factory/provider-cloudflare@0.7.114
  - @cat-factory/observability-langfuse@0.7.109
  - @cat-factory/provider-s3@0.2.59

## 0.58.5

### Patch Changes

- fc8df61: Restore cross-runtime block-ordering parity: the Postgres block repository's list reads
  (`listByWorkspace`/`listByService`/`listByServices`) had no `ORDER BY`, so block iteration
  order was non-deterministic and diverged from the Cloudflare facade's `ORDER BY rowid`.
  The `blocks` table gains a `seq` insert-sequence column (same pattern as `pipelines.seq`)
  and all three list reads order by it. Existing rows are backfilled by the migration in
  whatever order Postgres returns them (pre-1.0: close enough, self-heals as rows churn).
- Updated dependencies [fc8df61]
  - @cat-factory/agents@0.26.7
  - @cat-factory/server@0.66.2
  - @cat-factory/consensus@0.8.8
  - @cat-factory/orchestration@0.57.4
  - @cat-factory/provider-bedrock@0.7.113
  - @cat-factory/provider-cloudflare@0.7.113

## 0.58.4

### Patch Changes

- Updated dependencies [2a91615]
  - @cat-factory/contracts@0.81.1
  - @cat-factory/orchestration@0.57.3
  - @cat-factory/integrations@0.54.1
  - @cat-factory/server@0.66.1
  - @cat-factory/agents@0.26.6
  - @cat-factory/consensus@0.8.7
  - @cat-factory/gates@0.2.65
  - @cat-factory/gitlab@0.4.36
  - @cat-factory/kernel@0.69.4
  - @cat-factory/prompt-fragments@0.9.39
  - @cat-factory/spend@0.10.69
  - @cat-factory/provider-bedrock@0.7.112
  - @cat-factory/provider-cloudflare@0.7.112
  - @cat-factory/observability-langfuse@0.7.108
  - @cat-factory/provider-s3@0.2.58

## 0.58.3

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0
  - @cat-factory/integrations@0.54.0
  - @cat-factory/server@0.66.0
  - @cat-factory/agents@0.26.5
  - @cat-factory/consensus@0.8.6
  - @cat-factory/gates@0.2.64
  - @cat-factory/gitlab@0.4.35
  - @cat-factory/kernel@0.69.3
  - @cat-factory/orchestration@0.57.2
  - @cat-factory/prompt-fragments@0.9.38
  - @cat-factory/spend@0.10.68
  - @cat-factory/provider-bedrock@0.7.111
  - @cat-factory/provider-cloudflare@0.7.111
  - @cat-factory/observability-langfuse@0.7.107
  - @cat-factory/provider-s3@0.2.57

## 0.58.2

### Patch Changes

- d7f6e1c: Correctness fixes across the engine, the Node facade, and the SPA stores:

  - **Engine:** `finalizeMerge` and the merger resolver are now idempotent under
    durable-driver replays — a re-resolved merger step on an already-`done` (= merged)
    block is a no-op instead of re-merging, downgrading the block to `pr_ready`, and
    raising a spurious `merge_review` notification. `approveStep` now runs under the same
    optimistic-concurrency write as its siblings (`resolveDecision`/`requestStepChanges`),
    so an approve holding a stale snapshot can no longer resurrect a run a racing reject
    already failed (it now returns 409).
  - **CI gate (behavior change):** a check run concluding `stale` (superseded by GitHub)
    no longer fails the CI gate — previously it looped the `ci-fixer` against a check it
    could never fix until the attempt budget failed the run. `cancelled`/`timed_out`/
    `action_required` still fail the gate.
  - **Node facade parity:** the retention sweep now prunes the `github_commits`
    projection to `retention.commitMs` (previously it grew without bound; the Worker
    already pruned it), and a new every-2-min GitHub reconcile sweeper re-syncs stale
    repo projections and tombstones uninstalled installations — the backstop for missed
    webhooks the Worker's `github-reconcile` cron already provided.
  - **SPA stores:** the execution store now reconciles snapshots/events monotonically by
    the run's `rev` (a lagging refresh can no longer revert a just-terminal run to
    `running`), the requirements/clarity/brainstorm stores guard live-event upserts by
    `updatedAt` (out-of-order events no longer revert just-submitted answers), and
    `board.moveBlock`/`updateBlock` roll their optimistic mutation back on API failure.

- 63cf6de: Performance: batch reads, parallelize independent awaits, and push work into SQL on hot paths.

  - `GET /workspaces/:id` (the board-load endpoint) now fetches its ~15 independent snapshot
    ingredients concurrently instead of serially, so its latency is the slowest read rather
    than the sum of every round-trip; the create-workspace route parallelizes its spend +
    infra-setup reads the same way.
  - Agent-context reference lookups (Jira keys / GitHub refs / URLs) run concurrently on the
    per-step dispatch path; run-start model-default resolutions run concurrently per agent kind.
  - New batched port methods, mirrored on both runtimes with conformance coverage:
    `BlockRepository.findByIds` (cross-workspace dependency resolution — one chunked query
    instead of a point-read per id, also allow-listed for mothership mode),
    `NotificationRepository.escalateStaleOpen` (the escalation sweep is now one
    `UPDATE … RETURNING` statement instead of a load-filter-upsert loop), and
    `GitHubInstallationRepository.listByInstallationIds` (connect-UI annotation).
  - GitHub webhook fan-out resolves linked workspaces via the existing batched
    `linkedWorkspaces` read instead of a per-workspace point-read on every delivery.
  - The Node Drizzle GitHub projections write chunked multi-row upserts (matching the D1
    twins' `db.batch`) instead of one round-trip per row, and their list reads run
    `ORDER BY`/`LIMIT` in SQL (NULLS LAST for D1 parity) instead of sorting full result
    sets in JS.
  - `autoStartDependents` hoists the invariant workspace-pipeline read out of its loop and
    stops re-fetching blocks it already holds.
  - Session/WS-ticket/machine-token verification reuses a memoized `HmacSigner` per secret,
    so `crypto.subtle.importKey` no longer runs on every request (`signerFor` export).
  - The Cloudflare Workflows drivers (execution / bootstrap / env-config-repair) build the
    DI container once per wake instead of once per `step.do` poll tick.

- Updated dependencies [d7f6e1c]
- Updated dependencies [63cf6de]
  - @cat-factory/kernel@0.69.2
  - @cat-factory/orchestration@0.57.1
  - @cat-factory/contracts@0.80.1
  - @cat-factory/integrations@0.53.2
  - @cat-factory/server@0.65.2
  - @cat-factory/agents@0.26.4
  - @cat-factory/consensus@0.8.5
  - @cat-factory/gates@0.2.63
  - @cat-factory/gitlab@0.4.34
  - @cat-factory/observability-langfuse@0.7.106
  - @cat-factory/provider-bedrock@0.7.110
  - @cat-factory/provider-cloudflare@0.7.110
  - @cat-factory/provider-s3@0.2.56
  - @cat-factory/spend@0.10.67
  - @cat-factory/prompt-fragments@0.9.37

## 0.58.1

### Patch Changes

- 120de05: feat(testing): pipeline-builder toggle + Test Report surfacing for the test quality companion (PR 2)

  Completes the test quality-control (QC) companion (see
  `docs/initiatives/tester-quality-companion.md`) with its authoring + observability surfaces:

  - **Pipeline builder**: a per-Tester-step toggle (enabled by default) turns the QC companion
    off, and an optional estimate-gating panel runs the coverage audit only on tasks whose
    estimate clears a threshold (mirroring the companion-gating panel). The estimator-required
    hint now covers QC gating too.
  - **Test Report window**: a "Coverage review" section renders each QC verdict (adequate /
    gaps-found, the reviewer's feedback + concrete gaps, model, timestamp) plus the loop budget
    and a "budget spent" badge — so a report that greenlit only after a QC-driven re-run shows
    why it looped.
  - **Persistence fix**: the pipeline create/update/clone API + `PipelineService` now thread
    `testerQuality` (and the sibling `followUps`, which had the same latent gap) end-to-end, so a
    custom pipeline's builder toggle actually persists instead of being silently stripped by the
    request-body validator. This includes the persistence layer itself: new `follow_ups` +
    `tester_quality` JSON columns on the `pipelines` table, mirrored D1 (migration
    `0032_pipeline_companion_toggles`) ⇄ Drizzle (schema + generated migration), written by both
    repos and read by the shared `rowToPipeline` mapper. A QC estimate gate is validated like
    companion gating (a threshold must be set and a `task-estimator` must run earlier).
  - **Conformance**: the full QC loop (audit → loop the Tester on gaps → conclude on an adequate
    report) is now driven through an injected deterministic reviewer on every runtime, asserting
    the verdicts + counters persist identically across D1 and Drizzle. A separate round-trip
    assertion saves a custom pipeline with a `followUps` opt-out + a gated `testerQuality` config
    and re-reads it from the store, so the new columns can't silently drop the toggles on either
    runtime.

  All new user-facing copy is translated across every shipped locale.

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0
  - @cat-factory/orchestration@0.57.0
  - @cat-factory/kernel@0.69.1
  - @cat-factory/agents@0.26.3
  - @cat-factory/consensus@0.8.4
  - @cat-factory/gates@0.2.62
  - @cat-factory/gitlab@0.4.33
  - @cat-factory/integrations@0.53.1
  - @cat-factory/prompt-fragments@0.9.36
  - @cat-factory/server@0.65.1
  - @cat-factory/spend@0.10.66
  - @cat-factory/observability-langfuse@0.7.105
  - @cat-factory/provider-bedrock@0.7.109
  - @cat-factory/provider-cloudflare@0.7.109
  - @cat-factory/provider-s3@0.2.55

## 0.58.0

### Minor Changes

- dcc8b32: Browsable frontend preview — transport dispatch + `PreviewService` + controller + stop (slice 5c of
  the frontend-preview + in-context UI-testing initiative,
  docs/initiatives/frontend-preview-ui-testing.md).

  Wire the harness `preview` mode (slice 5b) end to end: a `frontend` frame can now be built and
  served on a HOST-reachable URL for a browsable preview, and stopped again. New pieces:

  - A new optional `PreviewTransport` kernel port — the per-runtime half that publishes a served
    app's port to an ephemeral host port and keeps the container alive past the build job. The local
    facade wires the real one over its Docker/Podman/OrbStack/Colima/Apple adapter (a second
    published port read back with `docker port` / the container IP); the Worker never wires it.
  - A runtime-neutral `PreviewService` (start / get / stop) that persists the running preview like an
    ephemeral `environments` row keyed by the `frontend` frame (reusing the existing table + soft-delete
    stop path — no new migration), plus a `PreviewController` mounting
    `GET|POST|DELETE /workspaces/:ws/frames/:frameId/preview`, gated server-side on the
    `frontendPreview.supported` capability (503 on the Worker).
  - The cross-runtime conformance suite drives the full start → serve → stop lifecycle on both Postgres
    runtimes with a fake transport, pinning the ephemeral-env-row persistence parity.

  Notes:

  - `frontendPreview.supported` now tracks whether a preview transport is actually wired: a stock Node
    build (runner pool, no host-port-publish primitive) advertises `false`, so the SPA never offers a
    Start button that would 503; local mode (and any facade injecting a `previewTransport`) advertises
    `true`.
  - Preview rows share the `environments` table but carry a dedicated `preview` discriminator (outside
    `provisionTypeSchema`), so the environment subsystem filters them out of its generic listing +
    block-resolution paths — a preview never leaks into the deployer-env UI or tester env resolution.
  - `PreviewService.get` re-polls a `ready` preview so a vanished/evicted container stops reporting a
    stale, unreachable URL (it flips to `failed`); a healthy preview whose URL merely can't be
    re-derived keeps its authoritative persisted URL.

  Local/node differentiator; the SPA surface (the clickable URL + a stop button on the frame inspector)
  lands in slice 5d. The harness is unchanged (no runner-image bump).

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/orchestration@0.56.0
  - @cat-factory/integrations@0.53.0
  - @cat-factory/contracts@0.79.0
  - @cat-factory/kernel@0.69.0
  - @cat-factory/server@0.65.0
  - @cat-factory/agents@0.26.2
  - @cat-factory/consensus@0.8.3
  - @cat-factory/gates@0.2.61
  - @cat-factory/gitlab@0.4.32
  - @cat-factory/prompt-fragments@0.9.35
  - @cat-factory/spend@0.10.65
  - @cat-factory/observability-langfuse@0.7.104
  - @cat-factory/provider-bedrock@0.7.108
  - @cat-factory/provider-cloudflare@0.7.108
  - @cat-factory/provider-s3@0.2.54

## 0.57.2

### Patch Changes

- Updated dependencies [16ee6cc]
- Updated dependencies [16ee6cc]
  - @cat-factory/orchestration@0.55.1
  - @cat-factory/contracts@0.78.1
  - @cat-factory/kernel@0.68.1
  - @cat-factory/server@0.64.4
  - @cat-factory/agents@0.26.1
  - @cat-factory/consensus@0.8.2
  - @cat-factory/gates@0.2.60
  - @cat-factory/gitlab@0.4.31
  - @cat-factory/integrations@0.52.2
  - @cat-factory/prompt-fragments@0.9.34
  - @cat-factory/spend@0.10.64
  - @cat-factory/observability-langfuse@0.7.103
  - @cat-factory/provider-bedrock@0.7.107
  - @cat-factory/provider-cloudflare@0.7.107
  - @cat-factory/provider-s3@0.2.53

## 0.57.1

### Patch Changes

- Updated dependencies [6da6637]
  - @cat-factory/server@0.64.3

## 0.57.0

### Minor Changes

- 16621f8: feat(testing): test quality-control companion that loops the Tester on incomplete reports

  The Tester gate concluded a step purely from `greenlight` + blocking concerns + failed
  outcomes, so a report that claimed to exercise many areas (`tested`) but recorded a single
  happy-path `outcome` could greenlight and "pass" — leaving most scenarios as "No discrete
  check recorded" in the Test Report window while the step read as successfully completed.

  Two changes address this:

  - **Tester prompts now require one recorded `outcome` per `tested` area** (API + UI testers):
    every scenario listed as tested must have a matching outcome with a concrete detail, and
    describing results only in the prose `summary` does not count. Genuinely un-exercised areas
    are recorded as `skipped` with a reason rather than dropped.
  - **A new test quality-control companion** (`tester-qc`) audits each Tester report for
    coverage/coherence BEFORE the greenlight/fixer decision. When the report is inadequate it
    loops the Tester for a focused additional pass (folding the prior report + the flagged gaps
    in, and carrying forward already-covered outcomes), bounded by a new merge-preset knob
    `maxTesterQualityIterations` (default 3). Enabled by default; a per-Tester-step toggle in
    the pipeline shape (`pipeline.testerQuality`) disables it or gates it on the task estimate.
    The companion is an inline reviewer (no container) that resolves its model like the other
    inline reviewers and is a pass-through when no model is wired.

  Persistence: the merge preset gains a `max_tester_quality_iterations` column, mirrored across
  the D1 and Drizzle stores (built-in preset seed `version` bumped 1 → 2). The QC loop state
  lives on the execution step, so no new table is added.

  The frontend pipeline-builder toggle + Test Report verdict surfacing land in a follow-up
  (see `docs/initiatives/tester-quality-companion.md`).

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0
  - @cat-factory/kernel@0.68.0
  - @cat-factory/agents@0.26.0
  - @cat-factory/orchestration@0.55.0
  - @cat-factory/consensus@0.8.1
  - @cat-factory/gates@0.2.59
  - @cat-factory/gitlab@0.4.30
  - @cat-factory/integrations@0.52.1
  - @cat-factory/prompt-fragments@0.9.33
  - @cat-factory/server@0.64.2
  - @cat-factory/spend@0.10.63
  - @cat-factory/observability-langfuse@0.7.102
  - @cat-factory/provider-bedrock@0.7.106
  - @cat-factory/provider-cloudflare@0.7.106
  - @cat-factory/provider-s3@0.2.52

## 0.56.1

### Patch Changes

- Updated dependencies [08be94c]
  - @cat-factory/orchestration@0.54.1
  - @cat-factory/server@0.64.1

## 0.56.0

### Minor Changes

- f21279e: Warn when required infrastructure is undefined. The workspace snapshot now carries an
  `infraSetup` projection (computed server-side in `WorkspaceController` from whatever the
  deployment actually wired) that tracks three areas explicitly as `not_defined` /
  `configured` / `not_applicable`:

  - **Ephemeral environments** (all runtimes that wire the environments integration) —
    `not_defined` when no environment provider connection is registered, so testing agents
    that need a live environment can't run.
  - **Agent executor** (stock/remote Node only — Cloudflare has built-in per-run containers, and
    local mode runs agents in per-run HOST containers) — `not_defined` when no self-hosted runner
    pool is registered, so NO container agents can run. This area fires only where the pool is the
    SOLE executor (the new `agentExecutorRequiresRunnerPool` container flag, set by the Node facade
    when it uses the default pool transport); Cloudflare and local both wire the runner surface but
    keep a built-in executor, so the pool is optional there and the area is `not_applicable` — a bare
    `!!container.runners` check would otherwise falsely nag on every local deployment.
  - **Binary storage** (remote Node only — Cloudflare binds R2, local defaults to a filesystem
    store) — `not_defined` when the account selected no content-storage backend, so UI
    screenshots / reference images have nowhere to live.

  The SPA surfaces each `not_defined` area as a loud, per-area setup banner with a deep-link
  into the relevant configuration. Dismissing a banner asks whether to hide it just for this
  session (re-nags next load) or permanently — "I'm OK with the limitations, don't notify me
  again" — the latter persisted per-user in localStorage.

  The advisory top-of-board banners (AI-readiness, provider-config, infra-setup) now render in a
  single shared, click-through column so concurrent prompts on a fresh deployment stack vertically
  instead of drawing on top of each other. The `RunnerPoolConnectionService` and
  `EnvironmentConnectionService` gain a `hasConnection` presence probe (no secret decrypt) that the
  projection uses on the hot board-load path.

  Each area probe is additionally bounded by a timeout and its swallowed faults are logged, so a slow
  or misconfigured backend read degrades that area to `not_applicable` (advisory-only, never 500s or
  stalls the board load) while staying diagnosable. The banner's permanent-dismissal `localStorage`
  key + the infra-setup area list are exported from `@cat-factory/contracts`
  (`INFRA_SETUP_DISMISSED_STORAGE_KEY` / `INFRA_SETUP_AREAS`) so the SPA and the e2e seed share one
  source of truth, and the stacked banner cards announce through a single polite live region instead
  of one assertive alert each.

- 6c51e31: Run inline LLM steps through the ambient Claude Code / Codex CLI in local mode, and refuse to
  start a pipeline whose model preset can't satisfy every step.

  - **Local inline harness execution**: with native agents enabled (`LOCAL_NATIVE_AGENTS`), the
    inline steps (requirements reviewer, brainstorm, task-estimator, inline document kinds) now run
    on the developer's ambient `claude`/`codex` subscription CLI as a host subprocess — the inline
    analogue of the existing container ambient-auth path. Previously a subscription-only preset
    (e.g. Claude Opus) degraded these inline steps to the routing default and failed against an
    unconfigured provider (the confusing "requirements reviewer (qwen:qwen3-max) failed" error).
    Implemented via a new AI-SDK `CliInlineLanguageModel` (`@cat-factory/agents`) wired into the
    local model provider; `inlineModelRef` now keeps an ambient-eligible harness ref instead of
    degrading it. The consensus executor (an inline path) threads the same predicate, so a
    subscription-only consensus participant model is kept inline in local mode too.
  - **Preset satisfiability guard**: the pipeline-start guard now checks INLINE steps against
    inline-usability, not just container-usability. A subscription-only model that satisfies the
    container agents but can't run the inline reviewers (and this deployment has no inline harness)
    is refused up front with a new `preset_unsatisfiable` conflict reason and an actionable message,
    instead of failing mid-run. The SPA maps the new reason to a translated toast.

  Breaking: `inlineModelRef` gains an optional third `opts` argument; the `ConflictReason` wire
  union gains `preset_unsatisfiable`.

### Patch Changes

- 9e93fe8: feat(frontend): `frontendPreview` infrastructure capability + preview-toggle gate (slice 5a of the
  frontend-preview + in-context UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

  A browsable frontend preview keeps a built app served on a host-reachable URL, which needs a
  long-lived host serve — so it is a genuine local/node differentiator. The Worker only runs the
  self-contained UI-test container (built, tested, and torn down with the run), so it cannot host one.
  Until now the `frontendConfig.previewEnabled` toggle (shipped as scaffolding in slice 2) was offered
  on every runtime and read by nothing.

  This lands the capability that makes the toggle honest, and gates it in the SPA where a preview can't
  run. The long-lived build+serve-kept-alive mechanic itself is the remaining slice 5b.

  - **New capability axis** on the `/auth/config` `infrastructureCapabilities` descriptor:
    `frontendPreview: { supported: boolean }`, built by the shared `buildInfrastructureCapabilities`
    so all three facades emit the same shape. Value is a per-facade differentiator — Worker `false`,
    Node + local `true`.
  - **SPA gate**: `FrontendConfig.vue` reads `infrastructure.frontendPreview.supported` (defaulting
    true until the auth handshake resolves) and disables the `previewEnabled` checkbox with an
    explanatory hint (`inspector.frontendConfig.previewUnsupported`, translated across every locale)
    when unsupported. The stored config is left untouched, so a `previewEnabled` flag authored on
    local/node is simply inert when served from the Worker (no migration; pre-1.0 breakage rules).
  - **Conformance** pins that the axis is present + boolean on every facade (its value is a
    differentiator); the Worker `auth.spec` pins `false`, the Node `auth-gate.spec` pins `true`.

- 9b26ff1: feat(frontend): key a deployer's ephemeral env by its service FRAME so a live `service` binding
  resolves (slice 4b of the frontend-preview + in-context UI-testing initiative,
  docs/initiatives/frontend-preview-ui-testing.md).

  A `frontend` frame's `service` binding names a service FRAME id, but a `deployer` keyed its
  ephemeral env only under the task `block_id` it ran on — so `resolveFrontendConfig`'s
  `handle === serviceBlockId` match never hit and a live-service binding fell back to WireMock even
  when the backend's env was up (the deferred keying gap slices 3/4 flagged).

  The env now also records the resolved service `frame_id` (the deployer's block walked up to its
  enclosing frame), and the frontend binding resolution matches handles on THAT. The task-keyed
  `block_id` — and the same-block deployer→tester env projection that reads it — is unchanged; this
  is an additive column, not a re-key.

  - **New `frame_id` column** on `environments`, mirrored D1 (`0030_environment_frame_id.sql`) ⇄
    Drizzle (`environments.frame_id` + generated migration), threaded through `EnvironmentRecord`,
    the `EnvironmentHandle` wire shape, and both registry repos.
  - **Keying**: `RunDispatcher.deployerProvisionArgs` resolves the service frame id via the shared
    frame walk and passes it on `ProvisionArgs.frameId`; the provisioning service persists it on both
    the provisioned and the failed-record paths.
  - **Resolution**: `AgentContextBuilder.resolveFrontendConfig` indexes the single `listHandles` read
    by `handle.frameId` (still one batch read, no per-binding point read), so a `service` binding
    resolves to its live ephemeral URL — and the frontend UI-test infra gate is satisfied instead of
    refusing the run.
  - **Conformance**: a new cross-runtime assertion provisions a service frame's env via a `deployer`,
    then a UI-tester run against a frontend bound to that frame STARTS (the mirror of the existing
    no-live-service refusal), pinning both the `frame_id` D1 ⇄ Drizzle round-trip and the
    frame-keyed resolution.

- e0aa45e: Self-contained frontend UI-test infra (slice 3 of the frontend-preview + in-context
  UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

  A `tester-ui` running on a task under a `type: 'frontend'` frame now builds and serves the
  frontend, stands WireMock up for its OTHER backend upstreams, and drives the UI tests against
  the two together — all as localhost processes in the one container (no Docker-in-Docker), so
  it works on Cloudflare and Apple `container` too.

  - **Harness**: a new `frontend` variant of the tester infra spec (`kind: 'frontend'`) that
    installs, builds (injecting the resolved backend URLs at build time, or a `window.env` shim
    for runtime injection), starts WireMock seeded from the frontend repo's mappings dir, serves
    the built app, health-checks it, and points the agent at it. The `ui` image gains pnpm/yarn
    (corepack), a static file server (`serve`), and a headless JRE + WireMock standalone
    (executor-harness image bumped to 1.28.0).
  - **Backend**: `AgentRunContext` carries a resolved `frontend` slice (the frame's
    `frontendConfig` plus its backend bindings resolved to concrete upstreams — a bound service's
    live ephemeral env URL for the service under test, else a WireMock mock). The engine's
    `testerInfraSpec` turns it into the harness spec, and the tester-infra start gate refuses a
    frontend UI test only when it binds a live-backend `service` with none actually live (a
    mock-only / no-backend frontend passes — WireMock + the static server fully stand it up).
    Empty-envVar bindings are filtered.
  - **Hardening** (review follow-ups): the harness's WireMock / serve child processes get an
    `'error'` listener (a spawn failure is captured, not an uncaught crash of the job server),
    WireMock is now health-checked alongside the served app (a dead mock becomes a prompt note,
    not a test-time ECONNREFUSED), reserved env-var names (`PATH`, `NODE_OPTIONS`, …) are dropped
    from the injected build env, and a configured `servePort` that collides with a reserved
    in-container port (8080 harness job server, 8089 WireMock) falls back to the default. The
    inspector's servePort placeholder now shows 4173. Shared `pathExists` / log-capture helpers
    are de-duplicated in the harness. The frontend UI-test gate's batch env read
    (`environmentRegistryRepository.listByWorkspace`) is added to the mothership remote-persistence
    allow-list so the gate resolves in mothership mode.
  - **Hardening (second review round)**: the frontend stand-up now feeds the run's inactivity
    watchdog with a heartbeat while it installs/builds/serves — a real frontend's `install` +
    `build` can exceed the 10-min inactivity window, and the (activity-silent) stand-up would
    otherwise be killed mid-build with a misleading "likely hung". `serveMode: 'command'` now also
    forwards the resolved backend URLs (`env`) to the serve process, so a runtime-reading
    dev/preview server sees them (previously only `PORT` was passed). Reserved env-var names are
    now also dropped in the backend infra-spec builder (defence in depth, not just the harness).
    The `mockMappingsPath` docs + inspector hint clarify WireMock's `--root-dir` layout (stubs go
    in a `mappings/` subfolder), and the env-injection hint notes the build-tool prefix caveat
    (e.g. Vite only exposes `VITE_*`). The UI-tester prompt flags a live-backend CORS failure as an
    infra gap rather than an app defect.
  - **Hardening (third review round)**: the frontend stand-up now runs in the run's SERVICE
    SUBTREE (`workDir`), not the clone root — a monorepo frontend's `package.json` / `outputDir` /
    `mocks/` live under its own subdirectory, so installing, building, serving and seeding WireMock
    from the repo root would have targeted the wrong directory (the docker-compose stand-up still
    runs at the root, where its repo-relative `composePath` resolves). The harness now bounds
    frontend `servePort` / `wiremockPort` to 1..65535 at its untrusted-body boundary (an
    out-of-range port can never bind, so it falls back to the default). The reserved-env filter —
    in BOTH the harness parse and the backend infra-spec builder — grows the `NODE_EXTRA_CA_CERTS`
    / `BASH_ENV` / `ENV` / `SHELL` / `IFS` names plus the `npm_config_*` and `GIT_*` FAMILIES, so a
    binding that reconfigures the package manager, git, or the TLS trust store during the build is
    dropped rather than injected. Runtime env injection under `serveMode: 'command'` now warns
    (the `window.env` shim is only served in static mode; the forwarded `env` covers the command
    server), and a failed shim write is logged instead of silently swallowed. `AgentContextBuilder`
    gains `resolveServiceFrame` so the frontend-config resolution reuses the frame row the walk
    already loaded instead of re-fetching it. Fixes the `Lint & format` failure (an unnecessary
    `?? {}` empty-fallback spread in the serve env).
  - **Hardening (fourth review round)**: the reserved-env family filter (`npm_config_*` / `GIT_*`)
    now matches **case-insensitively** in BOTH the harness parse and the backend infra-spec builder —
    npm reads its config env with a case-insensitive `/^npm_config_/i`, so `NPM_CONFIG_REGISTRY`
    (upper/mixed case) is honoured just like `npm_config_registry`; a case-sensitive prefix match
    would have let the upper-cased form slip through and reconfigure the package manager during the
    build. The frontend serve/WireMock health-check now also aborts an in-flight probe on the run's
    own abort signal (not just the per-attempt timeout). The stale `envInjectionHint` translation is
    synced across all locales, and the missed-translation class is now guarded in CI (see the app
    note). The agent prompt-note assembly and the frontend `installCommand` are extracted as pure
    helpers with unit coverage.

  `@cat-factory/app`: sync the `envInjectionHint` hint across all locales (the `en` update noting
  the build-tool prefix caveat, e.g. Vite only exposes `VITE_*`, had been left untranslated). A new
  CI **locale-parity guard** now fails a PR that changes an `en.json` message key without changing
  the same key in every other locale, so translations can't silently go stale.

  BREAKING (pre-1.0): the harness `AgentInfraSpec` is now a discriminated union
  (`service` | `frontend`); the default backend-service tester shape is unchanged.

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [ab7d589]
- Updated dependencies [6c51e31]
- Updated dependencies [456a992]
- Updated dependencies [1d2684f]
- Updated dependencies [33687cf]
  - @cat-factory/contracts@0.77.0
  - @cat-factory/server@0.64.0
  - @cat-factory/kernel@0.67.0
  - @cat-factory/integrations@0.52.0
  - @cat-factory/orchestration@0.54.0
  - @cat-factory/agents@0.25.0
  - @cat-factory/consensus@0.8.0
  - @cat-factory/gates@0.2.58
  - @cat-factory/gitlab@0.4.29
  - @cat-factory/prompt-fragments@0.9.32
  - @cat-factory/spend@0.10.62
  - @cat-factory/observability-langfuse@0.7.101
  - @cat-factory/provider-bedrock@0.7.105
  - @cat-factory/provider-cloudflare@0.7.105
  - @cat-factory/provider-s3@0.2.51

## 0.55.3

### Patch Changes

- 3135ae8: Make GitLab a first-class auth identity on the hosted (Cloudflare Worker + Node) path.

  **Wire hosted PAT sign-in into the Cloudflare Worker.** The Worker now registers the PAT-login
  identity registry (`vcsIdentity`) like the Node facade — GitHub always, GitLab when a GitLab
  connection is configured (`GITLAB_TOKEN` / `config.gitlab.enabled`) — so a user can sign in by
  pasting their own GitHub **or** GitLab PAT at `/auth/pat`. Previously the Worker wired none,
  leaving it OAuth-only; since GitLab has no OAuth browser flow, a GitLab user had no way to sign
  in to a Worker deployment at all, even though its engine already gated CI and merged on GitLab.
  `/auth/config` now advertises `patLogin.providers` accordingly, so the SPA renders the PAT form.

  **Implement `GitLabIdentityResolver.resolveOrgs`.** A hosted deployment admits a pasted PAT only
  when the account's login, an org/group it belongs to, or its email domain is allowlisted. Only
  `GitHubIdentityResolver` implemented `resolveOrgs`, so `isPatIdentityAllowed`'s org branch was
  skipped for GitLab — a GitLab account could be a primary identity via `AUTH_ALLOWED_LOGINS` or
  `AUTH_ALLOWED_EMAIL_DOMAINS`, but never `AUTH_ALLOWED_ORGS`. The resolver now enumerates the
  user's GitLab **group** memberships (`GET /groups?min_access_level=10`, lowercased full paths, so
  only groups the user actually belongs to admit), bringing group-based admission to parity with
  GitHub org admission.

  **Bound and diagnose PAT-login org/group admission.** Both `resolveOrgs` implementations
  (GitHub `/user/orgs`, GitLab `/groups`) now follow `Link: rel="next"` pagination up to a ~1000-entry
  cap (and `logger.warn` on truncation, wired from each facade — Node included), so a user whose only
  allowlisted org/group sat past the first 100 is no longer wrongly denied. When org enumeration fails
  because a token can authenticate `/user` but lacks the broader org/group-read scope
  (`read:org` / `read_api`), the `/auth/pat` 403 now hints at the missing scope instead of a flat
  "not allowed", and a hosted deployment's missing-token prompt tells the user to paste their PAT
  rather than to set an env var they don't control.

  Comment-only touches to `@cat-factory/server`'s `AuthController`, the kernel `VcsIdentityRegistry`
  doc, and the SPA login screen to correct the now-stale "hosted facades are OAuth-only" notes.

- Updated dependencies [3135ae8]
  - @cat-factory/gitlab@0.4.28
  - @cat-factory/server@0.63.3

## 0.55.2

### Patch Changes

- 39534d6: Mothership mode: allow-list `agentRunRepository.getRef`, so the board's run controls (retry /
  stop a failed or running run) are functional for execution runs in a no-Postgres mothership-mode
  local node.

  Wiring fix (both facades): `agentRunRepository` is the one repo surfaced on the container OUTSIDE
  `CoreDependencies`, so the mothership `repositories` registry (`ServerContainer.repositories`,
  reflected by `/internal/persistence`) was built from `dependencies` alone and did not carry it —
  a remote `getRef` call came back `Repository 'agentRunRepository.getRef' is not wired`. Both
  `buildNodeContainer` and the Cloudflare `buildContainer` now fold it into the registry explicitly,
  so either facade acting as a mothership serves the retry/stop `getRef` read.

  `AgentRunController` (`POST /workspaces/:ws/agent-runs/:id/{retry,stop}`) resolves a run's KIND via
  `agentRunRepository.getRef(workspaceId, id)` before dispatching to the matching service. That read
  was the last thing on the execution-run retry/stop path still coming back `unknown_method` over
  `/internal/persistence`. It is now allow-listed, workspace-scoped on arg0 (reusing the existing
  `workspace` rule — resolve the owning account, reject out-of-scope as 404). Every downstream
  read+write the execution retry/stop services make (`executionRepository.get`/`deleteByBlock`/
  `upsert`/`markFailed`, `blockRepository.update`, `pipelineRepository.get`, the budget/binary-storage
  prechecks) was already exposed on the run/start path, so `getRef` is the only new entry.

  The bootstrap + env-config-repair retry BRANCHES read their own repos (`bootstrapJobRepository.get`,
  `referenceArchitectureRepository.get`, …) and stay `pending` — a later slice. The sweeper-only
  `agentRunRepository.listStale`/`liveRunIds` stay mothership-internal.

  Server-only allow-list change, symmetric by construction (the dispatcher reflects over each facade's
  registry). Round-trip + cross-account-scope + off-allow-list unit tests cover it; the static
  allow-list drift guard moves `getRef` out of `pending`; and the fake-mothership integration test
  asserts the retry endpoint resolves a run's kind over the real RPC and 404s an unknown run id.

- Updated dependencies [39534d6]
  - @cat-factory/server@0.63.2

## 0.55.1

### Patch Changes

- Updated dependencies [eab2b60]
  - @cat-factory/server@0.63.1

## 0.55.0

### Minor Changes

- 762fe66: Add a first-class `frontend`-frame configuration. A frontend frame now carries a
  `frontendConfig` (package manager, install/build/serve knobs, WireMock mappings path,
  preview toggle) plus `backendBindings` that map each env var the frontend reads to an
  upstream: a bound service frame's ephemeral environment, or a WireMock stub. The bindings
  double as board links, drawn as frontend→service edges on the canvas. New inspector panel
  (`FrontendConfig.vue`), the `frontend_config` JSON column mirrored across D1 and Drizzle
  with a cross-runtime conformance round-trip, and `frontendConfig` on the update-block input.

  Second slice of the frontend-preview + in-context UI-testing initiative
  (docs/initiatives/frontend-preview-ui-testing.md).

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0
  - @cat-factory/server@0.63.0
  - @cat-factory/agents@0.24.16
  - @cat-factory/consensus@0.7.104
  - @cat-factory/gates@0.2.57
  - @cat-factory/gitlab@0.4.27
  - @cat-factory/integrations@0.51.4
  - @cat-factory/kernel@0.66.1
  - @cat-factory/orchestration@0.53.2
  - @cat-factory/prompt-fragments@0.9.31
  - @cat-factory/spend@0.10.61
  - @cat-factory/provider-bedrock@0.7.104
  - @cat-factory/provider-cloudflare@0.7.104
  - @cat-factory/observability-langfuse@0.7.100
  - @cat-factory/provider-s3@0.2.50

## 0.54.3

### Patch Changes

- fb53662: Recover and surface stalled runs instead of letting them spin `running` forever.

  A run whose durable driver was lost (a crashed/restarted orchestrator that left its
  pg-boss advance job orphaned-`active`) previously stayed `running` indefinitely with no
  error: the Node stale-run sweeper's re-`send` is a silent no-op while the `exclusive`
  singleton is still held, so the run was never recovered or flagged.

  - **Sweeper now reclaims orphaned advance jobs.** It classifies each stale run's advance
    job by pg-boss's own heartbeat (`live` / `orphaned` / `missing`); an orphaned job (dead
    worker, frozen heartbeat) is deleted to free its singletonKey before re-driving, so a
    bare re-send no longer no-ops onto a dead job. Runs on boot too (immediate reconcile),
    not just on the interval.
  - **Hard-stall backstop.** A run orphaned past a deadline (`STALE_RUN_HARD_FAIL_MINUTES`,
    default 60) that recovery can't resume is failed with the new `stalled`
    `AgentFailureKind` — surfaced by the existing failure banner + retry (a new "Run stalled"
    title) instead of spinning silently. Symmetric on the Cloudflare cron sweeper.
  - **Orphaned local containers are reaped at boot** — a still-running per-run container
    whose run has since gone terminal/away (its `release()` never ran) is removed, via a new
    `AgentRunRepository.liveRunIds` batch query + a `ContainerRuntimeAdapter.listRunContainers`.
  - **Harness structured-repair retries transient failures.** The last-ditch structured-output
    repair call now retries HTTP 429 / 5xx / network errors with exponential backoff honoring
    `Retry-After`, so a transient rate-limit no longer turns a recoverable parse into a hard
    `no structured result` run failure. (executor-harness image bumped to 1.27.5.)

  Breaking (internal): `AgentRunRepository.listStale` now returns `StaleAgentRun` (adds
  `updatedAt`) and gains `liveRunIds`; both D1 and Drizzle repos implement them.

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0
  - @cat-factory/contracts@0.75.0
  - @cat-factory/orchestration@0.53.1
  - @cat-factory/agents@0.24.15
  - @cat-factory/consensus@0.7.103
  - @cat-factory/gates@0.2.56
  - @cat-factory/gitlab@0.4.26
  - @cat-factory/integrations@0.51.3
  - @cat-factory/observability-langfuse@0.7.99
  - @cat-factory/provider-bedrock@0.7.103
  - @cat-factory/provider-cloudflare@0.7.103
  - @cat-factory/provider-s3@0.2.49
  - @cat-factory/server@0.62.3
  - @cat-factory/spend@0.10.60
  - @cat-factory/prompt-fragments@0.9.30

## 0.54.2

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0
  - @cat-factory/kernel@0.65.0
  - @cat-factory/orchestration@0.53.0
  - @cat-factory/agents@0.24.14
  - @cat-factory/consensus@0.7.102
  - @cat-factory/gates@0.2.55
  - @cat-factory/gitlab@0.4.25
  - @cat-factory/integrations@0.51.2
  - @cat-factory/prompt-fragments@0.9.29
  - @cat-factory/server@0.62.2
  - @cat-factory/spend@0.10.59
  - @cat-factory/observability-langfuse@0.7.98
  - @cat-factory/provider-bedrock@0.7.102
  - @cat-factory/provider-cloudflare@0.7.102
  - @cat-factory/provider-s3@0.2.48

## 0.54.1

### Patch Changes

- Updated dependencies [d4d4cbc]
  - @cat-factory/server@0.62.1
  - @cat-factory/integrations@0.51.1
  - @cat-factory/orchestration@0.52.1

## 0.54.0

### Minor Changes

- 3643708: Custom manifest types can now declare an optional `defaultManifestPath` and `fixerPrompt`.
  A `custom` service prefills its manifest path from the type's default on selection, and
  "Detect from repo" resolves the path monorepo-aware (keep an accurate current value; else
  the exact default within the service subtree/repo root; else, for a bare filename, one level
  deep; else pre-fill the default location). A new **Generate / fix manifest** button (shown
  only when the type defines a `fixerPrompt`) dispatches the fixer coding agent — reusing the
  durable `env-config-repair` run — to create the manifest at the entered path or fix it when
  invalid, after best-effort `validateRepo`. Adds the `default_manifest_path` / `fixer_prompt`
  columns to `custom_manifest_types` on both runtimes (D1 + Drizzle).

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0
  - @cat-factory/kernel@0.64.0
  - @cat-factory/integrations@0.51.0
  - @cat-factory/server@0.62.0
  - @cat-factory/orchestration@0.52.0
  - @cat-factory/agents@0.24.13
  - @cat-factory/consensus@0.7.101
  - @cat-factory/gates@0.2.54
  - @cat-factory/gitlab@0.4.24
  - @cat-factory/prompt-fragments@0.9.28
  - @cat-factory/spend@0.10.58
  - @cat-factory/observability-langfuse@0.7.97
  - @cat-factory/provider-bedrock@0.7.101
  - @cat-factory/provider-cloudflare@0.7.101
  - @cat-factory/provider-s3@0.2.47

## 0.53.8

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0
  - @cat-factory/server@0.61.0
  - @cat-factory/agents@0.24.12
  - @cat-factory/consensus@0.7.100
  - @cat-factory/gates@0.2.53
  - @cat-factory/gitlab@0.4.23
  - @cat-factory/integrations@0.50.2
  - @cat-factory/kernel@0.63.4
  - @cat-factory/orchestration@0.51.7
  - @cat-factory/prompt-fragments@0.9.27
  - @cat-factory/spend@0.10.57
  - @cat-factory/provider-bedrock@0.7.100
  - @cat-factory/provider-cloudflare@0.7.100
  - @cat-factory/observability-langfuse@0.7.96
  - @cat-factory/provider-s3@0.2.46

## 0.53.7

### Patch Changes

- 37c488f: Internal refactor of mothership-mode code (no behaviour change): share one `node:sqlite` open
  helper between the local credential store and work queue, make `statusForPersistenceError` a
  lookup table, inline the trivial mothership db-path wrappers, bind `pickRepoSource` through a
  local `sourced` helper (collapsing the repeated `remoteRepos`/`db` wiring, including the five
  GitHub projection repos) in the Node container, and centralize the mothership-vs-Postgres
  persistence decision in the local container behind a single `resolveLocalPersistence` helper.
- Updated dependencies [37c488f]
  - @cat-factory/server@0.60.3

## 0.53.6

### Patch Changes

- Updated dependencies [b744822]
- Updated dependencies [c40736e]
  - @cat-factory/integrations@0.50.1
  - @cat-factory/orchestration@0.51.6
  - @cat-factory/server@0.60.2

## 0.53.5

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0
  - @cat-factory/integrations@0.50.0
  - @cat-factory/agents@0.24.11
  - @cat-factory/consensus@0.7.99
  - @cat-factory/gates@0.2.52
  - @cat-factory/gitlab@0.4.22
  - @cat-factory/kernel@0.63.3
  - @cat-factory/orchestration@0.51.5
  - @cat-factory/prompt-fragments@0.9.26
  - @cat-factory/server@0.60.1
  - @cat-factory/spend@0.10.56
  - @cat-factory/provider-bedrock@0.7.99
  - @cat-factory/provider-cloudflare@0.7.99
  - @cat-factory/observability-langfuse@0.7.95
  - @cat-factory/provider-s3@0.2.45

## 0.53.4

### Patch Changes

- 79a0f48: Wire the programmatic custom provision-type catalog (`CustomManifestTypeRegistry`)
  into every facade so a code-registered `custom` manifest type is actually visible.
  Previously a deployment/provider package could register a custom manifest type, but
  no runtime constructed or injected the registry, so `listCustomTypes` always saw an
  empty registered set — the type never appeared in the infrastructure custom-type
  editor or the per-service provisioning picker.

  `customManifestTypeRegistry` now belongs to `BackendRegistries` (built by
  `createBackendRegistries()`), and the Cloudflare + Node facades thread it into
  `createCore` (local inherits via `buildNodeContainer`). A deployment registers a
  type by reference — `registries.customManifestTypeRegistry.register({ manifestId,
label, … })` — exactly like a custom environment/runner backend. The cross-runtime
  conformance suite now asserts a registered type surfaces in the handlers bundle
  (`source: 'registered'`) on both runtimes.

- 91f876b: Mothership-mode tech-debt cleanup (functionality-preserving): rename the persistence
  allow-list export `PILOT_PERSISTENCE_METHODS` → `REMOTE_PERSISTENCE_METHODS` (it is the
  functional surface, no longer a pilot) and drop the unused `accountField` `ScopeRule` kind
  that was defined but never allow-listed or exercised. Also refresh stale comments/docs that
  predated the Phase-3 merge gate (which is now MET): the `MothershipComposition.repos` JSDoc,
  the `buildNodeContainer` `db: undefined` service-matrix note, and the mothership-mode tracker
  banner. No runtime behavior change.
- Updated dependencies [79a0f48]
- Updated dependencies [91f876b]
  - @cat-factory/integrations@0.49.0
  - @cat-factory/server@0.60.0
  - @cat-factory/orchestration@0.51.4

## 0.53.3

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1
  - @cat-factory/kernel@0.63.2
  - @cat-factory/integrations@0.48.2
  - @cat-factory/server@0.59.2
  - @cat-factory/agents@0.24.10
  - @cat-factory/consensus@0.7.98
  - @cat-factory/gates@0.2.51
  - @cat-factory/gitlab@0.4.21
  - @cat-factory/orchestration@0.51.3
  - @cat-factory/prompt-fragments@0.9.25
  - @cat-factory/spend@0.10.55
  - @cat-factory/observability-langfuse@0.7.94
  - @cat-factory/provider-bedrock@0.7.98
  - @cat-factory/provider-cloudflare@0.7.98
  - @cat-factory/provider-s3@0.2.44

## 0.53.2

### Patch Changes

- Updated dependencies [66a8c71]
  - @cat-factory/integrations@0.48.1
  - @cat-factory/orchestration@0.51.2
  - @cat-factory/server@0.59.1

## 0.53.1

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0
  - @cat-factory/integrations@0.48.0
  - @cat-factory/server@0.59.0
  - @cat-factory/agents@0.24.9
  - @cat-factory/consensus@0.7.97
  - @cat-factory/gates@0.2.50
  - @cat-factory/gitlab@0.4.20
  - @cat-factory/kernel@0.63.1
  - @cat-factory/orchestration@0.51.1
  - @cat-factory/prompt-fragments@0.9.24
  - @cat-factory/spend@0.10.54
  - @cat-factory/provider-bedrock@0.7.97
  - @cat-factory/provider-cloudflare@0.7.97
  - @cat-factory/observability-langfuse@0.7.93
  - @cat-factory/provider-s3@0.2.43

## 0.53.0

### Minor Changes

- f568a8c: Add a built-in "Manual review only" merge-threshold preset and reseeding for the
  merge-preset catalog (mirroring pipelines).

  - "Manual review only" sets a new `autoMergeEnabled: false` flag, so the `merger` step
    never auto-merges a task using it — every PR is routed to a human `merge_review`
    notification regardless of the assessment scores. The flag is editable on any preset via
    a toggle in the Merge thresholds settings.
  - Built-in merge presets now carry a stable id (`mp_balanced`, `mp_manual_review`) and a
    monotonic `version`. The workspace snapshot ships `mergePresetCatalogVersions`, and the
    SPA surfaces a once-per-session startup advisory when a built-in preset is outdated or a
    new built-in appeared upstream, offering a one-click reseed
    (`POST /workspaces/:ws/merge-presets/:id/reseed`).

  Breaking (pre-1.0, no migration): `merge_threshold_presets` gains `auto_merge_enabled`
  (default on) and `version` columns (D1 + Drizzle). First read of a workspace's presets now
  seeds the whole built-in catalog (Balanced + Manual review only), not just the default.

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/kernel@0.63.0
  - @cat-factory/contracts@0.69.0
  - @cat-factory/orchestration@0.51.0
  - @cat-factory/server@0.58.0
  - @cat-factory/agents@0.24.8
  - @cat-factory/consensus@0.7.96
  - @cat-factory/gates@0.2.49
  - @cat-factory/gitlab@0.4.19
  - @cat-factory/integrations@0.47.1
  - @cat-factory/observability-langfuse@0.7.92
  - @cat-factory/provider-bedrock@0.7.96
  - @cat-factory/provider-cloudflare@0.7.96
  - @cat-factory/provider-s3@0.2.42
  - @cat-factory/spend@0.10.53
  - @cat-factory/prompt-fragments@0.9.23

## 0.52.2

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0
  - @cat-factory/integrations@0.47.0
  - @cat-factory/server@0.57.0
  - @cat-factory/agents@0.24.7
  - @cat-factory/consensus@0.7.95
  - @cat-factory/gates@0.2.48
  - @cat-factory/gitlab@0.4.18
  - @cat-factory/kernel@0.62.4
  - @cat-factory/orchestration@0.50.1
  - @cat-factory/prompt-fragments@0.9.22
  - @cat-factory/spend@0.10.52
  - @cat-factory/provider-bedrock@0.7.95
  - @cat-factory/provider-cloudflare@0.7.95
  - @cat-factory/observability-langfuse@0.7.91
  - @cat-factory/provider-s3@0.2.41

## 0.52.1

### Patch Changes

- Updated dependencies [3ec9c90]
  - @cat-factory/server@0.56.1

## 0.52.0

### Minor Changes

- cb9e2e3: Per-service provision types (Phase 2, slice 10): facade wiring for the async, container-backed
  Kubernetes deploy lifecycle + the local-mode native-CLI deploy transport. A `deployer` step whose
  manifests need rendering (kustomize/helm/Gateway-API) now stands its environment up in a real
  deploy container (or, locally, the host CLIs) on every runtime — slice 9's `deployJobClient` /
  `resolveDeployCloneTarget` seams are no longer unwired. The synchronous raw-manifest REST path is
  unchanged.

  - **Cloudflare Worker**: a new `DeployContainer` Durable Object (per-run, the separate
    deploy-harness image — `kubectl`/`kustomize`/`helm`) bound as `DEPLOY_CONTAINER`, with its
    `[[containers]]` block + binding + a `v4` migration in both wranglers and the class exported from
    the worker entry. The `image: 'deploy'` dispatch routes here while agent jobs stay on
    `ExecutionContainer`. `selectDeployDeps` wires a deploy-dedicated `RunnerJobClient` (over the
    deploy namespace) + `resolveDeployCloneTarget` when the binding + GitHub App are present.
  - **Node**: wires the default pool-backed `deployJobClient` (`new RunnerJobClient(resolveTransport)`)
    - a `resolveDeployCloneTarget` built from the App token mint, both overridable by a sibling facade.
      The self-hosted runner pool now forwards the `image` dispatch option (the generic
      `RunnerPoolTransport` + `HttpRunnerPoolProvider` expose it as a first-class `{{input.image}}`
      variable, and the native Kubernetes runner config gains an `imageDeploy` variant) so a pool pulls
      the deploy-harness image for `image: 'deploy'`.
  - **Local**: a new `NativeCliDeployTransport` (`LOCAL_DEPLOY_RUNTIME=native|container`). `native`
    (default) runs the deploy harness as a host process driving the developer's own
    `kubectl`/`kustomize`/`helm`; `container` runs the deploy image per job, keyed by its own job id so
    it never collides with the run's agent container. The clone target is inherited from Node's default
    (PAT mint + GitLab-aware origin).
  - **Shared**: `@cat-factory/server` exports `makeResolveDeployCloneTarget` (compose a deploy clone
    resolver from a repo-target walk + token mint, with a per-facade clone-URL override).
  - **Conformance**: the cross-runtime suite drives the engine's async render path on every facade —
    it forwards the provider's `deploy` kind + `image: 'deploy'` option through the wired client, polls
    a stubbed view, and finalizes — asserting the finalized record round-trips through each facade's
    real registry repo to an identical `ProvisionedEnvironment` on D1 and Postgres. (The per-facade
    transport selection is out of this runtime-neutral suite's scope; only local's selection has a
    dedicated unit test today.)

### Patch Changes

- Updated dependencies [cb9e2e3]
  - @cat-factory/contracts@0.67.0
  - @cat-factory/integrations@0.46.0
  - @cat-factory/orchestration@0.50.0
  - @cat-factory/server@0.56.0
  - @cat-factory/agents@0.24.6
  - @cat-factory/consensus@0.7.94
  - @cat-factory/gates@0.2.47
  - @cat-factory/gitlab@0.4.17
  - @cat-factory/kernel@0.62.3
  - @cat-factory/prompt-fragments@0.9.21
  - @cat-factory/spend@0.10.51
  - @cat-factory/provider-bedrock@0.7.94
  - @cat-factory/provider-cloudflare@0.7.94
  - @cat-factory/observability-langfuse@0.7.90
  - @cat-factory/provider-s3@0.2.40

## 0.51.2

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1
  - @cat-factory/integrations@0.45.0
  - @cat-factory/orchestration@0.49.0
  - @cat-factory/agents@0.24.5
  - @cat-factory/consensus@0.7.93
  - @cat-factory/gates@0.2.46
  - @cat-factory/gitlab@0.4.16
  - @cat-factory/kernel@0.62.2
  - @cat-factory/prompt-fragments@0.9.20
  - @cat-factory/server@0.55.2
  - @cat-factory/spend@0.10.50
  - @cat-factory/provider-bedrock@0.7.93
  - @cat-factory/provider-cloudflare@0.7.93
  - @cat-factory/observability-langfuse@0.7.89
  - @cat-factory/provider-s3@0.2.39

## 0.51.1

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0
  - @cat-factory/orchestration@0.48.2
  - @cat-factory/agents@0.24.4
  - @cat-factory/consensus@0.7.92
  - @cat-factory/gates@0.2.45
  - @cat-factory/gitlab@0.4.15
  - @cat-factory/integrations@0.44.1
  - @cat-factory/kernel@0.62.1
  - @cat-factory/prompt-fragments@0.9.19
  - @cat-factory/server@0.55.1
  - @cat-factory/spend@0.10.49
  - @cat-factory/provider-bedrock@0.7.92
  - @cat-factory/provider-cloudflare@0.7.92
  - @cat-factory/observability-langfuse@0.7.88
  - @cat-factory/provider-s3@0.2.38

## 0.51.0

### Minor Changes

- f9678df: Mothership mode (Phase 3 slice 3): route the board-load + run-path direct-db stores through the
  remote registry when `db` is undefined. `buildNodeContainer` previously constructed these
  org/durable stores directly from `options.db`, so a no-Postgres mothership-mode build would
  `TypeError` on the first board load / run. They now go through a single exported
  `pickRepoSource(remoteRepos, name, build)` seam: when `db` is undefined, `options.repos` is the
  full-surface remote `Proxy` (from the local facade's `composeMothership`) and the repo is sourced
  from there over RPC; otherwise the Drizzle repo is built over `db` exactly as before.

  Routed: `githubInstallationRepository`, `repoProjectionRepository` and the five GitHub projections
  (branch / PR / issue / commit / check-run), `runnerPoolConnectionRepository`, `bootstrapJobRepository`,
  `referenceArchitectureRepository`, `envConfigRepairJobRepository`, `notificationRepository`,
  `taskRepository` (issue writeback), and `subscriptionActivationRepository`. The separate
  `DrizzleServiceFrameRepository` construction is removed — `buildResolveRepoTarget` now reuses
  `repos.serviceRepository` (remote in mothership mode, Drizzle otherwise).

  Routing is orthogonal to the server-side allow-list: an un-allow-listed remote method returns a
  clean `unknown_method`, never a `db`-undefined `TypeError`. The standard (Postgres) build is
  unchanged. Tests: `pickRepoSource` routing in `runtimes/node/test/mothership-repo-source.spec.ts`,
  plus the existing no-Postgres build test which now exercises the remote-sourced repos and still makes
  no build-time network call.

  Still a DRAFT-gated initiative (see `docs/initiatives/mothership-mode.md`): the feature-flagged
  integration repos owned by the sub-helpers (tasks / documents / environments / fragments / slack) and
  the fake-mothership integration test (the runtime board-load + run-to-terminal assertion) remain
  before the mothership boot can ship.

- f9678df: Mothership mode (Phase 3 slice 4): the fake-mothership functional integration test — the merge
  gate's exit criteria — plus the agent-context run-path repo surface it surfaced.

  New test `runtimes/local/test/mothership-integration.spec.ts` boots a stock Node mothership
  (`buildNodeContainer` over real Postgres) on a 127.0.0.1 loopback and a no-Postgres mothership-mode
  `buildLocalContainer` whose `CoreRepositories` are the RPC-backed remote registry pointing at it,
  then asserts the two things the build-only tests can't: a board **loads** over the remote
  persistence RPC, and a run **drives to a persisted terminal state** (`done`) over it, with the
  execution read back straight from the mothership's Postgres. Only the agent executor is faked; the
  whole persistence path is real, so an un-allow-listed method, a mis-scoped call, or an unrouted
  direct-db store fails the test instead of a developer's first board load.

  Standing it up surfaced that `AgentContextBuilder` resolves a block's linked docs/tasks and its
  provisioned environment on EVERY agent dispatch — so those feature-flagged sub-helper repos are on
  the board-load + run path, not off it as previously assumed. Fixes:

  - `@cat-factory/node-server`: in mothership mode (`db` undefined) route the context-builder
    run-path repos — `documentRepository`, `taskRepository`, `environmentRegistryRepository` /
    `environmentConnectionRepository` — from the remote registry (the sub-helpers built them directly
    over the absent `db`). Their connect/provision surfaces stay db-direct (off the run path).
  - `@cat-factory/server`: widen `PILOT_PERSISTENCE_METHODS` to the run/board methods the path
    exercises, each workspace-scoped: `documentRepository.{listByBlock,get,getByUrl}`,
    `taskRepository.{listByBlock,get,getByUrl}`, `environmentRegistryRepository.{getByBlock,get}`, the
    run-start `modelPresetRepository.getDefault`, the board-load lazy default-preset seeds
    `mergePresetRepository.upsert` / `modelPresetRepository.upsert`, and the completion notification
    raise + inbox transitions `notificationRepository.{findOpenByBlock,upsertOpenForBlock,upsert}`.
    (`*.getByUrl` resolves a URL named in a block's description, and `notificationRepository.upsert`
    backs block-less raises + inbox act/dismiss/escalate — both squarely on the same run/post-run
    path as the reads they sit next to, so omitting them would fail any task whose description
    contains a link, or any inbox action after a run.) Round-trip + cross-account-scope unit tests
    for each are added to `persistenceRpc.spec.ts`, and the integration test patches a task with a
    URL + Jira/GitHub refs and enables the environment integration so these reads round-trip over the
    RPC end-to-end (not just in the unit suite).

  Still DRAFT-gated (`docs/initiatives/mothership-mode.md`): decrypting a remotely-sealed provisioned
  environment's access cipher needs the mothership's key (a later secrets-delegation slice); the
  kaizen-grading, LLM-metric and subscription-activation calls a run also makes degrade as best-effort
  no-ops over the remote (telemetry is Phase 5 local-first; activation is the local-sqlite bucket); and
  the remaining sub-helper surfaces (fragments / slack connect/provision) are follow-ups.

- f9678df: Mothership mode: the no-Postgres local boot SPINE (initiative slice 1b). A local node can now
  boot with `LOCAL_MOTHERSHIP_URL` set and NO local database: it composes the remote (RPC-backed)
  org repositories + a local `node:sqlite` credential store (sealed with the LOCAL key; the
  mothership's `ENCRYPTION_KEY` never reaches the machine) and drives runs with an in-process work
  runner instead of pg-boss.

  NOT yet functional end-to-end — keep the mothership PR a DRAFT. The pilot allow-list exposes only
  the six core domain repositories remotely, but a board load and a run reach many more org repos
  (mounts, settings, presets, notifications, projections, …) plus stores still built from the
  now-absent local `db`, so those paths currently throw. Routing the full repository surface through
  the remote registry + widening the server allow-list (with the per-method account/role scope rules
  that boundary needs) is the gating phase in `docs/initiatives/mothership-mode.md`; this work must
  not merge until that phase lands. See the tracker for the per-repo task list.

  - `@cat-factory/server`: `createRemoteRepositoryRegistry(client)` — a drift-proof, full-surface
    remote repository set (a `Proxy` that lazily forwards any accessed repository to one RPC), so a
    mothership-mode node backs its entire `CoreRepositories` surface remotely with no per-repo
    wiring. The server-side allow-list still gates which repo+method actually executes.
  - `@cat-factory/node-server`: `buildNodeContainer` now tolerates `db: undefined` — the per-user
    Postgres services (subscriptions, user secrets, OpenRouter catalog) turn themselves off, the
    API-key pool + local-model endpoints accept injected repositories, and the composite `repos`
    is required in that mode. Re-exports the execution driver + realtime pieces the local
    mothership boot reuses.
  - `@cat-factory/local-server`: `composeMothership` wires the remote repos + the local credential
    store; `buildLocalContainer` composes them with `db: undefined`, injects the credential repos,
    and drives runs with the new in-process `WorkRunner` (the no-pg-boss analogue, serialized per
    execution); `startLocal()` takes the dedicated no-Postgres boot path automatically when
    `LOCAL_MOTHERSHIP_URL` is set.
  - `@cat-factory/contracts`: `localModeConfig.mothership` is surfaced to the SPA so the UI can
    label what is stored locally vs delegated to the mothership.

  Login-based machine-token minting also lands later (a static `LOCAL_MOTHERSHIP_TOKEN` is used for
  now). Pre-1.0, no back-compat: the standard siloed-Postgres local mode is unchanged when
  `LOCAL_MOTHERSHIP_URL` is unset.

### Patch Changes

- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/server@0.55.0
  - @cat-factory/contracts@0.65.0
  - @cat-factory/orchestration@0.48.1
  - @cat-factory/kernel@0.62.0
  - @cat-factory/integrations@0.44.0
  - @cat-factory/agents@0.24.3
  - @cat-factory/consensus@0.7.91
  - @cat-factory/gates@0.2.44
  - @cat-factory/gitlab@0.4.14
  - @cat-factory/prompt-fragments@0.9.18
  - @cat-factory/spend@0.10.48
  - @cat-factory/observability-langfuse@0.7.87
  - @cat-factory/provider-bedrock@0.7.91
  - @cat-factory/provider-cloudflare@0.7.91
  - @cat-factory/provider-s3@0.2.37

## 0.50.0

### Minor Changes

- 9bb75b0: Per-service provision types (slices 3 + 4): the deployer engine step + run-details recording,
  and the per-type handler controllers + container wiring.

  Slice 3 — engine step:

  - The `deployer` step now resolves the SERVICE frame's declared `provisioning` and routes to the
    workspace handler for its type (merging the service's manifest source). A service declaring
    `infraless` records a no-op step output (nothing provisioned); an undeclared service falls
    through to the legacy single-connection path. The resolved provision type + engine are recorded
    on the `EnvironmentRecord` (success and failed paths) and surfaced on the step output
    (`Provision type:` / `Engine:` lines + `model: environment:<engine>:<providerId>`).
  - `EnvironmentProvisioningService.provision` gains an `initiatedBy` arg and a
    `resolveUserHandlerOverrides` seam: in local mode the run initiator's per-user handler
    overrides layer over the workspace handlers.

  Slice 4 — controllers + wiring:

  - New per-type infra handler HTTP surface on `EnvironmentController` (workspace-scoped): a batched
    `GET …/environments/handlers` bundle (handlers + custom-type catalog), `POST …/handlers`,
    `PATCH …/handlers/:provisionType/secrets`, `DELETE …/handlers/:provisionType`, plus custom-type
    CRUD (`PUT|DELETE …/environments/custom-types/:manifestId`).
  - New **local-mode-only** `EnvironmentUserHandlerController` mounted at the root
    (`GET /me/environment-handlers/:workspaceId`, `PUT|DELETE …/:provisionType`), backed by the new
    `EnvironmentUserHandlerService`. The service + per-user overrides are wired ONLY by the local
    facade (Worker/Node 503 the controller and ignore user overrides), enforced purely by container
    wiring.
  - `customManifestTypeRepository` is wired on all three facades (workspace catalog CRUD);
    `environmentUserHandlerRepository` only on the local facade.
  - The handler validation/lowering is extracted to a shared `buildInfraHandlerFields` helper used by
    both the workspace and per-user stores. Cross-runtime conformance asserts the per-type handler
    CRUD + custom-type CRUD + the `infraless` deployer no-op on every facade.

### Patch Changes

- Updated dependencies [9bb75b0]
  - @cat-factory/contracts@0.64.0
  - @cat-factory/integrations@0.43.0
  - @cat-factory/orchestration@0.48.0
  - @cat-factory/server@0.54.0
  - @cat-factory/agents@0.24.2
  - @cat-factory/consensus@0.7.90
  - @cat-factory/gates@0.2.43
  - @cat-factory/gitlab@0.4.13
  - @cat-factory/kernel@0.61.1
  - @cat-factory/prompt-fragments@0.9.17
  - @cat-factory/spend@0.10.47
  - @cat-factory/provider-bedrock@0.7.90
  - @cat-factory/provider-cloudflare@0.7.90
  - @cat-factory/observability-langfuse@0.7.86
  - @cat-factory/provider-s3@0.2.36

## 0.49.0

### Minor Changes

- 15c5894: feat(auth): remote node mode — surface the unauthenticated state and support PAT sign-in.

  - A remote facade (node service / Worker) has no anonymous tier, so once the auth handshake
    resolves with no signed-in user the SPA now routes to the login screen — even when the
    backend reports auth "disabled" (a dev-open / unconfigured remote). Previously this dropped
    the user onto a board where every per-user action silently failed with no sign-in affordance.
    An unreachable backend still falls through to the board's own error UI.
  - Source-control PAT sign-in now works on the remote node facade: a user pastes their own
    GitHub/GitLab PAT and is resolved to the account it belongs to. A hosted PAT login is held
    to the SAME login/org/domain allowlist as GitHub OAuth (admit when the login, an org it
    belongs to, or its email domain is allowlisted; fail closed when none are configured). Local
    mode keeps its configured-token, allowlist-exempt flow. `GET /auth/config` advertises the
    available PAT providers and the login screen renders a PAT option alongside OAuth/password;
    when a remote deployment has no sign-in method at all the screen explains that instead of
    showing a blank card.
  - New `TESTING_NO_AUTH` escape hatch (test-only, refused in a production-like ENVIRONMENT):
    a stronger `AUTH_DEV_OPEN` that both leaves the API open AND advertises (via `GET
/auth/config`) that the SPA may render the board anonymously instead of gating to login. The
    e2e suite opts into it; `AUTH_DEV_OPEN` on its own keeps the SPA's login gate, since a
    dev-open remote still has no anonymous tier.

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/server@0.53.0
  - @cat-factory/contracts@0.63.0
  - @cat-factory/kernel@0.61.0
  - @cat-factory/agents@0.24.1
  - @cat-factory/consensus@0.7.89
  - @cat-factory/gates@0.2.42
  - @cat-factory/gitlab@0.4.12
  - @cat-factory/integrations@0.42.1
  - @cat-factory/orchestration@0.47.1
  - @cat-factory/prompt-fragments@0.9.16
  - @cat-factory/spend@0.10.46
  - @cat-factory/observability-langfuse@0.7.85
  - @cat-factory/provider-bedrock@0.7.89
  - @cat-factory/provider-cloudflare@0.7.89
  - @cat-factory/provider-s3@0.2.35

## 0.48.0

### Minor Changes

- f383515: Per-service provision types (slice 2c — tester collapse). **Breaking:** the per-task/per-service
  `local` vs `ephemeral` Tester toggle is gone. A service's declared `provisioning` config now
  drives the Tester's infra entirely, so these are removed (BC is a non-goal — stale rows/columns
  are simply dropped):

  - the `Block` fields `defaultTestEnvironment`, `testComposePath`, `noInfraDependencies` (folded
    into `provisioning.type` / `provisioning.composePath`) — dropped from the contract, the shared
    block mapper, and the D1 (`0026_drop_tester_env_columns.sql`) + Drizzle block columns;
  - the `tester.environment` agent-config descriptor (`@cat-factory/agents`) and its prompt/job-body
    consumers — the Tester's run mode is now derived from the service's provision type;
  - the `delegateTestEnvToProvider` workspace setting (+ its D1/Drizzle column) and the local-facade
    `resolveTesterFallbackDefault` / `resolveRequireEnvironmentProvider` wiring.

  The start-time Tester gate is rewritten: it passes for an `infraless` (or undeclared) service,
  refuses a `docker-compose` service on a runtime that can't nest containers OR with no compose
  path declared (`tester_infra_unsupported` — "limited mode" / "nothing to stand up"), and requires
  a resolvable workspace handler for a `kubernetes`/`custom` service (`provision_type_unhandled`, via
  the new `EnvironmentConnectionService.resolveHandlerForType` /
  `EnvironmentProvisioningService.canProvision` seam). The Tester's run mode (the `infra` job spec +
  the prompt run-mode line, kept in lock-step) is derived from the provision type AND the run's
  provisioned environment: a service that actually provisioned an env URL (e.g. via a `deployer`
  step) tests against it regardless of declared type, and an undeclared service runs with no infra.
  The agent-executor `service` context carries `provisioning` instead of the three legacy fields. The
  service inspector replaces the local/ephemeral toggle with a provision-type selector.

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/kernel@0.60.0
  - @cat-factory/contracts@0.62.0
  - @cat-factory/agents@0.24.0
  - @cat-factory/orchestration@0.47.0
  - @cat-factory/integrations@0.42.0
  - @cat-factory/server@0.52.0
  - @cat-factory/consensus@0.7.88
  - @cat-factory/gates@0.2.41
  - @cat-factory/gitlab@0.4.11
  - @cat-factory/observability-langfuse@0.7.84
  - @cat-factory/provider-bedrock@0.7.88
  - @cat-factory/provider-cloudflare@0.7.88
  - @cat-factory/provider-s3@0.2.34
  - @cat-factory/spend@0.10.45
  - @cat-factory/prompt-fragments@0.9.15

## 0.47.0

### Minor Changes

- d21588d: Remote node mode now requires authentication from the first request — there is no
  anonymous tier. `loadNodeConfig` fails fast at boot when no login provider is configured
  (GitHub OAuth, Google OAuth, or password login with a 32+ char `AUTH_SESSION_SECRET`) and
  the `AUTH_DEV_OPEN` test hatch is off, instead of silently leaving auth disabled and
  503-ing every protected route (a confusing half-brick that read like a bug rather than a
  misconfiguration).

  Breaking: a hosted node deployment that previously booted with no auth provider configured
  (serving a fail-closed 503-only API) will now refuse to start until a login provider is
  configured. Local mode is unaffected (`applyLocalDefaults` always enables password login),
  and tests/CI continue to opt into `AUTH_DEV_OPEN` in a non-production environment.

  Because auth is mandatory in remote node mode, the SPA's existing auth gate forces the
  login screen before the app can render, so no separate front-end guard is needed for the
  credentials/subscriptions window.

## 0.46.1

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/contracts@0.61.0
  - @cat-factory/agents@0.23.4
  - @cat-factory/consensus@0.7.87
  - @cat-factory/gates@0.2.40
  - @cat-factory/gitlab@0.4.10
  - @cat-factory/integrations@0.41.1
  - @cat-factory/observability-langfuse@0.7.83
  - @cat-factory/orchestration@0.46.1
  - @cat-factory/provider-bedrock@0.7.87
  - @cat-factory/provider-cloudflare@0.7.87
  - @cat-factory/provider-s3@0.2.33
  - @cat-factory/server@0.51.3
  - @cat-factory/spend@0.10.44
  - @cat-factory/prompt-fragments@0.9.14

## 0.46.0

### Minor Changes

- 337d94d: Per-service provision types (slice 2b — reshape `environment_connections` + handler-aware
  service). **Breaking:** `environment_connections` is rekeyed from a single per-workspace
  provider binding (`(workspace_id, provider_id)`, discriminated by `kind`) into a multi-row
  per-provision-type HANDLER table `(workspace_id, provision_type, manifest_id)` with
  `engine` / `backend_kind` / `accepts_manifest_id` columns and `handler_json` (was
  `manifest_json`); pre-reshape rows are dropped (BC is a non-goal). The kernel
  `EnvironmentConnectionRepository` port becomes a multi-row API (`listByWorkspace`,
  `getByWorkspaceAndType`, `upsert`, per-type `softDelete`), mirrored in the D1 + Drizzle repos
  and the cross-runtime conformance suite.

  `EnvironmentConnectionService` gains the final handler-aware API — `registerHandler` /
  `listHandlers` / `updateHandlerSecrets` / `unregisterHandler`, custom-manifest-type CRUD, and
  `resolveProviderForType`, which matches a service's declared provisioning to a workspace
  handler and **merges the service-owned `manifestSource` into the engine config** at resolve
  time (the what/where ÷ how split). `EnvironmentProvisioningService.provision` accepts the
  service's `provisioning` and resolves per-type (short-circuiting `infraless`). A new
  `provision_type_unhandled` conflict reason is added (wire vocabulary + SPA title).

  The existing single-connection HTTP surface (register/describe/test/connection endpoints) is
  preserved as a thin **compat bridge** over the new table, so the current infrastructure UI
  keeps working unchanged; the per-type HTTP endpoints + the frontend rebuild follow in later
  slices, as does the tester collapse (dropping `defaultTestEnvironment`).

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0
  - @cat-factory/contracts@0.60.0
  - @cat-factory/integrations@0.41.0
  - @cat-factory/orchestration@0.46.0
  - @cat-factory/agents@0.23.3
  - @cat-factory/consensus@0.7.86
  - @cat-factory/gates@0.2.39
  - @cat-factory/gitlab@0.4.9
  - @cat-factory/observability-langfuse@0.7.82
  - @cat-factory/provider-bedrock@0.7.86
  - @cat-factory/provider-cloudflare@0.7.86
  - @cat-factory/provider-s3@0.2.32
  - @cat-factory/server@0.51.2
  - @cat-factory/spend@0.10.43
  - @cat-factory/prompt-fragments@0.9.13

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
