# @cat-factory/contracts

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
