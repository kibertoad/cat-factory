# @cat-factory/contracts

## 0.156.0

### Minor Changes

- 3c7d62b: Extend `provisioningRecommendationSchema` with additive `custom`-only fields for custom-provider
  autodetection: `customConfigSeed` (extracted config to prefill), `secondaryManifestPaths` (the
  other files a multi-file signature matched), and `detectedManifestTypeCandidates` (the arbitration
  result). Documents `prefer: 'custom'` without a `manifestId` as the arbitration trigger.

## 0.155.0

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

## 0.154.2

### Patch Changes

- 91ea6b7: observability: forward the container agent's liveness heartbeat so a quiet-but-alive run stops looking wedged.

  A long, output-less phase — a `pr-reviewer` reading hundreds of files, say — advances the harness heartbeat but not its subtask counts. That heartbeat was dropped at the transport boundary: `ContainerAgentExecutor.pollJob` forwarded phase/progress/follow-ups but never `view.heartbeatAt`, so `agent_runs.updated_at` only moved on a progress change. A live-but-quiet run was indistinguishable from a wedged one to the DB, the stale-run sweeper (keys off `updated_at`), and the UI (a client clock off `startedAt`, not a server liveness signal). This is the observable-heartbeat gap ADR 0026 P3 named (its D2.1/D3 restored progress + the watchdog heartbeat, not the observable one).

  `RunnerJobView` now carries `heartbeatAt` (Cloudflare/local cast the harness view verbatim; the runner pool maps an optional `heartbeatPath`), `pollJob` forwards it as the running `AgentJobUpdate.lastActivityAt`, and the engine folds it onto the step's new `lastActivityAt` **throttled** (`shouldPersistActivity`, a 20s window well under the 5-min sweeper lease) — so a live-but-quiet run keeps `updated_at` fresh while a wedged run's frozen heartbeat correctly lets it go stale. The field rides the step JSON, so both runtimes persist it with no migration. The SPA surfaces "active Ns ago" in `StepRunMeta` (and thus the PR-review window), distinct from the elapsed clock. No harness change (the `heartbeatAt` field already exists), so no image bump.

## 0.154.1

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

## 0.154.0

### Minor Changes

- a14fe03: PR deep-review: add per-finding **Dismiss** and **Challenge** actions to the review window.

  Dismiss drops a finding entirely (pruning it from the selection); the run stays parked. Challenge
  dispatches a new read-only `challenge-investigator` agent kind against a single finding — with an
  optional specific concern, or a generic "dig deeper + validate" prompt — which re-examines it
  against the full source and reaches a verdict: `upheld` (kept as written), `amended` (kept and
  actually strengthened/clarified), or `retracted` (auto-deselected, struck through, and no longer
  actionable — nor re-challengeable). A challenge whose investigator job fails settles the finding
  `failed` and re-parks the review rather than failing the whole run, so a crashed second opinion
  never nukes the human's in-flight curation. The investigator is its own agent kind, so it can be
  pointed at a different (stronger) model than the reviewer via a per-kind model-preset override. All
  state rides `step.prReview` / `step.pendingChallenge` (no side table), so it stays runtime-symmetric;
  the cross-runtime conformance suite asserts dismiss, challenge-retract, challenge-uphold-strengthen,
  challenge-uphold-as-is, and challenge-investigator-failure.

## 0.153.0

### Minor Changes

- 8053837: PR deep-review `post`: guard against comment position drift when the PR branch is updated
  after a review starts. The reviewer's dispatch now captures the PR head sha
  (`reviewedHeadSha`), and the `post` resolution re-reads the current head before publishing:
  if the branch moved, every finding is folded into the summary comment instead of being
  anchored to a line number that may have shifted, so comments can't land on the wrong code.
  Adds an optional `pullRequestHeadSha` read to the `GitHubClient`/`VcsClient`/`RepoFiles`
  ports (best-effort; the check is inert where a provider can't read it).

## 0.152.2

### Patch Changes

- 7f54858: Make the PR deep-review `post` resolution observable, partial-tolerant, and retryable — and fix its root-cause 422.

  Previously `post` submitted the selected findings as ONE atomic `COMMENT` review. GitHub rejects the whole review if any inline comment anchors a line outside the PR diff ("Line could not be resolved"), so a single bad finding failed all of them; the run then failed with the error visible only after closing the window, which read as a stuck "Posting…" spinner.

  Now:

  - **Root cause fixed.** The engine parses the PR diff (`computeCommentableLines`) and folds any finding whose line isn't in the diff into the summary comment instead of sending an inline comment GitHub would reject.
  - **Per-comment posting + observability.** `RepoFiles.createReview` (and the underlying `GitHubClient`/`VcsClient` port) now posts each inline comment individually and returns a per-comment `CreateReviewResult`, so anchorable comments land while the rest are reported. The outcome is recorded on `step.prReview.postReport` (how many of how many posted, per-finding failures + reasons, folded count), which the deep-review window renders.
  - **No more stuck spinner; retry only the posting.** A partial or failed post re-parks the review at `awaiting_selection` carrying the report (instead of failing the whole run), so the human sees what happened and can retry ONLY the posting — `post` skips findings already posted (`postedFindingIds`) so a retry never double-posts — or switch to `fix`/`finish`.

## 0.152.1

### Patch Changes

- f2b25ba: Make a task's best-practice fragment selection authoritative. A new task is now seeded from
  its enclosing service's `serviceFragmentIds` at creation (the create-form picker is pre-filled
  with them, and a task created without the form — e.g. via the public API — inherits them too),
  and the engine folds exactly the task's own `fragmentIds` at run time instead of re-unioning the
  service's set. This is what lets a task genuinely add OR remove a best-practice fragment for
  itself: removing an inherited one on the create form (an explicit empty selection is honoured, not
  re-seeded) or in the inspector now actually drops it for that task's agents. A frame-level run
  (e.g. `blueprints`) still folds in the service's own standards. Existing tasks are not
  retroactively changed when a service's selection later changes — a new fragment is picked up by
  adding it to the task by hand.

  The "which fragments apply to a block's run" rule now lives in one shared kernel helper
  (`applicableFragmentIds`) used by BOTH run-time fold paths — the execution engine's
  `AgentContextBuilder` and the requirements-review grounding — so the requirements reviewer also
  honours a per-task removal (previously it still re-unioned the service's set, resurrecting a
  fragment the task had dropped) and the two paths can no longer drift.

## 0.152.0

### Minor Changes

- e679977: Streamline the Add-task form. Review tasks no longer require a Title (one is derived
  from the target pull request when left blank) and no longer show the Risk (merge)
  policy selector — a review merges nothing, so the policy was meaningless there. The
  form also gains a Best-practices picker: any task can pin prompt fragments from the
  resolved catalog (scoped to the enclosing frame's block type) at creation, via the new
  optional `fragmentIds` on the add-task contract (unioned with the document
  writing-style defaults for document tasks).

## 0.151.0

### Minor Changes

- 9450415: feat: scope Review tasks to the PR-review pipeline and surface brand-new built-in pipelines

  A `review` task deep-reviews an existing pull request, so a build/document/test pipeline is useless for it. The task pickers now offer a `review` task ONLY `purpose: 'review'` pipelines — exactly as a `document` task is scoped to document pipelines — via the shared `pipelineAllowedForTaskType` predicate, and the add-task form defaults a review task to the `pl_review` PR-review pipeline so its (now purpose-narrowed) picker is never empty.

  Fixes the "I don't see a review pipeline when creating a Review task" gap: existing workspaces are seeded with the pipeline catalog only at creation, and — unlike the risk-policy and model-preset catalogs — pipelines had no mechanism to surface a built-in that shipped afterwards. `PipelineService.reseed` now MATERIALISES a brand-new built-in the workspace lacks (keyed off the catalog, inserting the row when absent instead of 404ing), and the startup pipeline-health advisory (`usePipelineHealth` → `PipelineHealthModal`) lists new built-ins to add, mirroring `useRiskPolicyHealth` / `useModelPresetHealth`.

  The `pl_review` description now explains it is built for large PRs: it slices the diff into cohesive chunks and reviews each, so it works through a big change over a longer run rather than choking on it in one pass. Its `version` is bumped, so existing workspaces are offered a reseed that adopts the new copy.

## 0.150.0

### Minor Changes

- 54c44bb: feat: add a selectable `purpose` classifier to pipelines (`build` / `document` / `review` / `research` / `planning`)

  Pipelines now carry an explicit use-case classifier instead of it being inferred from their steps. It is chosen in the pipeline builder (a new selector), stamped on every built-in preset in `seedPipelines()`, and persisted in a new `pipelines.purpose` column (mirrored D1 ⇄ Drizzle).

  Two surfaces key off it, sharing the pure predicates in `@cat-factory/contracts` (`pipelineAllowedForTaskType`, `purposeAllowsAgentCategory`):

  - **Task pickers** — a `document` task now offers ONLY document pipelines (the add-task modal, the task run-settings default, and the focus-view run menu), and the add-task form defaults a document task to the `pl_document` writing pipeline. Every other task type is unrestricted.
  - **Builder palette** — selecting a non-`build` purpose hides the Implementation and Testing agent kinds (a document/review/research/planning pipeline writes no product code and runs no tests).

  Every built-in pipeline's `version` is bumped so existing workspaces are offered a reseed that stamps the new `purpose`. Breaking-change note (pre-1.0, no back-fill): a pipeline persisted before this change reads as unclassified — shown everywhere except a document task — until it is reseeded (built-ins) or re-saved with a purpose (custom).

## 0.149.0

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

- a53bbf7: Attach repo files as task context via a repository picker. When a repo-backed
  document source (GitHub / GitLab) is selected in the context-document picker, the
  user now searches for a repository (reusing the shared server-side repo search),
  then picks one or more files from it — either by searching the whole tree by path
  or by browsing it with the monorepo directory browser, which now supports
  multi-pick in file mode. Backed by a new recursive repo-tree read (`listTree` on
  the VCS/GitHub client ports, `GET /github/repos/:id/files`) so file search is a
  single cached call per repo instead of walking the tree level-by-level.

## 0.148.1

### Patch Changes

- 9b3b85e: Secret-scrub agent-context snapshots before they are persisted to telemetry.

  `AgentContextObservabilityService.record` now runs every stored body — the composed
  system/user prompts, the folded-in fragment bodies, and every injected context-file
  content — through `redactSecrets`, deep-scrubs the free-text values in the `extras` bag
  (the run's decisions and revision feedback), and drops the whole body of a context file
  whose name marks it as a raw credential store (`.env`, `*.pem`, an SSH key, `.npmrc`,
  `.git-credentials`, …). Previously only the dispatch-site allow-list guarded these bodies,
  so a token embedded in a task description, a decision note, a linked doc, or an injected
  `.env`-shaped file was stored verbatim when `storeAgentContext` was on. Scrubbing happens
  before the size budget so truncation can never split a secret across the cap.

  `redactSecrets` additionally matches PEM-armored private keys by their armor header, so a
  key pasted into any prompt or ordinarily-named file is dropped regardless of filename.

  Adds `isSecretShapedFilename` and `redactSecretsDeep` to `@cat-factory/kernel` (alongside
  `redactSecrets`) and the first unit coverage for the previously-untested `redactSecrets`
  scrubber.

## 0.148.0

### Minor Changes

- 1f5f5bc: Adopt modular-vue in the Nuxt layer (slice 2: result views + custom-kind
  manifests). The dedicated result-view registry is no longer a hardcoded `Record`
  in `StepResultViewHost.vue`: every built-in window is contributed to a modular
  `resultViews` slot (`app/modular/result-views.ts`), and the host reads the merged
  slot through `useReactiveSlots` and indexes it with `@modular-vue/core`'s
  `resolveComponentRegistry` / `pairById`. A consumer deployment ships its OWN
  result window by contributing a `{ id, component }` entry to the same slot via
  `registerAppModule` — it mounts with no host edits, paired against the kind's
  `presentation.resultView` id (the sanctioned "backend data selects a
  code-shipped, locally-registered component" pattern).

  The deployment's custom agent kinds now flow through the modular system instead
  of mutating a module-global catalog: the frozen built-in `AGENT_BY_KIND` const is
  never written to, backend-registered kinds are modeled as a per-workspace
  `RemoteModuleManifest` (`hydrateCustomKinds`), CODE-shipped consumer kinds enter
  via a static `agentKinds` slot (`registerConsumerKinds`), and the agents store
  projects the merged catalog into a reactive read-model so `agentKindMeta` /
  `isKnownAgentKind` resolve custom kinds. `registerCustomKinds` (which mutated the
  global) is removed. Note a deliberate tightening: a custom kind whose id collides
  with an engine system/gate kind (`ci` / `merger` / `blueprints` / …) is now
  dropped from the palette, not just one colliding with a built-in — matching the
  `agentKindMeta` precedence where such a kind never won anyway. The per-workspace
  manifest carries a content-derived version so an unchanged snapshot re-hydrate
  (which recurs on every board refresh) is a no-op instead of re-invalidating every
  `agentKindMeta` consumer, and built-in result-view coverage is now a compile-time
  invariant (`Record<ResultViewId, Component>`) rather than a runtime dev warning.

  `@cat-factory/contracts`: `agentPresentationSchema.resultView` is opened from a
  closed built-in picklist to also accept a consumer-namespaced id (`<ns>:<name>`,
  e.g. `acme:security-report`), so a backend-registered custom kind can select a
  consumer-registered frontend view. A bare id that is not a built-in still fails
  validation (the typo guardrail); the boot-time registration validator accepts the
  same shape.

## 0.147.1

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

## 0.147.0

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

## 0.146.0

### Minor Changes

- 60c0a1e: Stuck-run audit — Group B (invisible parks): make the two remaining silent-park cases
  discoverable and stop a recurring fire from discarding a human-parked run.

  - **F3 — spend-pause now raises a notification.** A run paused by the spend safeguard is
    invisible to the sweeper and has no auto-resume, so the paused board badge used to be its only
    signal. A new workspace-scoped `budget_paused` notification type is now raised on pause (one card
    per workspace, de-duplicated) and cleared on `resumePaused`, surfacing the pause in the inbox
    where the escalation sweep can flag it. Informational (`act` marks it read; the human raises the
    budget then resumes from the spend panel).
  - **F7 — the "waiting for a decision" card is no longer masked by a stale card.**
    `ensureWaitingNotification`'s non-clobbering guard is scoped to the parked run's `executionId`, so
    a leftover `pipeline_complete`/`merge_review`/… card from a PRIOR run can no longer stand in for a
    new `blocked` run's only recovery signal. A richer card for the same run still wins.
  - **F10 — a recurring pipeline no longer clobbers a `blocked` prior run.** The overlap guard now
    treats `blocked` (a human-parked review/decision gate) as live alongside `running`/`paused`, so
    the next cadence fire is skipped instead of orphaning the parked run's durable driver.

## 0.145.0

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

## 0.144.0

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

## 0.143.0

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

## 0.142.0

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

## 0.141.0

### Minor Changes

- e618bf5: feat: repo-sourced Claude Skills — frontend (slice 3)

  Surface the account's repo-sourced Claude Skills in the SPA
  (docs/initiatives/repo-skills.md):

  - **Snapshot skills list.** The workspace snapshot now carries the account's skill
    catalog as lightweight `{ id, name, description }` summaries (one cached account read,
    shared across the account's workspaces), attached by the shared `WorkspaceController`
    and hydrated into a `skills` store. Best-effort — an unwired library or read failure
    degrades to no options rather than breaking the board load.
  - **Per-step skill picker.** The generic `skill` palette block (already surfaced via
    `customAgentKinds`) gets a per-step picker in the pipeline builder bound to
    `stepOptions[i].skillId`, with inline hints when no skills exist, a step has no skill
    selected (mirroring the backend save/start rejection), or a picked skill has left the
    catalog (renamed/unlinked source).
  - **Account Skills management UI.** A new "Skills" tab in Account settings lists the
    synced catalog and manages linked repo sources (link via the GitHub repo/dir picker or
    manual entry, check-for-changes, resync, unlink), mirroring the fragment library's
    repo-sources surface. The GitHub-integration and library opt-in gates degrade the UI
    cleanly (503 → hidden/notice) rather than erroring.
  - Full i18n in all locales (en/de/es/fr/he/it/ja/pl/tr/uk).

## 0.140.0

### Minor Changes

- 32a0720: feat: repo-sourced Claude Skills — executable pipeline step (slice 2)

  Make a synced repo-sourced Claude Skill runnable as a pipeline step
  (docs/initiatives/repo-skills.md):

  - **One generic `skill` agent kind** (`container-coding`, `noChangesTolerated`,
    `pr-or-work` clone), parametrized per step by a new `stepOptions.skillId` — not a
    dynamic kind per skill. Pipeline save (and run-start re-validation) rejects a `skill`
    step that names no skill.
  - **`SkillRunResolver`** resolves the picked skill at dispatch: the persisted
    instructions from the account catalog plus the sibling resource bodies fetched at the
    skill's immutable pinned commit (per-file + total caps; oversized/binary files are
    referenced by repo path instead). The run never depends on a live GitHub fetch — a
    fetch failure degrades a resource to a path reference rather than failing the run.
    Wired into the engine as `skillResolver` in `AgentContextBuilder` (a skill step
    dispatched with the library unconfigured fails loudly rather than running blank), and
    the run step is pinned with `skillVersion: { skillId, commit, sha }`.
  - **Harness-aware rendering** in `ContainerAgentExecutor`: the resolved skill travels as
    a dedicated top-level `skill` job-body field (never a context file). The
    executor-harness materialises it natively into `CLAUDE_CONFIG_DIR/skills/<name>/` for
    the claude-code subscription harness (so the CLI loads it), and under
    `.cat-context/skill/` for the Pi/codex harnesses (whose prompt carries the folded-in
    instructions).
  - Bumps `@cat-factory/executor-harness` (native claude-code skills write) and the pinned
    runner image tag in the Node/local facades.

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

## 0.139.0

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

## 0.138.0

### Minor Changes

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

## 0.137.0

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

## 0.136.0

### Minor Changes

- 1869ad3: Add a "Ralph loop" task type: a persistent retry-until-done coding loop whose exit condition is
  a programmatic validation command the harness runs against the checkout (exit 0 = done), bounded
  by a per-task iteration budget and surviving restarts.

  Each iteration is a fresh-context container-coding run that works the task spec; the harness then
  runs the task's configured `ralph.validationCommand` (bounded timeout, redacted output tail) and
  reports the verdict on the run result — never a model self-report. The engine (`RalphController` +
  a `ralph-verdict` step-completion interceptor, modelled on the Tester→Fixer loop) re-dispatches a
  fresh iteration on a failing verdict until it passes or the `ralph.maxIterations` budget (default 10) is spent, then hands off to a human. Loop state rides the persisted `step.ralph` (no
  migration), so a mid-loop run is re-driven from where it was by both durable drivers + sweepers.

  - New `ralph` agent kind (the reusable loop-body primitive) + the `pl_ralph` pipeline
    (`ralph → conflicts → ci → merger`) + a `ralph` task type (a one-click creation entry point).
  - The validation command + iteration budget are per-task agent config; `AgentConfigDescriptor`
    gained `text`/`number` control types for them.
  - Cross-runtime conformance coverage (loop completes / exhausts / refuses to start unconfigured)
    and pure-logic unit tests.

  Breaking: none (pre-1.0; `taskType` / `step.ralph` / the descriptor types are additive). The
  executor-harness image is bumped for the new in-container validation capability.

## 0.135.0

### Minor Changes

- 06a094a: Grow the external public API (`/api/v1`) into a complete task-lifecycle surface: edit a task
  (`PATCH /tasks/:taskId`), stop (`POST /tasks/:taskId/stop`) and retry (`POST /tasks/:taskId/retry`)
  its run, read a rich run projection with per-step status/subtasks/failure/PR branch
  (`GET /tasks/:taskId/run`), stream it live over SSE (`GET /tasks/:taskId/events`), and discover
  startable pipelines (`GET /pipelines`). Each is key-authenticated, double-scoped to the key's
  workspace and to real board tasks, and delegates to the existing service methods; retry reuses the
  individual-usage-model refusal. The OpenAPI spec (`docs/openapi.json`) is regenerated to cover them.

## 0.134.0

### Minor Changes

- 995249b: feat(spike): timeboxed research spike tasks — kind, pipeline, findings document, PR + review delivery

  Spike tasks now run as a real timeboxed investigation that produces a findings document
  instead of falling through to a full code-and-PR build:

  - A built-in read-only `spike` agent kind (`container-explore`, structured findings + a prose
    `summary`, opened in the `generic-structured` result view). Its backend post-op renders the
    findings to `docs/research/<slug>.md` (honouring `taskTypeFields.targetPath`) via the
    checkout-free `RepoFiles` port — no harness change.
  - Findings are delivered as a PULL REQUEST by default (`pl_spike`: `requirements-review`(off) →
    `spike` → `conflicts` → `ci` → `human-review` → `merger`): the post-op commits to a work branch
    and opens a PR that the review/merge tail lands, so protected base branches are respected and
    review comments are handled by the existing `human-review` gate + `fixer`. A `pl_spike_direct`
    pipeline keeps the fast, no-PR path (commit straight to base) for unprotected repos. `spike →
pl_spike` is the task-type default, so a spike no longer dispatches a coder.
  - New reusable engine seam: a `RepoOp` may open a pull request and return its ref, which the
    engine records as `block.pullRequest` (the same linkage a container-coding step produces), so a
    deterministic backend-rendered artifact can flow through the normal conflicts/CI/human-review/
    merge tail. `RepoFiles.openPullRequest` (and the underlying `GitHubClient`/`VcsClient` ports)
    now return the PR web `url` (`OpenedPullRequest`), provider-agnostically.
  - A no-PR completion path in the engine: a task run that opened no pull requests now finishes
    `done` (like a frame-level run) instead of stalling at `pr_ready` behind a `pipeline_complete`
    notification whose confirm threw `no_pr_to_merge`. This benefits every PR-less pipeline.
  - Spike creation collects research criteria (research question, success criteria, options to
    compare, target path) alongside the time-box; all are folded into the spike prompt (the
    time-box as a scope-discipline directive). New copy is translated across all locales.

  A repo-less spike (GitHub unwired, or a docs-only spike) settles on `step.custom` — the findings
  render is skipped rather than failing the run; a rejected direct commit is best-effort (the
  findings already live on the step), while a PR-mode open failure is surfaced.

## 0.133.0

### Minor Changes

- 9e9127f: Expose basic board workloads on the external public API (`/api/v1`), and generate an OpenAPI 3
  spec for that surface.

  New key-authenticated endpoints, each scoped to the key's workspace:

  - `GET /api/v1/services` — list the workspace's services.
  - `POST /api/v1/services/:serviceId/tasks` — create a task under a service.
  - `GET /api/v1/services/:serviceId/tasks` — list a service's tasks.
  - `GET /api/v1/tasks/:taskId` — get a task's status.
  - `POST /api/v1/tasks/:taskId/start` — start (run) a task. Refused for a task on a subscription-only
    individual-usage model (no headless personal-credential unlock), or one whose enclosing service is
    archived (`409 service_archived` — an archived service's tasks stay readable but not start-able).
    The response re-reads the task after start, so it reflects the run's authoritative status.

  Reads project a `Block` onto small `publicTask` / `publicService` resources — board/engine
  internals are never leaked. Added on `BoardService`: `listServices`, `addServiceTask`,
  `getServiceTask`, `listServiceTasks` (no new repository ports or migrations — both runtimes get
  the behaviour through the shared server + orchestration layers).

  Also adds a generated `docs/openapi.json` (OpenAPI 3.1) for the whole `/api/v1` surface, produced
  from the Valibot contracts (`pnpm gen:openapi`) and guarded against drift in CI (`pnpm check:openapi`).

## 0.132.0

### Minor Changes

- b414f34: PR deep-review: resolve a parked review by fixing or posting the selected findings.

  The `pr-review` window now offers two terminal resolutions alongside `Finish`, both acting on
  the human's curated finding selection:

  - **Fix** re-dispatches the `pr-reviewer` step as a Fixer (`FIXER_AGENT_KIND`) that clones the
    reviewed PR's head branch, commits fixes addressing the selected findings, and pushes back onto
    it (no new PR).
  - **Post** publishes the selected findings as a single advisory (`COMMENT`) inline PR review — each
    line-anchored finding as an inline comment, the rest folded into the review body.

  Two new optional VCS reads/writes back these resolutions — `getPullRequestHeadRef` and
  `createReview` on the neutral `VcsClient` + `GitHubClient` ports (GitHub-implemented, omitted on
  GitLab), surfaced to the engine through the checkout-free `RepoFiles` seam. All review state stays
  on `step.prReview` (no side table); a cross-runtime conformance assertion covers both resolutions.

  Scoped to a same-repo, non-fork PR (the reviewer's existing limitation); a cross-repo `prUrl` and
  fork PRs remain a tracked follow-up. See `backend/docs/adr/0023-pr-deep-review.md`.

## 0.131.0

### Minor Changes

- a552283: PR deep-review: park a review run on its findings for a human to select which to act on.

  The read-only `pr-reviewer` no longer finishes a review task the moment it returns. Its
  sliced, prioritized findings are now recorded onto the run's `pr-reviewer` step
  (`step.prReview`) and the run PARKS for a human to visually SELECT which findings matter
  through a dedicated multi-select window (findings grouped by slice, severity badges), then
  resolve. A `pr_review_ready` inbox card (routable to Slack) is raised on park. A clean PR
  (no findings) passes through and finishes as before.

  All review state rides the step (no side table), so D1 ⇄ Drizzle parity is free; a
  cross-runtime conformance assertion covers the park → select → resolve loop. The two
  terminal resolutions — feed the selected findings to a Fixer, or post them as inline PR
  review comments — are the tracked follow-up; this ships the slicing → park → multi-select
  loop with a neutral `finish` resolution.

## 0.130.0

### Minor Changes

- 55cae97: Add a **Review** task type for deep-reviewing an existing open pull request.

  A `review` task defaults to the new `pl_review` pipeline, which runs a built-in read-only
  `pr-reviewer` agent: it slices the PR's diff into cohesive chunks, reviews each within a
  bounded context (so token usage scales on huge PRs), and returns prioritized findings
  rendered in the generic structured result view. The create-task form gains a Review type
  with a target-PR field and an optional review focus.

  Foundations for the tracked follow-ups (human finding-selection + fix/inline-comment
  resolutions): a new provider-neutral `VcsClient`/`GitHubClient.listChangedFiles` method
  (implemented for GitHub), and a no-PR terminal path so read-only pipelines that open no PR
  finish cleanly as `done` instead of stranding on a confirm-and-merge notification.

## 0.129.0

### Minor Changes

- f7e7139: Make `type: 'library'` frames behave correctly end-to-end (P0 of the library-frame-support
  initiative). Previously picking `library` at import/bootstrap changed almost nothing: build
  pipelines dispatched a deployer (a no-op at best) and an EXPLORATORY tester against a running
  system that a published package doesn't have, and an infra-needing library's suite failed on a
  missing DB because the harness's in-container compose stand-up was dormant.

  Behaviour now ADAPTS to the frame, not to a copy of the pipeline catalog — via a single pure
  capability profile shared by the engine + prompts:

  - **`frameProfile(type)` (contracts)** — a table beside `visual-pipeline.ts` mapping a frame's
    block `type` to `{ deployable, liveTestable, hasUi, testPosture }`. `library` ⇒ not deployable,
    not live-testable, no UI, `suite` posture; `frontend`/`service` keep their deployable/exploratory
    defaults; any other type defaults to the service profile. The resolved frame `type` is carried on
    `AgentRunContext.service.type` so the deployer/tester paths and prompts can consult it.
  - **Deployer no-ops on a library frame** regardless of its `provisioning` (a declared compose path
    on a library is repo-local TEST infra, not an environment): the runtime deploy loop records a
    library skip with an explanatory step output, and the run-start deployer-config /
    deployer-before-consumer / tester-infra gates pass through — so a library never demands a
    workspace environment handler.
  - **Tester runs in suite posture on a library frame** (`TESTER_SYSTEM_PROMPT` +
    `testerEnvironmentSection`): run the unit + integration suite, assess public-API coverage against
    the change, and author the missing tests — instead of exploratory testing of a running system.
  - **Local test infra revived for libraries** (`testerInfraSpec`): a library frame emits
    `{ environment: 'local', composePath }` when it declares a repo/package-local compose file — which
    brings the harness's dormant `standUpInfra` DinD path back to life on localhost — else
    `{ environment: 'local', noInfraDependencies }` and the tester self-manages test deps via the
    repo's `pretest:ci`/`test:ci`/`posttest:ci` lifecycle scripts. No harness image change (the
    `composePath` wire shape already exists).

  Cross-runtime conformance asserts the whole thing: a deploy+test pipeline on a task under a real
  `library` frame runs the deployer as a library no-op (provider never reached, no environment) and
  the tester to completion — even when the frame declares a `docker-compose` path.

## 0.128.2

### Patch Changes

- 6c4bcef: chore(environments): drop the proprietary "Kargo" name from shared custom-deployment-provider code and UI

  "Kargo" is one specific proprietary deployment provider and should not appear as the
  canonical example in the framework's shared code or UI. Replaced every illustrative
  reference (comments, the `manifestId` placeholder/help text, config-file examples) with
  neutral wording (`.deploy.yml`, `my-preview-template`, "a native custom env backend").
  Behaviour is unchanged.

## 0.128.1

### Patch Changes

- 2ce396d: Classify harness clone/push, PR/MR-open, and LLM-proxy failures with actionable remedies
  (error-message initiative F1–F3).

  The executor-harness surfaced three common runtime failures as raw, opaque text: a git
  `Authentication failed` / `repository not found` stderr line, a bare `Failed to open PR
(HTTP <status>)`, and — for a run where every model call was refused — Pi's terse
  `finalError` classified only as a generic `agent` failure. Each now names the cause and the
  fix, at the single point where the third-party text enters our system (per the initiative's
  first-wrap-point rule); the raw line is preserved as detail, only the remedy is appended.

  - **F1 (git):** `describeGitFailure(stderr)` matches the auth / repository-not-found /
    write-permission shapes and appends a host-neutral remedy (reconnect the GitHub App, or in
    local mode regenerate the `GITHUB_PAT`; confirm repo visibility / write access), keeping the
    `git` structured cause.
  - **F2 (PR/MR open):** `describePrOpenFailure(status, provider)` maps 401 / 403 / 404 /
    422 (GitHub) / 400 (GitLab) to a remedy tailored per provider (GitHub App "Pull requests:
    write" vs GitLab `api` scope; the PR vs merge-request noun), keeping the `api` cause and the
    load-bearing `Failed to open …(HTTP n)` first line.
  - **F3 (LLM proxy):** a new `llm-upstream` `FailureCause` (mirrored in the kernel
    `HARNESS_FAILURE_CAUSES` union, mapped to the coarse `agent` kind). When Pi's terminal error
    is the proxy refusing every call, `classifyLlmUpstreamError` distinguishes auth (401/403),
    quota/credit (402) and rate-limit (429) and stamps `HarnessFailure('llm-upstream', …)` with
    the matching fix (re-enter the provider key in the AI key pool / top up quota / wait and
    retry) instead of a generic agent failure. The structured cause rides `RunnerJobView`'s
    `failureCause` to the engine as `AgentFailure.reason`.

  This bumps the executor-harness image tag (`1.43.3`) and the three hand-maintained pins.

## 0.128.0

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

## 0.127.1

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

## 0.127.0

### Minor Changes

- d1a4129: Complete the implementation-fork decision phase with grounded CHAT (PR 2 of the initiative).
  Before the Coder writes code, a human parked on the surfaced forks can now ask questions about
  them and get a grounded, comparative answer before deciding. Each human turn is answered by an
  inline LLM in the durable driver (no container re-dispatch) over the fixed proposal grounding +
  the thread; a `maxChatTurns` budget bounds spend, and with no chat model wired the chat degrades
  to a canned "chat unavailable" reply so pick / custom still work. Adds the
  `POST /executions/:id/fork-decision/chat` endpoint, the `fork-chat` prompt (v1), the
  `ForkChatService`, the `pendingForkChat` re-entry protocol, the window chat thread, and the
  cross-runtime + e2e coverage. The fork-decision initiative tracker is converted to ADR 0022.

## 0.126.0

### Minor Changes

- 5072999: Boot-time configuration problems now carry a documentation link. Each `ENV_HELP`
  entry embeds a stable in-repo doc URL (built through a new centralized `DOCS`
  helper in `@cat-factory/server`), the operator log appends a `Docs:` line, and the
  "backend misconfigured" screen renders a "View documentation" link per problem.
  This establishes the doc-URL convention for the error-message coverage initiative
  (item A1).

## 0.125.0

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

## 0.124.1

### Patch Changes

- 127fe3e: Apriori branches (slice 2): working mode.

  A task's single optional `working` apriori branch now drives the run — the agents start from
  and keep committing into that pre-existing branch instead of minting `cat-factory/<blockId>`,
  and the PR opens from it, the CI gate polls it, and the merger merges it. See
  `docs/initiatives/apriori-branches.md`.

  - **Context**: the engine lifts the block's `aprioriBranches` verbatim onto the agent run
    context (`AgentRunContext.aprioriBranches`), a pure projection like `referenceRepos`.
  - **Work-branch swap**: `ContainerAgentExecutor.buildJobBody` and the two `RunDispatcher`
    repo-op sites (`resolveRepoOpBranch` + the spec-writer `builtInRepoOpBranch`) resolve the
    work branch as `resolveAprioriWorkingBranch(...) ?? cat-factory/<blockId>`, so every
    downstream builder (`newBranch` / `pushBranch` / explore fallback / PR head) rides the
    user's branch. The base-branch rejection is a single shared `resolveAprioriWorkingBranch`
    helper (`@cat-factory/contracts`) so the executor and dispatcher rejections can't drift.
  - **Probe, never create**: an apriori working branch must already exist — it is probed
    (`ensureWorkBranch(..., { create: false })`, or a checkout-free `headSha`), and a missing
    branch fails the dispatch loudly rather than being silently created off base. A working
    branch equal to the repo base is rejected.
  - **Merge teardown guard**: `GitHubPullRequestMerger` only deletes a merged head branch when
    it is a platform `cat-factory/*` branch — a user-provided apriori branch is never torn down
    (reusing a merged apriori branch on a later task intentionally resumes it).
  - **Conformance**: a cross-runtime assertion that a custom kind's post-op commits onto the
    task's apriori working branch instead of `cat-factory/<blockId>` on both stores.

## 0.124.0

### Minor Changes

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

## 0.123.1

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

## 0.123.0

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

## 0.122.0

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

## 0.121.2

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

## 0.121.1

### Patch Changes

- 9aa9e19: Initiatives: phases can now declare a `checkpoint` (slice 2 of the
  custom-initiative-definitions initiative). A checkpoint phase PAUSES the initiative for
  human review once every one of its items settles, before the next phase spawns — so a
  human can read the phase's committed output (e.g. a research doc + GO/NO_GO verdict) and
  then resume to continue or cancel to stop. The engine never interprets an LLM verdict:
  the pause is declarative phase data the loop reads, and resume is the acknowledgment.

  - Contracts: `checkpoint?` on the plan/entity/draft phase and the preset phase-template
    phase, plus `checkpointClearedAt?` bookkeeping on the entity phase; a new `checkpoint`
    reason on the `initiative` notification.
  - Ingest stamps a template-authored `checkpoint` onto the matched phase (forced on — the
    planner cannot unset it), honours a planner-authored one on any draft phase (generic,
    usable without a preset), and preserves `checkpointClearedAt` across a re-plan.
  - The execution loop pauses at a completed, uncleared checkpoint phase (checked before
    completion, so a last-phase checkpoint still pauses) and raises the notification;
    `InitiativeService.resume` clears the checkpoint in the same CAS transform it resumes in.
  - The in-repo tracker markdown annotates a checkpoint phase (pending vs cleared).

  Non-checkpoint phases are byte-for-byte unchanged — a plan with no `checkpoint` advances
  exactly as before.

## 0.121.0

### Minor Changes

- 63f7881: Code Commenter is now a business-as-usual step in the full build pipelines, keeping in-source
  comments relevant and up to date on every task instead of only on a dedicated standalone run.

  - **Full pipelines gain a `code-commenter` step** (`pl_full` and `pl_fullstack`, versions bumped
    for the reseed): it runs right after the `reviewer` clears the implementation and edits comments
    only — adding why-not-what comments, updating ones that have drifted from the code, and deleting
    noise comments that merely restate what the code already says — with no behaviour change. The
    existing `ci` step is the backstop that proves the comment-only diff is behaviour-neutral before
    `merger` ships it.
  - **One parametrized agent serves both use-cases.** A new adaptive clone mode `pr-or-work`
    (`AgentCloneSpec.branch`) makes the Code Commenter amend the block's existing PR in place when
    there is one (the BAU pipeline case — the well-commented code ships in the coder's own PR) and
    fall back to branching off base and opening its own PR when there is none (a standalone
    `pl_code_comments` run or an initiative-framed sweep of a legacy codebase). It is
    `noChangesTolerated`, so a run that finds the comments already in good shape is a clean
    non-event rather than a failure. No new agent kind, no executor-harness image change.
  - The Code Commenter's prompt now actively **maintains** existing comments (fix/remove stale ones,
    strip redundant ones) rather than only adding new ones, and scopes a BAU run to the files the
    pull request changes.
  - **Hardening:** `agentPresentationSchema.description` is now required and non-empty
    (`minLength(1)`, like `label`/`icon`/`color`). The SPA renders a registered kind's description
    verbatim in the pipeline builder palette with no fallback, so a blank one would have surfaced as
    an empty description on a first-class palette block; this makes that impossible at the wire
    boundary. Every existing agent kind already ships a description, so nothing changes for them.

## 0.120.0

### Minor Changes

- a2db337: Planning-interview questions gain the same answer surface as requirements review, via a shared
  clarification-item abstraction (see `docs/initiatives/clarification-items.md`).

  A planning question can now be marked **not relevant** (dismissed — it stops blocking Continue and
  the interviewer is told not to re-ask it) and the human can ask the interviewer to **recommend** a
  suggested answer (drafted inline, adopted with "use this answer"). These reuse a new shared
  `ClarificationItem` component rather than cloning the requirements UI. `InitiativeQa` gains
  `status` + `recommendation`; no DB migration (the initiative persists as a JSON blob, so both
  runtimes pick up the fields for free). The initiative board card also pulses while its interview is
  awaiting answers, matching how a review gate surfaces attention on a task card.

## 0.119.0

### Minor Changes

- 8728bf7: Capture per-run diagnostics on `agent_runs` for after-the-fact investigation. Each run now
  records a `diagnostics` object (riding in the run's `detail` JSON, like `notes`/`frontendBindings`)
  with the most recent container-step dispatch context — `agentKind`, resolved `model`, the `repo`
  (owner/name/baseBranch/provider), the **execution backend** (`local-native` vs `local-container`
  vs `runner-pool` vs `cloudflare-container` — the datum that distinguishes a native host-process run
  from a sandboxed container), and the control-plane host `platform`. The backend is reported by the
  runner transport (a new optional `RunnerTransport.backend` / `RunnerJobView.backend`, stamped by
  the shared job client; the native/container router stamps its per-job leg).

  Also preserves the harness's fine-grained failure `cause` (`git` / `api` / `no-usable-output` /
  `no-changes`) on the failure's machine-readable `reason` instead of collapsing it to the coarse
  `agent` kind — so a push/clone failure reads as `git`, not a generic agent error, without grepping
  the transcript. No schema migration (the diagnostics ride in the existing `detail` column; the
  cause rides on the existing `failure.reason`); mirrored across both runtimes with a cross-runtime
  conformance round-trip assertion.

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

## 0.118.0

### Minor Changes

- b35e1a0: Technological-migration initiative — slice T1: preset phase templates (contract + planner prompt fold).

  A generic, declarative capability that lets an initiative preset shape its plan's phase
  structure; the migration preset (a later slice) is its first consumer, and `preset_generic`
  declares no template and stays byte-for-byte free-form.

  - **contracts**: `InitiativePresetDescriptor` gains an optional `phaseTemplate: { phases:
[{ id, title, goal, required? }], allowAdditionalPhases? }`. `id`/`title`/`goal` reuse the exact
    clamps of `initiativePhaseSchema` (so a template phase matches a planned phase by id); phase ids
    must be unique and the array non-empty. Pure serialisable wire data (like `policyDefaults`), so
    it rides the workspace snapshot and a future SPA create-time preview needs zero per-preset work.
  - **kernel**: `AgentRunContext.initiative.preset` now carries an optional `phaseTemplate` and its
    `promptAddition` is optional — a preset may contribute a template, steering, or both.
  - **orchestration** (`AgentContextBuilder`): the preset-context resolver surfaces the descriptor's
    `phaseTemplate` and returns the preset context when EITHER a per-kind `promptAddition` OR a
    `phaseTemplate` is present (neither ⇒ absent, so the generic planning prompt is unchanged).
  - **server** (planner prompt fold): when the resolved preset declares a template, the initiative
    **planner** prompt renders a generic "Required plan shape" section — phase ids VERBATIM, titles,
    goals, order, and whether extra phases are allowed. Generic code that never branches on a preset
    id; no template ⇒ the free-form planner prompt is byte-for-byte today's, and the analyst prompt
    (a prose step) never renders the plan shape.

  Ingest normalization/enforcement of the template shape is the following slice (T2); this slice
  lands the contract + the prompt fold only.

## 0.117.0

### Minor Changes

- 4a3e536: Initiative presets — slice 5: loop/ingest glue (spawn decoration + `seedPlan` at ingest).

  - **contracts** (`initiativeItemSpawnSchema`): the spawn bag now carries an optional `taskType`, so
    a preset's `seedPlan` can declare a spawned item's kind (`document`/`bug`/`spike`/…) exactly as
    the create-task form does.
  - **orchestration** (`InitiativeLoopService.buildTaskBlock`): a spawned item's preset-authored
    `spawn` bag is now folded onto the task block, so a planned item comes out as a first-class
    TYPED task rather than a bare description block — its `taskType` (so a doc task classifies as
    `document`, not the default `feature` — `taskType`-keyed per-type task limits and the SPA's
    document affordances now apply), the doc task's `taskTypeFields` (`docKind`/`targetPath`/…),
    best-practice `fragmentIds`, and per-agent `agentConfig`. Each is additive + sparse (an empty bag
    is omitted), mirroring `BoardService.addTask`, so a decoration-less item (the generic / no-preset
    case) spawns a block byte-identical to before. A `document`-typed spawn with no explicit
    `fragmentIds` inherits the default writing-style fragments, exactly as `BoardService.addTask`
    seeds them for a board-created document task. The per-run gate override (`spawn.gates`, slice 2)
    is unchanged.
  - **orchestration** (`applyPlanDraft`): the draft item's `spawn` decoration is now carried onto the
    persisted item (it follows the draft like the other content fields), so `buildTaskBlock` can read
    it. A re-plan refreshing an already-materialised item is harmless — its block was decorated when
    it spawned.
  - **orchestration** (`InitiativeService.ingestPlan`): runs the resolved initiative preset's
    `seedPlan` post-processor over the parsed draft BEFORE `applyPlanDraft`. The preset is resolved
    from the entity's FROZEN `presetId`/`presetInputs`, so reading it outside the CAS `mutate` is
    race-free and (being pure) replay-safe. The hook's output is RE-PARSED through the strict schema:
    a `seedPlan` bug can't persist a malformed draft, and an unsafe spawn `targetPath` (from a hook OR
    the planner) is rejected by `taskTypeFieldsSchema`'s `isSafeDocPath` check — it can never escape
    the repo. Absent preset / no `seedPlan` ⇒ the draft is applied unchanged (byte-for-byte the
    pre-slice-5 path).
  - **conformance**: asserts a preset-authored item `spawn` bag (task type, typed-task fields,
    fragments, agent config, gate override) round-trips through the initiative store intact on both
    runtimes — a store that dropped it would silently spawn a bare block instead of a first-class doc
    task.

## 0.116.1

### Patch Changes

- 18a9cb5: Initiative presets — slice 4: SPA preset picker + generic descriptor-driven create form.

  - **CreateInitiativeModal** becomes a preset-aware create surface: a picker over the registered
    presets (built-in "Custom initiative" + any a deployment registered), defaulting to
    `preset_generic`. The picker is shown only when more than one preset exists, so a stock install
    keeps today's plain title/goal form. On submit the modal sends the selected `presetId` + the
    sanitized `presetInputs`.
  - **New `InitiativePresetFields.vue`** — a GENERIC descriptor-driven field renderer (zero per-preset
    frontend code), extending the `ProviderConnectionTab` flat-field pattern with the three shapes a
    preset form needs: `checkbox-group` (multi-select → `string[]`), `path` (repo-relative dir with an
    inline safety error via the shared `isSafeRepoDirPath`), and single-condition `showWhen`
    visibility (via the shared `isPresetFieldVisible`). The model is the typed `InitiativePresetInputs`
    so it round-trips the wire contract unchanged.
  - **Probe prefill**: selecting a preset with a detection probe fires
    `POST …/initiative-presets/:id/probe` for the target frame and merges the detected values (known
    fields only) over the descriptor defaults, with a stale-response guard. Best-effort — a failure /
    unwired GitHub falls back to defaults and never blocks create.
  - Client-side create validation mirrors the server via the SAME shared
    `validateInitiativePresetInputs`, gating the submit button; the per-field path error renders
    inline. New pure `defaultPresetInputs` util seeds the form's initial typed values from the
    descriptor. Store `create` now forwards `presetId`/`presetInputs`; new `probePreset` store action
    - `probeInitiativePreset` API binding. i18n chrome (`initiative.create.preset` /
      `.pathInvalid`) added across all locales.
  - Review follow-ups: the renderer now DROPS emptied fields (blank string / empty multi-select /
    unchecked box) so a cleared field stays absent instead of freezing an empty value on the entity;
    the in-flight probe no longer clobbers a value the user typed while it was loading; and
    `isPresetFieldVisible` (`@cat-factory/contracts`) treats an absent value as `false` for a boolean
    `equals: false` condition, so a `showWhen`-gated field appears at first render for an unchecked box
    (previously only after a toggle) — the same shared function both facades already use.

## 0.116.0

### Minor Changes

- bc77f89: Initiative presets — slice 3: create/planning integration.

  - **contracts**: `createInitiativeSchema` gains optional `presetId` + `presetInputs` (validated
    against the resolved descriptor at create and frozen on the entity). New
    `probeInitiativePresetContract` (`POST /workspaces/:ws/initiative-presets/:presetId/probe`,
    body `{ frameId }` → the detected `InitiativePresetInputs`). The workspace snapshot gains
    `initiativePresets: InitiativePresetDescriptor[]`. New pure helpers
    `sanitizeInitiativePresetInputs` (reduce a form to its known, visible fields) and
    `renderInitiativePresetValue` (option-label-aware value rendering), shared by the create flow.
  - **orchestration** (`InitiativeService.create`): resolves + validates the preset (an unknown id
    or an invalid form is a create-time `ValidationError`, so nothing is written), and — only when a
    preset resolves — persists `presetId` + the SANITIZED `presetInputs` (known, currently-visible
    fields only, so a hidden field's unvalidated value can never freeze, and a form posted with no
    `presetId` is dropped). For a `skip`-interview preset it seeds the `qa` digest from the filled
    form (one answered exchange per visible, filled field via the new pure `seedPresetInterviewQa`)
    and templates the goal (the human's description wins, else the preset's stated purpose). Absent
    `presetId` ⇒ today's behaviour byte-for-byte.
  - **orchestration** (`AgentContextBuilder`): an initiative planning step's context now folds in the
    preset `{ label, promptAddition }` resolved for the RUNNING kind — set ONLY when that kind has
    steering — so the analyst/planner prompts carry the preset's per-kind steering. The generic
    preset registers no steering, so the generic planning prompt is unchanged.
  - **kernel**: `AgentRunContext.initiative` gains an optional `preset` sub-object carrying the
    preset `label` + the per-kind `promptAddition` (the frozen form reaches the prompt via `qa`).
  - **server**: the shared `WorkspaceController` attaches `initiativePresets`
    (`initiativePresetDescriptors()`) to the snapshot on both the create + read handlers (so both
    facades advertise it), and `InitiativeController` serves the probe endpoint — resolving the
    frame's repo through the existing `resolveRunRepoContext` seam and running the preset's `detect`
    hook, returning `{}` (descriptor defaults) whenever GitHub is unwired / the frame has no linked
    repo / the preset has no probe hook, so it never blocks create. The initiative planning prompts
    render the folded-in preset steering.
  - **app**: the SPA hydrates `initiativePresets` from the snapshot and starts planning with the
    initiative's preset descriptor's `planningPipelineId` (the generic/absent preset keeps
    `pl_initiative`) instead of a hardcoded id. A NAMED preset that hasn't hydrated resolves to
    `null` (not the generic pipeline), so "Run planning" stays disabled rather than silently
    launching the interviewer over an already-seeded skip-interview initiative.

  Conformance: a shared assertion that both facades advertise the built-in generic preset on the
  snapshot (create + read), binding `pl_initiative` and the interviewer.

## 0.115.0

### Minor Changes

- 802fc05: Deployer run-start config gate: when a pipeline includes an enabled `deployer` step, validate the service's ephemeral-environment provisioning (the in-repo "what/where") AND the workspace's infra handler (the "how") are complete + correct BEFORE starting, and — best-effort — probe the resolved deployment integration's live connection. A gap now fails loudly at start with an actionable, deep-linked toast (fix the service config / configure the handler / re-test the connection) instead of an async failed environment (or a silent docker-compose no-op) mid-run.

  - New pure decision logic (`decideDeployerConfig` / `deployerServiceConfigIssues` / `hasEnabledDeployerStep`) drives a new `ExecutionService` start guard shared by start/retry/restart.
  - New `EnvironmentProvisioningService.testProvisioning` probes the already-saved handler's connection; `canProvision` now honors the run initiator's local per-user handler overrides. The run initiator is threaded through every handler-resolution path — the new gate, the Tester infra gate, and the deployer's own dispatch decision — so a valid override-only local compose setup resolves identically at start and at provision time (a run that passes the gate provisions instead of silently no-opping).
  - New wire conflict reasons `deployer_service_provisioning_incomplete` and `deployer_connection_test_failed`; `provision_type_unhandled` toasts now carry a "Configure infrastructure" jump.

## 0.114.0

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

## 0.113.0

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

## 0.112.0

### Minor Changes

- ecbcbec: Add repo autodetection to the shared-stacks definition screen. A new **Autodetect** button on
  the shared-stack form reads the repo at the entered clone URL — checkout-free, over the
  workspace's VCS connection (no clone, no host daemon) — and prefills the compose-shaped fields
  from a non-binding recommendation the user reviews before saving:

  - **`composeFiles`** — the base compose file plus any `<stem>.override.ya?ml` auto-merge family
    (the common single self-contained `docker-compose.yml` case resolves to just that one file).
  - **`managedNetworks`** — the `external: true` networks the compose references, which a shared
    stack is responsible for creating + owning (the `acme-net` shape). A self-contained stack that
    defines its dependencies internally declares no external network, so this stays empty.
  - **`composeProfiles`** — the `COMPOSE_PROFILES` the file declares.
  - A suggested **name** from the repo basename (only when the field is empty).

  New wire contract `POST /workspaces/:ws/shared-stacks/detect` (`detectSharedStackContract` +
  `sharedStackRecommendationSchema`), served by `SharedStackService.detect`, which reuses the
  deterministic compose scan (`detectSharedStack`) the environment provisioning detector already
  runs. Detection is a pass-through (`detected: false`) when no VCS connection is wired, and a
  genuine read fault surfaces as an actionable error. Nothing is persisted.

## 0.111.0

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

## 0.110.1

### Patch Changes

- 10787c4: Make the "environment provisioning failed" surface actionable when no deploy runner is wired.

  - **Backend, provider-agnostic message:** the `EnvironmentProvisioningService` error for a
    render-needing config with no `deployJobClient` no longer hardcodes Kubernetes tooling (it
    reaches for any provider that needs a container-backed deploy). It names the runtime-neutral
    transport remedies (a self-hosted runner pool, `LOCAL_DEPLOY_RUNTIME`, or the Cloudflare
    `DeployContainer` binding) or using a config that provisions without a deploy container.
  - **Structured failure reason:** `AgentFailure` gains an optional machine-readable `reason`
    (JSON column — no migration), and this condition carries `deploy_runner_unwired`
    (`EnvironmentFailureReason` in contracts) from the thrown `ValidationError` through the
    deployer-step failure path onto the run's failure, so the SPA can act on the cause without
    string-matching prose. Adds `getErrorReason` to the kernel error helpers.
  - **Frontend, precisely-gated guidance:** the board's `AgentFailureCard` shows a "Configure…"
    deep-link on `environment`-kind failures whose destination follows the cause: a
    `deploy_runner_unwired` failure on a non-local deployment links to Infrastructure → **Agent
    containers** (`runner-pool`) — where the deploy runner/pool is actually wired, so the button no
    longer dead-ends on the Test-environments tab that can't fix it — while every other environment
    failure keeps linking to Infrastructure → **Test environments** (`environment`). The
    Kubernetes+local env-var hint (`LOCAL_DEPLOY_RUNTIME` + `LOCAL_DEPLOY_HARNESS_ENTRY` /
    `LOCAL_DEPLOY_IMAGE`) is shown ONLY for the `deploy_runner_unwired` reason, in local mode, and
    for a `kubernetes` provision — so a docker-compose / transient / future non-K8s failure never
    shows inaccurate guidance.

## 0.110.0

### Minor Changes

- f596090: Record successful step outputs in the step-detail "execution history", not just failures.

  A restart-from-step resets the chosen step and every later one, dropping their `output`;
  previously that successful work was lost and the per-step history could only ever show
  errors. The run now keeps an `outputHistory` — the positive complement of `failureHistory`
  — capturing the successful outputs a restart superseded (attributed by step index, bounded
  in count + per-entry size, riding the run's `detail` JSON with no schema migration). The
  step-detail overlay renders a merged, newest-first timeline of these superseded outputs and
  the failed attempts. A plain retry (which re-runs only unfinished steps) records nothing.

## 0.109.0

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

## 0.108.1

### Patch Changes

- e66accb: Stack recipes & shared stacks (slice 7): make the Deployer the sole docker-compose provisioner + the environment setup wizard scaffolding.

  **Deployer becomes the single docker-compose provisioner (the compose-centralization follow-up owed by this slice).** Now that the setup wizard can save a `docker-compose` handler, docker-compose is provisioned by the single Deployer step through a workspace handler, exactly like `kubernetes`/`custom` — the in-container (DinD) bring-up is retired from the run-mode decision:

  - `decideTesterInfra` (`tester-infra.logic.ts`): `docker-compose` is handler-based (drops the `localTestInfraSupported`/`hasComposePath` inputs and the `limited-local`/`compose-unconfigured` reasons).
  - `needsDeployerBeforeConsumer` + `ExecutionService.assertTesterInfraConfigured`'s `needsHandler` now cover `docker-compose`, so a compose chain that reaches a tester with no resolvable handler is refused at run start (fail-fast, same as k8s/custom) instead of dead-ending.
  - `testerInfraSpec` (`@cat-factory/server`): `docker-compose` targets the Deployer-provisioned env (`environment: 'ephemeral'`); the `local`/`composePath` branch is gone.
  - (The harness's in-container `docker compose up` is now unreachable and retired in a later image-bumping slice.)

  **Environment setup wizard.** The guided detect → review → preflight → save flow the compose-centralization depends on: `EnvironmentSetupWizard.vue` (stepper shell over the `environmentWizard` store — detection, opt-in deep analysis via `pl_environment_analysis` with live provenance-merged review, compose-file/profile/seed candidate pickers, a raw-recipe editor, the preflight checklist, save the workspace compose handler + the frame recipe, and an optional trial provision with live provisioning logs), a docker-compose service-inspector nudge, a SideBar entry, the mount in `pages/index.vue`, and the `environmentWizard` i18n namespace across all 8 locales. Backed by the `preflights` API + store (`POST /workspaces/:ws/preflights/run`) and the `provisionEnvironment` API. (The `data-testid`-only e2e spec is deferred — it needs a fake `ProvisioningRepoReader` e2e seam so detection returns a canned recommendation with GitHub off; tracked in the slice-7 checklist.)

  Breaking (pre-1.0, acceptable): a `docker-compose` service reaching a tester/human-test with no configured compose handler is now refused at run start rather than falling back to an in-container compose bring-up.

  Review follow-ups in the same slice: the `environmentWizard` store now fully resets per-frame state when re-targeted (`selectFrame` no longer leaves a prior frame's `saved`/service/port behind), resolves the analyst run by preferring a live/succeeded instance over a bare `.at(-1)` (so a retry's dead predecessor can't mask the successful run), validates the exposed port before registering the handler, and surfaces a real (non-503) preflight failure instead of swallowing it. The now-dead `localTestInfraSupported` dependency (its only reads were removed with the DinD path) is dropped from `CoreDependencies`/`ExecutionService` and the local facade's wiring, and the stale DinD doc comments on `assertTesterInfraConfigured` / `testerInfraSpec` are corrected.

## 0.108.0

### Minor Changes

- 1afa003: Make the **Deployer the single environment provisioner** and fix environment-lifecycle
  correctness so a `kubernetes`/`custom` service can no longer dead-end inside the Tester.

  - **Deployer in every tester/human-test built-in pipeline.** A type-aware `deployer` is seeded
    before the first tester / human-test / playwright step in the 12 relevant built-ins. It
    provisions `kubernetes`/`custom`, a `docker-compose` service with a resolvable compose handler,
    or an undeclared service on a workspace with a legacy connection, and is a fast **no-op** for
    `infraless`/frontend frames (and for `docker-compose` with no compose handler configured yet) — so
    the injection is safe everywhere. Touched built-ins get a `version` bump (reseed offer).
  - **Docker-compose provisions through the Deployer** (single-provisioner direction) whenever a
    compose handler resolves; the Tester then targets that provisioned env (`testerInfraSpec` already
    prefers a provisioned URL for any type). Until the shared-stacks compose-connection setup wizard
    lands, docker-compose with no handler stays a Deployer no-op and the Tester falls back to its
    in-container compose bring-up (no regression). See the initiative trackers for the full
    centralization owed once the wizard ships.
  - **`human-test` no longer self-provisions.** The gate READS the environment the upstream Deployer
    provisioned (the one env is shared by the AI tester + the human), and its recreate / fix-loop /
    pull-main rebuild now **loops back to the Deployer** to re-provision, rather than standing up its
    own env. No deployer before it (an infraless service) ⇒ the gate degrades to manual mode.
  - **Fail-fast run-start guard.** Starting a `kubernetes`/`custom` pipeline whose enabled chain
    reaches a tester/human-test with no enabled `deployer` before it is now refused with an actionable
    `deployer_required_before_tester` conflict (new `ConflictReason`) instead of the silent
    ephemeral-with-no-coordinates dead-end inside the Tester.
  - **Environment teardown correctness.** Superseding a provisioned env now tears the old infra down
    when the new provision targets a DIFFERENT provider identity (a config-change namespace switch, a
    provider/type change, or the `infraless` flip) — best-effort, with the TTL reaper as the backstop
    — instead of only tombstoning the registry row. Teardown + status now resolve the provider from
    the env RECORD's stored provision type/engine (the handler that stood it up), not the
    workspace-primary handler.
  - **Named-gate pipeline authoring.** Built-in pipelines are authored with `definePipeline` +
    named-step specs (`{ kind, gate, enabled }`) instead of fragile index-aligned `gates`/`enabled`
    boolean arrays, so a gate is declared on its step by name and inserting a step can't shift a flag
    onto the wrong one. The persisted wire shape is unchanged.
  - Frontend: a `deployer` palette/step metadata entry (renders as "Deployer" rather than a generic
    agent) and the localized `deployer_required_before_tester` conflict title.

  Breaking (pre-1.0, acceptable): persisted built-in pipeline copies are offered a reseed to gain the
  deployer step; a `kubernetes`/`custom` pipeline that previously relied on the Tester dead-ending is
  now refused at launch until a Deployer is added or the service is set to docker-compose/infraless.

- f91b99d: Stack recipes & shared stacks (slice 7, part 1): the analyst draft-merge core.

  Adds `mergeAnalystRecipeDraft(recommendation, draft)` — the pure function that combines the deterministic provisioning recommendation with the opt-in environment analyst's `AnalystRecipeDraft` into a single reviewable recipe with per-field provenance. This is the "review recipe" input the setup wizard renders (the piece slice 8 deferred here).

  The rule: **deterministic detector facts win where both produce a field; analyst-only fields (setup steps, health gate, prerequisites the checkout-free scan can't see) fill the gaps.** Each populated field carries the winning source's provenance — detector confidence + note, or the analyst's rationale + source citations — and the analyst's verbatim notes ride along so the wizard can surface granular per-step provenance (e.g. `setupSteps[2]`).

  - `mergeAnalystRecipeDraft` + the `MergedRecipeDraft` / `MergedRecipeField` / `RecipeFieldOrigin` view-model types + the `MERGEABLE_RECIPE_FIELDS` field list (`environment-analyst-merge.ts`).
  - Placed in `@cat-factory/contracts` beside the types it merges (both inputs are contract types) rather than in `integrations` beside the detector, so the SPA wizard consumes it client-side with no extra endpoint — the same shared-pure-helper shape as `resolveFrontendBindings` / `buildFrontendRunNotes`. Unit-tested from `@cat-factory/integrations` (contracts has no test runner), the pattern by which `buildFrontendRunNotes` is tested from a consumer.

  Pure + no IO, no persistence change. The wizard UI + the "run deep analysis" trigger are the remainder of slice 7.

## 0.107.0

### Minor Changes

- bf31df7: Stack recipes & shared stacks (slice 8): the opt-in environment analyst.

  Adds an `environment-analyst` agent kind — the LLM half of environment auto-detection. Where the deterministic detector reads a repo checkout-free and can only see mechanical facts (compose layering, external networks, env-file pairs), the analyst is a read-only `container-explore` agent that CLONES the repo and reads the imperative bring-up a scan can't (README / Makefile / `bin/*` CLIs / setup scripts / seed dumps) to draft a declarative Docker Compose stack recipe — setup steps, prerequisites and a health gate — each grounded in a source citation. It returns the draft on `result.custom` (rendered by the shared `generic-structured` view); it never writes the repo. The draft is NON-BINDING: the setup wizard (slice 7) will merge it over the deterministic recommendation and nothing is applied until the human confirms.

  - Contracts: `AnalystRecipeDraft` / `AnalystRecipeNote` / `AnalystCitation` (`environment-analyst.ts`) — a lenient LLM-output shape (a proposed `StackRecipe` + per-field provenance + summary) that degrades field-by-field on a partially-malformed reply.
  - Agents: the `environment-analyst` kind (registered through the public `AgentKindRegistry` seam, pre-loaded by `defaultAgentKindRegistry()`), with its schema-derived structured output (`failOnUnusableFinal`, so an empty reply fails loudly rather than yielding an empty draft).
  - Kernel: a seeded analyst-only pipeline `pl_environment_analysis` (`ENVIRONMENT_ANALYSIS_PIPELINE_ID`) the wizard runs against a service frame, mirroring `pl_blueprint`.

  No persistence change — the analyst rides the execution engine and the existing `provisioning` blob, so no migration and no runtime asymmetry. The draft-merge + wizard trigger UI land with the wizard (slice 7).

## 0.106.0

### Minor Changes

- 6f9d935: Stack recipes & shared stacks (slice 6): preflight prerequisite checks with guided remediation.

  A stack recipe can now declare machine `prerequisites: PreflightRef[]` — automated PROBE + human REMEDIATION checks for the inherently-manual one-time machine setup a complex compose repo needs (docker daemon reachable, free disk / RAM, container-registry login state, VPN reachability, mkcert CA, hosts-file entries, an env-file secrets marker). They are re-run at provision start: a failing REQUIRED check fails the provision fast with its copy-paste remediation in the provisioning log, instead of a mystery deep inside a 40-image pull (a non-required check is advisory — a warning). A `POST /workspaces/:ws/preflights/run` endpoint runs an arbitrary set of checks for the setup wizard's live re-check.

  - Contracts: `PreflightCheckId` / `PreflightParams` / `PreflightRef` / `PreflightResult` (`preflights.ts`) + `prerequisites` on `stackRecipeSchema`; the `runPreflightsContract` route.
  - Kernel: the runtime-bound `PreflightHostProbes` seam + `PreflightProbeOutcome`, and a `runPreflights` seam on `ProvisionEnvironmentRequest`.
  - Integrations: `PreflightService` (runtime-neutral orchestration over the probe seam) + provision-start enforcement in `ComposeEnvironmentProvider`.
  - Server: `PreflightController`.
  - Local facade: `createDockerPreflightProbes` (the host probes over the docker CLI + `node:*`), wired only where the compose runtime is (a Docker-family host daemon). The probes are runtime-bound (local facade only, the documented compose exception); the declaration + API are runtime-neutral and the recipe rides the existing `provisioning` blob, so there is no migration. On the Worker / plain Node the preflight API 503s and a recipe that declares prerequisites fails loudly at provision.

## 0.105.0

### Minor Changes

- 5490103: Surface web search on container agent run details, and store/display performed search queries as telemetry.

  - Container steps now carry a `search` availability fact (`{ available, provider }`), resolved backend-side at dispatch from the run's account web-search keys (else the deployment default). The observability drill-down shows whether web search was available and which provider (Brave / SearXNG) served the run — a static per-run fact, not gated by prompt-recording.
  - New `agent_search_queries` telemetry sink records every web search a container agent performs through the backend search proxy (query, provider, result count), gated by the same double switch as agent-context snapshots (`LLM_RECORD_PROMPTS` + the workspace `storeAgentContext` setting) and pruned on the same telemetry retention window. Mirrored across the D1 (Cloudflare) and Drizzle/Postgres (Node) stores with a cross-runtime conformance suite, and surfaced on demand via `GET /workspaces/:ws/executions/:executionId/search-queries` in a new "Web search" observability view.

### Patch Changes

- e5b9462: Show a step's failure trail on its step-detail overlay. The step-detail overlay now has an "Execution history" toggle that reveals the prior failed attempts recorded for that specific step (plus the current failure when the run is presently failed at it): the run-level "previous errors" history narrowed to one step. Each `AgentFailure` now carries the `stepIndex` it failed at (stamped by the engine's failure funnel), so the trail can be attributed per step.

## 0.104.0

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

## 0.103.0

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

## 0.102.0

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

## 0.101.1

### Patch Changes

- 029a689: chore(environments): genericize the stack-recipes pilot name in code + fixtures

  Replace the real company name used as the stack-recipes pilot with the neutral `acme`
  placeholder across the code comments and detection test fixtures (`acme-main`, `acme-net`,
  `deployment/acme-db-dummy/*.sql`, …). Behaviour-neutral: the detection fixtures rename both
  the input and the expected assertion in lockstep, so the golden tests are unchanged.

## 0.101.0

### Minor Changes

- 2e4d883: Initiative presets — slice 1: preset contracts, kernel registry, and entity extensions.

  - **contracts** (`initiative-preset.ts`): the serialisable, SPA-facing preset vocabulary —
    `InitiativePresetField` (the `ProviderConfigField` family plus `checkbox-group`, `path`, and
    single-condition `showWhen` visibility), `InitiativePresetDescriptor` (form + planning-pipeline
    binding + interview/human-review/fragment/policy defaults + a derived `probe` flag), and the pure
    helpers `isSafeRepoDirPath`, `isPresetFieldVisible`, and `validateInitiativePresetInputs`
    (returns `string[]` — empty ⇒ valid). The bounded `InitiativePresetInputs` record + the item
    `spawn` decoration bag (`taskTypeFields`/`fragmentIds`/`agentConfig`/`gates`) live in
    `initiative.ts` (with the entity that persists them) to avoid a valibot import cycle.
  - **contracts** (`initiative.ts`): the `Initiative` entity gains optional `presetId` +
    `presetInputs` (frozen at create), and both the tracker item and the planner draft item gain the
    optional `spawn` bag. All ride the existing JSON `doc` blob — no migration, runtime-symmetric.
  - **kernel** (`initiative-preset-registry.ts`): the module-global `registerInitiativePreset` seam
    (mirroring the pipeline / gate registries) carrying the descriptor plus the `detect` / `seedPlan`
    code hooks and per-agent-kind `promptAdditions`. Ships the built-in `preset_generic` strangler
    default (always resolvable) and `initiativePresetDescriptors()`, which derives each descriptor's
    wire `probe` flag from the presence of a `detect` hook.

  Additive only — an initiative with no `presetId` keeps today's behaviour byte-for-byte.

## 0.100.0

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

## 0.99.0

### Minor Changes

- 3981bbb: feat(environments): stack-recipe contracts (shared-stacks initiative, slice 1)

  Add the declarative `StackRecipe` shape to the `docker-compose` branch of `ServiceProvisioning`
  plus the recommendation-shape extensions the detector (slice 2) will populate — the contracts
  foundation for provisioning complex multi-step compose repos (the acme-main pilot).

  - New optional `recipe` field on `serviceProvisioningSchema` (`stackRecipeSchema`): ordered
    `-f` `composeFiles` layering, `composeProfiles`, `envFiles` materialization (template →
    gitignored target), `externalNetworks`, `sharedStackRefs`, ordered `setupSteps`/`teardownSteps`
    (`recipeStepSchema` — `compose-exec` / `copy-file` / `wait-http` / `wait-file` / `host-command`,
    each with a per-step timeout budget), and a terminal `healthGate` (`compose-healthy` default /
    `http` / `compose-exec`). Every field is optional, so the existing single-file `composePath`
    config parses unchanged.
  - New recommendation candidate arrays + hint on `provisioningRecommendationSchema`:
    `composeFileCandidates`, `profileCandidates`, `seedDumpCandidates`, and the report-only
    `repoCliHint`; the detection-note `field` vocabulary is extended for the new recipe fields.

  Contracts-only; additive and non-breaking. The compose provider will consume the persisted
  recipe in slice 3; detection populates the recommendation in slice 2.

## 0.98.0

### Minor Changes

- cfcb6c7: Add the recurring `pl_bug_triage` pipeline (bug-triage initiative, phase H).

  - **kernel**: seed the built-in `pl_bug_triage` pipeline (`availability: 'recurring'`,
    `bug-intake → bug-investigator → clarity-review → task-estimator → repro-test → coder →
reviewer → tester-api → conflicts → ci → merger`) and export `BUG_TRIAGE_PIPELINE_ID`.
  - **contracts**: add the `'bug-triage'` `ScheduleTemplate` value so the recurring modal seeds a
    bug-triage block description.
  - **orchestration**: seed the `'bug-triage'` template description; `RecurringPipelineService.create`
    now emits a best-effort `boardChanged('block-added')` when it materialises the reused block, so a
    schedule-created task appears live on every open board (parity with every other block creation).
  - **app**: infer the `'bug-triage'` template from `pl_bug_triage` in the recurring modal, and add a
    `bug-intake` display-metadata entry to the agent catalog (the inbound dual of `tracker`).

  Recurring-only enforcement: a `pl_bug_triage` run refuses a one-off manual start and is hidden from
  the add-task picker, while remaining attachable to a recurring schedule.

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

## 0.97.0

### Minor Changes

- 102c049: Document tasks: per-kind specific fields. The create-task form now collects the fields that
  matter for the chosen document kind (PRD target users + success metrics, RFC alternatives +
  rollout concerns, ADR decision drivers + considered options, runbook when-to-use + escalation,
  research question + options to compare, API surface), and the author agents fold them into the
  brief as required content for the matching template sections. The fields live on the sparse
  `taskTypeFields` bag (no migration) with `DOC_KIND_FIELDS` as the single source of truth shared
  by the form and the prompts.

## 0.96.0

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

- c20a69a: feat(initiatives): slice 4 — follow-ups & polish

  Complete the Initiatives feature: a settling spawned-task run's forward-looking
  follow-ups (and, on failure, its real cause) are harvested onto the initiative
  tracker at the terminal emit; a human promotes an open follow-up into a new
  `pending` tracker item or dismisses it, retries/skips/re-scopes items, and retunes
  the execution policy — all over the existing rev-CAS single-writer path. No new
  persistence or facade wiring: the curation state rides the initiative `doc` blob
  (D1 ⇄ Drizzle parity unchanged), and the harvest reuses the in-hand run instance
  so it costs no extra read.

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
- 49b498a: Service connections Phase 4 (= bug-triage Phase C) — multi-PR gates + merge-all. The `ci`,
  `conflicts` and `merger` tail now operate across ALL of a multi-repo task's pull requests
  (own-service + peer-service repos from Phase 3), not just the own PR — no runner-image change
  (the ci-fixer reuses the existing sibling-checkout harness path via a widened `peerRepos` job
  body).

  - **CI gate** aggregates check runs across every PR: a red check in ANY repo fails the gate,
    the failing repo(s) are named, and `step.gate.headShas` tracks each PR head. The `ci-fixer`
    helper now fans out across the sibling checkouts (the `coder`-only multi-repo dispatch is
    widened to `ci-fixer`) so one fixer round covers every failing repo. `CiStatusReport` becomes
    per-PR (`repos: RepoCiStatus[]`).
  - **Conflicts gate** probes mergeability per PR (`MergeabilityReport.repos`); any PR still
    computing keeps polling, the first conflicted repo is recorded on `step.gate.conflictTarget`.
    The conflict-resolver stays single-repo.
  - **Merger** merges every PR in provider-before-consumer order (`orderPrsForMerge`), stopping at
    the first failure. The task is `done` only when ALL PRs merged; a mid-sequence failure
    (cross-repo merges are non-atomic) leaves the block `blocked` and raises an enumerated
    `merge_review` notification (`payload.mergedRepos` / `unmergedRepos`, decision reason
    `merge_partial`). `PullRequestMerger.mergeForBlock` becomes `mergePullRequests(prs)` returning
    a `MergeAllOutcome`.
  - Cross-runtime conformance asserts multi-repo CI aggregation + escalation on both runtimes;
    the merge-all ordering + provider fan-out are unit-tested.
  - A partially-merged multi-repo task (block left `blocked`) is now replay-idempotent: a
    durable-driver retry no longer re-merges the already-merged PRs (which threw and downgraded
    the block to `pr_ready` + raised a duplicate card).
  - A conflict on a PEER repo no longer burns the conflict-resolver attempt budget on the
    own-repo resolver (which can't reach it): the gate declines escalation (`GateProbe.escalatable`)
    and goes straight to the manual-resolution give-up. Own-repo conflicts are unchanged.

## 0.95.0

### Minor Changes

- 6c1efd1: Docker Compose ephemeral envs: opt-in build-from-source mode.

  The Docker Compose environment backend was checkout-free / image-pull only and hard-rejected
  `build:`, host bind mounts, relative `env_file`, and `privileged`, so an app repo that builds
  its own images (e.g. a .NET + Angular + SQL Server stack) could not become a per-PR preview env.

  A new opt-in `build` mode (workspace handler `providerConfig.build`, mirrored advisory
  `ServiceProvisioning.composeBuild`) clones the PR head into a per-project working tree, writes
  the isolation-safe rewritten compose beside the original inside the checkout, and runs
  `docker compose build` + `up --wait`. In build mode `build:`, in-checkout relative bind mounts,
  and relative `env_file`s are honored. Image mode is unchanged and remains the default.

  Host-escape refusal is uniform across EVERY path-bearing reference, not just bind mounts: bind
  sources, `env_file`s, the `build:` context, and top-level `secrets:`/`configs:` `file:` sources are
  all run through `escapesCheckout`, which now also catches UNC/backslash-absolute paths, a
  separator-buried `../` source (`sub/../../../etc`, previously mis-read as a named volume), and an
  unresolved `${VAR}` interpolation (expands to an arbitrary host path at runtime). `include:` and
  cross-file `extends: { file }` are refused outright in both modes — the daemon merges those files
  from disk, so their services would otherwise slip a privileged container / host bind / pinned port
  past the parse-based guard. `privileged: true` stays refused.

  The `ComposeRuntime` seam gains optional `checkout`/`writeCheckoutFile` (implemented in the local
  facade via a shallow, token-authenticated git clone); `ProvisionEnvironmentRequest` gains a LAZY
  `clone` resolver (a thunk) invoked only by the build-mode provider that actually needs a working
  tree — so image-mode compose / custom / k8s-sync provisions no longer mint a short-lived VCS token
  they never use (reusing the deploy clone-target seam, memoized so one provision never mints twice).
  Build mode registers only on the docker-family local runtime — the documented runtime-bound
  exception. Build timeout is separate from the health-wait bound (`buildTimeoutMinutes`).

  Auto-detection is now content-aware: a compose stack that declares `build:` is detected and
  recommended in build-from-source mode (previously it was recommended blindly and then failed at
  provision time).

  The compose environment connect form gains an "Image source" selector (pull pre-built vs build
  from source) and a build-timeout field; the misleading "image-based stacks only" copy is removed.

## 0.94.0

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

## 0.93.0

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

## 0.92.0

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

## 0.91.0

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

## 0.90.0

### Minor Changes

- b928904: Service connections Phase 2 — multi-env provisioning. A `deployer` step now fans out over
  the task's own service frame PLUS each connected involved-service frame, provisioning one
  ephemeral environment per frame (dispatched provider-before-consumer, parked between), each
  keyed per `(blockId, frameId)` so the fan-out no longer clobbers itself. Already-ready peers
  are injected into a later provision as `{{input.peerEnvUrls}}`, the agent context gains
  `involvedServices` (title + connection description + the peer's live env URL, read-time
  stale-filtered), and the Tester infra spec gains a `peerEnvironments` map so a cross-service
  integration test can reach a peer's real environment.

## 0.89.0

### Minor Changes

- 7fa7578: Initiatives slice 2 — interactive planning.

  The Initiative Planning pipeline (`pl_initiative`) now interviews the human and analyses the
  codebase before the planner drafts, so the plan is grounded in the stakeholder's intent and the
  real code. The pipeline becomes
  `[initiative-interviewer → initiative-analyst → initiative-planner → approval gate → initiative-committer]`
  (catalog `version` bumped to 2, so workspaces get the reseed offer).

  - **`initiative-interviewer`** — a new inline LLM gate that asks clarifying questions about goals,
    scope and constraints, PARKS the planning run on a durable decision-wait while the human answers
    through a dedicated planning Q&A window, then synthesizes the agreed goal / constraints / non-goals
    brief. It is **entity-native**: the questions, answers and brief live directly on the `initiatives`
    entity (its `qa` + new `interview` fields) via the CAS `mutate` — no new table. Reuses the shared
    `RunStateMachine` park/answer/resume spine (the review-gate model). Passes through when no
    interviewer model is wired, so pipelines run unchanged.
  - **`initiative-analyst`** — a new container-explore agent that reads the repo and writes a prose
    codebase analysis onto the entity (`analysisSummary`), grounding the plan.
  - The **planner** and **analyst** prompts now fold in the interview brief + analysis (threaded onto
    the agent context for `initiative`-level runs).
  - New endpoints (`POST /blocks/:blockId/initiative-planning/{answer,continue,proceed}`), store
    actions and the `initiative-planning` result-view window; the inspector surfaces an "Answer
    planning questions" button while the interviewer is parked. `initiative.planning.*` copy added to
    all locales.

  Runtime-symmetric with no facade changes (the interviewer resolves its model exactly like the
  requirements reviewer, from the routing default already wired in both runtimes) and no new
  persistence — so no D1/Drizzle migration and no executor-harness image bump.

## 0.88.0

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

## 0.87.0

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

## 0.86.0

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

## 0.85.0

### Minor Changes

- 0ac0dc4: Surface per-iteration fixing instructions in polling-gate run details. A `ci` /
  `conflicts` gate's helper attempt now records the instructions it was handed (the
  failing-check summary + structured red checks for CI, the conflict/review detail for the
  others) alongside the helper's own report, so the gate window shows WHAT each round set out
  to fix — bringing the gate attempt timeline to parity with the Tester's fixer timeline
  (`concerns` + `summary`). Adds `instructions` / `failingChecks` to `gateAttemptSchema` and a
  transient `lastDispatchedInstructions` stash on `gateStepStateSchema` (schemaless step JSON,
  no migration).

## 0.84.0

### Minor Changes

- 36f4cf6: Frontend UI-test bindings: surface how each backend binding resolves + a non-fatal run-start note.

  - **Shared resolution helpers moved to `@cat-factory/contracts`** (next to `frontendOriginsForService`)
    so the SPA and the backend share ONE source of truth: `resolveFrontendBindings`,
    `indexLiveServiceEnvUrls`, `boundServiceFrameIds`, the `ResolvedFrontendBinding`/`LiveEnvHandle`
    types, and a new pure `buildFrontendRunNotes`. Orchestration re-exports them, so existing importers
    are unchanged.
  - **Inspector resolved-binding visibility**: `FrontendConfig.vue` now shows, live, how each backend
    binding resolves — `envVar → a bound service's live ephemeral URL | mocked (WireMock)` — mirroring
    what a UI-test run resolves, plus a warning for duplicate env vars. Backed by a new lightweight
    `environments` store over `GET /workspaces/:ws/environments`.
  - **Run/step detail projection + run-start note**: the engine stamps BOTH the resolved bindings
    (`ExecutionInstance.frontendBindings`) and the non-fatal advisories (`ExecutionInstance.notes`:
    duplicate env vars, or a partial-live set where some bound services fall back to WireMock) on the
    run ONCE at start — the SPA-visible mirror of the harness's own `buildInfraNotes`. A `tester-ui`
    step's detail projects the FROZEN start-time bindings (so a finished run shows what it actually
    drove against, not a live re-resolution that could disagree with the co-located note after the
    envs are torn down); the run-start note shows on any step detail of a frontend-frame run. Both
    ride in the run's `detail` JSON (no migration) and round-trip identically on D1 ⇄ Postgres.

  No wire/behaviour break: the notes field is optional, the moved helpers are re-exported, and a
  non-frontend run is unaffected.

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

## 0.83.0

### Minor Changes

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

## 0.82.0

### Minor Changes

- 5ce03c6: Frontend-config inspector: add repo autodetection, a frontend-directory field, clearer serve-mode
  help, and collapsible field groups.

  - **Detect from repo**: a new deterministic, checkout-free detector proposes a frontend config
    (package manager from the lockfile, install command, build script + output dir from
    package.json/framework markers, serve mode/script, and backend-binding env-var names from dotenv
    examples). Exposed as `POST /workspaces/:ws/environments/detect-frontend-config`
    (`detectFrontendConfig` on the environments connection service) and surfaced in the panel as a
    non-binding preview the user reviews and applies (backend bindings are appended, never
    overwriting existing service links).
  - **Frontend directory**: `FrontendConfig.directory` scopes a monorepo frontend's build/serve to a
    subdirectory (threaded into the harness job-body builder).
  - **Serve mode**: replaced the single hint with per-mode descriptions and a note distinguishing it
    from the separate env-injection axis.
  - **Grouping**: the panel's fields are now collapsible sections (Build / Serve / Mocking / Env
    injection / Backend bindings / Preview), collapsed by default.

## 0.81.3

### Patch Changes

- 4a7a3f1: Preserve a task run's error trail across retries. A failed run's `failure` is now
  appended to a new `failureHistory` on the fresh attempt (persisted in the shared
  `agent_runs.detail`, so both runtimes get it with no migration), and cleared on the
  running attempt — so the top failure banner disappears the moment the task restarts
  while every previous error stays viewable in a "previous errors" history on the task
  inspector. Applies to both retry (resume-from-failure) and restart-from-step.

## 0.81.2

### Patch Changes

- 6243bea: Scope the "create task from a GitHub issue" picker's already-imported list to the
  target service's repo. The quick-pick list of imported issues was filtered only by
  source and free text, so it leaked in issues from every repo in the workspace even
  though the live search was already repo-scoped. `listTasks` now accepts an optional
  `blockId` that resolves the service's linked repo (via the same `resolveRepoTarget`
  the search uses) and drops GitHub issues from other repos; repo-less sources (Jira,
  Linear) are unaffected. The picker fetches its own repo-scoped list rather than
  reading the shared workspace-wide store.

## 0.81.1

### Patch Changes

- 2a91615: Frontend↔backend ephemeral-stack wiring (slice 6a of the frontend-preview initiative):

  - **Reverse CORS origin injection.** A `deployer` step now passes `inputs.frontendOrigins` — the
    comma-joined browser origins (`http://localhost:<servePort>`) of every `frontend` frame that
    binds the service being provisioned (the reverse of the frontend's `backendBindings`). A
    backend manifest folds it into its CORS allow-list via `{{input.frontendOrigins}}` (HTTP-manifest
    provider) or `{{frontendOrigins}}` (Kubernetes native adapter, flat scope), so an ephemeral
    frontend can reach an ephemeral backend. Derivation is automatic (`frontendOriginsForService`,
    a single workspace block-list read — no N+1); the CORS env-var mapping stays operator-authored,
    and the backend must be re-provisioned to pick up a newly-linked frontend. The served port is
    resolved through the shared `resolveFrontendServePort` (contracts) — the same reserved-port
    sanitization the harness infra spec uses — so a `servePort` set to a reserved in-container port
    (8080/8089) injects the port the app is actually served on (4173), not the raw value.
  - **Binding-resolution correctness.** `resolveFrontendBindings` now dedupes a repeated `envVar`
    deterministically (last non-empty binding wins, matching the injected env map) instead of leaving
    it to insertion order. New `duplicateBindingEnvVars` predicate (contracts) surfaces the collision
    for the inspector + run-start notes (a follow-up slice); it is advisory, not a schema reject
    (bindings persist per-blur with an allowed empty `envVar`).

  Runtime-neutral (all facades). The inspector visibility panel + run-detail projection (6b) and the
  deterministic local preview host port (6c) are tracked follow-ups in
  `docs/initiatives/frontend-preview-ui-testing.md`.

## 0.81.0

### Minor Changes

- 67d3876: feat(github): search available repos server-side in the "add service from repo" picker.
  The picker no longer prefetches the entire installation repo list on open (slow for a wide
  App install or PAT with hundreds of repos, and it blocked filtering until the whole list
  loaded). Instead the user types at least 3 characters and the (debounced) query is sent to
  `GET /github/available-repos?q=…`, which returns only the `owner/name` matches. The `q`
  param is optional, so the repo-link management panel's browse-all is unchanged. The now-moot
  manual "refresh list" button is removed (each search hits GitHub live).

## 0.80.1

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

## 0.80.0

### Minor Changes

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

## 0.79.0

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

## 0.78.1

### Patch Changes

- 16ee6cc: Surface the merger's verdict as a structured decision instead of raw JSON.

  The engine now records a `MergeDecision` on the completed `merger` step (`step.custom`): the
  assessment scores, the resolved preset ceilings, and — crucially — whether it auto-merged or routed
  the PR to a human, and WHY (`within_thresholds` / `exceeded_thresholds` / `auto_merge_disabled` /
  `no_rationale` / `no_assessment` / `merge_failed` — `no_rationale` distinguishes a scored-but-
  unexplained assessment from a truly absent one). The SPA renders it in a dedicated `MergerResultView` (complexity /
  risk / impact bars vs their ceilings + a plain-language decision banner — "Auto-merged — every score
  is within the Balanced thresholds" / "Awaiting human review — risk exceeded the thresholds") instead
  of the agent's raw JSON.

  Also fixes the inspector showing a finished merger step as "Agent running": the run's shared container
  is kept alive until the pipeline's final step, so a step whose state is already `done` (the merger
  resolving mid-pipeline before a trailing gate) no longer displays the stale live container-phase label.

## 0.78.0

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

## 0.77.0

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

- f70c273: feat(frontend): `pl_frontend` pipeline + frontend-aware mocker (slice 4 of the
  frontend-preview + in-context UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

  Builds on slice 3's self-contained UI-test infra with the pipeline that drives it and a mocker
  that authors the mocks it needs.

  - **`pl_frontend` built-in pipeline** (`coder → reviewer → mocker → tester-ui → conflicts → ci →
merger`). For a `type: 'frontend'` frame the engine already resolves the frame's
    `frontendConfig` + backend bindings and stands the app + WireMock up in one container (slice 3),
    so this pipeline is just the step order that exercises it end to end: implement → review → mock
    → browser-test → the standard mergeability/CI/merge tail. Labelled `experimental` — two
    deploy-/keying-time steps remain (the `ui`-image per-step routing, and keying a bound service's
    ephemeral env by its FRAME id so a live-service binding resolves instead of falling back to
    WireMock); a mock-only frontend already runs fully self-contained today.
  - **Frontend-aware mocker.** When a `mocker` step runs on a task under a `frontend` frame, its
    user prompt now carries a frontend section: author WireMock stub mappings under the frontend
    repo's mock dir in WireMock's `--root-dir` layout (`<dir>/mappings/*.json` + `<dir>/__files/`)
    for exactly the upstreams the harness points at WireMock (every binding with no live service
    under test), and do NOT wire a docker-compose stack — the platform serves the app + WireMock
    directly. The live service(s) under test are named and explicitly excluded from mocking. A
    backend-service mocker run is unchanged (the section is absent without a resolved frontend
    context). The section explicitly OVERRIDES the docker-compose stand-up guidance in the
    (backend-oriented) mocker role prompt so the two do not contradict for a frontend run, and the
    default WireMock root (`mocks/`) is now the shared `DEFAULT_FRONTEND_MOCK_MAPPINGS_PATH` constant
    in `@cat-factory/contracts` rather than a private literal.

- edf4e69: feat(frontend): gate visual pipelines to frames with a UI (slice 4c of the frontend-preview +
  in-context UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

  A pipeline with a VISUAL step — `tester-ui` (drives a real browser against a running frontend) or
  `visual-confirmation` (the human gate over its screenshots) — only makes sense where there is a UI
  to exercise. Until now nothing stopped `pl_frontend` / `pl_visual` from being started on a bare
  backend `service` (or a `library` / `document`) frame, where `tester-ui` has no app to drive.

  The engine now refuses such a start unless the task's enclosing frame is a `frontend` frame (it
  owns the app under test) OR a frame a `frontend` frame links to (its `frontendConfig.backendBindings`
  name it as a `service` upstream — the linked frontend is the UI a change to that service is
  validated through). The SPA surfaces the SAME rule so those pipelines are hidden from the pickers
  where they can't run, and both sides share one predicate so the surface can't drift from the gate.

  - **Shared predicates in `@cat-factory/contracts`** (`pipelineHasVisualStep`,
    `frameAllowsVisualPipeline`, and the canonical `UI_TESTER_AGENT_KIND` /
    `VISUAL_CONFIRM_AGENT_KIND` slugs, now re-exported by orchestration's `ci.logic` so the wire
    values can't drift). The link scan reads the workspace block list once — no per-frame point read.
  - **Run-start gate** (`ExecutionService.assertPipelineFrameTypeAllowed`): a new
    `visual_pipeline_no_frontend` conflict reason, refused before any side effects, alongside the
    existing tester-infra / binary-storage start guards. A non-visual pipeline passes through.
  - **SPA surface**: the task-create, run-settings, run-launcher (inspector + focus view) and
    recurring-schedule pipeline pickers filter out visual pipelines for a frame with no UI, keyed off
    the block's enclosing frame and the board's frontend→service links. The new conflict reason maps
    to a localized toast title across every locale.
  - **Conformance**: a cross-runtime assertion refuses a visual pipeline on a bare service frame
    (`visual_pipeline_no_frontend`) and lets the same run START once a frontend links that service —
    pinning the D1 ⇄ Drizzle parity of reading `frontend_config` during the run-start gate.

## 0.76.0

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

## 0.75.0

### Minor Changes

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

## 0.74.0

### Minor Changes

- 6f95aff: Add a repository-type selector to repo import and bootstrap. A frame can now be onboarded as
  a backend service, a frontend app, a shared library, or a document repository. Document
  repositories accept only document/spike tasks (enforced in `BoardService.addTask` and the
  create-task form). New `library`/`document` block types, `frameRepoTypeSchema`/`FRAME_REPO_TYPES`
  in contracts, and display metadata for the new types.

## 0.73.0

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

## 0.72.0

### Minor Changes

- 70e321b: Mothership mode: mint the machine token from a whitelisted login and cache it locally, so
  `LOCAL_MOTHERSHIP_TOKEN` is now a headless/CI override instead of a hard requirement.

  A mothership (either facade) serves `POST /auth/machine-token`, which exchanges the caller's
  mothership SESSION for a `machine`-audience token scoped to the user's accounts (derived from
  `accountService.listForUser`; a `requestedAccountIds` hint may only NARROW that set, never widen
  it). The single production mint helper `mintMachineToken` (`@cat-factory/server`) replaces the
  hand-rolled test copy.

  The local facade adds a `node:sqlite` machine-token cache and a local-only
  `POST /local/mothership/connect` proxy: the SPA signs the user into the mothership (OAuth),
  captures the returned session from the redirect fragment, and hands it to its own node, which
  exchanges it for the opaque machine token (cached locally), mints a LOCAL session for the same
  user, and returns it so the SPA is signed in. `composeMothership` now resolves the token per
  request (env override → unexpired cached token → none), so a token-less node boots inert and the
  SPA can drive the login rather than the boot throwing. The login screen gains a "Sign in via
  mothership" affordance behind `localMode.mothership` (i18n across all locales).

  A mothership now honours a post-login `redirect` back to a loopback host (`localhost`,
  `127.0.0.0/8`, `::1`) in `pickPostLoginRedirect`, so the "Sign in via mothership" round-trip lands
  back on the local node without an operator allowlisting every dev port (a redirect to the caller's
  own machine is not a token-exfiltration vector). A failed connect exchange now surfaces an error on
  the login screen instead of silently returning to the sign-in button, and each connect lets the
  mothership assign the node id (a reconnect as a different user never inherits the previous user's
  id).

  Config: `AUTH_MACHINE_TOKEN_TTL_MS` (default 30 days) sets the machine-token lifetime on both
  facades.

## 0.71.0

### Minor Changes

- 77c6842: Broaden the provisioning auto-detector and make it monorepo-aware with user-selectable candidates.

  - **More layouts recognized.** Compose detection now covers override/env-variant names
    (`compose.override.*`, `docker-compose.override.*`, `docker-compose.{prod,dev}.*`) and files nested
    under `deploy/` / `docker/` / `.docker/` / `compose/`. Kubernetes detection adds common roots
    (`charts`, `chart`, `helm`, `kustomize`, `.kube`, `infra`, `infrastructure`, `infra/manifests`,
    `deploy/k8s`, `deploy/kubernetes`, `config/k8s`, `ops`, `gitops`, `.deploy`) and nested wrapper
    subdirs (`overlays`, `base`, `helm`, `charts`, `kustomize`).
  - **Monorepo-aware.** When scoped to a service subdirectory, the detector checks both the colocated
    service folder AND the repo's root shared-deploy dirs (`deploy/<svc>`, `k8s/<svc>`,
    `manifests/services/<svc>`, …), matching the service's slice by its directory basename. Unrelated
    slices are not surfaced when colocated manifests already win, and a name-matched slice with no
    confirmable manifests is only pre-selected when it actually matches the service name (never a
    fabricated pick at an arbitrary directory).
  - **Choose instead of silent auto-pick.** The recommendation now surfaces `serviceDirCandidates`
    (which root-shared monorepo slice), `manifestRootCandidates` (which k8s root when several resolve),
    and `composeServiceCandidates` (which compose service) alongside the existing overlay candidates, each
    rendered as a selectable chip in the service inspector's "Detect from repo" panel.

  The recommendation's new fields are optional; nothing is persisted by detection. The compose service key
  is advisory (surfaced as a candidate/note only) — it is not written onto the service provisioning.

## 0.70.1

### Patch Changes

- 2e1354f: Improve the Kubernetes per-type engine configurator:

  - **k3s feedback** — picking the `local-k3s` engine now prefills the engine form's loopback
    defaults (API server `https://127.0.0.1:6443`, label, skip-TLS) and shows a hint banner that
    explains the prefill and how to mint a ServiceAccount token, instead of leaving the form
    unchanged. Switching back to `remote-kubernetes` clears those local-only defaults. k3s/k3d/kind
    share the same loopback defaults, so they remain one preset rather than separate options.
  - **Test connection** — the Kubernetes engine form (workspace + per-user override) gains a working
    "Test connection" button. A new `POST /workspaces/:ws/environments/handlers/test` endpoint lowers
    the engine config to a backend config and reaches the apiserver with the supplied token (nothing
    persisted), reusing the existing connection-probe path. Reported as `{ ok, message }`.

## 0.70.0

### Minor Changes

- b4c7e60: Provisioning auto-detection now prioritizes the option matching the user's selected
  provision-type tab.

  The "Detect from repo" affordance sends the currently-selected tab (`kubernetes` vs
  `docker-compose`) as a new optional `prefer` field on `POST /environments/detect-provisioning`.
  The detector honors it: on the `docker-compose` tab a compose file wins when present (even if
  Kubernetes manifests also exist, surfaced as a low-confidence "switch to kubernetes" hint),
  falling back to the other kind when the preferred one isn't found. With no preference (or any
  non-compose tab) it keeps the historical kubernetes-first order, so existing behavior is
  unchanged unless a caller opts in.

## 0.69.0

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

## 0.68.0

### Minor Changes

- 41203db: Per-service provision types (slice 11): auto-detect a recommended Kubernetes provisioning
  config from a service's repo.

  A deterministic, pure-TS heuristic detector reads a service's repo checkout-free over the
  `RepoFiles` port and proposes a NON-BINDING recommended provisioning config. High-confidence
  facts are inferred deterministically (renderer from a `kustomization.yaml`; the URL source from
  the manifest kinds — `Ingress`/`Gateway`/`HTTPRoute`/`LoadBalancer Service`; a pinned namespace;
  `generatorEnvFile` secret injections with keys read from a `.env.example`; image overrides
  defaulting the tag to `{{branch}}`); ambiguous ones (which `overlays/*` is the ephemeral one,
  helm releases from a `helmfile.yaml`/`Chart.yaml`) are surfaced as candidates with a hint
  rather than guessed. The user always confirms/edits — nothing is applied silently.

  - Contracts: `provisioningRecommendationSchema` + `detectServiceProvisioningSchema` +
    `detectServiceProvisioningContract` (`POST /workspaces/:ws/environments/detect-provisioning`).
  - `EnvironmentConnectionService.detectServiceProvisioning` runs the detector over the
    workspace-bound `RepoFiles`; new `provision-detect.logic.ts` with unit tests.
  - Frontend: a "Detect from repo" affordance in the service inspector's test-infra section that
    prefills `block.provisioning` + surfaces the per-field confidence notes, overlay candidates,
    and engine-level URL/namespace suggestions; new i18n keys across all 8 locales.

  No migration (detection is pure repo introspection — nothing persisted).

## 0.67.0

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

## 0.66.1

### Patch Changes

- 1e55e77: Per-service provision types (Phase 2, slice 9): the async, container-backed deployer lifecycle.
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

## 0.66.0

### Minor Changes

- ecf4cc1: Per-service provision types (slice 5): the frontend for the what/where ÷ how split.

  - **Service provisioning section** (`ServiceTestConfig.vue`): the per-type source inputs a
    service owns (the "what/where"). Kubernetes now offers the manifest source (colocated path —
    browsable in-repo — or a separate repo + ref + path) and the renderer (raw / kustomize);
    custom pins a `manifestId` from the workspace catalog (+ an optional manifest path);
    docker-compose gains a "local development only" flag. Type switches merge onto the existing
    provisioning so each type's fields survive toggling.
  - **Infrastructure configurator** (`InfraHandlersConfigurator.vue` in the Infrastructure
    window's environments tab): one section per provision type (the "how"). Kubernetes has an
    engine picker (local-k3s / remote-kubernetes) revealing the new `KubernetesEngineForm` (the
    apiserver + URL-derivation engine connection, split from the service-owned manifest source);
    docker-compose is informational (runs on the runtime's local Docker); custom hosts the
    `CustomManifestTypeEditor` (the open catalog — read-only registered types + editable
    workspace ones) plus a `remote-custom` HTTP handler per custom type. In local mode each kube
    handler also offers a personal (this-machine) override written to the `/me/environment-handlers`
    endpoints.
  - **Run details**: `EnvironmentStatusPanel` now surfaces the resolved provision type + engine
    recorded on the environment handle. `runEnvironmentSchema` (`@cat-factory/contracts`) gains
    `provisionType`/`engine`, and `RunDispatcher.attachEnvironmentProjection` maps them from the
    handle onto the step's environment projection.
  - **Stores/API**: a new `composables/api/infraHandlers.ts` wraps the slice-4 handler-bundle,
    per-type register/rotate/remove, custom-type CRUD, and the per-user override endpoints; a new
    `stores/infraConfig.ts` owns the handler + custom-type state (loaded on demand, never from the
    snapshot). New `inspector.testConfig.*`, `settings.infrastructure.kubernetesEngine.*` /
    `customType.*` / `handler.*` / `engine.*`, and `environments.provisionType.*` / `engine.*`
    i18n keys across all 8 locales.

## 0.65.0

### Minor Changes

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

- 858799e: Per-service provision types (Phase 2, slice 8): the `KubernetesEnvironmentProvider` render
  path. The provider now implements the `asyncProvision` capability — it builds a
  container-backed deploy job (real `kubectl`/`kustomize`/`helm`) for any config the in-Worker
  REST path can't handle, and maps the harness outcome back into a `ProvisionedEnvironment`.

  - `buildProvisionJob` returns a `deploy`-kind job (`image: 'deploy'`) when the source needs
    rendering (`renderer: 'kustomize'`) or declares helm releases / image overrides / secret
    injections, and `null` (use the synchronous REST `provision()` path) for plain raw
    manifests. Every template is rendered and every `secretRef` is resolved backend-side, so
    the job body the harness receives carries concrete values only.
  - `finalizeProvision` maps the harness's `DeployOutcome` (namespace / url / status) onto a
    `ProvisionedEnvironment`; a failed job becomes a `failed` environment carrying the error.
  - The native REST `status()` path gained the Gateway-API URL resolvers — `gatewayStatus`
    (prefer a concrete listener hostname over the assigned address) and `httpRouteStatus` (the
    route's own hostname, else the parent Gateway's address read in the parentRef's namespace)
    — so a kustomize/Gateway env resolves its URL on ongoing status polls. REST teardown/status
    are otherwise unchanged.
  - Contracts: a `kubernetesProvisionConfigSchema` (the combined cluster + URL + manifest source
    config PLUS the render inputs) is what the deploy adapter consumes; `EnvironmentConnectionService`
    merges the service's render inputs (image overrides, per-environment helm releases, secret
    injections) with the workspace engine config (shared helm releases) at provision time.
  - Kernel: `DeployCloneTarget` + `DeployProvisionInputs` (the clone coordinates + git token + job
    ref the stateless provider can't derive itself) on `ProvisionEnvironmentRequest`, supplied by
    the provisioning service before dispatch.
  - Deploy harness: when per-PR isolation is NOT requested, the harness now reads the namespace the
    built manifests actually declare (an overlay's own `namespace:`) and ensures / monitors /
    reports / tears down THAT namespace instead of the backend's per-PR default — so an
    overlay-pinned (shared) namespace no longer leaves an empty namespace behind with no URL and a
    wrong-target teardown. Image tag bumped to `0.2.2`.
  - A new optional `rolloutTimeoutSeconds` on the kube engine config is forwarded to the deploy
    job (the harness's per-Deployment rollout wait); `buildDeployJobSpec` now fails fast when the
    cluster `apiToken` secret is unset instead of dispatching an unauthenticated job. Same-named
    shared/per-env helm releases are merged by name (service overrides engine — no double install).

  The async deployer lifecycle (dispatch/poll/park) and facade wiring follow in slices 9–10, so
  nothing dispatches a deploy job yet; this slice adds + unit-tests the provider methods.

## 0.64.0

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

## 0.63.0

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

## 0.62.0

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

## 0.61.0

### Minor Changes

- e4cddb4: Per-service provision types (Phase 2, slice 6 — Kustomize / Helm / Gateway-API contract +
  port seam). Additive only; no migration (the new fields ride the existing `handler_json` /
  service `provisioning` JSON columns).

  Contracts (`@cat-factory/contracts` `environments.ts`):

  - `kubernetesManifestSourceSchema` gains an optional `renderer: 'raw' | 'kustomize'` on both
    the `colocated` and `separate` members (absent ⇒ `raw`). `kustomize` marks an overlay
    directory that must be `kustomize build`-rendered before apply — handled only by the
    container-backed deploy adapter, not the in-Worker REST adapter.
  - New schemas `kubernetesImageOverrideSchema` (structured `images:`-style overrides),
    `kubernetesHelmReleaseSchema` (+ `kubernetesHelmSetSchema`; pinned version,
    `scope: 'per-environment' | 'shared'`), and `kubernetesSecretInjectionSchema` (+
    `kubernetesSecretEntrySchema`; logical-key → `secretRef`/templated value mapping). The
    injection has two `mode`s: `secret` (materialize a `Secret` directly) and
    `generatorEnvFile` (write a `KEY=value` `.env` at `envFilePath` for an overlay's own
    `secretGenerator` to consume — the common dedicated-overlay ephemeral-env shape).
  - These schemas ENFORCE their documented invariants rather than only describing them: a
    helm release `version` must be a pinned semver (floating tags like `latest`/`^1.0` are
    rejected); an image override must set at least one of name/tag/digest and may not set both
    a tag and a digest; a secret entry must set exactly one of `secretRef` or `valueTemplate`.
  - `serviceProvisioningSchema` (the service "what/where") gains optional `images`,
    `helmReleases`, and `secretInjections`; `kubernetesEngineConfigSchema` (the workspace
    "how") gains optional `helmReleases` for cluster-singleton (`scope: 'shared'`) releases.
  - `kubernetesUrlSourceSchema` gains `gatewayStatus` and `httpRouteStatus` variants for
    Gateway-API URL discovery (alongside the existing Ingress/Service sources).

  Kernel port seam (`@cat-factory/kernel`):

  - `RunnerDispatchKind` widens to `'agent' | 'deploy'`; `RunnerDispatchOptions.image` gains
    `'deploy'` (the separate deploy-harness image with `kubectl`/`kustomize`/`helm`).
  - `EnvironmentProvider` gains an optional `asyncProvision` capability (`AsyncProvisionCapability`)
    that pairs `buildProvisionJob(req)` (return a container-backed `DeployProvisionJob` to dispatch
    - park on, or `null` for the synchronous path) with `finalizeProvision(view, req)` (map a
      finished deploy job into a `ProvisionedEnvironment`). The two are grouped into one member so the
      build⇒finalize invariant is type-enforced — a provider cannot supply one without the other.

  The deploy-harness image, the provider implementation, the async deployer lifecycle, and the
  facade wiring follow in later slices.

## 0.60.0

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

## 0.59.0

### Minor Changes

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

## 0.58.0

### Minor Changes

- 5fd0ffa: Refuse to start a pipeline that includes an agent relying on binary-artifact storage when the workspace's account has none configured.

  The requirement is modelled as a new `binary-storage` agent trait (carried today by the UI Tester, which uploads its screenshots), so the system is universal: a future artifact-producing agent just declares the trait instead of the engine hard-coding it. `ExecutionService` enforces it on start/retry/restart and throws a `binary_storage_unconfigured` conflict, which the SPA surfaces as an error prompt with a "Configure storage" jump to the content-storage settings.

## 0.57.0

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

## 0.56.1

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

## 0.56.0

### Minor Changes

- ad5d3e0: Collapse the Infrastructure settings into one flat backend list per tab. The "Agent
  containers" and "Test environments" tabs each now show a single radio list of concrete
  destinations (built-in · Kubernetes cluster · custom HTTP pool/provider) with a one-line
  description, instead of stacking a "where it runs" radio above a separate "runner/environment
  backend" dropdown. Selecting a cluster/pool reveals its connect form inline.

  Adds a low-config **Local Kubernetes (k3s)** preset (local mode, agent containers) that
  prefills the Kubernetes runner form for a local k3s cluster — the operator only pastes a
  ServiceAccount token. To support it, the Kubernetes runner form gains the
  `insecureSkipTlsVerify` toggle, and the infrastructure capability descriptor surfaces the
  local deployment's executor image (`suggestedExecutorImage`, from `LOCAL_HARNESS_IMAGE`) so
  the preset's image is prefilled. No backend behavior change was needed — the Kubernetes
  apiserver validator already permits loopback hosts and self-signed TLS.

  Also moves the manifest editor's "currently stored secrets" indication next to the secret
  inputs so it's clear whether a value is already saved.

  BREAKING (pre-1.0, internal): removes the `settings.providerConnection.backend.*` and
  `settings.providerConnection.advancedManifest.*` i18n keys (the old in-form backend
  dropdown + collapsed-manifest disclosure are gone).

## 0.55.0

### Minor Changes

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

## 0.54.0

### Minor Changes

- 915861c: Surface the Tester's in-container docker-compose dependency stand-up logs on the test report
  window.

  A `local`-infra Tester stands the service's dependencies up inside its container with
  `docker compose up --wait` before running. Until now that command's output was written only
  to the harness's own logs — so when the dependencies failed to come up (a port clash, an
  image pull-auth failure, a healthcheck timeout, a service that exits immediately) the run
  showed an opaque failure and the single highest-signal artifact for diagnosing it was
  unreachable from the UI. This was flagged as the natural follow-up to the container-lifecycle
  observability work (the orchestrator-side provisioning logs can't see it — the stand-up runs
  _inside_ the container).

  - **Harness.** `standUpInfra` now captures the `docker compose up` stdout+stderr (on success
    _and_ failure), redacts credentials (the shared `redact` now also scrubs credential-named
    `KEY=value` / `KEY: value` assignments — e.g. a dependency echoing `POSTGRES_PASSWORD=…` —
    which are neither a token shape nor a known value), tail-bounds it, and returns an
    `infraSetup` record
    (started / compose path / duration / logs / error) on the agent result.
  - **Propagation.** The record rides the existing `RunnerJobResult` → `AgentRunResult` path
    (forwarded verbatim by both transports) and the engine persists it on the Tester step as
    `step.test.infraSetup`, refreshed on each Tester round.
  - **UI.** The test report window's Infrastructure section now shows a "Dependency stand-up"
    panel — the outcome, the compose file, how long it took, the verbatim error on failure, and
    the captured stand-up logs behind a toggle.
  - **Parity.** The cross-runtime conformance suite asserts the record round-trips onto
    `step.test.infraSetup` identically on D1 and Postgres.

  Bumps the `@cat-factory/executor-harness` image to `1.26.0` (the harness `src/` changed) and
  the matching tag in `deploy/backend`.

## 0.53.0

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

## 0.52.0

### Minor Changes

- 0577404: feat: move infrastructure configuration into its own top-level navbar menu. Agent-container execution + Tester environments + (local mode) the warm-container pool / checkout reuse now live in a dedicated tabbed "Infrastructure" window reached from the navbar, instead of being buried in the Integrations hub and a separate "Local mode" entry. The old bare "delegate to runner pool" toggle is replaced by a clear execution-backend selector that reflects the backends available for THIS deployment (local Docker host / Cloudflare Containers / self-hosted runner pool) and which is active — driven by a new symmetric `infrastructure` capability descriptor on `GET /auth/config` (set by every facade; asserted by the cross-runtime conformance suite). The raw-JSON runner manifest editor is kept but collapsed behind an "Advanced: custom API-based scheduler" disclosure, since the common backends don't need it.

## 0.51.0

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

## 0.50.1

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

## 0.50.0

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

## 0.49.0

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

## 0.48.0

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

## 0.47.0

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

## 0.46.0

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

## 0.45.1

### Patch Changes

- c2ec53b: Local mode: env-PAT sign-in that's remembered across restarts.

  Local-mode sign-in is now purely **provider selection** — a "Sign in with configured
  GitHub/GitLab PAT" button for whichever of `GITHUB_PAT` / `GITLAB_PAT` is set in env. The
  paste-a-token textarea is **removed**: a pasted token only ever resolved an identity (it never
  became the operational clone/push token, which comes from env), so it was a dead-end. When
  neither PAT is configured, the login screen shows an informational notice (with scopes-preset
  token-creation links) instead of an empty form; email/password sign-in is unchanged.

  The chosen provider (a non-secret label — never the token) is remembered in `localStorage`, so
  on a later load the SPA silently re-mints a session from the env PAT without showing the login
  screen. Logout clears it (so logout sticks, no re-login loop); a transient/expiry 401 keeps it
  so the next load re-mints rather than bouncing to the login screen. The PAT never leaves the
  server.

  `AUTH_SESSION_SECRET` and `ENCRYPTION_KEY` are now **required** in local mode (no longer
  auto-generated per process). The per-process auto-generation was the original cause of "re-enter
  the PAT every restart" — a fresh session secret each boot invalidated the persisted session, and
  a fresh encryption key orphaned credentials sealed at rest. Boot now **fails loudly** with an
  actionable message when either is unset. A new `pnpm secrets` script in `deploy/local` prints
  both in the correct format (cross-platform, no `openssl` needed) to paste into `.env`.

  **Breaking (pre-1.0, no migration):**

  - the `localMode.patLogin.available` field is removed from the auth-config wire shape; only
    `configured` + `setupUrls` remain.
  - local mode no longer auto-generates `AUTH_SESSION_SECRET` / `ENCRYPTION_KEY`; both must be set
    in the environment (generate via `pnpm secrets`).

## 0.45.0

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

## 0.44.0

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

## 0.43.3

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

## 0.43.2

### Patch Changes

- fb339db: Lower the personal-subscription password minimum from 8 to 6 characters.

  The personal password that gates the second encryption layer on individual-usage
  subscription credentials now requires at least 6 characters (was 8). Updated the
  `personalPasswordSchema` contract and the matching client-side guards/labels in the
  store and unlock UIs. The account login/reset password is unaffected.

## 0.43.1

### Patch Changes

- c11a0cc: Add a `prepublishOnly` build hook so each package is compiled to `dist/` before it is
  packed, regardless of how publish is invoked. `dist/` is gitignored and was only built by
  the canonical `pnpm ci:publish` flow, so a bare `pnpm publish` could ship an empty shell
  (this is what happened to `@cat-factory/gitlab` and `@cat-factory/provider-s3`). The hook
  removes that footgun for every publishable library.

## 0.43.0

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

## 0.42.0

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

## 0.41.0

### Minor Changes

- 63e2177: Add Linear support as a document source and issue tracker. Linear Docs can be
  imported as task context (mirroring Notion/Confluence); Linear issues can be
  imported and linked to board blocks (mirroring Jira/GitHub Issues); the `tracker`
  pipeline step can file issues into Linear; and PR writeback comments on and
  resolves the linked Linear issue. Authentication is a per-workspace personal API
  key (sealed at rest), behind a shared GraphQL client shaped so OAuth can be added
  later. Adds one nullable `linear_team_id` column to `tracker_settings` (mirrored
  across D1 and Postgres) for the team new issues are filed under.

## 0.40.1

### Patch Changes

- d1027ec: Add internationalization (i18n) foundation to the SPA via `@nuxtjs/i18n`. The Nuxt layer
  now ships a `i18n/` config + `en` locale catalog and resolves user-facing copy through
  vue-i18n message keys. Downstream deployments can override or add locales by dropping their
  own `i18n/locales/*.json` (per-layer deep-merge, consumer wins).

  Note for consumers: the published layer now depends on `@nuxtjs/i18n` (and pulls in
  vue-i18n), so a downstream `extends` of `@cat-factory/app` gains that dependency weight.

  Maintainability is guarded in two tiers. Typed message keys
  (`i18n.experimental.typedOptionsAndMessages`) make a statically written unknown `t()` key a
  `nuxt typecheck` failure. Because that cannot see a key assembled at runtime, enum→key
  lookups are additionally guarded by an exhaustive `Record<TheEnum, string>` keyed off the
  source-of-truth union — adding an enum value without a key fails the typecheck on the map.

  To make that source of truth reachable by the SPA, the `ConflictReason` wire vocabulary
  moves from `@cat-factory/kernel` to `@cat-factory/contracts` (kernel re-exports it, so
  backend imports are unchanged).

  First migrated surface: the pipeline-error toast (`usePipelineErrorToast`), which now
  resolves conflict titles from `errors.conflict.*` keys via an exhaustive `ConflictReason`
  map and shows raw backend prose only as an untranslated fallback. Most other components
  still hold inline strings — the sweep is incremental.

## 0.40.0

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

## 0.39.0

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

## 0.38.0

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

## 0.37.0

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

## 0.36.0

### Minor Changes

- efbd910: Fix the SPA error handling broken by the `@toad-contracts/*` migration.

  The contract client (`sendByApiContract`) reports a contract-declared non-2xx as a plain
  `{ statusCode, headers, body }` value (not an `Error`), with the `{ error: { code, message,
details } }` envelope under `body`. The old `$fetch` threw an ofetch `FetchError` with the
  body under `data` and was always an `Error`. Several handlers still read the old shape, so:

  - `parseCredentialError` returned `null` for every 428, so the personal-subscription
    password modal never opened and individual-usage runs (Claude/Codex/GLM) could not be
    started or retried.
  - `parseConflict` returned `null` for every 409, so run-control conflict toasts lost their
    tailored guidance (including the `providers_unconfigured` "Configure AI" jump).
  - `instanceof Error` message extraction across many catch blocks rendered `"[object Object]"`
    for declared 4xx/5xx, and the login/account/tracker-probe handlers dropped the server's
    message.

  `sendContract` now wraps a bare non-2xx into a real `ApiError` (an `Error` carrying
  `statusCode`, the parsed `body`, and the server's message), and a shared
  `apiErrorEnvelope` / `apiErrorStatus` reads the envelope from either client shape. The
  provisioning-logs query now validates through the contract schema so an invalid query
  returns the standard `{ code: 'validation' }` 400 like every other route. `@cat-factory/contracts`
  gains a `singleStringParam` helper that collapses the one-key path-param schemas the route
  files each re-declared (typing preserved).

## 0.35.0

### Minor Changes

- a4ea607: Adopt `@toad-contracts/*` for end-to-end typed, validated API contracts.

  The HTTP boundary is now a single source of truth. Each route is defined once with
  `defineApiContract` in `@cat-factory/contracts` (`src/routes/*`) and consumed by both
  sides: the backend mounts it with `@toad-contracts/hono`'s `buildHonoRoute` (method,
  path and request validation derived from the contract; the handler's `c.req.valid(...)`
  inputs and `c.json(body, status)` return are type-checked against it), and the SPA calls
  it with `@toad-contracts/frontend-http-client`'s `sendByApiContract` over `wretch`
  (runtime-validating every response). The frontend wire-type mirror in
  `frontend/app/app/types/*` no longer hand-redefines shapes — it re-exports the inferred
  types from `@cat-factory/contracts`, so backend and frontend can't drift.

  Breaking / notable:

  - `@cat-factory/server` no longer exports `jsonBody`, and drops the
    `@hono/valibot-validator` dependency (request validation now comes from the contract
    via `buildHonoRoute`); request-validation failures still return the same
    `{ error: { code: 'validation', issues } }` 400 envelope, mapped centrally in
    `handleError`.
  - `updateBlockSchema` now accepts `responsibleProductUserId` (it was silently dropped on
    the wire despite the domain block carrying it and the mapper persisting it).
  - The runtime-internal endpoints that are not request/response JSON APIs (the WebSocket
    event stream, the LLM/web-search proxies, the GitHub webhook, the Slack OAuth callback)
    are intentionally left on plain Hono routing.
  - The wire-returned shapes that the kernel ports also describe (`ProvisionedRepo`,
    `AgentContextSnapshot`/`AgentContextFile`/`AgentContextFragment`) now have their single
    source of truth in `@cat-factory/contracts` valibot schemas; the `@cat-factory/kernel`
    ports re-export the inferred types, so the route contract and the port can't drift. The
    `/auth/config` `localMode` field is now a real schema (`localModeConfigSchema`) instead
    of `v.unknown()`, and `AppConfig.localMode` derives its type from it.

## 0.34.0

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

## 0.33.0

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

## 0.32.0

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

## 0.31.0

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

## 0.30.0

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

## 0.29.0

### Minor Changes

- b82304e: Remove per-model price overrides from the workspace budget. A workspace's budget is
  now just a currency + monthly limit overlaid on the built-in `DEFAULT_SPEND_PRICING`
  table; the `spendModelPrices` setting, its contracts/schemas, and the
  `workspace_settings.spend_model_prices` column (D1 + Postgres) are dropped. Also fixes
  the budget save in the UI throwing `spendMonthlyLimit.trim is not a function` when the
  number input emits a numeric value.

  **Breaking:** the `spend_model_prices` column is dropped on both runtimes with no
  migration of existing override data (pre-1.0); any stored overrides are discarded and
  budgets fall back to the built-in price table.

## 0.28.0

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

## 0.27.0

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

## 0.26.0

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

## 0.25.1

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

## 0.25.0

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

## 0.24.0

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

## 0.23.0

### Minor Changes

- ce81233: Surface optional/default config values and unconfigured-provider warnings for the
  ephemeral-environment and self-hosted runner-pool providers.

  - `ProviderConfigField` gains an optional `default`; a field that has one is optional
    (the connect form shows it blank with a "defaulted to …" hint and falls back to it).
  - `ProviderDescriptor` gains `missingRequired` (required-without-default keys not yet
    supplied — the loud-banner signal), an optional `manifestTemplate` scaffold, and the
    current `savedManifest` (non-secret) so the native connect form overlays edits onto the
    real stored manifest — preserving previously-saved `providerConfig` (incl. nested values
    the flat form doesn't render) instead of silently dropping it on a re-save.
  - A native `EnvironmentProvider` / `RunnerPoolProvider` may implement
    `describeManifestTemplate()` so the SPA renders a flat `describeConfig` connect form yet
    still persists a single full manifest (per `backend/docs/native-environment-adapter.md`).
  - Both connection services compute `missingRequired` server-side from the saved secret
    bundle + manifest `providerConfig` + manifest `baseUrl` (so a required `baseUrl` field,
    which is stored on the manifest rather than in providerConfig/secrets, can clear).
  - Frontend: a generic descriptor-driven connect panel for both providers (under
    Settings ▸ Integrations) and a loud `ProviderConfigBanner` that fires when a provider is
    wired for the instance but mandatory fields are missing.

## 0.22.0

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

## 0.21.0

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

## 0.20.0

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

## 0.19.0

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

## 0.18.0

### Minor Changes

- 25efe48: Add UI-configurable provider config + per-user GitHub PAT, with provider self-describe and connection-test.

  - Providers self-describe the config they expect (`describeConfig`) and can be connection-tested (`testConnection`) before saving — added as optional methods on the `EnvironmentProvider` and `RunnerPoolProvider` kernel ports, implemented by the generic HTTP adapters (secret-key fields from the manifest + an authed probe), and surfaced via new `GET …/environments/provider`, `POST …/environments/connection/test`, `GET …/runner-pool/provider`, `POST …/runner-pool/connection/test` endpoints. The SPA renders the descriptor fields generically.
  - New generic, `kind`-discriminated per-user secret store (`user_secrets`, mirrored D1 ⇄ Drizzle) with `UserSecretService` + a kind registry (first kind: `github_pat`). User-scoped `GET/POST/DELETE /user-secrets` + `…/test`; a "My GitHub token" entry under Integrations → Source control.
  - A run you initiate now prefers YOUR stored GitHub PAT over the deployment's GitHub App / env token for the container push token AND the engine CI-gate + merge reads (resolved by the run initiator via an ambient `RunInitiatorScope`), falling back to the existing source when you have none. Wired symmetrically across the Cloudflare, Node and local facades.

  Breaking: none for existing data. The local-mode `GITHUB_PAT` env var still works as a fallback.

## 0.17.1

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

## 0.17.0

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

## 0.16.0

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

## 0.15.0

### Minor Changes

- fde0437: Add a first-class **Issue tracker** settings panel (Workspace settings → Issue tracker,
  also linked from the Integrations hub) plus a **live "Check setup" diagnostic** so a
  workspace can both configure issue tracking in one place and see _why_ a source isn't
  working.

  **Panel (frontend).** One discoverable home that gathers what used to be scattered:

  - **Filing tracker** — select where the tech-debt recurring pipeline files its ticket
    (GitHub Issues / Jira / none). Previously only reachable buried inside the tech-debt
    recurring-pipeline modal, so a workspace had no obvious way to designate GitHub Issues.
  - **Linking sources** — the per-workspace on/off toggle for each task source, making
    explicit that filing and linking are independent.
  - **Writeback** — the comment-on-PR-open / close-on-merge toggles, folded in from the old
    standalone "Issue writeback" tab (`IssueTrackerWritebackPanel` is removed).

  **Live "Check setup" (backend, all runtimes).** A new
  `POST /workspaces/:ws/task-sources/:source/diagnostics` endpoint actually authenticates
  against the source and reads a slice of its issues API, returning a classified verdict —
  `ready` / `not_installed` / `not_connected` / `auth_failed` / `forbidden` / `unreachable` /
  `error` — with an actionable message. For GitHub Issues it escalates three probes
  (validate the App credentials → mint the installation token + list repos → read issues on a
  repo) so a 403 pinpoints the most common misconfiguration: the GitHub App lacks the
  **Issues** permission. For Jira it probes `/myself` and distinguishes a rejected token (401)
  from a forbidden account (403). The panel also now surfaces the previously-swallowed probe
  error (e.g. "503 — integration disabled / ENCRYPTION_KEY not set", "500 — backend not
  migrated") instead of a blanket "install integration first".

  Adds an optional `diagnose` capability to the `TaskSourceProvider` port (kernel), implemented
  by the GitHub and Jira providers and orchestrated by `TaskConnectionService.diagnose`
  (integrations), the `taskSourceDiagnosticSchema` wire contract (contracts), and the
  controller endpoint (server). Runtime-neutral — wired through the existing `tasks` module on
  Cloudflare, Node, and local — with a cross-runtime conformance assertion (gate-on-connection
  then delegate-to-provider). A provider without `diagnose` falls back to a static verdict
  from availability.

## 0.14.0

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

## 0.13.1

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

## 0.13.0

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

## 0.12.0

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

## 0.11.0

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

## 0.10.0

### Minor Changes

- d0081e1: Shard the in-repo `spec/` artifact by a module → feature taxonomy to kill merge churn.

  The spec-writer no longer commits a single monolithic `spec/spec.json` (+ `overview.md`
  / `rules.md` / `version.json`); every spec run rewrote those whole files, so two task
  branches that both touched the spec conflicted hard on merge. The spec is now SHARDED:
  a tiny `spec/service.json`, an `spec/overview.md` index, and one canonical
  `spec/modules/<module>/<group>.json` (+ a human `<group>.md`) per feature group, with
  the Gherkin `spec/features/<module>/<group>.feature` files nested to match. A group's
  file bytes depend only on that group, so concurrent branches editing different
  features never touch the same file.

  **Breaking (acceptable per pre-1.0 policy — no migration):**

  - `@cat-factory/contracts`: `SpecDoc` gains a two-level taxonomy — `modules: SpecModule[]`
    where each module holds `groups`, and each group carries BOTH its `requirements` and the
    domain `rules` scoped to it. The top-level `SpecDoc.groups`/`SpecDoc.rules`,
    the `SpecVersion`/`version.json` manifest, and the `SPEC_JSON_PATH`/`SPEC_RULES_PATH`/
    `SPEC_VERSION_PATH` path constants are removed; `SPEC_SERVICE_PATH`/`SPEC_MODULES_DIR`
    are added. `renderSpecForReview` walks the new shape. An existing repo's monolithic
    `spec.json` / `rules.md` / `version.json` (and any old flat `features/*.feature` files)
    are DELETED on the next spec run — the sharded layout is written fresh; no migration.
  - `@cat-factory/executor-harness`: sharded deterministic render + on-disk reassembly
    read-back + orphan-shard pruning (a removed/renamed module or group is deleted, not
    resurrected) + a one-time prune of the pre-sharding monolithic/flat artifacts;
    `version.json` dropped (no-op detection is now per-file via the commit).
    Content-derived (not positional) rule ids keep a group file byte-stable. The spec-writer
    prompt + reassembled-baseline now carry an EXISTING-taxonomy inventory and steer the
    agent to slot new requirements/rules into the closest existing module + feature (reusing
    exact names) rather than spawning near-duplicate domains/groups. Ships in the **1.9.0**
    runner image already pinned in `deploy/backend` (no further tag move needed).
  - `@cat-factory/agents`: the runtime-neutral `repo-ops/render.ts` mirror is reworked to
    the same sharded layout (`renderSpecVersionFile`/`nextSpecVersion`/`canonicalSpecJson`/
    `hashSpec` for the spec removed); `SPEC_AWARE_GUIDANCE` points readers at
    `spec/modules/<module>/<feature>.{md,json}`.
  - `@cat-factory/server`: `SPEC_WRITER_SYSTEM_PROMPT` describes the module → feature →
    {requirements, rules} structure, the no-catch-all rule, and the taxonomy-reuse rule.

## 0.9.0

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

## 0.8.0

### Minor Changes

- c70df09: Add the foundations for manifest-driven custom agents (pre/agent/post-op model).

  - `@cat-factory/agents`: new `repo-ops/render.ts` — the deterministic, container-free
    rendering + lenient coercion of the in-repo `blueprints/`/`spec/` artifacts
    (`renderBlueprintFiles`/`renderSpecFiles`/`renderSpecFeatureFiles`,
    `coerceBlueprintService`/`coerceSpecDoc`/`dedupeSpecIds`, the version manifests). This
    is the logic lifted out of the executor-harness image; the hash uses Web Crypto so it
    is runtime-neutral (so the hash + version helpers are async). The agent-kind registry
    (`AgentKindDefinition`) gains `agent` (execution surface), `preOps`/`postOps` (backend
    repo-op hooks) and `presentation` (frontend palette metadata), with matching accessors;
    `registeredKindRequiresContainer` now also derives from a container agent surface.
  - `@cat-factory/kernel`: new `RepoFiles`/`ResolveRepoFiles` ports (a per-run,
    checkout-free facade over the `GitHubClient` Git Data API) and the agent-definition
    vocabulary (`AgentSurface`/`AgentStepSpec`/`AgentCloneSpec`/`AgentOutputSpec`,
    `RepoOp`/`RepoOpContext`).
  - `@cat-factory/contracts`: new `AgentPresentation`/`AgentCategory`/`CustomAgentKind`
    wire shapes for the data-driven agent palette.

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.

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

- 0972696: Surface external context sources in the add-task popup, with search + a new GitHub
  repo-doc source.

  The task-creation popup gains a `ContextPicker`: pick a connected source
  (Confluence, Notion, GitHub repo docs, Jira, GitHub issues), then **search its
  catalogue by title/content**, paste a page/issue URL, or pick something already
  imported — chosen items are imported and linked to the new task as agent context
  when it's created. Previously the popup could only tick already-imported items and
  there was no in-UI way to reach the catalogue.

  - **Search** is a new optional capability on the document/task source providers
    (`search?(credentials, query)`), exposed as `POST
/workspaces/:ws/{document,task}-sources/:source/search`. Implemented for
    Confluence (CQL), Notion (`/v1/search`), Jira (JQL), GitHub issues
    (`/search/issues`) and GitHub docs (`/search/code`). The `GitHubClient` port
    gains `searchIssues` / `searchCode`. Descriptors advertise `searchable` so the UI
    knows when to offer a search box.
  - **GitHub repo docs** are a new `github` document source: link a Markdown/text
    file from a repo (README, RFC, architecture note) by URL or `owner/repo:path`, or
    by code-search. Like GitHub issues it reuses the workspace's installed GitHub App
    (no credentials of its own) and is wired only when the GitHub integration is on.

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

- 88b3170: Separate reusable libraries from deployment. The libraries now publish to npm
  (`main`/`exports` point at built `dist`, with `files` + `publishConfig`); the
  worker is no longer private and exposes its handler + Durable Object / Workflow
  classes for deployments to re-export, and ships its D1 migrations. The frontend
  SPA is now the `@cat-factory/app` Nuxt layer. Deployments live in `deploy/backend`
  and `deploy/frontend`; the runner image publishes to GHCR. Releases are managed
  with changesets.
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

- f066c59: Make the **native environment-adapter** path first-class, so a deployment can inject a
  hand-written `EnvironmentProvider` (e.g. a Kargo adapter) instead of the generic
  manifest-driven `HttpEnvironmentProvider` — with per-workspace config and the supported
  local-mode entry point.

  - **Manifest `providerConfig` bag** (`@cat-factory/contracts`): `environmentManifestSchema`
    gains an optional, opaque `providerConfig: Record<string, unknown>`. The generic
    `HttpEnvironmentProvider` ignores it; a native adapter reads + validates it off the
    per-call `manifest`. Because an injected provider is a deployment-wide singleton, the
    per-workspace connection's manifest is its only per-workspace config carrier — so a
    single deployment can now target a different native project (Kargo project, link key,
    status map, …) per workspace. It rides inside the existing `manifest_json` JSON column on
    both runtimes — no migration, automatic D1 ⇄ Drizzle parity. **Not** covered by the
    manifest URL/SSRF checks (which only guard `baseUrl`/`tokenUrl`); an adapter that reads a
    URL from `providerConfig` must guard it itself.
  - **`startLocal({ environmentProvider })`** (`@cat-factory/local-server`): the local-mode
    entry point gains an `environmentProvider` seam (and a `host` option, matching `start()`),
    threaded through `buildLocalContainer` → `buildNodeContainer`. A local deployment can now
    wire a native provider through the supported entry point — keeping local mode's boot
    preflight (orphan reaping, PAT/auth warnings) and differentiators — instead of bypassing
    `startLocal()` and re-implementing the preflight. `buildContainer` is intentionally not
    exposed (overriding it would discard local mode's differentiators).
  - New `backend/docs/native-environment-adapter.md` documents the injection contract, the
    env-port-vs-runner-port boundary, teardown/TTL idempotency, the `@cat-factory/kernel`
    adapter dependency, and a reference `KargoEnvironmentProvider` sketch.

  No backwards-incompatible changes: every addition is optional and defaults to today's
  behaviour.

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

- 197264e: Self-hosted runner pools: serve every harness kind and forward structured results.

  Two fixes to the runtime-neutral runner-pool transport (used by both the Cloudflare
  and Node facades for a workspace's self-hosted pool):

  - **Forward the whole structured result.** `HttpRunnerPoolProvider.mapJobView`
    previously copied only `prUrl` / `branch` / `summary` / `error` off a finished job,
    silently dropping every structured product — so a pool-backed `tester` produced no
    `testReport`, a `merger` no assessment, a `blueprints`/`spec-writer` no tree/doc. The
    response mapping gains an optional `resultPath` pointing at the harness `result`
    envelope; when set, the provider coerces and forwards `report` / `service` / `spec` /
    `assessment` / `defaultBranch` / `pushed` / `resolved` / `usage` (type-guarded, with
    the structured products passed through for the engine to validate). The individual
    scalar paths still apply and override.
  - **Serve every harness route, with no allow-list.** A pool runs the same
    executor-harness image as the Cloudflare backend, and runtime parity is the default
    (the "keep the runtimes symmetric" guideline), so `RunnerPoolTransport` dispatches
    every kind with no opt-in `POOL_SUPPORTED_KINDS` guard to gate them. A new harness kind
    reaches a pool automatically, exactly as it does a Cloudflare container, instead of
    silently diverging until it is added to a list.

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

- 21ca647: Foundation for the **Sandbox** — a parallel, opt-in surface for the organized
  testing of prompts and models. It answers "which model is best for this task?"
  (one prompt, many models) and "does a better prompt help?" (one model, many
  prompt versions).

  This change lands the isolated foundation only (no runtime wiring yet):

  - **`@cat-factory/sandbox`** (new, isolated package): the pure domain logic —
    the testable-agent-kind catalog with live baseline enumeration (read from
    `@cat-factory/agents`, never persisted), append-only prompt-version lineage
    (clone → versioned candidates + freeform labels), experiment-matrix expansion
    into run cells, and the judge rubrics (lifted from the benchmark harness) plus
    a deterministic objective-findings recall scorer. Nothing in the core product
    depends on this package, so the whole feature can be extracted later.
  - **`@cat-factory/contracts`**: Valibot wire contracts for sandbox prompt
    versions, fixtures, experiments, runs, and grades (`sandbox.ts`).
  - **`@cat-factory/kernel`**: the sandbox repository ports
    (`SandboxPromptVersionRepository`, `SandboxFixtureRepository`,
    `SandboxExperimentRepository`, `SandboxRunRepository`,
    `SandboxGradeRepository`) and the re-exported domain types.

  Follow-ups (per the approved design): the server controller, the durable
  fan-out run driver + judge/objective grading, D1 ⇄ Drizzle persistence with a
  conformance assertion, the dedicated fixture repo + ephemeral-branch lifecycle,
  and the lazy-loaded frontend section.

- c4ef995: Add **`@cat-factory/sandbox-fixtures`** — a published package of hand-authored,
  standardized, **graded** no-repo fixtures for the Sandbox, plus the asymmetric
  grading model that scores them.

  - **`@cat-factory/sandbox-fixtures`** (new): inline (text-only) agent inputs that
    need NO repository checkout — `requirements-review`, `clarity-review`, `reviewer`
    (code review), and architecture-proposal review (`architect-companion`) — each
    spanning a simple → complex range. Every fixture declares the genuine findings a
    strong answer should surface, each rated by **trickiness** (how hard to spot —
    catching it is a "wow") and **impact** (how bad to miss). The standardized
    `SandboxFixtureDefinition` projects to the wire `SandboxFixture` via
    `toSandboxFixture`. Depends only on `@cat-factory/contracts` so the published
    `@cat-factory/sandbox` can load it via `workspace:*`.
  - **`@cat-factory/contracts`** (breaking, pre-1.0): the `findings` fixture objective
    now carries graded `expectations` (`{ id, summary, trickiness, impact, matchHints }`)
    instead of a flat `expectedFindings: string[]`; the objective result records the
    asymmetric breakdown (`impactRecall`, `wowBonus`, `caught`/`total`,
    `missedHighImpact`). New `clarity` inline fixture kind.
  - **`@cat-factory/sandbox`**: loads the workspace builtin fixtures by default
    (`listBuiltinFixtures`, re-exporting `@cat-factory/sandbox-fixtures`); replaces the
    flat `scoreExpectedFindings` recall with `scoreExpectations` (impact-weighted miss
    penalty so missing something impactful hurts most, plus a trickiness-weighted "wow"
    bonus for catching the subtle items) and `renderExpectationBrief` for the judge;
    adds the `architecture-review` (`architect-companion`) catalog entry and a
    `suggestExperiment` helper that maps selected models × prompts × fixtures to a
    ready-to-create experiment for a selected agent.

  No CI cache list change is needed: the new package sits under
  `backend/packages/*`, already covered by the workflow's `node_modules` cache glob;
  it is added to the `backend/tsconfig.build.json` composite build graph (the
  incremental `.tsbuildinfo` cache) so it builds before its `@cat-factory/sandbox`
  consumer.

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

- 8eed38c: Author relative imports with explicit `.js` extensions across the shared backend
  packages so their emitted `dist` is directly resolvable by Node's ESM loader (no
  bundler required). This lets the Node runtime run the built output on plain Node
  (`node dist/main.js`) — no tsx, no esbuild bundle — and is inert for the Cloudflare
  Worker (wrangler bundles regardless). `handlebars/runtime` is imported as
  `handlebars/runtime.js` for the same reason (its type is sourced from the full
  package, type-only). No behaviour or public-API change.
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

- 157cd02: Standardize the executor-harness job API on a single `POST /jobs` endpoint with the
  agent kind carried in the request body, instead of one route per kind (`/run`,
  `/bootstrap`, `/merge`, …).

  Breaking wire change between the runtime transports and the harness image (acceptable
  pre-1.0: the two ship together, no external consumers). The old per-kind-route image
  is incompatible with the new transports, so the runner image MUST be republished and
  deployed.

  - Harness: `server.ts` is now table-driven — one `KINDS` registry keyed by kind drives
    a single `POST /jobs` dispatcher (reads the body's `kind` to pick the validator +
    registry) and a single `GET /jobs/{id}` poll. Adding an agent kind is one table
    entry, not a new endpoint + registry global + poll-chain branch. Bumps the runner
    image tag (1.7.2 -> 1.7.3) in `deploy/backend` (`image:publish` + wrangler.toml).
  - Harness: the explore job's temp-dir/log label field is renamed `kind` -> `label` so
    it no longer collides with the reserved dispatch discriminator `kind`.
  - Server: `ContainerAgentExecutor` stamps the kind into the dispatch body (the explore
    body now sends `label` for its agent-kind label).
  - Worker + local-server transports POST `{ ...spec, kind }` to `/jobs`;
    `LocalDockerRunnerTransport` drops its `KIND_ROUTE` map. The self-hosted pool already
    forwards `kind` in the spec, so it needs no code change — only the manifest docs
    (kernel/contracts/integrations) are updated to note the harness routes by the body's
    `kind`.

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
