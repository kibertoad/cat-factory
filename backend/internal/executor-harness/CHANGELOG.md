# @cat-factory/executor-harness

## 1.8.0

### Minor Changes

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

- b305349: Raise the harness output ceiling and guard against malformed final answers.

  - `PI_MAX_OUTPUT_TOKENS` 16k → 32k (and the structured-repair call now references it
    rather than hard-coding 16k). It is a per-completion ceiling, not a target — unused
    tokens are unbilled and Workers AI clamps to the model's real max — so this is safe
    headroom for larger specs/diffs. The shared LLM proxy (`@cat-factory/server`,
    served by both runtimes) only FLOORS workers-ai output, it does not cap, so the
    higher request flows through unchanged on Cloudflare and Node alike.
  - New `runDiagnostics` over Pi's transcript reports whether any completion hit the
    output ceiling (`truncated`/`finalTruncated`) and whether the agent's final turn
    produced no text at all (`finalAnswerEmpty` — an empty `content: []` despite spent
    output tokens, observed from `kimi-k2.7-code`). It is computed universally but acted
    on per agent: the document producers that hand a final answer ONWARD to be reviewed
    (spec-writer, blueprinter) now fail loudly with a clear cause instead of letting the
    structured-output repair manufacture a half-baked artifact from garbage. Side-effect
    agents (coder/ci-fixer/conflict-resolver pushing a PR or commit) are unaffected — an
    empty final turn is normal for them.

  Bumps the runner image tag to 1.5.0 (deploy/backend `image:publish` + wrangler.toml).

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

### Patch Changes

- e28a63d: Bump the pinned Pi coding agent (`@earendil-works/pi-coding-agent`) from 0.79.4 to
  0.79.8 in the executor-harness image. Changes the image, so the harness version (its
  GHCR/registry image tag) bumps with it.
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

- 3a12f15: Make container coding runs durable and restart-resilient, and stop the harness
  committing files the agent didn't choose.

  - **Agent owns commits, harness owns push.** The harness no longer blanket-stages
    (`git add -A`) the working tree — which would sweep in scratch scripts and build
    artifacts the agent created while exploring. The agent commits its own work (only it
    knows what belongs); the harness pushes those commits and opens the PR. A safety net
    (`commitTrackedEdits` → `git add -u`) still captures forgotten edits to ALREADY
    tracked files, but never untracked junk. A run is a no-op only when the branch never
    advanced past its pre-run tip.
  - **Checkpoint + resume.** The harness pushes the branch periodically during a run
    (`JOB_CHECKPOINT_INTERVAL_MS`, default 60s), so an evicted container's commits
    survive on the branch. The work branch is now deterministic per task
    (`cat-factory/<blockId>`), so a retry (fresh execution id) or a sweeper re-drive
    targets the SAME branch; the harness detects it already exists and RESUMES on it
    (cloning it and continuing on its commits) instead of starting over. `openPullRequest`
    is now idempotent (a resumed branch's existing PR is reused, not re-failed).
    A checkpoint only pushes once the branch has actually advanced past its pre-run tip,
    so a run that never commits leaves no empty work branch behind (which would otherwise
    make a later retry treat the base commit as resumable work and fail to open a PR).
  - **Branch torn down on merge.** Because the work branch is deterministic per task, the
    platform now deletes it when its PR merges (new `GitHubClient.deleteBranch` port +
    `GitHubPullRequestMerger`), so a later re-run of the same block starts fresh from base
    instead of resuming on already-merged commits (which a squash/rebase merge would
    otherwise re-introduce). Best-effort: a failed delete never fails the completed merge.
  - **Resumed branch refreshed against base.** A resumed branch was cut from an older base,
    so the harness now merges the latest base in when the two merge cleanly
    (`refreshFromBaseIfClean`), keeping the PR current; on a conflict it aborts and
    continues on the stale base (the merge gate handles a conflicting PR downstream).

- 41d16f0: Write the agent's composed system prompt to Pi's **global** context file
  (`~/.pi/agent/AGENTS.md`, alongside the existing `models.json`) instead of into
  the repo checkout (`<repo>/AGENTS.md`). The instructions already travel headlessly
  in the job body — only the harness→Pi hop went through a file in the working tree.
  Moving it out-of-tree means it can never be committed into a PR (across run,
  ci-fix, bootstrap, and blueprint), and a repo's own committed `AGENTS.md` is now
  read and concatenated by Pi rather than clobbered/overwritten. Removes the
  scattered `AGENTS.md` special-casing in `hasAgentChanges`, the bootstrap no-op
  check, and the benchmark diff exclusion. Changes the image, so the harness version
  (its GHCR/registry image tag) bumps with it.
- 3a12f15: Add a live no-progress guard to the container coding agent so a run that has plainly
  stopped making progress is killed early with a useful diagnostic, instead of burning
  the whole budget and failing with a generic "no file changes".

  `runPi` now feeds every streamed Pi event to a `ProgressGuard` that aborts when the
  agent makes many tool calls without ever editing a file (the signature of the
  credential rabbit-hole: exploring/probing the environment without implementing) or
  makes too many consecutive failing tool calls. Bounds are env-configurable
  (`JOB_MAX_TOOLCALLS_WITHOUT_EDIT`, `JOB_MAX_CONSECUTIVE_TOOL_ERRORS`); the no-edit
  bound is skipped for assess-only runs (`expectsEdits: false`) so a run that correctly
  makes zero edits is never falsely aborted — this covers both the merger AND the
  Blueprinter, which explores the repo and returns the service tree as JSON (the harness
  renders the files), so it never calls an edit tool itself. The edit-tool detection
  also recognises alternate names case-insensitively (`apply_patch`/`str_replace`/
  `multiedit`/… in addition to `edit`/`write`) so a model that mutates files under a
  different tool name is not mistaken for one making no edits. The no-edit bound counts
  only "action" calls (chiefly `bash`, the rabbit-hole's vector): read-only exploration
  (`read`/`grep`/`glob`/…) and planning (`todo`) are excluded, so a large task that
  legitimately reads or searches many files before its first edit is not killed for it
  (the default ceiling is correspondingly generous).

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

- 7c37653: Fail a container agent run when Pi ends in a terminal error, even on exit 0.

  Pi can exit 0 while the agent run itself ended in a hard error (every model call
  failed and its auto-retries were exhausted). The harness judged success purely on
  exit code plus whether the work branch carried commits, so a run that RESUMED a
  branch with prior checkpoint commits would open a PR off work this pass never
  produced, and a totally-failed implementation surfaced as a green pipeline.

  `runPi` now inspects Pi's terminal transcript (`terminalRunError`: the trailing
  `auto_retry_end success:false`, or the last `agent_end` with `stopReason: error`)
  and rejects with that message on exit 0, so the job is reported failed across every
  container agent kind (coder/ci-fixer/bootstrap/blueprint/merger). A mid-run error
  the agent recovered from leaves a clean terminal event and is unaffected.

  Bumps the executor image tag (1.0.3 -> 1.0.4).

- 9be11e1: Fix false "no file changes" failures in the container coding agents, and converge
  the implementation (`/run`) and CI-fixer (`/ci-fix`) paths onto one shared flow.

  The build/ci-fix roles commit their work themselves, so by the end of a successful
  run the working tree is often clean — and the harness's trailing `commitAll` then
  found nothing and reported "no changes" (a hard failure for `/run`, a lost fix for
  `/ci-fix`) even though the branch carried real changes. The harness now judges the
  _whole run_ against the branch's pre-run tip (`branchHasChanges`): it counts the
  agent's own commits as well as any still-uncommitted edits, ignores the
  harness-written `AGENTS.md`, and only treats nothing-at-all as a no-op.

  The two paths were near-duplicates (clone → write context → run Pi → push), so they
  now share `runCodingAgent` (and `noChangesReason`) and diverge only in what is truly
  different: implementation branches off the base onto a fresh PR branch and opens a
  pull request; the CI-fixer works directly on the PR branch and treats a no-op as
  non-fatal. The fix therefore applies to both without being written twice. Bumps
  `@cat-factory/executor-harness` (its image logic changed).

- 6406c8c: Repo housekeeping: separate published libraries from private packages by moving
  the harnesses out of `backend/packages/` into a new `backend/internal/`
  directory — `@cat-factory/executor-harness` and `@cat-factory/benchmark-harness`.
  Updates the pnpm workspace globs, the CI path-filters + Docker build context, the
  acceptance-test worker-src alias, and the package tables in the
  README/CONTRIBUTING/CLAUDE docs. No source, public API, or image contents change
  (the patch bump just keeps the GHCR image tag in lockstep with the relocated
  package).
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

- a112105: Optimize the runner Docker image: install Pi extensions as the unprivileged
  `harness` user (and `COPY --chown` the compiled wrapper) to drop the recursive
  `chown -R` layer that duplicated the extension tree, collapse the two `pi install`
  steps and the `git config` into single layers, and install the TS toolchain before
  copying `src` so a source edit no longer reinvalidates the dependency layer. Behavior
  is unchanged; the image is smaller and rebuilds faster.
- 0095e2c: Add an optional `onEvent` callback to `runPi` — the raw observability seam over a Pi
  run. It is invoked with every parsed Pi `--mode json` event in stream order (the full
  prompt/response/tool-call transcript), so offline tooling (the new smoketest harness)
  can capture and analyse what a model actually did without re-implementing the Pi
  driver. The container payload doesn't pass it, so production behaviour is unchanged;
  a throwing handler is swallowed so a faulty observer can't break a run. Touches the
  harness `src/**`, so the image tag bumps with it.
- 861d363: Re-tag the runner image 1.5.0 → 1.6.0 to force a rollout of the 32k output headroom.

  The `PI_MAX_OUTPUT_TOKENS` 16k → 32k bump (see harness-output-headroom-and-guards)
  landed in source under the existing 1.5.0 tag, so the deployed container kept running
  the stale 16k digest — `wrangler deploy` diffs the image by tag string and reports
  "no changes" when the tag is reused. Production telemetry confirmed it: every
  spec-writer LLM call recorded `request_max_tokens: 16384`, and one completion hit that
  ceiling exactly. A fresh, immutable tag is what forces the new digest to roll out.

  Bumps the runner image tag to 1.6.0 (deploy/backend `image:publish` + wrangler.toml).

- 954c850: Finish the `implementer` → `executor` rename so the package, directory, and
  Durable Object class match the already-published `cat-factory-executor` image.

  - `@cat-factory/implementer-harness` → `@cat-factory/executor-harness`
    (`backend/internal/implementer-harness` → `backend/internal/executor-harness`).
  - The per-run container Durable Object `ImplementationContainer` →
    `ExecutionContainer`, bound as `EXEC_CONTAINER` (was `IMPL_CONTAINER`). A
    `renamed_classes` migration (`tag = "v3"`) carries the class rename.

  **Deployment action required:** in your `wrangler.toml`, rename the
  `[[durable_objects.bindings]]` `name`/`class_name` to `EXEC_CONTAINER` /
  `ExecutionContainer`, update the `[[containers]]` `class_name`, and add the
  `v3` `renamed_classes` migration (see `deploy/backend/wrangler.toml`).

- 23b9fb6: Add a reusable structured-output abstraction with a repair retry + diagnostics for the
  JSON-returning container agents (requirements, blueprint, merger), so a single
  malformed reply no longer fails the whole run.

  A caller describes its output once as a `StructuredOutputSpec<T>` (label, shape hint,
  parser) and calls `resolveStructuredOutput`. It parses the agent's primary reply and,
  on failure, makes ONE structured "repair" call — a single-shot, no-tools,
  NON-streaming completion through the same proxy with `response_format: json_object`,
  asking the model to return only the corrected JSON — then reparses. It is
  provider-agnostic (external OpenAI-compatible upstreams honour `response_format`; the
  in-process Workers AI path ignores it but answers buffered and the focused prompt keeps
  it to JSON) and capability-gated by construction (an upstream that can't enforce
  `response_format` falls back to the prompt).

  Observability: every parse failure and repair outcome is logged (warn on first
  failure, info on recovery, error when the retry doesn't help), the repair call lands in
  `llm_call_metrics` as a NON-streaming row for the agent kind (so repair attempts are
  queryable), and a compact diagnostics suffix — including a token-doubling detector
  (`looksTokenDoubled`) that flags the streaming-corruption signature — is folded into
  the persisted failure reason. Changes the image, so the harness version (its registry
  image tag) bumps.

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
