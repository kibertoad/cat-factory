# @cat-factory/orchestration

## 0.123.3

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
  - @cat-factory/integrations@0.86.3
  - @cat-factory/kernel@0.139.3
  - @cat-factory/sandbox@0.9.102
  - @cat-factory/caching@0.10.8
  - @cat-factory/spend@0.12.52
  - @cat-factory/workspaces@0.16.5

## 0.123.2

### Patch Changes

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

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0
  - @cat-factory/agents@0.62.10
  - @cat-factory/integrations@0.86.2
  - @cat-factory/kernel@0.139.2
  - @cat-factory/prompt-fragments@0.13.38
  - @cat-factory/sandbox@0.9.101
  - @cat-factory/spend@0.12.51
  - @cat-factory/workspaces@0.16.4
  - @cat-factory/caching@0.10.7

## 0.123.1

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/contracts@0.147.1
  - @cat-factory/kernel@0.139.1
  - @cat-factory/integrations@0.86.1
  - @cat-factory/agents@0.62.9
  - @cat-factory/prompt-fragments@0.13.37
  - @cat-factory/sandbox@0.9.100
  - @cat-factory/spend@0.12.50
  - @cat-factory/workspaces@0.16.3
  - @cat-factory/caching@0.10.6

## 0.123.0

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
  - @cat-factory/integrations@0.86.0
  - @cat-factory/agents@0.62.8
  - @cat-factory/prompt-fragments@0.13.36
  - @cat-factory/sandbox@0.9.99
  - @cat-factory/spend@0.12.49
  - @cat-factory/workspaces@0.16.2
  - @cat-factory/caching@0.10.5

## 0.122.0

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

### Patch Changes

- Updated dependencies [60c0a1e]
  - @cat-factory/contracts@0.146.0
  - @cat-factory/integrations@0.85.4
  - @cat-factory/agents@0.62.7
  - @cat-factory/kernel@0.138.1
  - @cat-factory/prompt-fragments@0.13.35
  - @cat-factory/sandbox@0.9.98
  - @cat-factory/spend@0.12.48
  - @cat-factory/workspaces@0.16.1
  - @cat-factory/caching@0.10.4

## 0.121.0

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
  - @cat-factory/workspaces@0.16.0
  - @cat-factory/kernel@0.138.0
  - @cat-factory/agents@0.62.6
  - @cat-factory/integrations@0.85.3
  - @cat-factory/prompt-fragments@0.13.34
  - @cat-factory/sandbox@0.9.97
  - @cat-factory/spend@0.12.47
  - @cat-factory/caching@0.10.3

## 0.120.2

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0
  - @cat-factory/agents@0.62.5
  - @cat-factory/integrations@0.85.2
  - @cat-factory/kernel@0.137.1
  - @cat-factory/prompt-fragments@0.13.33
  - @cat-factory/sandbox@0.9.96
  - @cat-factory/spend@0.12.46
  - @cat-factory/workspaces@0.15.2
  - @cat-factory/caching@0.10.2

## 0.120.1

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
  - @cat-factory/agents@0.62.4
  - @cat-factory/integrations@0.85.1
  - @cat-factory/caching@0.10.1
  - @cat-factory/sandbox@0.9.95
  - @cat-factory/spend@0.12.45
  - @cat-factory/workspaces@0.15.1

## 0.120.0

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

## 0.119.0

### Minor Changes

- 576f2e0: Workspace RBAC (slice 4): cache the effective-access resolution behind the app cache seam.

  The shared auth gate resolves a caller's effective workspace access on every
  `/workspaces/:ws/*` request (three reads: the board access row, the caller's account roles,
  their member row). This adds a `workspaceAccess` slice to the kernel `AppCaches` port
  (`@cat-factory/caching`) so `loadWorkspaceAccess` reads through it — grouped by workspace id,
  keyed by user id, with both a denial and a missing board cached as values (negative caching).
  A cache hit costs zero repository reads.

  Coherence is invalidation-driven, after each write commits: a board delete drops the
  workspace group (`WorkspaceService.delete`), and account-tier membership writes
  (`AccountService.addMember` / `setMemberRoles`, `InvitationService.accept`) drop everything
  (`invalidateAll` — the deliberate coarse fallback for a rare management action, since a new
  membership can change access to many boards). The roster + access-mode write paths added by
  the member-management API (a later slice) invalidate the same workspace group on their own
  writes.

  The slice follows the established seam rules: the `DEFAULT_APP_CACHES_PROFILE` enables it with
  a short 60s TTL (a freshness backstop; invalidation is the real coherence story), while the
  Worker's `ISOLATE_SAFE_APP_CACHES_PROFILE` keeps it **pass-through** — the resolution reads our
  own mutable D1 state and a Worker isolate has no cross-isolate invalidation bus, so a TTL'd
  entry could keep granting access after a peer isolate revoked a member. Cross-runtime
  conformance asserts an account-membership grant is visible on the immediately following request
  (the cached denial is dropped) on both D1 and Postgres.

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/contracts@0.143.0
  - @cat-factory/kernel@0.136.0
  - @cat-factory/integrations@0.85.0
  - @cat-factory/caching@0.10.0
  - @cat-factory/workspaces@0.15.0
  - @cat-factory/agents@0.62.3
  - @cat-factory/prompt-fragments@0.13.32
  - @cat-factory/sandbox@0.9.94
  - @cat-factory/spend@0.12.44

## 0.118.0

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
  - @cat-factory/agents@0.62.2
  - @cat-factory/caching@0.9.5
  - @cat-factory/integrations@0.84.12
  - @cat-factory/sandbox@0.9.93
  - @cat-factory/spend@0.12.43
  - @cat-factory/workspaces@0.14.2
  - @cat-factory/prompt-fragments@0.13.31

## 0.117.1

### Patch Changes

- Updated dependencies [e618bf5]
  - @cat-factory/contracts@0.141.0
  - @cat-factory/agents@0.62.1
  - @cat-factory/integrations@0.84.11
  - @cat-factory/kernel@0.134.1
  - @cat-factory/prompt-fragments@0.13.30
  - @cat-factory/sandbox@0.9.92
  - @cat-factory/spend@0.12.42
  - @cat-factory/workspaces@0.14.1
  - @cat-factory/caching@0.9.4

## 0.117.0

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

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/contracts@0.140.0
  - @cat-factory/kernel@0.134.0
  - @cat-factory/agents@0.62.0
  - @cat-factory/integrations@0.84.10
  - @cat-factory/workspaces@0.14.0
  - @cat-factory/prompt-fragments@0.13.29
  - @cat-factory/sandbox@0.9.91
  - @cat-factory/spend@0.12.41
  - @cat-factory/caching@0.9.3

## 0.116.0

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
  - @cat-factory/agents@0.61.2
  - @cat-factory/caching@0.9.2
  - @cat-factory/integrations@0.84.9
  - @cat-factory/sandbox@0.9.90
  - @cat-factory/spend@0.12.40
  - @cat-factory/workspaces@0.13.51
  - @cat-factory/prompt-fragments@0.13.28

## 0.115.1

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/contracts@0.138.0
  - @cat-factory/kernel@0.132.0
  - @cat-factory/agents@0.61.1
  - @cat-factory/integrations@0.84.8
  - @cat-factory/prompt-fragments@0.13.27
  - @cat-factory/sandbox@0.9.89
  - @cat-factory/spend@0.12.39
  - @cat-factory/workspaces@0.13.50
  - @cat-factory/caching@0.9.1

## 0.115.0

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
  - @cat-factory/integrations@0.84.7
  - @cat-factory/sandbox@0.9.88
  - @cat-factory/spend@0.12.38
  - @cat-factory/workspaces@0.13.49
  - @cat-factory/prompt-fragments@0.13.26

## 0.114.0

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

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/contracts@0.136.0
  - @cat-factory/kernel@0.130.0
  - @cat-factory/agents@0.60.0
  - @cat-factory/integrations@0.84.6
  - @cat-factory/prompt-fragments@0.13.25
  - @cat-factory/sandbox@0.9.87
  - @cat-factory/spend@0.12.37
  - @cat-factory/workspaces@0.13.48
  - @cat-factory/caching@0.8.8

## 0.113.2

### Patch Changes

- Updated dependencies [06a094a]
  - @cat-factory/contracts@0.135.0
  - @cat-factory/agents@0.59.2
  - @cat-factory/integrations@0.84.5
  - @cat-factory/kernel@0.129.2
  - @cat-factory/prompt-fragments@0.13.24
  - @cat-factory/sandbox@0.9.86
  - @cat-factory/spend@0.12.36
  - @cat-factory/workspaces@0.13.47
  - @cat-factory/caching@0.8.7

## 0.113.1

### Patch Changes

- 6108525: perf(engine): resolve the agent-context service frame once, and cache the merge-preset read

  - `AgentContextBuilder` walks a block's ancestry to its owning service frame a SINGLE time
    per dispatch (threaded into the environment / service-config / frontend / fragment
    resolvers) and fans the mutually-independent context resolutions out in one `Promise.all`
    wave, instead of re-walking frame→module→task once per resolver and awaiting each in turn
    (performance initiative item 13).
  - `resolveRiskPolicy` reads a task's merge-threshold preset through a new `riskPolicy`
    AppCaches slice — the slow-moving admin config was re-read on every gate evaluation.
    `RiskPolicyService` invalidates the workspace group on every preset write (create / update /
    remove / reseed / first-use seed); pass-through on the Worker's isolate-safe profile
    (performance initiative item 23).

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1
  - @cat-factory/caching@0.8.6
  - @cat-factory/agents@0.59.1
  - @cat-factory/integrations@0.84.4
  - @cat-factory/sandbox@0.9.85
  - @cat-factory/spend@0.12.35
  - @cat-factory/workspaces@0.13.46

## 0.113.0

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

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/agents@0.59.0
  - @cat-factory/kernel@0.129.0
  - @cat-factory/contracts@0.134.0
  - @cat-factory/sandbox@0.9.84
  - @cat-factory/caching@0.8.5
  - @cat-factory/integrations@0.84.3
  - @cat-factory/spend@0.12.34
  - @cat-factory/workspaces@0.13.45
  - @cat-factory/prompt-fragments@0.13.23

## 0.112.0

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

### Patch Changes

- Updated dependencies [9e9127f]
  - @cat-factory/contracts@0.133.0
  - @cat-factory/agents@0.58.1
  - @cat-factory/integrations@0.84.2
  - @cat-factory/kernel@0.128.1
  - @cat-factory/prompt-fragments@0.13.22
  - @cat-factory/sandbox@0.9.83
  - @cat-factory/spend@0.12.33
  - @cat-factory/workspaces@0.13.44
  - @cat-factory/caching@0.8.4

## 0.111.0

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

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
  - @cat-factory/contracts@0.132.0
  - @cat-factory/agents@0.58.0
  - @cat-factory/caching@0.8.3
  - @cat-factory/integrations@0.84.1
  - @cat-factory/sandbox@0.9.82
  - @cat-factory/spend@0.12.32
  - @cat-factory/workspaces@0.13.43
  - @cat-factory/prompt-fragments@0.13.21

## 0.110.0

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

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/contracts@0.131.0
  - @cat-factory/kernel@0.127.0
  - @cat-factory/agents@0.57.0
  - @cat-factory/integrations@0.84.0
  - @cat-factory/prompt-fragments@0.13.20
  - @cat-factory/sandbox@0.9.81
  - @cat-factory/spend@0.12.31
  - @cat-factory/workspaces@0.13.42
  - @cat-factory/caching@0.8.2

## 0.109.0

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

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/contracts@0.130.0
  - @cat-factory/kernel@0.126.0
  - @cat-factory/agents@0.56.0
  - @cat-factory/integrations@0.83.3
  - @cat-factory/prompt-fragments@0.13.19
  - @cat-factory/sandbox@0.9.80
  - @cat-factory/spend@0.12.30
  - @cat-factory/workspaces@0.13.41
  - @cat-factory/caching@0.8.1

## 0.108.1

### Patch Changes

- Updated dependencies [d38d6c2]
  - @cat-factory/integrations@0.83.2

## 0.108.0

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

### Patch Changes

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/contracts@0.129.0
  - @cat-factory/kernel@0.125.0
  - @cat-factory/agents@0.55.0
  - @cat-factory/caching@0.8.0
  - @cat-factory/integrations@0.83.1
  - @cat-factory/prompt-fragments@0.13.18
  - @cat-factory/sandbox@0.9.79
  - @cat-factory/spend@0.12.29
  - @cat-factory/workspaces@0.13.40

## 0.107.10

### Patch Changes

- 3f3031a: Poll-first durable drivers: the execution drivers (orchestration `driveExecution` and the Cloudflare `ExecutionWorkflow`) now poll a just-dispatched container job immediately instead of sleeping a full poll interval (default 15s) first, so the first running/subtask state reaches the board with no leading dead air. Gate prechecks deliberately keep the sleep-first shape (the precheck just ran inside advance/pollGate). The Cloudflare Bootstrap/EnvironmentTest/EnvConfigRepair workflows are flipped the same way, matching their already-poll-first Node runner twins.

## 0.107.9

### Patch Changes

- Updated dependencies [ca9ea20]
  - @cat-factory/integrations@0.83.0

## 0.107.8

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
  - @cat-factory/agents@0.54.12
  - @cat-factory/sandbox@0.9.78
  - @cat-factory/spend@0.12.28
  - @cat-factory/workspaces@0.13.39

## 0.107.7

### Patch Changes

- Updated dependencies [6c4bcef]
  - @cat-factory/contracts@0.128.2
  - @cat-factory/kernel@0.123.3
  - @cat-factory/integrations@0.81.20
  - @cat-factory/agents@0.54.11
  - @cat-factory/prompt-fragments@0.13.17
  - @cat-factory/sandbox@0.9.77
  - @cat-factory/spend@0.12.27
  - @cat-factory/workspaces@0.13.38
  - @cat-factory/caching@0.6.46

## 0.107.6

### Patch Changes

- b34ab46: Classify errors by structured fields, not strings, on three more paths (error-message initiative I5/I6/I7).

  - **I7 — installation-token-gone:** the App token mint now throws a named
    `InstallationTokenMintError` carrying the HTTP `status` as a field, wrapped once at the mint site
    in `GitHubAppAuth`. The stale-installation reconcile (`reconcileStaleRepos`) classifies via the
    `installationTokenMintStatusOf` extractor — an `instanceof` check deliberately specific to the mint
    error, so a repo-level 404 can never be mistaken for a gone installation — and the log-level check
    reads the repo-level `GitHubApiError.status` structurally too. Both errors throw in-process, so
    there is NO message-regex fallback (we target current installations only). The elaborated C3 remedy
    text is free to change without breaking the tombstone decision.
  - **I5 — delete the string-fallback classifiers:** with the structured `RunnerJobView.evicted` field
    and the harness `failureCause` now minted by every in-repo transport, the superseded error-string
    fallbacks are removed — `classifyAgentFailure` / `classifyBootstrapFailure` / `classifyRepairFailure`
    are gone (the sites default to the coarse `agent`), and `evictionKindOf`'s string fallback (plus
    `isTransientEviction` and the exported `TRANSIENT_EVICTION_MARKER`) is dropped in favour of reading
    the `evicted` field directly. `isContainerEvictionError` is kept for the dispatch-time eviction
    throw, which carries no job view. Backend/runtime-only; no executor-harness image change.
  - **I6 — first-wrap-point rule:** codified (the named boundaries — git stderr, pg driver errors,
    kubectl/k3s stderr — already conformed): third-party text is classified once, where it enters the
    system, into a named error with a machine field; nothing downstream re-parses the prose.

## 0.107.5

### Patch Changes

- Updated dependencies [90a7fb3]
  - @cat-factory/integrations@0.81.19

## 0.107.4

### Patch Changes

- c1028cc: Give every execution failure kind an actionable board hint (error-message initiative G3).

  The execution engine's `EXECUTION_FAILURE_HINTS` map omitted `preflight`, yet the engine
  produces that kind whenever a precondition rejects a run before dispatch — most commonly a
  `github_not_connected` `ConflictError` raised while building the job for a workspace with no
  connected repository (`classifyDispatchFailure` → `preflight`). Those failures reached
  `AgentFailureCard` on the board with `hint: null`, so the card showed the terse message with
  no "what to do next" guidance.

  `preflight` now carries a hint (connect GitHub and link a repository, or pick a configured
  model in the workspace settings, then retry), and the map is retyped from
  `Partial<Record<AgentFailureKind, string>>` to an exhaustive `Record<AgentFailureKind,
string>` — the engine is the primary producer of the full union, so a total map is correct
  and its type is now the drift guard: adding a new failure kind without a hint is a typecheck
  failure. The two other hint maps were already safe (bootstrap is exhaustive over its narrow
  alias; env-config-repair keeps a `?? unknown` fallback over the subset it produces) and are
  unchanged.

## 0.107.3

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2
  - @cat-factory/contracts@0.128.1
  - @cat-factory/agents@0.54.10
  - @cat-factory/caching@0.6.45
  - @cat-factory/integrations@0.81.18
  - @cat-factory/sandbox@0.9.76
  - @cat-factory/spend@0.12.26
  - @cat-factory/workspaces@0.13.37
  - @cat-factory/prompt-fragments@0.13.16

## 0.107.2

### Patch Changes

- 2c7ca2e: Reuse the already-loaded list instead of looping point-reads on four engine/board paths
  (performance-optimizations initiative — items 15, 16, 17, 18). No behaviour change; each
  collapses a per-item repository read into one batched read or a reused list.

  - **`autoStartDependents` (item 15)** now resolves every dependent's pipeline from a single
    `pipelineRepository.listByWorkspace` indexed into a `Map`, instead of a `get` per dependent
    in the loop (the board "Run" default already came from the first pipeline).
  - **`InitiativeLoopService.spawn` (item 16)** loads the pipeline catalog once per tick and
    checks each spawned item's pipeline against that `Set`, instead of a `pipelineRepository.get`
    per eligible item.
  - **`BoardScanService.reconcileBlueprint` / `spawnBlueprint` (item 17)** insert missing modules
    through a new batched `BoardService.addModules` seam (resolve + list the board once for the
    whole batch), instead of `addModule` re-listing the entire board per module. `addModule` now
    delegates to it.
  - **Block delete (item 18)** — `teardownForBlockTree` returns the workspace block list it loaded
    (it deletes only run records, never blocks) and `removeBlock` accepts it via a new `preloaded`
    option, reusing it when it was loaded for the block's home workspace (the common locally-owned
    delete) and re-listing only for a mounted shared service homed elsewhere. Removes the second
    full board read the DELETE path used to pay. New shared `PreloadedBlocks` kernel type.

- Updated dependencies [2c7ca2e]
  - @cat-factory/kernel@0.123.1
  - @cat-factory/agents@0.54.9
  - @cat-factory/caching@0.6.44
  - @cat-factory/integrations@0.81.17
  - @cat-factory/sandbox@0.9.75
  - @cat-factory/spend@0.12.25
  - @cat-factory/workspaces@0.13.36

## 0.107.1

### Patch Changes

- e4c5abe: Type the harness failure-cause wire and consolidate its classifiers (error-message initiative I4).
  The kernel now owns the structured cause vocabulary — `HARNESS_FAILURE_CAUSES` /
  `HarnessFailureCause` / `isHarnessFailureCause` / `failureKindFromHarnessCause`
  (`kernel/src/domain/harness-failure.ts`), kept in step by hand with the dependency-free container
  payloads (executor-harness `FailureCause` plus deploy-harness `DeployFailureCause`, hence the
  `deploy` member) — and the three job-view ports carry the union instead of a bare string
  (`RunnerJobView.failureCause`, the failed `AgentJobUpdate` variant, `PreviewView.failureCause`).
  The mapper's internal `Record<HarnessFailureCause, 'timeout' | 'agent'>` is the drift guard: a new
  union member without a mapping fails the typecheck.

  The three per-flow copies of the cause switch are deleted in favour of that one kernel mapper:
  orchestration's `agentFailureKindFromCause` (a module export of `job.logic.ts`, now removed —
  `RunDispatcher` calls the kernel mapper), the bootstrapper's `bootstrapFailureKindFromCause`, and
  the repairer's `repairFailureKindFromCause`. Each flow keeps its own error-string regex purely as
  the no-cause fallback. `HttpRunnerPoolProvider` now narrows the pool's dot-path-mapped cause
  through `isHarnessFailureCause` (an unknown free-form value degrades to the regex fallback instead
  of riding the wire untyped), and the conformance `FakeAgentExecutor.pollFailCause` option is typed
  to the union. Container eviction stays outside the union (a transport signal —
  `RunnerJobView.evicted`). No executor-harness image bump: the harness sources are untouched.

- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0
  - @cat-factory/integrations@0.81.16
  - @cat-factory/agents@0.54.8
  - @cat-factory/caching@0.6.43
  - @cat-factory/sandbox@0.9.74
  - @cat-factory/spend@0.12.24
  - @cat-factory/workspaces@0.13.35

## 0.107.0

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

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/contracts@0.128.0
  - @cat-factory/kernel@0.122.0
  - @cat-factory/integrations@0.81.15
  - @cat-factory/agents@0.54.7
  - @cat-factory/prompt-fragments@0.13.15
  - @cat-factory/sandbox@0.9.73
  - @cat-factory/spend@0.12.23
  - @cat-factory/workspaces@0.13.34
  - @cat-factory/caching@0.6.42

## 0.106.8

### Patch Changes

- Updated dependencies [2a13ece]
  - @cat-factory/kernel@0.121.8
  - @cat-factory/caching@0.6.41
  - @cat-factory/integrations@0.81.14
  - @cat-factory/agents@0.54.6
  - @cat-factory/sandbox@0.9.72
  - @cat-factory/spend@0.12.22
  - @cat-factory/workspaces@0.13.33

## 0.106.7

### Patch Changes

- 3ce997d: Structured container-eviction signal (error-message initiative I1). A container eviction is now
  carried on a typed `RunnerJobView.evicted` field (`'crash'` | `'transient'`, the new
  `ContainerEvictionKind`) minted by every runner transport (Cloudflare, the shared local
  `harnessHttp`, the local container/pool/process/native-routing transports, and Kubernetes/EKS),
  forwarded through `AgentJobUpdate`, and read by the execution / bootstrap / env-config-repair
  consumers via the new `evictionKindOf` extractor. The `(container evicted or crashed)` sentinel +
  the transient marker are PRESERVED as the fallback for an older producer, so nothing that still
  matches the string breaks — the structured field is simply the load-bearing signal now, replacing
  the regex as the primary classification channel.
- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7
  - @cat-factory/integrations@0.81.13
  - @cat-factory/agents@0.54.5
  - @cat-factory/caching@0.6.40
  - @cat-factory/sandbox@0.9.71
  - @cat-factory/spend@0.12.21
  - @cat-factory/workspaces@0.13.32

## 0.106.6

### Patch Changes

- 67dccb6: perf(caching): route workspace-settings and spend budget reads through the app cache seam (perf-tracker items 7 & 9)

  Replaces `SpendService`'s three homebrew `{ value, expiresAt }` TTL `Map`s (pricing /
  account limit / user limit) and the uncached `WorkspaceSettingsService.get` with three new
  `AppCaches` slices — `workspaceSettings`, `accountBudgetLimit`, `userBudgetLimit` — so these
  slow-moving reads are coherent across a horizontally-scaled Node deployment (a budget/settings
  edit invalidates every replica via the notification bus instead of leaving peers stale for the
  TTL). The workspace-settings row is now read through a single shared slice by
  `WorkspaceSettingsService`, `SpendService`'s pricing overlay, and
  `LlmObservabilityService.bodiesEnabled`, so one invalidation on `WorkspaceSettingsService.update`
  covers them all. The slices are pass-through on the Worker's isolate-safe profile (our own
  mutable D1 state, no cross-isolate bus).

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6
  - @cat-factory/caching@0.6.39
  - @cat-factory/spend@0.12.20
  - @cat-factory/workspaces@0.13.31
  - @cat-factory/agents@0.54.4
  - @cat-factory/integrations@0.81.12
  - @cat-factory/sandbox@0.9.70

## 0.106.5

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
  - @cat-factory/contracts@0.127.1
  - @cat-factory/integrations@0.81.11
  - @cat-factory/kernel@0.121.5
  - @cat-factory/prompt-fragments@0.13.14
  - @cat-factory/sandbox@0.9.69
  - @cat-factory/spend@0.12.19
  - @cat-factory/workspaces@0.13.30

## 0.106.4

### Patch Changes

- Updated dependencies [e68c958]
  - @cat-factory/integrations@0.81.10

## 0.106.3

### Patch Changes

- 4810353: Structured, elaborated container/runner dispatch failures (error-message coverage initiative,
  items D1/I2). A `dispatch()` rejection used to throw a bare `Container dispatch failed (HTTP n)`
  string that named the symptom but not the cause, and downstream consumers decided "was this a
  dispatch failure?" by regex-matching `/dispatch failed/i` — so error IDENTITY rode a string, and a
  self-hosted-pool fault (`Runner pool … → <status>`, a different wording) fell through and was
  mislabelled a `preflight` error.

  - **I2** — new kernel `DispatchError` (`domain/dispatch-errors.ts`) carries the HTTP `status` as a
    structured field, thrown by every transport `dispatch()`: `CloudflareContainerTransport`,
    `KubernetesRunnerTransport`, the local `postHarnessJob` (both local transports), and
    `RunnerPoolTransport` (which re-wraps the pool provider's `RunnerPoolApiError`, carrying its
    status). `BootstrapService`, `EnvConfigRepairService`, and the execution engine
    (`classifyDispatchFailure`) now classify via `instanceof` / the `isDispatchFailure` extractor,
    with the legacy `/dispatch failed/i` message shape kept only as a fallback. This fixes the pool
    dispatch fault being mislabelled `preflight`.
  - **D1** — a 404 from the harness `/jobs` route (the deployed executor-harness image predates the
    route because its tag was never bumped, so new containers run stale code) now elaborates with the
    stale-image cause + the republish-under-a-fresh-tag remedy and a link to the release rules. The
    raw `<label> dispatch failed (HTTP n): <body>` first line is preserved verbatim (still greppable,
    still matched by the fallback regex); the cause + remedy is only appended.

  No behaviour changes beyond error message text and failure classification. No executor-harness
  image change (the dispatch signal is minted by in-repo transports).

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4
  - @cat-factory/integrations@0.81.9
  - @cat-factory/agents@0.54.2
  - @cat-factory/caching@0.6.37
  - @cat-factory/sandbox@0.9.68
  - @cat-factory/spend@0.12.18
  - @cat-factory/workspaces@0.13.29

## 0.106.2

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
  - @cat-factory/agents@0.54.1
  - @cat-factory/caching@0.6.36
  - @cat-factory/integrations@0.81.8
  - @cat-factory/sandbox@0.9.67
  - @cat-factory/spend@0.12.17
  - @cat-factory/workspaces@0.13.28

## 0.106.1

### Patch Changes

- Updated dependencies [3b3bdc8]
  - @cat-factory/integrations@0.81.7

## 0.106.0

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

### Patch Changes

- Updated dependencies [d1a4129]
  - @cat-factory/contracts@0.127.0
  - @cat-factory/agents@0.54.0
  - @cat-factory/integrations@0.81.6
  - @cat-factory/kernel@0.121.2
  - @cat-factory/prompt-fragments@0.13.13
  - @cat-factory/sandbox@0.9.66
  - @cat-factory/spend@0.12.16
  - @cat-factory/workspaces@0.13.27
  - @cat-factory/caching@0.6.35

## 0.105.6

### Patch Changes

- 473e849: Classify VCS (GitHub / GitLab) HTTP failures with cause + fix + doc links (error-message coverage
  initiative, items C1/C4/C5/C6). The `fetch`-based clients used to throw the same bare status dump
  for any non-2xx (`GitHub GET <url> → 401: <body>`), so a revoked token, an exhausted rate limit,
  and a missing scope all read identically.

  - Adds a shared kernel helper `describeVcsApiError` (`@cat-factory/kernel` `domain/vcs-errors.ts`)
    that maps `{ provider, status }` to a remedy. It PRESERVES the raw
    `<Provider> <method> <url> → <status>: <body>` first line (detectors still surface it and it stays
    greppable) and APPENDS a cause + remedy sentence: 401 → token revoked/expired (reconnect the App,
    or refresh `GITHUB_PAT` in local mode); 403 + rate-limit headers / 429 → rate limited, wait for
    the reset (App has a higher limit than a PAT); 403 → missing permission/scope + where to grant it;
    404 → repo/installation not visible to the token. GitLab gets the same shapes, GitLab-flavoured
    (`api` scope, Developer/Maintainer role). Kernel sits below the server layer so it keeps its own
    `VCS_DOC_URLS` (per the doc-URL convention) linking `backend/docs/github-integration.md` /
    `github-operations.md` / `vcs-providers.md`.
  - **C1/C6** — `FetchGitHubClient` (REST `request()` + PAT `requestWithToken()`) and
    `FetchGitLabClient.request()` / `provisioning.ts` now build their `*ApiError` message through the
    helper. Error identity still rides the structured `status` field, so classification is unchanged.
  - **C5** — `Installation X not found on any configured App` now explains the App was likely
    uninstalled or the workspace points at a stale installation, and to reconnect GitHub.
  - **C4** — `No connected GitHub repository found for workspace 'X'` (`ContainerAgentExecutor`) is now
    a `ConflictError` carrying the existing `github_not_connected` reason (was a plain `Error` → 500),
    with a UI-first remedy pointing at the GitHub connect / repo-linking flow. The SPA already maps
    that reason to a translated title.
  - **C4 (async run path)** — the durable dispatch previously caught EVERY `startJob` throw and framed
    it as a container `dispatch` failure ("The container failed to start."), so a `github_not_connected`
    precondition reached the board mislabeled and lost its `reason`. `classifyDispatchFailure`
    (`job.logic.ts`) now distinguishes a pre-dispatch domain precondition (any `DomainError`) as a
    `preflight` failure that keeps its own actionable message and propagates its `reason`, so
    `AgentFailureCard` titles it with the same translated "GitHub not connected" string the 409 toast
    uses (no new locale keys) and shows the remedy in the detail.

  No behaviour changes beyond error identity (C4's 409 + `preflight` classification on the async path)
  and message text.

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1
  - @cat-factory/agents@0.53.6
  - @cat-factory/caching@0.6.34
  - @cat-factory/integrations@0.81.5
  - @cat-factory/sandbox@0.9.65
  - @cat-factory/spend@0.12.15
  - @cat-factory/workspaces@0.13.26

## 0.105.5

### Patch Changes

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0
  - @cat-factory/workspaces@0.13.25
  - @cat-factory/agents@0.53.5
  - @cat-factory/caching@0.6.33
  - @cat-factory/integrations@0.81.4
  - @cat-factory/sandbox@0.9.64
  - @cat-factory/spend@0.12.14

## 0.105.4

### Patch Changes

- Updated dependencies [cc6d554]
  - @cat-factory/agents@0.53.4
  - @cat-factory/sandbox@0.9.63

## 0.105.3

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0
  - @cat-factory/agents@0.53.3
  - @cat-factory/caching@0.6.32
  - @cat-factory/integrations@0.81.3
  - @cat-factory/sandbox@0.9.62
  - @cat-factory/spend@0.12.13
  - @cat-factory/workspaces@0.13.24

## 0.105.2

### Patch Changes

- Updated dependencies [a5dcf7d]
  - @cat-factory/kernel@0.119.0
  - @cat-factory/agents@0.53.2
  - @cat-factory/caching@0.6.31
  - @cat-factory/integrations@0.81.2
  - @cat-factory/sandbox@0.9.61
  - @cat-factory/spend@0.12.12
  - @cat-factory/workspaces@0.13.23

## 0.105.1

### Patch Changes

- Updated dependencies [5072999]
  - @cat-factory/contracts@0.126.0
  - @cat-factory/agents@0.53.1
  - @cat-factory/integrations@0.81.1
  - @cat-factory/kernel@0.118.1
  - @cat-factory/prompt-fragments@0.13.12
  - @cat-factory/sandbox@0.9.60
  - @cat-factory/spend@0.12.11
  - @cat-factory/workspaces@0.13.22
  - @cat-factory/caching@0.6.30

## 0.105.0

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
  - @cat-factory/integrations@0.81.0
  - @cat-factory/prompt-fragments@0.13.11
  - @cat-factory/sandbox@0.9.59
  - @cat-factory/spend@0.12.10
  - @cat-factory/workspaces@0.13.21
  - @cat-factory/caching@0.6.29

## 0.104.1

### Patch Changes

- e254ef5: Perf: roll up per-step LLM metrics only on step-boundary/terminal emits, not on every progress fold (performance-optimizations item 1).

  - `RunStateMachine.emitInstance` now takes a `{ rollUpMetrics }` option (default `true`). The
    metrics rollup is a per-agent-kind GROUP BY over the whole run's `llm_call_metrics`, so running
    it on every emit made the drive loop pay O(emits × calls-in-run) — the frequent progress-only
    poll folds (a subtask tick or a streamed follow-up while a container runs) re-aggregated the run
    just to redraw a progress bar. The two running-progress poll folds in `RunDispatcher`
    (`pollAgentJobInner`'s container fold and `pollDeployerJob`'s deploy fold) now pass
    `rollUpMetrics: false`; the rollup refreshes only on the emits that surface a settled step.
  - `step.metrics` is live-only, derived state (never persisted; absent from the snapshot), so the
    SPA execution store now carries the last-known per-step rollup forward when an incoming instance
    omits it (`upsert`/`hydrate`), per the live-push coherence rules — a metric-less running fold no
    longer blanks the board's per-step metrics bar between boundaries. Pinned with store-level unit
    tests.

## 0.104.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/contracts@0.124.1
  - @cat-factory/kernel@0.117.6
  - @cat-factory/agents@0.52.9
  - @cat-factory/integrations@0.80.6
  - @cat-factory/prompt-fragments@0.13.10
  - @cat-factory/sandbox@0.9.58
  - @cat-factory/spend@0.12.9
  - @cat-factory/workspaces@0.13.20
  - @cat-factory/caching@0.6.28

## 0.103.1

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
  - @cat-factory/agents@0.52.8
  - @cat-factory/caching@0.6.27
  - @cat-factory/integrations@0.80.5
  - @cat-factory/sandbox@0.9.57
  - @cat-factory/spend@0.12.8
  - @cat-factory/workspaces@0.13.19

## 0.103.0

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

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/contracts@0.124.0
  - @cat-factory/kernel@0.117.4
  - @cat-factory/agents@0.52.7
  - @cat-factory/integrations@0.80.4
  - @cat-factory/prompt-fragments@0.13.9
  - @cat-factory/sandbox@0.9.56
  - @cat-factory/spend@0.12.7
  - @cat-factory/workspaces@0.13.18
  - @cat-factory/caching@0.6.26

## 0.102.8

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
  - @cat-factory/agents@0.52.6
  - @cat-factory/caching@0.6.25
  - @cat-factory/integrations@0.80.3
  - @cat-factory/sandbox@0.9.55
  - @cat-factory/spend@0.12.6
  - @cat-factory/workspaces@0.13.17

## 0.102.7

### Patch Changes

- a650396: fix(execution): don't clobber a merged task's block to `blocked` when a stop races the merge (race-audit 2.3 follow-up)

  Race-audit 2.3 closed the terminal-state clobber on the run row (`markFailed` is SQL-guarded
  against a `done`/`failed` row, so a `stopRun` racing a just-merged run can't re-mark the run
  `failed`). But `RunStateMachine.failRun` still projected the failure onto the BLOCK
  unconditionally — so in the same load→`markFailed` window a stop landing right as the merger
  flipped the run `done` left `markFailed` correctly no-op'ing while the block was still forced to
  `blocked`, resurfacing the "looks failed but the PR merged" inconsistency one layer out. The
  block projection now reads the AUTHORITATIVE post-write run status and only drops the block to
  `blocked` when the run actually transitioned to `failed`. Runtime-neutral (pure orchestration
  logic above the repos); covered by a new `RunStateMachine.failRun` unit test.

## 0.102.6

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
  - @cat-factory/workspaces@0.13.16
  - @cat-factory/agents@0.52.5
  - @cat-factory/caching@0.6.24
  - @cat-factory/integrations@0.80.2
  - @cat-factory/sandbox@0.9.54
  - @cat-factory/spend@0.12.5
  - @cat-factory/prompt-fragments@0.13.8

## 0.102.5

### Patch Changes

- Updated dependencies [cb7fd14]
  - @cat-factory/integrations@0.80.1
  - @cat-factory/kernel@0.117.1
  - @cat-factory/agents@0.52.4
  - @cat-factory/caching@0.6.23
  - @cat-factory/sandbox@0.9.53
  - @cat-factory/spend@0.12.4
  - @cat-factory/workspaces@0.13.15

## 0.102.4

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0
  - @cat-factory/integrations@0.80.0
  - @cat-factory/agents@0.52.3
  - @cat-factory/caching@0.6.22
  - @cat-factory/sandbox@0.9.52
  - @cat-factory/spend@0.12.3
  - @cat-factory/workspaces@0.13.14

## 0.102.3

### Patch Changes

- 2924e32: Finish the optimistic-concurrency (rev/CAS) migration — the CONTROLLER half (race-audit 2.2/2.3).

  The driver half already routed the durable driver's writes through `RunStateMachine.casPersist`
  (abort-and-re-drive on a lost race) and the single-action human handlers through `mutateInstance`.
  The six gate-window controllers, however, still force-wrote the entire serialized instance via the
  blind `persistInstance` — so a concurrent human action (or a `stopRun`/`cancel`) landing in a
  controller's read→write window could silently clobber the winner or resurrect a deleted run. This
  closes that half:

  - **Driver-path controller writes → `casPersist`.** The gate `evaluate` / `completeStep` / dispatch
    / apply-assessment paths in `CompanionController`, `TesterController`, `HumanTestController`,
    `InterviewGateController`, `VisualConfirmationController`, and `ReviewGateController` run inside the
    driver's `advanceInstance` / `redriveOnContention` envelope, so a lost race throws
    `RunContendedError` and re-drives on fresh state — exactly like `handleAgentStep`.
  - **HTTP human-action handlers → `mutateInstance`.** Review `incorporate` / `offloadRecommendation` /
    `resumeRun`, human-test & visual-confirm `signalAction` + `destroyEnvironment`, interview `resume`,
    and `ExecutionService.resolveCompanionExceeded` now load fresh, re-find the parked gate, apply the
    pure mutation under `compareAndSwap`, and run their non-idempotent side effects (driver signal /
    emit / dispatch / env teardown) once after, on the winning snapshot.
  - **Gate-resume split.** The blind combined `RunStateMachine.advancePastResolvedGate` is deleted;
    every gate-resume path now uses the pure `advanceRunPastGate` (inside `mutateInstance`) +
    the side-effect `settleAdvancedGate`.

  Cross-runtime conformance adds a repository-layer assertion for the `mutateInstance` reload-and-retry
  contract — a racing human write reloads and lands alongside the driver's write instead of clobbering
  it — proven identically on D1 and Postgres.

- Updated dependencies [51869b8]
  - @cat-factory/kernel@0.116.0
  - @cat-factory/spend@0.12.2
  - @cat-factory/agents@0.52.2
  - @cat-factory/caching@0.6.21
  - @cat-factory/integrations@0.79.3
  - @cat-factory/sandbox@0.9.51
  - @cat-factory/workspaces@0.13.13

## 0.102.2

### Patch Changes

- Updated dependencies [ddb0b68]
  - @cat-factory/workspaces@0.13.12

## 0.102.1

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
  - @cat-factory/kernel@0.115.1
  - @cat-factory/agents@0.52.1
  - @cat-factory/caching@0.6.20
  - @cat-factory/integrations@0.79.2
  - @cat-factory/sandbox@0.9.50
  - @cat-factory/spend@0.12.1
  - @cat-factory/workspaces@0.13.11

## 0.102.0

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

### Patch Changes

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

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/contracts@0.123.0
  - @cat-factory/kernel@0.115.0
  - @cat-factory/agents@0.52.0
  - @cat-factory/spend@0.12.0
  - @cat-factory/integrations@0.79.1
  - @cat-factory/prompt-fragments@0.13.7
  - @cat-factory/sandbox@0.9.49
  - @cat-factory/workspaces@0.13.10
  - @cat-factory/caching@0.6.19

## 0.101.0

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
  - @cat-factory/prompt-fragments@0.13.6
  - @cat-factory/sandbox@0.9.48
  - @cat-factory/spend@0.11.24
  - @cat-factory/workspaces@0.13.9
  - @cat-factory/caching@0.6.18

## 0.100.2

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
  - @cat-factory/contracts@0.121.2
  - @cat-factory/caching@0.6.17
  - @cat-factory/integrations@0.78.8
  - @cat-factory/sandbox@0.9.47
  - @cat-factory/spend@0.11.23
  - @cat-factory/workspaces@0.13.8
  - @cat-factory/prompt-fragments@0.13.5

## 0.100.1

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
  - @cat-factory/integrations@0.78.7
  - @cat-factory/kernel@0.112.1
  - @cat-factory/sandbox@0.9.46
  - @cat-factory/caching@0.6.16
  - @cat-factory/spend@0.11.22
  - @cat-factory/workspaces@0.13.7

## 0.100.0

### Minor Changes

- f25d5e2: Complete the two deferred service-connections Phase 4 multi-repo follow-ups.

  **Conflict-resolver peer targeting.** The `conflicts` gate now ESCALATES a conflict on a
  connected involved service's PEER repo (previously it declined escalation and fast-failed the run
  to a manual give-up). The gate still tags which repo conflicted (`conflictTarget`); the engine
  threads that onto the dispatched `conflict-resolver`'s context, and the container executor points
  the (single-repo) resolver at THAT peer repo — resolving its target, cloning its PR (work) branch,
  and merging the peer's base in — instead of always the task's own service. An own-repo conflict is
  unchanged (no `frameId` ⇒ the own service is the implicit target). Handles the peer-only case (own
  service unchanged, so no own PR) by pinning the resolve branch to the shared work branch.

  **Merger combined-diff.** The `merger` now scores the COMBINED cross-repo change on a multi-repo
  task instead of only the own-repo diff. Driven by the PRs that actually exist
  (`block.peerPullRequests`), it clones each peer PR's repo as a read-only sibling checkout at its PR
  branch (full history) alongside the own service, and a "Multi-repo pull request" prompt section
  plus the reworked merger prompts instruct it to diff each repo against its base and return ONE
  blended complexity/risk/impact assessment covering the whole change. The read-only multi-repo
  explore harness path gained per-peer `cloneBranch` selection and honours the job's `full` flag (a
  new container capability — the executor-harness image is bumped), so the bug-investigator's
  base-branch fan-out is unchanged while the merger checks each peer out at its PR head.

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0
  - @cat-factory/agents@0.49.2
  - @cat-factory/caching@0.6.15
  - @cat-factory/integrations@0.78.6
  - @cat-factory/sandbox@0.9.45
  - @cat-factory/spend@0.11.21
  - @cat-factory/workspaces@0.13.6

## 0.99.1

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

- Updated dependencies [9aa9e19]
  - @cat-factory/contracts@0.121.1
  - @cat-factory/agents@0.49.1
  - @cat-factory/integrations@0.78.5
  - @cat-factory/kernel@0.111.1
  - @cat-factory/prompt-fragments@0.13.4
  - @cat-factory/sandbox@0.9.44
  - @cat-factory/spend@0.11.20
  - @cat-factory/workspaces@0.13.5
  - @cat-factory/caching@0.6.14

## 0.99.0

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

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0
  - @cat-factory/agents@0.49.0
  - @cat-factory/contracts@0.121.0
  - @cat-factory/caching@0.6.13
  - @cat-factory/integrations@0.78.4
  - @cat-factory/sandbox@0.9.43
  - @cat-factory/spend@0.11.19
  - @cat-factory/workspaces@0.13.4
  - @cat-factory/prompt-fragments@0.13.3

## 0.98.1

### Patch Changes

- bcc843d: Initiatives: an initiative preset's per-agent-kind `promptAddition` now reaches the
  runs SPAWNED by that initiative (a task's coder / tester / custom kind), not only the
  initiative's own planning run. The `AgentContextBuilder` resolves the preset's steering
  for any block carrying `initiativeId` (gated on it, so plain tasks pay nothing), and a
  shared `initiativePresetSection` renderer folds the `## Initiative preset:` steering into
  the standard-phase, generic custom-kind, and planning prompts alike — including a custom
  kind that supplies its own user prompt (the steering is folded in ahead of it). This is the vehicle
  for an org to attach standing role/task methodology to built-in agents without forking
  them (slice 1 of the custom-initiative-definitions initiative). No behaviour changes for
  non-initiative runs — their prompts stay byte-for-byte identical.
- Updated dependencies [bcc843d]
  - @cat-factory/agents@0.48.5
  - @cat-factory/kernel@0.110.1
  - @cat-factory/sandbox@0.9.42
  - @cat-factory/caching@0.6.12
  - @cat-factory/integrations@0.78.3
  - @cat-factory/spend@0.11.18
  - @cat-factory/workspaces@0.13.3

## 0.98.0

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

### Patch Changes

- a2db337: Fix initiative planning interview wedging after "Continue"/"Proceed", and surface a
  "Run planning" start control on the initiative board card.

  - **Engine:** the step re-park guard in `ExecutionService` never let a _resumed_
    interactive-interviewer step (initiative planning + document interviewer) fall through to
    its gate evaluation — it re-parked the run immediately, so pressing Continue/Proceed
    loaded briefly and then hung on the same questions. The guard, the generic approve/reject
    guard, AND the step-handler dispatch in `RunDispatcher` now all key off a new
    `interview-gate` agent **trait** carried by both interviewer kinds — the dispatch routes
    by trait to the controller registered for the step's `agentKind`, so a resumed interview
    (one carrying `pendingInterview`) re-runs the interviewer in the durable driver instead of
    wedging. Fully trait-based rather than kind-based, so a future interviewer just carries the
    trait and wires its controller — no engine branch.
  - **Board:** an initiative card now offers "Run planning" (and, while the interview is
    parked, "Answer planning questions") directly on the board, mirroring a task card's
    on-card Start affordance instead of hiding it behind selecting the block. The card and the
    inspector share a single `useInitiativePlanning` composable (no duplicated planning logic):
    the "Answer planning questions" affordance now keys on the interview's parked status alone
    (so it stays reachable once every question is answered but before the human resumes), and
    the optimistic start flag clears the moment the run takes over (so the button can't strand
    itself spinning after a cancel).

- Updated dependencies [a2db337]
- Updated dependencies [a2db337]
  - @cat-factory/agents@0.48.4
  - @cat-factory/contracts@0.120.0
  - @cat-factory/kernel@0.110.0
  - @cat-factory/sandbox@0.9.41
  - @cat-factory/integrations@0.78.2
  - @cat-factory/prompt-fragments@0.13.2
  - @cat-factory/spend@0.11.17
  - @cat-factory/workspaces@0.13.2
  - @cat-factory/caching@0.6.11

## 0.97.2

### Patch Changes

- Updated dependencies [35636d5]
  - @cat-factory/agents@0.48.3
  - @cat-factory/sandbox@0.9.40

## 0.97.1

### Patch Changes

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1
  - @cat-factory/workspaces@0.13.1
  - @cat-factory/agents@0.48.2
  - @cat-factory/caching@0.6.10
  - @cat-factory/integrations@0.78.1
  - @cat-factory/sandbox@0.9.39
  - @cat-factory/spend@0.11.16

## 0.97.0

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

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/contracts@0.119.0
  - @cat-factory/kernel@0.109.0
  - @cat-factory/integrations@0.78.0
  - @cat-factory/workspaces@0.13.0
  - @cat-factory/agents@0.48.1
  - @cat-factory/prompt-fragments@0.13.1
  - @cat-factory/sandbox@0.9.38
  - @cat-factory/spend@0.11.15
  - @cat-factory/caching@0.6.9

## 0.96.3

### Patch Changes

- Updated dependencies [4775c40]
  - @cat-factory/agents@0.48.0
  - @cat-factory/sandbox@0.9.37

## 0.96.2

### Patch Changes

- Updated dependencies [f97d5d3]
  - @cat-factory/agents@0.47.0
  - @cat-factory/prompt-fragments@0.13.0
  - @cat-factory/sandbox@0.9.36

## 0.96.1

### Patch Changes

- Updated dependencies [cb088c7]
  - @cat-factory/agents@0.46.0
  - @cat-factory/sandbox@0.9.35

## 0.96.0

### Minor Changes

- 09a1c85: Technological-migration initiative — slice T5: the methodology prompt pack + the interviewer
  promptAddition seam.

  Adds `backend/packages/agents/src/presets/tech-migration/`, the code-side methodology steering the
  upcoming `preset_tech_migration` registration (T8) will spread onto its `promptAdditions`. Kept OFF
  the wire descriptor per the parent's off-the-wire rule (the descriptor's `phaseTemplate` carries
  only the short phase ids/titles/goals; the deep methodology lives here):

  - **`phases.ts`** — `MIGRATION_PHASE_IDS` (+ `MIGRATION_PHASE_ID_ORDER`), the single canonical
    phase-id contract shared by the phase template, this prompt pack, the plan post-processor
    (`seedMigrationPlan`, T7) and the migration E2E (T10), so no consumer retypes a phase id (a typo
    would silently break the ingest normalizer's verbatim id match).
  - **`prompt-additions.ts`** — `MIGRATION_PROMPT_ADDITIONS` (keyed by the kernel initiative kind
    constants) with the interviewer / analyst / planner steering: the interviewer probes the fuzzy,
    form-uncapturable migration facts (downtime tolerance, data-migration constraints, compat posture)
    and never re-asks the seeded form; the analyst produces the direct + TRANSITIVE blast-zone
    inventory with per-touchpoint existing-test coverage; the planner authors per-phase item briefs
    (single-writer artifacts, the human-gated confidence-case item, coverage-before-delivery),
    referencing the canonical phase ids verbatim.

  Completes the interviewer half of the preset `promptAdditions` seam in
  `InitiativeInterviewService`: the analyst/planner already fold their steering via `AgentContextBuilder`
  → `initiativeContextLines`, but the interviewer is an inline service that builds its own prompt, so it
  now folds `promptAdditions['initiative-interviewer']` under the same `## Initiative preset: <label>`
  heading. Generic and preset-less initiatives register none, so their interview stays byte-for-byte
  unchanged — the migration preset is simply the first FULL-interview preset to steer its interviewer.
  Both changes are dormant data + a generic seam until T8 registers the preset; the loop never branches
  on a preset id.

### Patch Changes

- Updated dependencies [09a1c85]
  - @cat-factory/agents@0.45.0
  - @cat-factory/sandbox@0.9.34

## 0.95.3

### Patch Changes

- Updated dependencies [785576b]
  - @cat-factory/agents@0.44.1
  - @cat-factory/sandbox@0.9.33

## 0.95.2

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/agents@0.44.0
  - @cat-factory/kernel@0.108.0
  - @cat-factory/prompt-fragments@0.12.0
  - @cat-factory/sandbox@0.9.32
  - @cat-factory/caching@0.6.8
  - @cat-factory/integrations@0.77.8
  - @cat-factory/spend@0.11.14
  - @cat-factory/workspaces@0.12.14

## 0.95.1

### Patch Changes

- Updated dependencies [4a7fca0]
  - @cat-factory/prompt-fragments@0.11.0
  - @cat-factory/agents@0.43.1
  - @cat-factory/sandbox@0.9.31

## 0.95.0

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
  - @cat-factory/kernel@0.107.0
  - @cat-factory/agents@0.43.0
  - @cat-factory/caching@0.6.7
  - @cat-factory/integrations@0.77.7
  - @cat-factory/sandbox@0.9.30
  - @cat-factory/spend@0.11.13
  - @cat-factory/workspaces@0.12.13

## 0.94.0

### Minor Changes

- cd60892: Technological-migration initiative — slice T3: full-interview qa seeding.

  A preset's create-time FORM now seeds the planning-interview digest for BOTH interview modes, so a
  FULL-interview preset's interviewer starts from the enumerable facts the form already captured
  instead of re-asking them. Generic (preset-id-agnostic) behaviour: `preset_generic` and a
  preset-less initiative are byte-for-byte unchanged.

  - **orchestration**: `InitiativeService.create` now runs `seedPresetInterviewQa` for ANY resolved
    preset (previously only `interview: 'skip'`), folding each filled, visible field into the entity's
    `qa` as one answered exchange. `seedPresetInterviewQa` reads the filled fields, so `preset_generic`
    (empty form) seeds nothing; an absent preset seeds nothing. Goal-templating from the preset's
    stated purpose stays `skip`-only — a full-interview preset's goal is still synthesized by the
    interviewer (blank until it converges when the human gave no description).
  - **orchestration**: `InitiativeInterviewService` now adds a generic "the answers above include the
    intake-form responses the stakeholder already provided — treat them as SETTLED, do NOT re-ask what
    the form covers, build on them" steering line to the interviewer prompt when the preset form
    actually seeded qa. The gate re-derives that from the SAME seeder the create flow ran (over the
    frozen `presetInputs`), so it can never disagree with what was seeded: `preset_generic` (empty
    form), a preset-less initiative, and a preset whose visible fields were all left blank never see
    it, keeping their interviewer prompt unchanged. The interviewer digs into the fuzzy,
    judgment-dependent aspects the form could not capture (downtime tolerance, data-migration
    constraints, compat posture) rather than repeating the form.

## 0.93.1

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/agents@0.42.0
  - @cat-factory/kernel@0.106.0
  - @cat-factory/sandbox@0.9.29
  - @cat-factory/caching@0.6.6
  - @cat-factory/integrations@0.77.6
  - @cat-factory/spend@0.11.12
  - @cat-factory/workspaces@0.12.12

## 0.93.0

### Minor Changes

- f7f9a9e: Technological-migration initiative — slice T2: phase-template ingest normalization.

  The generic counterpart to T1's planner prompt fold: when an initiative preset declares a
  `phaseTemplate`, the plan draft is now normalized against it at ingest, BEFORE the preset's own
  `seedPlan` hook. This is plan-SHAPE enforcement only (which phases the plan presents, and in what
  order) and stays deliberately separate from `seedPlan`'s per-item decoration.

  - **orchestration**: new pure `normalizeDraftAgainstPhaseTemplate(template, draft)`
    (`initiative.logic.ts`) — matches planned phases to template phases by `id` VERBATIM, reorders
    them into template order (preserving the planner's `title`/`goal`), appends any extra phases
    after the template ones when `allowAdditionalPhases` is set, and throws `ValidationError` on a
    missing `required` phase or a disallowed extra (an id-less phase counts as an extra). Wired into
    `InitiativeService.seedPlanDraft` ahead of the `seedPlan` hook and gated on the resolved preset's
    `phaseTemplate`, so a preset with no template (including `preset_generic`) ingests byte-for-byte
    as before. Pure + deterministic, so re-ingesting the same draft stays idempotent.
  - **orchestration**: `validatePlanDraft` now also rejects a dependency that points FORWARD into a
    later phase. Phases execute in declared order, so an earlier-phase item depending on a
    later-phase one can never resolve and deadlocks the loop — a general invariant, but the T2 phase
    reorder can turn a planner-consistent draft into a violating one, so it's caught loudly at the
    ingest trust boundary instead of stalling silently at run time.
  - **orchestration**: `seedPlanDraft` now RE-NORMALIZES the `seedPlan` hook's output against the
    template (idempotent), symmetric with the existing re-parse-for-path-safety: a hook that touched
    phases can no longer bypass the template's shape enforcement.
  - **conformance**: `defineInitiativeSuite` now drives `InitiativeService.ingestPlan` over each
    facade's real store — asserting an out-of-order plan is reordered into template order and
    persisted, and a plan missing a required phase is rejected with nothing written — so the two
    stores can't drift on a template-shaped plan.

## 0.92.0

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

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/agents@0.41.0
  - @cat-factory/kernel@0.105.0
  - @cat-factory/integrations@0.77.5
  - @cat-factory/contracts@0.118.0
  - @cat-factory/sandbox@0.9.28
  - @cat-factory/caching@0.6.5
  - @cat-factory/spend@0.11.11
  - @cat-factory/workspaces@0.12.11
  - @cat-factory/prompt-fragments@0.10.27

## 0.91.1

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

## 0.91.0

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

### Patch Changes

- Updated dependencies [4a3e536]
  - @cat-factory/contracts@0.117.0
  - @cat-factory/agents@0.40.13
  - @cat-factory/integrations@0.77.3
  - @cat-factory/kernel@0.104.4
  - @cat-factory/prompt-fragments@0.10.26
  - @cat-factory/sandbox@0.9.27
  - @cat-factory/spend@0.11.10
  - @cat-factory/workspaces@0.12.10
  - @cat-factory/caching@0.6.4

## 0.90.1

### Patch Changes

- Updated dependencies [18a9cb5]
  - @cat-factory/contracts@0.116.1
  - @cat-factory/agents@0.40.12
  - @cat-factory/integrations@0.77.2
  - @cat-factory/kernel@0.104.3
  - @cat-factory/prompt-fragments@0.10.25
  - @cat-factory/sandbox@0.9.26
  - @cat-factory/spend@0.11.9
  - @cat-factory/workspaces@0.12.9
  - @cat-factory/caching@0.6.3

## 0.90.0

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

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/contracts@0.116.0
  - @cat-factory/kernel@0.104.2
  - @cat-factory/agents@0.40.11
  - @cat-factory/integrations@0.77.1
  - @cat-factory/prompt-fragments@0.10.24
  - @cat-factory/sandbox@0.9.25
  - @cat-factory/spend@0.11.8
  - @cat-factory/workspaces@0.12.8
  - @cat-factory/caching@0.6.2

## 0.89.0

### Minor Changes

- 802fc05: Deployer run-start config gate: when a pipeline includes an enabled `deployer` step, validate the service's ephemeral-environment provisioning (the in-repo "what/where") AND the workspace's infra handler (the "how") are complete + correct BEFORE starting, and — best-effort — probe the resolved deployment integration's live connection. A gap now fails loudly at start with an actionable, deep-linked toast (fix the service config / configure the handler / re-test the connection) instead of an async failed environment (or a silent docker-compose no-op) mid-run.

  - New pure decision logic (`decideDeployerConfig` / `deployerServiceConfigIssues` / `hasEnabledDeployerStep`) drives a new `ExecutionService` start guard shared by start/retry/restart.
  - New `EnvironmentProvisioningService.testProvisioning` probes the already-saved handler's connection; `canProvision` now honors the run initiator's local per-user handler overrides. The run initiator is threaded through every handler-resolution path — the new gate, the Tester infra gate, and the deployer's own dispatch decision — so a valid override-only local compose setup resolves identically at start and at provision time (a run that passes the gate provisions instead of silently no-opping).
  - New wire conflict reasons `deployer_service_provisioning_incomplete` and `deployer_connection_test_failed`; `provision_type_unhandled` toasts now carry a "Configure infrastructure" jump.

### Patch Changes

- Updated dependencies [802fc05]
  - @cat-factory/integrations@0.77.0
  - @cat-factory/contracts@0.115.0
  - @cat-factory/agents@0.40.10
  - @cat-factory/kernel@0.104.1
  - @cat-factory/prompt-fragments@0.10.23
  - @cat-factory/sandbox@0.9.24
  - @cat-factory/spend@0.11.7
  - @cat-factory/workspaces@0.12.7
  - @cat-factory/caching@0.6.1

## 0.88.0

### Minor Changes

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

## 0.87.0

### Minor Changes

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
  - @cat-factory/kernel@0.104.0
  - @cat-factory/caching@0.6.0
  - @cat-factory/integrations@0.76.0
  - @cat-factory/agents@0.40.9
  - @cat-factory/prompt-fragments@0.10.22
  - @cat-factory/sandbox@0.9.23
  - @cat-factory/spend@0.11.6
  - @cat-factory/workspaces@0.12.6

## 0.86.0

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
  - @cat-factory/agents@0.40.8
  - @cat-factory/integrations@0.75.1
  - @cat-factory/prompt-fragments@0.10.21
  - @cat-factory/sandbox@0.9.22
  - @cat-factory/spend@0.11.5
  - @cat-factory/workspaces@0.12.5

## 0.85.0

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

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/contracts@0.112.0
  - @cat-factory/kernel@0.102.0
  - @cat-factory/integrations@0.75.0
  - @cat-factory/agents@0.40.7
  - @cat-factory/prompt-fragments@0.10.20
  - @cat-factory/sandbox@0.9.21
  - @cat-factory/spend@0.11.4
  - @cat-factory/workspaces@0.12.4
  - @cat-factory/caching@0.4.22

## 0.84.0

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

- Updated dependencies [fdba1ea]
  - @cat-factory/contracts@0.111.0
  - @cat-factory/integrations@0.74.0
  - @cat-factory/agents@0.40.6
  - @cat-factory/kernel@0.101.2
  - @cat-factory/prompt-fragments@0.10.19
  - @cat-factory/sandbox@0.9.20
  - @cat-factory/spend@0.11.3
  - @cat-factory/workspaces@0.12.3
  - @cat-factory/caching@0.4.21

## 0.83.2

### Patch Changes

- Updated dependencies [6a701ef]
  - @cat-factory/integrations@0.73.6

## 0.83.1

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

- Updated dependencies [10787c4]
  - @cat-factory/contracts@0.110.1
  - @cat-factory/kernel@0.101.1
  - @cat-factory/integrations@0.73.5
  - @cat-factory/agents@0.40.5
  - @cat-factory/prompt-fragments@0.10.18
  - @cat-factory/sandbox@0.9.19
  - @cat-factory/spend@0.11.2
  - @cat-factory/workspaces@0.12.2
  - @cat-factory/caching@0.4.20

## 0.83.0

### Minor Changes

- f596090: Record successful step outputs in the step-detail "execution history", not just failures.

  A restart-from-step resets the chosen step and every later one, dropping their `output`;
  previously that successful work was lost and the per-step history could only ever show
  errors. The run now keeps an `outputHistory` — the positive complement of `failureHistory`
  — capturing the successful outputs a restart superseded (attributed by step index, bounded
  in count + per-entry size, riding the run's `detail` JSON with no schema migration). The
  step-detail overlay renders a merged, newest-first timeline of these superseded outputs and
  the failed attempts. A plain retry (which re-runs only unfinished steps) records nothing.

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0
  - @cat-factory/kernel@0.101.0
  - @cat-factory/agents@0.40.4
  - @cat-factory/integrations@0.73.4
  - @cat-factory/prompt-fragments@0.10.17
  - @cat-factory/sandbox@0.9.18
  - @cat-factory/spend@0.11.1
  - @cat-factory/workspaces@0.12.1
  - @cat-factory/caching@0.4.19

## 0.82.0

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
  - @cat-factory/workspaces@0.12.0
  - @cat-factory/agents@0.40.3
  - @cat-factory/integrations@0.73.3
  - @cat-factory/prompt-fragments@0.10.16
  - @cat-factory/sandbox@0.9.17
  - @cat-factory/caching@0.4.18

## 0.81.0

### Minor Changes

- e66accb: Stack recipes & shared stacks (slice 7): make the Deployer the sole docker-compose provisioner + the environment setup wizard scaffolding.

  **Deployer becomes the single docker-compose provisioner (the compose-centralization follow-up owed by this slice).** Now that the setup wizard can save a `docker-compose` handler, docker-compose is provisioned by the single Deployer step through a workspace handler, exactly like `kubernetes`/`custom` — the in-container (DinD) bring-up is retired from the run-mode decision:

  - `decideTesterInfra` (`tester-infra.logic.ts`): `docker-compose` is handler-based (drops the `localTestInfraSupported`/`hasComposePath` inputs and the `limited-local`/`compose-unconfigured` reasons).
  - `needsDeployerBeforeConsumer` + `ExecutionService.assertTesterInfraConfigured`'s `needsHandler` now cover `docker-compose`, so a compose chain that reaches a tester with no resolvable handler is refused at run start (fail-fast, same as k8s/custom) instead of dead-ending.
  - `testerInfraSpec` (`@cat-factory/server`): `docker-compose` targets the Deployer-provisioned env (`environment: 'ephemeral'`); the `local`/`composePath` branch is gone.
  - (The harness's in-container `docker compose up` is now unreachable and retired in a later image-bumping slice.)

  **Environment setup wizard.** The guided detect → review → preflight → save flow the compose-centralization depends on: `EnvironmentSetupWizard.vue` (stepper shell over the `environmentWizard` store — detection, opt-in deep analysis via `pl_environment_analysis` with live provenance-merged review, compose-file/profile/seed candidate pickers, a raw-recipe editor, the preflight checklist, save the workspace compose handler + the frame recipe, and an optional trial provision with live provisioning logs), a docker-compose service-inspector nudge, a SideBar entry, the mount in `pages/index.vue`, and the `environmentWizard` i18n namespace across all 8 locales. Backed by the `preflights` API + store (`POST /workspaces/:ws/preflights/run`) and the `provisionEnvironment` API. (The `data-testid`-only e2e spec is deferred — it needs a fake `ProvisioningRepoReader` e2e seam so detection returns a canned recommendation with GitHub off; tracked in the slice-7 checklist.)

  Breaking (pre-1.0, acceptable): a `docker-compose` service reaching a tester/human-test with no configured compose handler is now refused at run start rather than falling back to an in-container compose bring-up.

  Review follow-ups in the same slice: the `environmentWizard` store now fully resets per-frame state when re-targeted (`selectFrame` no longer leaves a prior frame's `saved`/service/port behind), resolves the analyst run by preferring a live/succeeded instance over a bare `.at(-1)` (so a retry's dead predecessor can't mask the successful run), validates the exposed port before registering the handler, and surfaces a real (non-503) preflight failure instead of swallowing it. The now-dead `localTestInfraSupported` dependency (its only reads were removed with the DinD path) is dropped from `CoreDependencies`/`ExecutionService` and the local facade's wiring, and the stale DinD doc comments on `assertTesterInfraConfigured` / `testerInfraSpec` are corrected.

### Patch Changes

- Updated dependencies [e66accb]
  - @cat-factory/contracts@0.108.1
  - @cat-factory/agents@0.40.2
  - @cat-factory/integrations@0.73.2
  - @cat-factory/kernel@0.99.1
  - @cat-factory/prompt-fragments@0.10.15
  - @cat-factory/sandbox@0.9.16
  - @cat-factory/spend@0.10.109
  - @cat-factory/workspaces@0.11.27
  - @cat-factory/caching@0.4.17

## 0.80.1

### Patch Changes

- Updated dependencies [9cc02a0]
  - @cat-factory/integrations@0.73.1

## 0.80.0

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

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/integrations@0.73.0
  - @cat-factory/contracts@0.108.0
  - @cat-factory/agents@0.40.1
  - @cat-factory/caching@0.4.16
  - @cat-factory/sandbox@0.9.15
  - @cat-factory/spend@0.10.108
  - @cat-factory/workspaces@0.11.26
  - @cat-factory/prompt-fragments@0.10.14

## 0.79.1

### Patch Changes

- Updated dependencies [eef8612]
- Updated dependencies [bf31df7]
  - @cat-factory/integrations@0.72.1
  - @cat-factory/contracts@0.107.0
  - @cat-factory/agents@0.40.0
  - @cat-factory/kernel@0.98.0
  - @cat-factory/prompt-fragments@0.10.13
  - @cat-factory/sandbox@0.9.14
  - @cat-factory/spend@0.10.107
  - @cat-factory/workspaces@0.11.25
  - @cat-factory/caching@0.4.15

## 0.79.0

### Minor Changes

- 6f9d935: Stack recipes & shared stacks (slice 6): preflight prerequisite checks with guided remediation.

  A stack recipe can now declare machine `prerequisites: PreflightRef[]` — automated PROBE + human REMEDIATION checks for the inherently-manual one-time machine setup a complex compose repo needs (docker daemon reachable, free disk / RAM, container-registry login state, VPN reachability, mkcert CA, hosts-file entries, an env-file secrets marker). They are re-run at provision start: a failing REQUIRED check fails the provision fast with its copy-paste remediation in the provisioning log, instead of a mystery deep inside a 40-image pull (a non-required check is advisory — a warning). A `POST /workspaces/:ws/preflights/run` endpoint runs an arbitrary set of checks for the setup wizard's live re-check.

  - Contracts: `PreflightCheckId` / `PreflightParams` / `PreflightRef` / `PreflightResult` (`preflights.ts`) + `prerequisites` on `stackRecipeSchema`; the `runPreflightsContract` route.
  - Kernel: the runtime-bound `PreflightHostProbes` seam + `PreflightProbeOutcome`, and a `runPreflights` seam on `ProvisionEnvironmentRequest`.
  - Integrations: `PreflightService` (runtime-neutral orchestration over the probe seam) + provision-start enforcement in `ComposeEnvironmentProvider`.
  - Server: `PreflightController`.
  - Local facade: `createDockerPreflightProbes` (the host probes over the docker CLI + `node:*`), wired only where the compose runtime is (a Docker-family host daemon). The probes are runtime-bound (local facade only, the documented compose exception); the declaration + API are runtime-neutral and the recipe rides the existing `provisioning` blob, so there is no migration. On the Worker / plain Node the preflight API 503s and a recipe that declares prerequisites fails loudly at provision.

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/contracts@0.106.0
  - @cat-factory/kernel@0.97.0
  - @cat-factory/integrations@0.72.0
  - @cat-factory/agents@0.39.4
  - @cat-factory/prompt-fragments@0.10.12
  - @cat-factory/sandbox@0.9.13
  - @cat-factory/spend@0.10.106
  - @cat-factory/workspaces@0.11.24
  - @cat-factory/caching@0.4.14

## 0.78.0

### Minor Changes

- 5490103: Surface web search on container agent run details, and store/display performed search queries as telemetry.

  - Container steps now carry a `search` availability fact (`{ available, provider }`), resolved backend-side at dispatch from the run's account web-search keys (else the deployment default). The observability drill-down shows whether web search was available and which provider (Brave / SearXNG) served the run — a static per-run fact, not gated by prompt-recording.
  - New `agent_search_queries` telemetry sink records every web search a container agent performs through the backend search proxy (query, provider, result count), gated by the same double switch as agent-context snapshots (`LLM_RECORD_PROMPTS` + the workspace `storeAgentContext` setting) and pruned on the same telemetry retention window. Mirrored across the D1 (Cloudflare) and Drizzle/Postgres (Node) stores with a cross-runtime conformance suite, and surfaced on demand via `GET /workspaces/:ws/executions/:executionId/search-queries` in a new "Web search" observability view.

- dd6df12: feat(environments): attach per-PR compose stacks to their shared stacks (shared-stacks slice 5)

  Wire a stack recipe's `sharedStackRefs` + `externalNetworks` through to the per-PR consumer
  environment, so a complex compose repo can reach the long-lived shared infra it depends on (the
  acme `acme-net` shape). This is the provider-integration slice of the stack-recipes initiative.

  - **Provider-before-consumer bring-up.** `SharedStackService.ensureRefsUp(workspaceId, refs)`
    brings each referenced shared stack up (via the idempotent `ensureUp`) IN ORDER and returns the
    deduped union of the Docker networks they own — or a blocking `error` (never a throw) for a
    missing ref, a failed bring-up, or a deployment with no host daemon. It is exposed to the compose
    provider as the new `ProvisionEnvironmentRequest.ensureSharedStacks` seam (a kernel
    `SharedStackEnsureResult`), bound in `EnvironmentProvisioningService.buildProvisionRequest`.
  - **External-network attach.** `ComposeEnvironmentProvider.provisionRecipe` ensures the shared
    stacks up (streaming one `shared stacks (N)` provisioning-log step) and then attaches the per-PR
    project to `externalNetworks ∪ managedNetworks` via a new pure `attachExternalNetworks` folded
    into `prepareRecipeComposeFiles`: each network not already declared external across the merged
    `-f` layers is declared top-level `{ external: true }` and joined by every service (preserving
    the implicit `default` connectivity; skipping a `network_mode`-pinned service). The attach
    reasons about the MERGED stack (all `-f` layers together), not each layer in isolation, so it
    never re-adds `default` to a service the base intentionally scoped, never lands `networks` on a
    service whose `network_mode` sits in another layer (which compose rejects at `up`), and refuses —
    rather than silently overwrites — a requested network whose name collides with a project-owned
    network in the recipe.
  - Execution stays local-facade-bound (the documented compose runtime-binding exception); the recipe
    rides the existing persisted `provisioning` blob, so there is no migration. A recipe that
    references shared stacks on a deployment without the lifecycle wired fails loudly.

### Patch Changes

- e5b9462: Show a step's failure trail on its step-detail overlay. The step-detail overlay now has an "Execution history" toggle that reveals the prior failed attempts recorded for that specific step (plus the current failure when the run is presently failed at it): the run-level "previous errors" history narrowed to one step. Each `AgentFailure` now carries the `stepIndex` it failed at (stamped by the engine's failure funnel), so the trail can be attributed per step.
- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
- Updated dependencies [dd6df12]
  - @cat-factory/contracts@0.105.0
  - @cat-factory/kernel@0.96.0
  - @cat-factory/integrations@0.71.0
  - @cat-factory/agents@0.39.3
  - @cat-factory/prompt-fragments@0.10.11
  - @cat-factory/sandbox@0.9.12
  - @cat-factory/spend@0.10.105
  - @cat-factory/workspaces@0.11.23
  - @cat-factory/caching@0.4.13

## 0.77.0

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
  - @cat-factory/agents@0.39.2
  - @cat-factory/integrations@0.70.1
  - @cat-factory/prompt-fragments@0.10.10
  - @cat-factory/sandbox@0.9.11
  - @cat-factory/spend@0.10.104
  - @cat-factory/workspaces@0.11.22
  - @cat-factory/caching@0.4.12

## 0.76.0

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
  - @cat-factory/agents@0.39.1
  - @cat-factory/prompt-fragments@0.10.9
  - @cat-factory/sandbox@0.9.10
  - @cat-factory/spend@0.10.103
  - @cat-factory/workspaces@0.11.21
  - @cat-factory/caching@0.4.11

## 0.75.0

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
  - @cat-factory/integrations@0.69.1
  - @cat-factory/kernel@0.93.0
  - @cat-factory/contracts@0.102.0
  - @cat-factory/sandbox@0.9.9
  - @cat-factory/spend@0.10.102
  - @cat-factory/workspaces@0.11.20
  - @cat-factory/prompt-fragments@0.10.8

## 0.74.3

### Patch Changes

- Updated dependencies [029a689]
- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1
  - @cat-factory/integrations@0.69.0
  - @cat-factory/kernel@0.92.0
  - @cat-factory/agents@0.38.2
  - @cat-factory/prompt-fragments@0.10.7
  - @cat-factory/sandbox@0.9.8
  - @cat-factory/spend@0.10.101
  - @cat-factory/workspaces@0.11.19
  - @cat-factory/caching@0.4.9

## 0.74.2

### Patch Changes

- Updated dependencies [f6399cf]
  - @cat-factory/integrations@0.68.0

## 0.74.1

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0
  - @cat-factory/kernel@0.91.0
  - @cat-factory/agents@0.38.1
  - @cat-factory/integrations@0.67.1
  - @cat-factory/prompt-fragments@0.10.6
  - @cat-factory/sandbox@0.9.7
  - @cat-factory/spend@0.10.100
  - @cat-factory/workspaces@0.11.18
  - @cat-factory/caching@0.4.8

## 0.74.0

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
  - @cat-factory/prompt-fragments@0.10.5
  - @cat-factory/sandbox@0.9.6
  - @cat-factory/spend@0.10.99
  - @cat-factory/workspaces@0.11.17
  - @cat-factory/caching@0.4.7

## 0.73.1

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0
  - @cat-factory/agents@0.37.2
  - @cat-factory/integrations@0.66.1
  - @cat-factory/kernel@0.89.1
  - @cat-factory/prompt-fragments@0.10.4
  - @cat-factory/sandbox@0.9.5
  - @cat-factory/spend@0.10.98
  - @cat-factory/workspaces@0.11.16
  - @cat-factory/caching@0.4.6

## 0.73.0

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

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/contracts@0.98.0
  - @cat-factory/integrations@0.66.0
  - @cat-factory/agents@0.37.1
  - @cat-factory/caching@0.4.5
  - @cat-factory/sandbox@0.9.4
  - @cat-factory/spend@0.10.97
  - @cat-factory/workspaces@0.11.15
  - @cat-factory/prompt-fragments@0.10.3

## 0.72.1

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0
  - @cat-factory/agents@0.37.0
  - @cat-factory/caching@0.4.4
  - @cat-factory/integrations@0.65.3
  - @cat-factory/sandbox@0.9.3
  - @cat-factory/spend@0.10.96
  - @cat-factory/workspaces@0.11.14

## 0.72.0

### Minor Changes

- 13a284f: Bug-triage pipeline (phase G): the `repro-test` Reproduction Test Automation agent. A new
  structured `container-coding` agent kind writes one or more tests that fail for the reported
  reason and commits them onto the run's shared work branch (seeding it for the coder, which opens
  the one PR containing both the reproduction test and the fix) — or concedes `not_reproducible`
  without failing the run. Conceding and reproduced outcomes both advance to the coder; a
  post-completion resolver folds the `{ outcome, testPaths, notes }` assessment into the step
  output so the coder reads it, and a `BUG_FIX_GUIDANCE` prompt fragment reframes the coder's
  objective around the pre-existing failing test (fix the issue, don't merely make the test pass).

  Enabling changes: `AgentStepSpec` gains `opensPr` / `noChangesTolerated` (container-coding) so a
  kind can seed the work branch without opening a PR and tolerate a no-op; the executor-harness
  coding path now parses a structured JSON outcome (`custom`) alongside the pushed commit; the
  harness image is bumped to `1.34.9`. The runtime-neutral `@cat-factory/server` package keeps its
  Web-standard `src` surface (no `@types/node`) while typing the one cross-runtime Node built-in it
  uses (`AsyncLocalStorage`) via a local ambient shim, with node-using tests typechecked under a
  separate project.

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0
  - @cat-factory/agents@0.36.0
  - @cat-factory/caching@0.4.3
  - @cat-factory/integrations@0.65.2
  - @cat-factory/sandbox@0.9.2
  - @cat-factory/spend@0.10.95
  - @cat-factory/workspaces@0.11.13

## 0.71.1

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0
  - @cat-factory/agents@0.35.0
  - @cat-factory/integrations@0.65.1
  - @cat-factory/kernel@0.86.1
  - @cat-factory/prompt-fragments@0.10.2
  - @cat-factory/sandbox@0.9.1
  - @cat-factory/spend@0.10.94
  - @cat-factory/workspaces@0.11.12
  - @cat-factory/caching@0.4.2

## 0.71.0

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

- 49b498a: Bug-triage pipeline, Phase E — the `bug-intake` engine step (engine + SPA).

  The recurring bug-triage pipeline's inbound entry point: each scheduled fire pulls ONE matching
  open issue from the schedule's configured tracker board, claims it, and seeds the reused block
  from it so every downstream step works that bug. Consumes the Phase D foundations
  (`searchIssues`, `issueIntake`, `onIssuePickedUp`, `replaceForBlock`); no harness change, no
  image bump.

  - **`bug-intake` engine step** — a non-LLM one-shot step (the inbound dual of `tracker`),
    registered as a `StepHandler` in the engine so it never reaches a container. It resolves the
    schedule's `issueIntake` config by block, searches the source (predicates pushed into the
    vendor query), dedupes against every already-worked issue in ONE batched projection read,
    picks the oldest match, imports + **replace-links** it onto the block, rewrites the block's
    title/description from it, and posts the best-effort "taken by cat-factory" pickup writeback.
    The read-and-claim logic lives in a new provider-neutral `BugIntakeService`
    (`@cat-factory/integrations`), wired into the engine only when task sources are configured.
  - **No-match no-op** — when nothing qualifies (or no task source is wired), the run completes
    SUCCESSFULLY with every remaining step marked `skipped` (there is nothing to fix) and no
    notification — the outcome is visible in the schedule's run history. A scoped early-complete
    that reuses the existing skip/finalize machinery, not a new gate archetype.
  - **Schedule validation** — `RecurringPipelineService.create`/`update` now require an
    `issueIntake` config, pointed at a connected task source, whenever the pipeline carries an
    enabled `bug-intake` step (validated at both boundaries, including clearing the config on an
    existing bug-intake schedule) — otherwise every fire would silently no-op.
  - **SPA** — `RecurringPipelineModal.vue` gains an issue-intake section (source picker from the
    connected task sources, per-vendor board field, and the title/labels/issue-type predicates)
    shown when the picked pipeline has a `bug-intake` step, with i18n across all locales.
  - **Conformance** — intake pickup (a matching issue is imported, linked and seeds the block),
    the no-match no-op (the run completes with the remaining steps skipped), and the
    missing-config rejection are asserted on every runtime against a fake task source.

  Review fixes folded in:

  - The no-match no-op now finalizes the reused block `done` DIRECTLY instead of via
    `finalizeBlock`, which for a mergerless bug-triage pipeline would have flipped the block
    `pr_ready` and raised a spurious `pipeline_complete` "confirm + merge the PR" notification for a
    PR that does not exist. The conformance no-match test now asserts the `done` status and that no
    notification is raised.
  - Schedule intake validation now checks `TaskConnectionService.isOffered` (available AND enabled)
    rather than `isEnabled`, which defaults ON for a never-connected source and so would have waved
    through intake from a source with no connection to search.
  - `PipelineService.update` now rejects enabling a `bug-intake` step on a pipeline whose attached
    schedules carry no `issueIntake` config (the pipeline-edit dual of the schedule-attach guard).
  - Reseeding the reused block on pickup also clears the previous fire's `peerPullRequests` so a new
    bug doesn't inherit a prior bug's connected-repo PRs.
  - `RecurringPipelineModal.vue`'s bug-intake detection now respects the per-step `enabled` mask,
    mirroring the backend, and the literal `owner/name` / `bug` / `in-progress` placeholder examples
    are inlined in the component rather than living (and being mistranslated) in the message catalog.

- 49b498a: Bug-triage pipeline, Phase F — structured, multi-repo investigation + clarification.

  The `bug-investigator` is upgraded from a thin prose role into a STRUCTURED, read-only,
  multi-repo `container-explore` kind whose triage drives the downstream `clarity-review` gate,
  and the gate learns to seed itself from that triage instead of running its own first LLM pass.
  Same kind id, so the existing `pl_bugfix` preset inherits the upgrade.

  - **Structured `bug-investigator`** (`@cat-factory/agents`): registered via the public
    `registerAgentKind` seam (the `security-auditor` shape) with a lenient valibot
    `bugInvestigation` schema — `clarity` (`clear` | `needs_clarification`), `summary`, ranked
    `rootCauseHypotheses`, `affectedRepos`, `suggestedReproductions`, and `questions`
    (non-empty only when clarification is needed). Its structured object lands on `step.custom`
    (rendered by the stock `generic-structured` view); a built-in post-completion resolver renders
    a prose digest onto `step.output` so downstream steps read the investigation via `priorOutputs`.
    The old prose ROLE entry is removed.
  - **Read-only multi-repo checkouts** (`@cat-factory/server` + `@cat-factory/executor-harness`,
    image bump): the multi-repo fan-out gate now also fires for `bug-investigator`, and the
    container-explore job body threads `peerRepos` + the multi-repo prompt section. The harness
    gains a read-only `runMultiRepoExplore` path — it clones the primary repo PLUS every connected
    involved-service repo as SIBLING checkouts, runs the agent once at the workspace root, and
    makes NO edits / commits / PR (a read-only peer carries no `newBranch`/`pr`) — so a
    cross-service bug is traced across every repo it touches. `PeerRepoSpec.newBranch` is now
    optional (present for the coding fan-out, absent for the read-only one).
  - **Clarity gate seeding + auto-pass** (`@cat-factory/orchestration`): when a structured
    investigator ran upstream, the `clarity-review` gate seeds DETERMINISTICALLY from its triage —
    no reviewer LLM — auto-passing on `clarity === 'clear'` (advance, no human park, no
    notification) and seeding one blocking finding per `question` on `needs_clarification` (park
    for a human, exactly as an LLM reviewer pass would). Because the seed needs no model, the gate
    now activates whenever the clarity store is wired, and the review/incorporate/re-review LLM
    paths degrade gracefully when unwired. Mirrors the requirements-review auto-pass pattern.
  - **Tracker echo on park** (`@cat-factory/kernel` port + `@cat-factory/integrations`): a new
    best-effort `IssueWritebackProvider.postQuestions` echoes the open questions as a comment on
    the block's linked tracker issue when the gate parks — answers still arrive in-app (the tracker
    comment is an echo, not a channel). Not gated on the workspace writeback settings, and a
    tracker outage never fails the run.
  - **Conformance**: a two-facade suite drives the investigator → clarity gate flow — `clear`
    auto-passes straight through to the next step with the digest recorded, and
    `needs_clarification` parks one finding per question then resumes on dismiss-all + proceed.

  The runner image is bumped for the read-only multi-repo explore path; the three hand-maintained
  image-tag pins are synced.

- c20a69a: feat(initiatives): slice 4 — follow-ups & polish

  Complete the Initiatives feature: a settling spawned-task run's forward-looking
  follow-ups (and, on failure, its real cause) are harvested onto the initiative
  tracker at the terminal emit; a human promotes an open follow-up into a new
  `pending` tracker item or dismisses it, retries/skips/re-scopes items, and retunes
  the execution policy — all over the existing rev-CAS single-writer path. No new
  persistence or facade wiring: the curation state rides the initiative `doc` blob
  (D1 ⇄ Drizzle parity unchanged), and the harvest reuses the in-hand run instance
  so it costs no extra read.

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
  - @cat-factory/agents@0.34.0
  - @cat-factory/sandbox@0.9.0
  - @cat-factory/prompt-fragments@0.10.1
  - @cat-factory/spend@0.10.93
  - @cat-factory/workspaces@0.11.11
  - @cat-factory/caching@0.4.1

## 0.70.1

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
  - @cat-factory/integrations@0.64.0
  - @cat-factory/agents@0.33.1
  - @cat-factory/sandbox@0.8.104
  - @cat-factory/spend@0.10.92
  - @cat-factory/workspaces@0.11.10

## 0.70.0

### Minor Changes

- 8eaa3f2: Universal writing-style fragments for document-authoring tasks (WS2 of the
  documentation-type task initiative). Two built-in fragments — `style.anti-llmisms`
  (cut the machine-written tells: filler intensifiers, hedging, throat-clearing,
  summary-that-restates, bullet inflation) and `style.concise-actionable` (lead with
  the point, active voice, one idea per paragraph, every recommendation names an actor
  and an action) — now guide the document-authoring agents.

  They reach those agents through a new `doc-aware` capability trait, the document
  analogue of `code-aware`: the `doc-researcher` / `doc-outliner` / `doc-writer` /
  `doc-finalizer` kinds carry it on their definitions and the `doc-reviewer` companion
  carries it too, so the execution engine folds the block's selected style fragments
  into each one's system prompt via the same `AgentContextBuilder` path `code-aware`
  uses — no parallel fragment path in the prompt builders. Because the reviewer sees
  the same bodies, the style guidance is both the writer's instruction and the
  reviewer's criteria (an explicit clause in the companion prompt says so).

  A new document task is pre-seeded with both style fragments (default-on,
  user-removable like any block pin) via `DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS`, seeded
  onto the task's `fragmentIds` in `BoardService.addTask` — the selection default lives
  at task creation, not hard-coded in a prompt.

  The fragment "add" pickers (service, task, and workspace-default) now render their
  options as labelled per-category sections instead of one flat list, so the catalog
  stays navigable now that a block can pin across two tracks at once — the technical
  collections (Node / React / …) and the Writing-style fragments.

### Patch Changes

- Updated dependencies [8eaa3f2]
  - @cat-factory/prompt-fragments@0.10.0
  - @cat-factory/agents@0.33.0
  - @cat-factory/sandbox@0.8.103

## 0.69.1

### Patch Changes

- e5ddaa4: Cache document-backed prompt-fragment bodies through the app caching seam
  (caching-layer initiative, slice 2). A new `AppCaches.fragmentDocumentBody`
  group cache serves a living fragment's external Confluence/Notion/GitHub/Figma/
  Zeplin/Linear body, replacing the hand-rolled `DEFAULT_DOCUMENT_FRAGMENT_TTL_MS`
  in `FragmentLibraryService`: a run reads the cached body instead of blocking on a
  live page fetch, and an entry entering its refresh window runs the source's cheap
  version probe — keeping the cached body when the page hasn't moved, reloading in
  the background when it has.

  To support the probe, `DocumentContent` now carries an opaque `version` token and
  `DocumentSourceProvider`/`DocumentContentResolver` gain a `probeVersion` method
  (metadata-only, strictly cheaper than a full fetch), implemented across all
  document providers. The self-verifying cache stays enabled on the Cloudflare
  Worker (bounded staleness via the probe), unlike the mutable-state fragment
  catalog.

  Behavior change (pre-1.0, no back-compat): the durable `prompt_fragments.body` is
  now the offline fallback + management-view content, refreshed only by an explicit
  create/refresh; the live run-time body flows through the cache. Without a cache
  wired, a run serves the persisted body and does not re-resolve live.

- Updated dependencies [e5ddaa4]
- Updated dependencies [6213771]
  - @cat-factory/caching@0.3.0
  - @cat-factory/kernel@0.84.0
  - @cat-factory/integrations@0.63.0
  - @cat-factory/agents@0.32.0
  - @cat-factory/sandbox@0.8.102
  - @cat-factory/spend@0.10.91
  - @cat-factory/workspaces@0.11.9

## 0.69.0

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
  - @cat-factory/integrations@0.62.1
  - @cat-factory/sandbox@0.8.101
  - @cat-factory/spend@0.10.90
  - @cat-factory/workspaces@0.11.8

## 0.68.1

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0
  - @cat-factory/kernel@0.82.0
  - @cat-factory/integrations@0.62.0
  - @cat-factory/agents@0.30.5
  - @cat-factory/prompt-fragments@0.9.55
  - @cat-factory/sandbox@0.8.100
  - @cat-factory/spend@0.10.89
  - @cat-factory/workspaces@0.11.7

## 0.68.0

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
  - @cat-factory/agents@0.30.4
  - @cat-factory/prompt-fragments@0.9.54
  - @cat-factory/sandbox@0.8.99
  - @cat-factory/spend@0.10.88
  - @cat-factory/workspaces@0.11.6

## 0.67.0

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
  - @cat-factory/agents@0.30.3
  - @cat-factory/integrations@0.60.2
  - @cat-factory/prompt-fragments@0.9.53
  - @cat-factory/sandbox@0.8.98
  - @cat-factory/spend@0.10.87
  - @cat-factory/workspaces@0.11.5

## 0.66.0

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
  - @cat-factory/agents@0.30.2
  - @cat-factory/integrations@0.60.1
  - @cat-factory/kernel@0.79.1
  - @cat-factory/prompt-fragments@0.9.52
  - @cat-factory/sandbox@0.8.97
  - @cat-factory/spend@0.10.86
  - @cat-factory/workspaces@0.11.4

## 0.65.0

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
  - @cat-factory/agents@0.30.1
  - @cat-factory/prompt-fragments@0.9.51
  - @cat-factory/sandbox@0.8.96
  - @cat-factory/spend@0.10.85
  - @cat-factory/workspaces@0.11.3

## 0.64.0

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
  - @cat-factory/contracts@0.90.0
  - @cat-factory/kernel@0.78.0
  - @cat-factory/integrations@0.59.0
  - @cat-factory/agents@0.30.0
  - @cat-factory/prompt-fragments@0.9.50
  - @cat-factory/sandbox@0.8.95
  - @cat-factory/spend@0.10.84
  - @cat-factory/workspaces@0.11.2

## 0.63.0

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

### Patch Changes

- Updated dependencies [7fa7578]
  - @cat-factory/contracts@0.89.0
  - @cat-factory/kernel@0.77.0
  - @cat-factory/agents@0.29.1
  - @cat-factory/integrations@0.58.1
  - @cat-factory/prompt-fragments@0.9.49
  - @cat-factory/sandbox@0.8.94
  - @cat-factory/spend@0.10.83
  - @cat-factory/workspaces@0.11.1

## 0.62.0

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
  - @cat-factory/workspaces@0.11.0
  - @cat-factory/prompt-fragments@0.9.48
  - @cat-factory/sandbox@0.8.93
  - @cat-factory/spend@0.10.82

## 0.61.0

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
  - @cat-factory/integrations@0.57.2
  - @cat-factory/prompt-fragments@0.9.47
  - @cat-factory/sandbox@0.8.92
  - @cat-factory/spend@0.10.81
  - @cat-factory/workspaces@0.10.28

## 0.60.4

### Patch Changes

- cc924a9: Requirements-review recommendations: batch, tighten, and surface what's awaited.

  - The Requirement Writer now answers findings in CHUNKS (up to 4 per LLM call) instead of one
    call per finding, so a batch of N findings costs `ceil(N / 4)` calls rather than N. Shared
    grounding is still gathered once and progress still streams `ready / total` a chunk at a time;
    a failure is isolated to its chunk. Each finding keeps the same per-finding output budget the
    single-call path used (scaled by chunk size), and a batched response is routed back to its
    findings by the echoed itemId with a prompt-order fallback — so a response that drops the ids
    isn't discarded wholesale and the whole chunk force-reopened.
  - The Writer prompt (`requirement-writer`, bumped to v2) now asks for precise, succinct
    recommendations — the concrete answer in a couple of sentences, cite sources briefly, no
    preamble or padding — instead of open-ended prose.
  - The review window now shows a persistent "awaited recommendations" summary (how many the
    Writer is still generating and how many are waiting on the human) in the stats rail, and lets
    you request recommendations while a merged review is being reworked — not only in the initial
    `ready` state.
  - The incorporated-requirements document can now be collapsed as a whole. It defaults to collapsed
    only in the pre-incorporation `ready` phase (so a long doc doesn't push the findings being worked
    through off-screen) and expanded in `merged`/`incorporated`, where the document itself is the
    thing to read; a manual collapse no longer leaks across a status change.

- Updated dependencies [cc924a9]
  - @cat-factory/agents@0.27.1
  - @cat-factory/sandbox@0.8.91

## 0.60.3

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0
  - @cat-factory/contracts@0.86.0
  - @cat-factory/agents@0.27.0
  - @cat-factory/integrations@0.57.1
  - @cat-factory/sandbox@0.8.90
  - @cat-factory/spend@0.10.80
  - @cat-factory/workspaces@0.10.27
  - @cat-factory/prompt-fragments@0.9.46

## 0.60.2

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0
  - @cat-factory/integrations@0.57.0
  - @cat-factory/agents@0.26.18
  - @cat-factory/sandbox@0.8.89
  - @cat-factory/spend@0.10.79
  - @cat-factory/workspaces@0.10.26

## 0.60.1

### Patch Changes

- 0ac0dc4: Surface per-iteration fixing instructions in polling-gate run details. A `ci` /
  `conflicts` gate's helper attempt now records the instructions it was handed (the
  failing-check summary + structured red checks for CI, the conflict/review detail for the
  others) alongside the helper's own report, so the gate window shows WHAT each round set out
  to fix — bringing the gate attempt timeline to parity with the Tester's fixer timeline
  (`concerns` + `summary`). Adds `instructions` / `failingChecks` to `gateAttemptSchema` and a
  transient `lastDispatchedInstructions` stash on `gateStepStateSchema` (schemaless step JSON,
  no migration).
- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0
  - @cat-factory/kernel@0.72.0
  - @cat-factory/agents@0.26.17
  - @cat-factory/integrations@0.56.5
  - @cat-factory/prompt-fragments@0.9.45
  - @cat-factory/sandbox@0.8.88
  - @cat-factory/spend@0.10.78
  - @cat-factory/workspaces@0.10.25

## 0.60.0

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

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0
  - @cat-factory/kernel@0.71.0
  - @cat-factory/agents@0.26.16
  - @cat-factory/integrations@0.56.4
  - @cat-factory/prompt-fragments@0.9.44
  - @cat-factory/sandbox@0.8.87
  - @cat-factory/spend@0.10.77
  - @cat-factory/workspaces@0.10.24

## 0.59.2

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
  - @cat-factory/agents@0.26.15
  - @cat-factory/integrations@0.56.3
  - @cat-factory/prompt-fragments@0.9.43
  - @cat-factory/sandbox@0.8.86
  - @cat-factory/spend@0.10.76
  - @cat-factory/workspaces@0.10.23

## 0.59.1

### Patch Changes

- 0d51638: Secret-handling hardening:

  - **LLM telemetry** (`LlmObservabilityService`) now scrubs credential shapes from the
    prompt/response/reasoning bodies AND the `errorMessage` with a shared `redactSecrets`
    (promoted to `@cat-factory/kernel`, reused by the provisioning-log path) BEFORE anything is
    stored or fanned out to an external trace sink (Langfuse). `errorMessage` is kept as
    diagnostic metadata even when bodies are dropped and is fanned out ungated, so it is
    scrubbed too (an upstream 4xx/5xx string can echo an auth header). Prompt/response/reasoning
    body capture is additionally gated on the per-workspace `storeAgentContext` toggle (numeric
    telemetry is always recorded). Also fixed a latent O(n²) regex backtrack in the URL-userinfo
    redaction rule that a large prompt could trigger.
  - **Signed tokens** (`HmacSigner`) now derive an independent HKDF-SHA256 subkey per audience
    (`session`/`oauth-state`/`llm-proxy`/`ws`/`machine`), so a token class is cryptographically
    isolated rather than sharing one raw HMAC key. Key derivation is bounded to that fixed
    audience set — `verify` selects the key from the token's attacker-controlled claimed `aud`
    before the MAC check, so an unrecognised (or absent) audience falls back to the raw-secret
    base key rather than deriving+caching a fresh subkey, preventing an unbounded key-cache /
    per-request-HKDF DoS from a flood of junk-audience tokens. Breaking: any tokens signed before
    this change no longer verify (pre-1.0, no migration — clients re-authenticate).

- Updated dependencies [0d51638]
- Updated dependencies [0d51638]
  - @cat-factory/integrations@0.56.2
  - @cat-factory/kernel@0.70.1
  - @cat-factory/agents@0.26.14
  - @cat-factory/sandbox@0.8.85
  - @cat-factory/spend@0.10.75
  - @cat-factory/workspaces@0.10.22

## 0.59.0

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
  - @cat-factory/agents@0.26.13
  - @cat-factory/integrations@0.56.1
  - @cat-factory/sandbox@0.8.84
  - @cat-factory/spend@0.10.74
  - @cat-factory/workspaces@0.10.21

## 0.58.1

### Patch Changes

- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0
  - @cat-factory/integrations@0.56.0
  - @cat-factory/agents@0.26.12
  - @cat-factory/kernel@0.69.8
  - @cat-factory/prompt-fragments@0.9.42
  - @cat-factory/sandbox@0.8.83
  - @cat-factory/spend@0.10.73
  - @cat-factory/workspaces@0.10.20

## 0.58.0

### Minor Changes

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

- Updated dependencies [7f9d215]
- Updated dependencies [05d1b08]
  - @cat-factory/kernel@0.69.7
  - @cat-factory/integrations@0.55.0
  - @cat-factory/agents@0.26.11
  - @cat-factory/sandbox@0.8.82
  - @cat-factory/spend@0.10.72
  - @cat-factory/workspaces@0.10.19

## 0.57.7

### Patch Changes

- 4955639: Fix five bugs in how best-practice prompt fragments are managed and applied:

  - **Code-aware helper agents now receive the service fragments.** `ci-fixer`, `fixer`
    and `on-call` are dispatched off their HOSTING step (a `ci`/`post-release-health`
    gate, the tester, the human-test/visual-confirmation loops), and the fragment fold
    keyed off that step's kind — so the helpers never received the service's standards
    despite being marked `code-aware`. `AgentContextBuilder.buildContext` now takes an
    explicit `agentKind` override and every helper dispatch passes it; the on-call job
    body additionally folds the resolved fragments into its bespoke system prompt
    (previously bypassed). A stale `step.selectedFragmentIds` is also cleared when a
    re-dispatch resolves to nothing, so observability can't over-report.
  - **Tier tombstones now stick on the run path.** `resolveBodiesForRun` used to fall
    back to the static pool for any id missing from the merged catalog — which is
    exactly what a tombstone does to a built-in, so suppressing a fragment a service
    had selected silently resurrected it. The fallback is gone; a missing id is dropped.
  - **Deployment-registered fragments join the tenant catalog.** The library's built-in
    tier now reads the UNIVERSAL pool (shipped catalog + `registerPromptFragment`
    entries, lazily) instead of the raw shipped array, so a registered override of a
    built-in id actually reaches runs and the resolved catalog, and registered
    fragments can be tier-shadowed/tombstoned like any built-in.
  - **Repo-source resync no longer mishandles renames and id edits.** The tombstone
    sweep is keyed by the fragment ids the current tree produces, not by stale paths:
    renaming a file that pins an explicit frontmatter `id` no longer tombstones the
    fragment the rename just updated, and changing a file's explicit `id` in place now
    retires the old id instead of leaving a live duplicate forever. The GitHub
    installation is also resolved once per sync instead of once per file, and the
    requirement writer's fragment grounding resolves through the merged tenant catalog
    when the library is wired.
  - **The SPA pickers now offer the merged catalog.** The per-service / per-block /
    workspace-default fragment pickers loaded only the static built-in pool, so
    managed, repo-sourced and document-backed fragments could be authored but never
    attached (and a managed id set via API rendered no chip). The fragments store now
    loads the workspace's resolved catalog (falling back to the static pool when the
    library is off), invalidates on library edits, and unknown selected ids render as
    removable chips instead of disappearing. The catalog is per-board, so a workspace
    switch now invalidates it and the task inspector reloads it on mount — otherwise the
    task picker kept showing the previous board's fragments.

  Review follow-ups: `AgentContextBuilder` now clears a stale `step.selectedFragmentIds`
  on the non-code-aware and error paths too (not only when a code-aware resolve is empty);
  the requirement-writer grounding resolves the merged catalog once (reused for titles and
  bodies) instead of twice; a repo-source RENAME of an explicit-id file inherits the
  fragment's `version`/`createdAt` by id instead of resetting them; and the source `status`
  count no longer double-counts a pure rename.

- Updated dependencies [4955639]
  - @cat-factory/agents@0.26.10
  - @cat-factory/sandbox@0.8.81

## 0.57.6

### Patch Changes

- 4a7a3f1: Preserve a task run's error trail across retries. A failed run's `failure` is now
  appended to a new `failureHistory` on the fresh attempt (persisted in the shared
  `agent_runs.detail`, so both runtimes get it with no migration), and cleared on the
  running attempt — so the top failure banner disappears the moment the task restarts
  while every previous error stays viewable in a "previous errors" history on the task
  inspector. Applies to both retry (resume-from-failure) and restart-from-step.
- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3
  - @cat-factory/agents@0.26.9
  - @cat-factory/integrations@0.54.3
  - @cat-factory/kernel@0.69.6
  - @cat-factory/prompt-fragments@0.9.41
  - @cat-factory/sandbox@0.8.80
  - @cat-factory/spend@0.10.71
  - @cat-factory/workspaces@0.10.18

## 0.57.5

### Patch Changes

- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2
  - @cat-factory/integrations@0.54.2
  - @cat-factory/agents@0.26.8
  - @cat-factory/kernel@0.69.5
  - @cat-factory/prompt-fragments@0.9.40
  - @cat-factory/sandbox@0.8.79
  - @cat-factory/spend@0.10.70
  - @cat-factory/workspaces@0.10.17

## 0.57.4

### Patch Changes

- Updated dependencies [fc8df61]
  - @cat-factory/agents@0.26.7
  - @cat-factory/sandbox@0.8.78

## 0.57.3

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

- Updated dependencies [2a91615]
  - @cat-factory/contracts@0.81.1
  - @cat-factory/integrations@0.54.1
  - @cat-factory/agents@0.26.6
  - @cat-factory/kernel@0.69.4
  - @cat-factory/prompt-fragments@0.9.39
  - @cat-factory/sandbox@0.8.77
  - @cat-factory/spend@0.10.69
  - @cat-factory/workspaces@0.10.16

## 0.57.2

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0
  - @cat-factory/integrations@0.54.0
  - @cat-factory/agents@0.26.5
  - @cat-factory/kernel@0.69.3
  - @cat-factory/prompt-fragments@0.9.38
  - @cat-factory/sandbox@0.8.76
  - @cat-factory/spend@0.10.68
  - @cat-factory/workspaces@0.10.15

## 0.57.1

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
  - @cat-factory/contracts@0.80.1
  - @cat-factory/integrations@0.53.2
  - @cat-factory/agents@0.26.4
  - @cat-factory/sandbox@0.8.75
  - @cat-factory/spend@0.10.67
  - @cat-factory/workspaces@0.10.14
  - @cat-factory/prompt-fragments@0.9.37

## 0.57.0

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

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0
  - @cat-factory/kernel@0.69.1
  - @cat-factory/agents@0.26.3
  - @cat-factory/integrations@0.53.1
  - @cat-factory/prompt-fragments@0.9.36
  - @cat-factory/sandbox@0.8.74
  - @cat-factory/spend@0.10.66
  - @cat-factory/workspaces@0.10.13

## 0.56.0

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
  - @cat-factory/integrations@0.53.0
  - @cat-factory/contracts@0.79.0
  - @cat-factory/kernel@0.69.0
  - @cat-factory/agents@0.26.2
  - @cat-factory/prompt-fragments@0.9.35
  - @cat-factory/sandbox@0.8.73
  - @cat-factory/spend@0.10.65
  - @cat-factory/workspaces@0.10.12

## 0.55.1

### Patch Changes

- 16ee6cc: Refactor: the Kaizen grader now resolves its model through the SAME shared inline
  model-resolution seam every other inline agent uses (`resolveInlineModelRef`) instead of a
  hand-rolled copy of the precedence in `KaizenService.modelFor`. The bespoke copy was
  behaviourally equivalent but a divergent code path that could drift and silently degrade a
  subscription preset (e.g. a "Claude for everything" preset) to the env routing default (e.g.
  `qwen`) — the same class of drift the `assertRunnable` de-duplication addressed for
  start/retry/restart. Routing it through the one shared helper keeps kaizen identical to the
  requirements reviewer et al. (block pin > workspace per-kind default > routing default, keeping
  an ambient-eligible subscription harness ref rather than degrading it) and prevents future
  drift. Adds `KaizenService.model.test.ts` pinning that precedence and the keep-vs-degrade
  behaviour so the qwen-degrade scenario is now a regression test.
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

- Updated dependencies [16ee6cc]
  - @cat-factory/contracts@0.78.1
  - @cat-factory/kernel@0.68.1
  - @cat-factory/agents@0.26.1
  - @cat-factory/integrations@0.52.2
  - @cat-factory/prompt-fragments@0.9.34
  - @cat-factory/sandbox@0.8.72
  - @cat-factory/spend@0.10.64
  - @cat-factory/workspaces@0.10.11

## 0.55.0

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
  - @cat-factory/integrations@0.52.1
  - @cat-factory/prompt-fragments@0.9.33
  - @cat-factory/sandbox@0.8.71
  - @cat-factory/spend@0.10.63
  - @cat-factory/workspaces@0.10.10

## 0.54.1

### Patch Changes

- 08be94c: Fix: a task **retry** and **restart-from-step** now run the same config/resource preconditions
  as a fresh **start**, so a re-drive can no longer silently proceed on a configuration a start
  would refuse.

  `ExecutionService.start`, `.retry` and `.restartFromStep` previously each hand-rolled their
  guard sequence, and retry/restart were missing the provider/preset satisfiability check (plus
  pipeline-shape, frame-type, tester-infra and agent-backend). So retrying a task whose model
  preset can't run every step — e.g. a subscription-only model an inline step (the requirements
  reviewer) can't run without an inline harness — skipped the guard and failed mid-run against the
  routing default (the confusing "requirements reviewer (qwen:qwen3-max) failed"), instead of the
  clear `preset_unsatisfiable` / `providers_unconfigured` refusal a fresh start gives.

  The shared preconditions are extracted into one `assertRunnable` method all three entry points
  call, so they can't drift again. A retry/restart validates them over the STORED steps it
  re-drives (not the current pipeline definition, which may have been edited out of band since the
  run started), so the gate reflects exactly what re-executes and a deleted pipeline needs no
  special case. The concurrency (task-limit) and dependency gates stay start-only by design (a
  retry replaces the failed run rather than adding a new concurrent one).

## 0.54.0

### Minor Changes

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

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [ab7d589]
- Updated dependencies [6c51e31]
- Updated dependencies [33687cf]
  - @cat-factory/contracts@0.77.0
  - @cat-factory/kernel@0.67.0
  - @cat-factory/integrations@0.52.0
  - @cat-factory/agents@0.25.0
  - @cat-factory/prompt-fragments@0.9.32
  - @cat-factory/sandbox@0.8.70
  - @cat-factory/spend@0.10.62
  - @cat-factory/workspaces@0.10.9

## 0.53.2

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0
  - @cat-factory/agents@0.24.16
  - @cat-factory/integrations@0.51.4
  - @cat-factory/kernel@0.66.1
  - @cat-factory/prompt-fragments@0.9.31
  - @cat-factory/sandbox@0.8.69
  - @cat-factory/spend@0.10.61
  - @cat-factory/workspaces@0.10.8

## 0.53.1

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
  - @cat-factory/agents@0.24.15
  - @cat-factory/integrations@0.51.3
  - @cat-factory/sandbox@0.8.68
  - @cat-factory/spend@0.10.60
  - @cat-factory/workspaces@0.10.7
  - @cat-factory/prompt-fragments@0.9.30

## 0.53.0

### Minor Changes

- 6f95aff: Add a repository-type selector to repo import and bootstrap. A frame can now be onboarded as
  a backend service, a frontend app, a shared library, or a document repository. Document
  repositories accept only document/spike tasks (enforced in `BoardService.addTask` and the
  create-task form). New `library`/`document` block types, `frameRepoTypeSchema`/`FRAME_REPO_TYPES`
  in contracts, and display metadata for the new types.

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0
  - @cat-factory/kernel@0.65.0
  - @cat-factory/agents@0.24.14
  - @cat-factory/integrations@0.51.2
  - @cat-factory/prompt-fragments@0.9.29
  - @cat-factory/sandbox@0.8.67
  - @cat-factory/spend@0.10.59
  - @cat-factory/workspaces@0.10.6

## 0.52.1

### Patch Changes

- Updated dependencies [d4d4cbc]
  - @cat-factory/integrations@0.51.1

## 0.52.0

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
  - @cat-factory/agents@0.24.13
  - @cat-factory/prompt-fragments@0.9.28
  - @cat-factory/sandbox@0.8.66
  - @cat-factory/spend@0.10.58
  - @cat-factory/workspaces@0.10.5

## 0.51.7

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0
  - @cat-factory/agents@0.24.12
  - @cat-factory/integrations@0.50.2
  - @cat-factory/kernel@0.63.4
  - @cat-factory/prompt-fragments@0.9.27
  - @cat-factory/sandbox@0.8.65
  - @cat-factory/spend@0.10.57
  - @cat-factory/workspaces@0.10.4

## 0.51.6

### Patch Changes

- Updated dependencies [b744822]
- Updated dependencies [c40736e]
  - @cat-factory/integrations@0.50.1

## 0.51.5

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0
  - @cat-factory/integrations@0.50.0
  - @cat-factory/agents@0.24.11
  - @cat-factory/kernel@0.63.3
  - @cat-factory/prompt-fragments@0.9.26
  - @cat-factory/sandbox@0.8.64
  - @cat-factory/spend@0.10.56
  - @cat-factory/workspaces@0.10.3

## 0.51.4

### Patch Changes

- Updated dependencies [79a0f48]
  - @cat-factory/integrations@0.49.0

## 0.51.3

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1
  - @cat-factory/kernel@0.63.2
  - @cat-factory/integrations@0.48.2
  - @cat-factory/agents@0.24.10
  - @cat-factory/prompt-fragments@0.9.25
  - @cat-factory/sandbox@0.8.63
  - @cat-factory/spend@0.10.55
  - @cat-factory/workspaces@0.10.2

## 0.51.2

### Patch Changes

- Updated dependencies [66a8c71]
  - @cat-factory/integrations@0.48.1

## 0.51.1

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0
  - @cat-factory/integrations@0.48.0
  - @cat-factory/agents@0.24.9
  - @cat-factory/kernel@0.63.1
  - @cat-factory/prompt-fragments@0.9.24
  - @cat-factory/sandbox@0.8.62
  - @cat-factory/spend@0.10.54
  - @cat-factory/workspaces@0.10.1

## 0.51.0

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
  - @cat-factory/workspaces@0.10.0
  - @cat-factory/agents@0.24.8
  - @cat-factory/integrations@0.47.1
  - @cat-factory/sandbox@0.8.61
  - @cat-factory/spend@0.10.53
  - @cat-factory/prompt-fragments@0.9.23

## 0.50.1

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0
  - @cat-factory/integrations@0.47.0
  - @cat-factory/agents@0.24.7
  - @cat-factory/kernel@0.62.4
  - @cat-factory/prompt-fragments@0.9.22
  - @cat-factory/sandbox@0.8.60
  - @cat-factory/spend@0.10.52
  - @cat-factory/workspaces@0.9.43

## 0.50.0

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
  - @cat-factory/agents@0.24.6
  - @cat-factory/kernel@0.62.3
  - @cat-factory/prompt-fragments@0.9.21
  - @cat-factory/sandbox@0.8.59
  - @cat-factory/spend@0.10.51
  - @cat-factory/workspaces@0.9.42

## 0.49.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1
  - @cat-factory/integrations@0.45.0
  - @cat-factory/agents@0.24.5
  - @cat-factory/kernel@0.62.2
  - @cat-factory/prompt-fragments@0.9.20
  - @cat-factory/sandbox@0.8.58
  - @cat-factory/spend@0.10.50
  - @cat-factory/workspaces@0.9.41

## 0.48.2

### Patch Changes

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

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0
  - @cat-factory/agents@0.24.4
  - @cat-factory/integrations@0.44.1
  - @cat-factory/kernel@0.62.1
  - @cat-factory/prompt-fragments@0.9.19
  - @cat-factory/sandbox@0.8.57
  - @cat-factory/spend@0.10.49
  - @cat-factory/workspaces@0.9.40

## 0.48.1

### Patch Changes

- f9678df: Mothership Phase 3 review fixes:

  - `ExecutionService.start` now clears a replaced block's prior per-run subscription activation
    best-effort (try/catch), mirroring the terminal cleanup in `RunStateMachine.emit`. In mothership
    mode `subscriptionActivationRepository` is remote and `deleteByExecution` is not yet allow-listed
    (it throws `unknown_method`), so the previously-unguarded call would break re-running any block;
    the TTL sweep reclaims the stale row as the backstop.
  - The persistence RPC controller memoises the `block` / `serviceList` scope reads
    (`blockRepository.findById` / `serviceRepository.listByIds`) per request, so when the request
    also dispatches that same read it reuses the resolver's result instead of issuing a second
    identical query.

- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/contracts@0.65.0
  - @cat-factory/kernel@0.62.0
  - @cat-factory/integrations@0.44.0
  - @cat-factory/agents@0.24.3
  - @cat-factory/prompt-fragments@0.9.18
  - @cat-factory/sandbox@0.8.56
  - @cat-factory/spend@0.10.48
  - @cat-factory/workspaces@0.9.39

## 0.48.0

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
  - @cat-factory/agents@0.24.2
  - @cat-factory/kernel@0.61.1
  - @cat-factory/prompt-fragments@0.9.17
  - @cat-factory/sandbox@0.8.55
  - @cat-factory/spend@0.10.47
  - @cat-factory/workspaces@0.9.38

## 0.47.1

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/contracts@0.63.0
  - @cat-factory/kernel@0.61.0
  - @cat-factory/agents@0.24.1
  - @cat-factory/integrations@0.42.1
  - @cat-factory/prompt-fragments@0.9.16
  - @cat-factory/sandbox@0.8.54
  - @cat-factory/spend@0.10.46
  - @cat-factory/workspaces@0.9.37

## 0.47.0

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
  - @cat-factory/integrations@0.42.0
  - @cat-factory/sandbox@0.8.53
  - @cat-factory/spend@0.10.45
  - @cat-factory/workspaces@0.9.36
  - @cat-factory/prompt-fragments@0.9.15

## 0.46.1

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/contracts@0.61.0
  - @cat-factory/agents@0.23.4
  - @cat-factory/integrations@0.41.1
  - @cat-factory/sandbox@0.8.52
  - @cat-factory/spend@0.10.44
  - @cat-factory/workspaces@0.9.35
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
  - @cat-factory/agents@0.23.3
  - @cat-factory/sandbox@0.8.51
  - @cat-factory/spend@0.10.43
  - @cat-factory/workspaces@0.9.34
  - @cat-factory/prompt-fragments@0.9.13

## 0.45.3

### Patch Changes

- 6009266: Refresh dependencies to their latest release-age-compliant versions: the Vercel AI
  SDK family within its `workers-ai-provider`-compatible majors (`ai` 6.0.214,
  `@ai-sdk/anthropic` 3.0.89, `@ai-sdk/openai` 3.0.77, `@ai-sdk/openai-compatible`
  2.0.54, `@ai-sdk/amazon-bedrock` 4.0.124), `drizzle-orm`/`drizzle-kit` 1.0.0-rc.4,
  and `yaml` 2.9.0, plus refreshed transitive resolutions.
- Updated dependencies [6009266]
  - @cat-factory/agents@0.23.2
  - @cat-factory/integrations@0.40.1
  - @cat-factory/kernel@0.57.1
  - @cat-factory/sandbox@0.8.50
  - @cat-factory/spend@0.10.42
  - @cat-factory/workspaces@0.9.33

## 0.45.2

### Patch Changes

- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/contracts@0.59.0
  - @cat-factory/kernel@0.57.0
  - @cat-factory/integrations@0.40.0
  - @cat-factory/agents@0.23.1
  - @cat-factory/prompt-fragments@0.9.12
  - @cat-factory/sandbox@0.8.49
  - @cat-factory/spend@0.10.41
  - @cat-factory/workspaces@0.9.32

## 0.45.1

### Patch Changes

- Updated dependencies [2ac148d]
  - @cat-factory/integrations@0.39.0

## 0.45.0

### Minor Changes

- 5fd0ffa: Refuse to start a pipeline that includes an agent relying on binary-artifact storage when the workspace's account has none configured.

  The requirement is modelled as a new `binary-storage` agent trait (carried today by the UI Tester, which uploads its screenshots), so the system is universal: a future artifact-producing agent just declares the trait instead of the engine hard-coding it. `ExecutionService` enforces it on start/retry/restart and throws a `binary_storage_unconfigured` conflict, which the SPA surfaces as an error prompt with a "Configure storage" jump to the content-storage settings.

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/contracts@0.58.0
  - @cat-factory/agents@0.23.0
  - @cat-factory/integrations@0.38.1
  - @cat-factory/kernel@0.56.1
  - @cat-factory/prompt-fragments@0.9.11
  - @cat-factory/sandbox@0.8.48
  - @cat-factory/spend@0.10.40
  - @cat-factory/workspaces@0.9.31

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
  - @cat-factory/integrations@0.38.0
  - @cat-factory/agents@0.22.6
  - @cat-factory/prompt-fragments@0.9.10
  - @cat-factory/sandbox@0.8.47
  - @cat-factory/spend@0.10.39
  - @cat-factory/workspaces@0.9.30

## 0.43.4

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
  - @cat-factory/integrations@0.37.1
  - @cat-factory/workspaces@0.9.29
  - @cat-factory/agents@0.22.5
  - @cat-factory/sandbox@0.8.46
  - @cat-factory/spend@0.10.38

## 0.43.3

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
  - @cat-factory/contracts@0.56.1
  - @cat-factory/agents@0.22.4
  - @cat-factory/kernel@0.55.3
  - @cat-factory/prompt-fragments@0.9.9
  - @cat-factory/sandbox@0.8.45
  - @cat-factory/spend@0.10.37
  - @cat-factory/workspaces@0.9.28

## 0.43.2

### Patch Changes

- Updated dependencies [ad5d3e0]
  - @cat-factory/contracts@0.56.0
  - @cat-factory/agents@0.22.3
  - @cat-factory/integrations@0.36.1
  - @cat-factory/kernel@0.55.2
  - @cat-factory/prompt-fragments@0.9.8
  - @cat-factory/sandbox@0.8.44
  - @cat-factory/spend@0.10.36
  - @cat-factory/workspaces@0.9.27

## 0.43.1

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/contracts@0.55.0
  - @cat-factory/integrations@0.36.0
  - @cat-factory/agents@0.22.2
  - @cat-factory/kernel@0.55.1
  - @cat-factory/prompt-fragments@0.9.7
  - @cat-factory/sandbox@0.8.43
  - @cat-factory/spend@0.10.35
  - @cat-factory/workspaces@0.9.26

## 0.43.0

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

### Patch Changes

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0
  - @cat-factory/contracts@0.54.0
  - @cat-factory/agents@0.22.1
  - @cat-factory/integrations@0.35.4
  - @cat-factory/sandbox@0.8.42
  - @cat-factory/spend@0.10.34
  - @cat-factory/workspaces@0.9.25
  - @cat-factory/prompt-fragments@0.9.6

## 0.42.1

### Patch Changes

- b76f303: Trim the `ExecutionService` constructor of its last two vestigial fields (the final Phase 6
  cleanup of the engine split): `resolveRunRepoContext` (stored but never read — `RunDispatcher`
  already takes it from the constructor param) and `runInitiatorScope` (read only to build
  `RunDispatcher`, now a constructor-local). No behaviour change; the public
  `ExecutionServiceDependencies` shape is unchanged.

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
