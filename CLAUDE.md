# CLAUDE.md — architecture & flow notes

Orientation for working in this repo. High-level product docs live in
[`README.md`](./README.md) and [`backend/README.md`](./backend/README.md) +
`backend/docs/`. This file captures the **runtime flows** that are spread across
many files and are otherwise slow to re-derive.

## Backwards compatibility is NOT a goal

This project is pre-1.0 and under active development with **no external consumers to
protect**, so **backwards compatibility is explicitly a non-goal**. Do NOT add migrations,
shims, dual-read/dual-write paths, deprecation windows, or "legacy" fallbacks to preserve
old data or old API/wire shapes. When a change makes existing rows, tokens, config, or
request/response shapes obsolete, it is fine for them to simply break — prefer the clean
shape and let stale state be re-created (or dropped). Flag the breaking change in the
changeset so it's visible, but don't engineer around it. (This is why, e.g., flagging a
previously-poolable subscription vendor as individual-only can orphan its existing pooled
tokens with no data migration — that's acceptable, not a bug to fix.)

## Known environment quirks

- **Do not validate Cloudflare auth before deployments.** Skip `wrangler whoami`
  and similar pre-flight auth checks — always assume the Cloudflare login is
  correct and proceed straight to the deploy commands.
- **Worker tests fail on Windows** with `config wrangler validation failed` / 47 errors
  and "no tests" output. This is a pre-existing Windows-only wrangler issue, not caused
  by code changes. Use `pnpm test:run` from `backend/packages/orchestration` (or any other
  non-worker package with a vitest setup, e.g. `integrations`) to verify pure-logic changes;
  the worker integration suite only runs cleanly on Linux/macOS.
- **`oxfmt .` on Windows rewrites line endings across the whole tree**, so it touches
  hundreds of files even when CI's `oxfmt --check` (run on a Linux checkout) flags only a
  handful. This is expected, not a sign something is wrong: **committing the seemingly
  large drift is fine.** Git's line-ending normalization (`core.autocrlf` / `.gitattributes`)
  absorbs the CRLF↔LF churn at commit time, so only the genuine formatting changes survive
  in the recorded diff. Do not revert the mass reformat or try to hand-pick the files CI
  named — run `pnpm exec oxfmt .`, stage everything, and let git collapse the noise.

## Keep the runtimes symmetric

**Any change to one runtime facade (`backend/runtimes/cloudflare` or
`backend/runtimes/node`) MUST be accompanied by the symmetric change in every other
runtime.** The two facades serve the same `@cat-factory/server` app behind the same
kernel ports, so a new repository, port implementation, persisted table, migration,
scheduled/cron task, gateway, or wiring added to one runtime has to land in the other
too (D1 migration ⇄ Drizzle schema + a `pnpm db:generate` migration; a Cloudflare
`scheduled` cron handler ⇄ a Node `setInterval` sweeper; a D1 repo ⇄ a Drizzle repo).
The cross-runtime conformance suite (see "Multi-runtime facades & cross-runtime
conformance" below) exists to catch drift — add assertions there for any new shared
behaviour so a facade that forgot the symmetric change fails a test instead of shipping.

**A facade-parity gap is a critical showstopper, not a follow-up.** Wiring a shared
behaviour (a new repository, an optional core dependency, a domain-engine path) into
only one runtime is a bug, even when the second runtime "degrades gracefully" — a task
that gets reworked requirements on Cloudflare but the raw description on Node is exactly
the silent divergence this rule exists to prevent. Do NOT land a change that wires a
shared behaviour into one facade and defer the other: land both runtimes together AND a
conformance assertion in the SAME change, or do not land it. "Node has no X persistence
yet" is acceptable ONLY for behaviour that genuinely cannot exist on a runtime (e.g. a
Cloudflare-Container-only execution path), never for runtime-neutral domain behaviour
that merely needs a repository wired.

## Layout

One pnpm workspace (single root lockfile). Packages are sorted by visibility:
**published libraries** live in `backend/packages/*` + `frontend/app`, the
**runtime facades** (one per deployment target) in `backend/runtimes/*`, **private
packages** (the harnesses + the conformance suite) in `backend/internal/*`, and the
example **deployments** (which carry the `wrangler.toml`s / `Dockerfile` and config
and depend on the libraries) in `deploy/*`. See [`CONTRIBUTING.md`](./CONTRIBUTING.md)
for the package/publish table.

The backend is **runtime-neutral by construction**: the domain + the HTTP layer know
nothing about Cloudflare or Node, and each facade in `backend/runtimes/*` supplies
only its differentiators (persistence, durable jobs, real-time transport, model
provisioning). A shared **conformance suite** runs the SAME assertions against every
facade so the runtimes can't drift (see "Cross-runtime conformance" below).

- `frontend/app` — `@cat-factory/app`, the reusable **Nuxt layer** (`ssr: false`):
  the SPA source under `app/` (stores in `app/stores`, composables in
  `app/composables`, components in `app/components`, wire types in `app/types`).
  Published to npm; consumed by a deployment via `extends: ['@cat-factory/app']`.
- `backend/packages/contracts` — Valibot wire contracts shared by SPA + backends.
- `backend/packages/prompt-fragments` — versioned best-practice prompt fragments.
- The framework-agnostic domain is split across several published packages (there
  is **no** `backend/packages/core` any more):
  - `backend/packages/kernel` — shared vocabulary: the domain **types**
    (`src/domain/types.ts`, re-exporting the contracts), pure logic + constants
    (`src/domain/*`, e.g. `seed.ts`, `catalog.ts`), and **all repository/port
    interfaces** (`src/ports/*`). Everything else imports its ports from here.
  - `backend/packages/orchestration` — the delivery-workflow engine + domain
    **composition root**: module services under `src/modules/*` (`execution`,
    `bootstrap`, `pipelines`, `board`, `boardScan`, `requirements`,
    `notifications`, `merge`) and `createCore()` in `src/container.ts`.
  - `backend/packages/integrations` — opt-in integration services (GitHub,
    documents, tasks, environments, runner pools) behind kernel ports.
  - `backend/packages/agents` — agent catalog + prompt composition
    (`systemPromptFor`/`userPromptFor`, the per-kind `ROLES`) **and the AI
    provisioning facade**: `CompositeModelProvider` + the runtime-neutral
    single-provider resolvers (`openai`/`anthropic`/the OpenAI-compatible vendors —
    Qwen/DeepSeek/Moonshot plus the **OpenRouter** + **LiteLLM** gateways — +
    the Cloudflare-over-REST resolver) and `providerEndpoints` (the base-URL/key
    source of truth, also used by the LLM proxy). Each facade composes the registry
    from the resolvers it can serve. OpenRouter/LiteLLM are pure OpenAI-compatible
    entries: keys live in the UI key pool like the other direct vendors, OpenRouter
    defaults to the public gateway, and LiteLLM is operator-hosted (`LITELLM_BASE_URL`
    required, no public default).
  - `backend/packages/provider-bedrock` — `@cat-factory/provider-bedrock`, the
    opt-in AWS Bedrock resolver (`@ai-sdk/amazon-bedrock`) with a **supported-model
    allow-list** that throws `Unsupported Bedrock model` for anything outside it.
    Mixed into a facade's registry only when configured.
  - `backend/packages/spend` — the spend safeguard; `backend/packages/workspaces`
    — workspace + account services.
- `backend/packages/server` — `@cat-factory/server`, the **runtime-neutral HTTP
  layer** shared by every facade (no `@cloudflare/*` dep): all the Hono controllers
  (`src/modules/*/?*Controller.ts`), middleware (auth/authz/CORS/error), request
  helpers (`src/http/*`), HMAC signing + the GitHub OAuth helper (`src/auth/*`), the
  runtime **gateway** interfaces (`src/runtime/gateways.ts` — real-time, GitHub
  ingest/backfill, LLM upstream, **web-search upstream**), the `AppConfig` contract
  (`src/config/types.ts`),
  the dialect-agnostic row↔domain **mappers** (`src/persistence/mappers.ts`, reused
  by both stores), and `registerCoreControllers(app)` (`src/app.ts`). Controllers
  resolve everything from `c.get('container')` (a `ServerContainer` = the domain
  `Core` + `config` + `agentRunRepository` + `gateways`).
- `backend/runtimes/cloudflare` — `@cat-factory/worker`, the **Cloudflare Worker
  facade** (formerly `backend/packages/worker`): D1 repos + infra
  (`src/infrastructure/*`), the DI composition root (`src/infrastructure/container.ts`),
  Durable Objects, Workflows, Containers, the `scheduled`/`queue` handlers, and the CF
  gateway impls (`src/infrastructure/gateways/*` — `DoRealtimeGateway`, the GitHub
  gateways, `WorkersAiLlmUpstream`). `createApp`/`buildContainer` are thin wrappers
  over `@cat-factory/server`. Exposes the default fetch/scheduled/queue handler + the
  DO/Workflow classes. Ships its D1 `migrations/` — pre-1.0 history (0001–0041) is
  squashed into a single `0001_init.sql`, and new tables get a fresh numbered migration
  on top (so the old per-table migration numbers no longer exist). Carries **no**
  production config; its own `wrangler.toml` is a stripped test/dev config (the vitest
  workers pool reads it).
- `backend/runtimes/node` — `@cat-factory/node-server`, the **Node.js service facade**:
  serves the same `@cat-factory/server` Hono app via `@hono/node-server`, with
  **Drizzle/Postgres** repositories (`src/db/*`, `src/repositories/drizzle.ts` — the
  single persistence used in dev/test/prod), **pg-boss** durable execution
  (`src/execution/{pgBossRunner,drive}.ts`, the analogue of the Worker's Workflows
  driver), Node gateways + model provisioning (`loadNodeConfig`,
  `createNodeModelProvider` = direct vendors + Cloudflare-over-REST + opt-in Bedrock),
  and `createServer()` / `start()`. `DATABASE_URL` selects the database; `migrate()`
  bootstraps the schema idempotently on boot. Exposes composition seams used by
  the local facade (all default to the existing Node behaviour): `buildNodeContainer`
  accepts an injected `resolveTransport`, `mintInstallationToken` and `githubClient`,
  and `start()` an injected `buildContainer` + a `host` bind address (else `HOST` from
  the env, else all interfaces). When the GitHub App is configured, Node now builds its
  own `FetchGitHubClient` from the shared App registry to wire the **CI gate + merge /
  mergeability** providers — so a stock Node-with-App deployment gates on real Actions
  CI and merges for real, exactly like the Worker (previously only local mode did).
- `backend/runtimes/local` — `@cat-factory/local-server`, the **local-mode facade**:
  the Node facade with two differentiators so a developer can run the whole product on
  their own machine. Agent jobs run as **per-run local containers** (the
  `LocalContainerRunnerTransport` — the local analogue of `CloudflareContainerTransport`
  and `RunnerPoolTransport`, driven through the same `RunnerTransport` port: start the
  executor-harness image per run, re-attach the run's later steps to it (each step's
  harness job is keyed by the per-step `RunnerJobRef.jobId`), eviction-maps a vanished
  container). HOW it talks to the runtime is delegated to a `ContainerRuntimeAdapter`
  (`src/runtimes/*`), selected by `LOCAL_CONTAINER_RUNTIME` (docker | podman | orbstack |
  colima | apple): **Docker/Podman/OrbStack/Colima** share the Docker-CLI adapter
  (`docker run`, publish `:8080` to an ephemeral host port read with `docker port`,
  `cat-factory.runId` label), while **Apple `container`** has its own adapter
  (VM-per-container: `container run` addressed by a deterministic name, connect to the
  container's own IP, no Docker-in-Docker). Each adapter exposes a `localDind` capability;
  the local facade threads it into `ExecutionService` as `localTestInfraSupported` so a
  runtime that can't nest containers (Apple) **refuses a local-infra Tester run at start**
  ("limited mode" — steer to the ephemeral env or a no-infra service; see
  `tester-infra.logic.ts`). GitHub is reached via a **PAT** (`GITHUB_PAT` →
  `mintInstallationToken`) instead of a GitHub App. `buildLocalContainer` reuses ALL of Node's persistence/
  pg-boss/gateways and only swaps the runner transport + the GitHub token/client seams;
  `startLocal()` reuses Node's `start()`. The harness itself opens the PR via the PAT,
  and the **CI gate + merge / mergeability providers are wired from a PAT-backed
  `FetchGitHubClient`** (`createLocalGitHubClient`), so a local pipeline gates on real
  GitHub Actions CI and **merges the PR for real**. Repo resolution is unchanged (the
  `github_repos`/`github_installations` projection); the `linkRepo` helper (+ CLI) seeds
  those rows from PAT-read repo metadata since there is no GitHub-App connect flow.
- `backend/internal/executor-harness` — the payload that runs **inside** each
  per-run Cloudflare Container (the Pi coding-agent harness). Private (not on npm);
  its multi-arch Docker image is published publicly to **GHCR + Docker Hub** by
  `docker-publish.yml` (or manually via the package's `image:publish` script /
  `scripts/publish-image.sh`).
- `backend/internal/benchmark-harness` — headless agent benchmarking (`cat-bench`);
  private, not published.
- `backend/internal/conformance` — `@cat-factory/conformance`, the private
  **cross-runtime conformance suite** + the single canonical deterministic
  `FakeAgentExecutor`. `defineConformanceSuite(harness)` runs the key backend
  behaviour against any facade; both runtimes' test suites invoke it (see below).
- `backend/internal/example-custom-agent` — `@cat-factory/example-custom-agent`, a
  private **worked example** of a company-authored agent package: an inline `org-reviewer`
  - a container `security-auditor` (`container-explore` structured, a post-op rendering
    `compliance/REPORT.md` via `RepoFiles.commitFiles`, presented through
    `generic-structured`) + the `pl_org_audit` pipeline, registered purely via the public
    seams (`registerAgentKind` + `registerPipeline`) and imported for side effect. Proves a
    brand-new repo-writing agent ships with ZERO harness changes. See **Custom agents** below.
- `deploy/backend` — example Worker deployment: a one-line `src/index.ts`
  re-exporting `@cat-factory/worker` + the full production `wrangler.toml`
  (`[vars]`, the GHCR runner `image`, `migrations_dir` →
  `node_modules/@cat-factory/worker/migrations`).
- `deploy/node` — example **Node.js service** deployment: a one-line `src/main.ts`
  calling `@cat-factory/node-server`'s `start()`, a `Dockerfile` (builds from the repo
  root, then `pnpm install --prod` prunes to runtime deps — no `pnpm deploy`/`--legacy`),
  and an `.env.example`. Env-driven (`DATABASE_URL` required); the scripts load `.env`
  via Node's native `--env-file-if-exists`, and the entry runs via Node 24/26 **type
  stripping** (no build step for this package).
- `deploy/local` — example **local-mode** deployment: a one-line `src/main.ts` calling
  `@cat-factory/local-server`'s `startLocal()`, a `docker-compose.yml` (local Postgres
  only — the orchestrator runs on the host so it can drive the Docker daemon to spawn
  agent containers), and an `.env.example` (`LOCAL_HARNESS_IMAGE`, `GITHUB_PAT`,
  `DATABASE_URL`). Like `deploy/node`, the entry runs via Node type stripping.
- `deploy/frontend` — example Pages deployment: a thin Nuxt app that `extends` the
  `@cat-factory/app` layer + the Pages `wrangler.toml`. `NUXT_PUBLIC_API_BASE` is
  baked in at `nuxt generate` time.

## Releases & changesets

- Versioning/publishing is [changesets](https://github.com/changesets/changesets)
  (`.changeset/config.json`, root `pnpm changeset` / `ci:publish`). Public packages
  publish to npm; `deploy/*` + `benchmark-harness` are `ignore`d;
  `executor-harness` is versioned-but-private (its version is the GHCR image tag).
- **Always add a changeset for any change to a versioned package**, and bump
  `@cat-factory/executor-harness` whenever you touch what goes into its image
  (`src/**`, `Dockerfile`, `tsconfig.json`, the pinned `PI_*` args). Empty changeset
  (`pnpm changeset --empty`) for docs/CI/test-only changes. Full rules + file format
  in [`CONTRIBUTING.md`](./CONTRIBUTING.md). CI enforces this (`changeset status`).
- `.github/workflows/release.yml` runs changesets on push to `main`;
  `docker-publish.yml` republishes the runner image (multi-arch, GHCR + Docker Hub),
  gated on image-affecting paths (incl. the harness `package.json`, so a version
  bump re-tags the image). Docker Hub is gated on the `DOCKERHUB_USERNAME` /
  `DOCKERHUB_TOKEN` repo secrets; absent them it publishes GHCR only.
- **Any change that affects the runner image MUST bump the image tag** (the harness
  `src/**`, `Dockerfile`, `tsconfig.json` or the pinned `PI_*` args). Bump
  `@cat-factory/executor-harness`'s `version` AND the matching tag in BOTH
  `deploy/backend/package.json` (`image:publish`) and `deploy/backend/wrangler.toml`
  (`[[containers]] image`), then `pnpm image:publish` + `pnpm deploy` from
  `deploy/backend`. The deployment serves the **Cloudflare managed-registry** image
  (`registry.cloudflare.com/<acct>/cat-factory-executor:<tag>`), NOT the GHCR image,
  so the GHCR auto-publish does not roll it out. Reusing the same tag does NOT
  deploy: `wrangler deploy` diffs the image by tag string, reports
  `no changes cat-factory-backend-executioncontainer`, and the container application
  stays pinned to the OLD digest — so new per-run containers keep running stale code
  (a missing harness route then 404s as `Container dispatch failed (HTTP 404)`). A
  fresh, immutable tag is what forces the rollout.

## Execution flow (the canonical async + observable pattern)

This is the gold-standard pattern for long-running agent work. Anything new that
runs an agent in a container should mirror it.

1. `ExecutionService.start()` (orchestration `src/modules/execution/ExecutionService.ts`)
   creates an `ExecutionInstance` with steps and hands off to the durable driver.
2. `ExecutionWorkflow` (worker `infrastructure/workflows/ExecutionWorkflow.ts`) —
   one Cloudflare **Workflows** instance per run, addressed by execution id.
   Loops calling `advanceInstance`, parking on `waitForEvent` for human
   decisions. A cron sweeper re-drives runs whose Workflows instance died.
3. `ContainerAgentExecutor` (worker `infrastructure/ai/ContainerAgentExecutor.ts`)
   — `startJob()` dispatches the job **asynchronously** (`/run`, non-blocking,
   returns a `jobId`); `pollJob()` polls and lifts `view.progress` → `subtasks`.
4. Inside the container, `runPi()` (`executor-harness/src/pi.ts`) streams
   Pi's JSON-line events; `parseTodoProgress()` turns the todo tool's output into
   `{completed, inProgress, total}` via the `onProgress` callback →
   `JobRegistry` (`src/runner.ts`) → exposed on the `/jobs/{id}` `JobView.progress`.
5. `ExecutionService.pollAgentJob()` writes `step.subtasks`/`step.progress`,
   `executionRepository.upsert()`, then `emitInstance()`.
6. Events reach the browser by **push, not polling**:
   `DurableObjectEventPublisher.executionChanged()` →
   `WorkspaceEventsHub` Durable Object (`/publish`, hibernatable WebSockets,
   one per workspace) → broadcast → SPA `useWorkspaceStream.ts` →
   `execution.upsert()` store → `TaskExecution.vue` / `PipelineProgress.vue`
   render the `{completed}/{total}` subtask bars.

## Repo bootstrap flow (ASYNC + observable + board-integrated)

The "bootstrap repo" task adapts a reference architecture (or scaffolds from
scratch) into a **pre-created, empty** GitHub repo and force-pushes the result.
It mirrors the execution pattern above: dispatch → durable poll → push events.

- Trigger: SPA `components/bootstrap/BootstrapModal.vue` → `stores/bootstrap.ts`
  → `POST /workspaces/:ws/bootstrap/jobs`. The call returns **immediately** with a
  `running` job (the container keeps working in the background).
- `BootstrapService.bootstrap()` (orchestration `src/modules/bootstrap/BootstrapService.ts`):
  pre-flight GitHub connection → insert a `bootstrap_jobs` row as `running` →
  `repoBootstrapper.startBootstrap()` (dispatch, returns once accepted) →
  materialise a **provisional service frame** (a real `Block`, `level:'frame'`,
  `status:'in_progress'`, titled from the repo; its id is stored on the job's
  `block_id`) → `bootstrapRunner.startRun()` to kick the durable driver → return
  the running job. A pre-flight/dispatch failure returns a `failed` job with **no**
  frame left behind.
- `BootstrapWorkflow` (worker `infrastructure/workflows/BootstrapWorkflow.ts`) —
  one Cloudflare Workflows instance per job (id = bootstrap job id; binding
  `BOOTSTRAP_WORKFLOW`). Loops calling `BootstrapService.pollBootstrapJob()`
  inside retriable `step.do`s, sleeping durably between polls.
- `pollBootstrapJob()`: polls the container once via
  `repoBootstrapper.pollBootstrap()`; while running, writes changed `subtasks` and
  emits a `bootstrap` event; on **success** marks the job `succeeded`, calls
  `repoBootstrapper.linkRepoToBlock()` (upserts the new repo into the
  `github_repos` projection + sets `block_id`) and flips the frame to `ready`; on
  **failure** marks the job `failed` and the frame `blocked`. It is idempotent
  (terminal jobs return as-is) so the driver's retries/replays are safe.
- `ContainerRepoBootstrapper` (worker `infrastructure/ai/ContainerRepoBootstrapper.ts`):
  a **thin layer on the generic runner seam**, mirroring `ContainerAgentExecutor`.
  `startBootstrap` pre-flights (target exists, reachable, empty — only
  README/.gitignore/license/**AGENTS.md** tolerated, see `isBootstrapBoilerplate`),
  mints GH + proxy tokens, builds the job body, then dispatches via the shared
  `RunnerJobClient` → `resolveTransport(workspaceId).dispatch(jobId, body,
'bootstrap')` (no direct `EXEC_CONTAINER`; backend-polymorphic — Cloudflare
  always, a self-hosted pool throws a clean "unsupported" until it implements the
  kind). `pollBootstrap` `RunnerJobClient.poll`s and maps the `RunnerJobView` to
  running (with subtasks) / done (outcome, from `result.defaultBranch`) / failed
  (`classifyBootstrapFailure`: `evicted` on a 404-mapped view, `timeout` on a
  watchdog kill, else `agent`). `stopBootstrap` → `RunnerJobClient.release`.
- Harness: `/bootstrap` starts a **background job** in a `JobRegistry` (the same
  generic registry as `/run`), keyed by the job id; `handleBootstrap()`
  (`executor-harness/src/bootstrap.ts`) threads `onProgress`/`signal` so Pi's
  todo-tool counts surface as `subtasks`. Sequence: clone (or empty dir) →
  `writeAgentsContext()` writes the prompt to Pi's **global** `~/.pi/agent/AGENTS.md`
  (outside the checkout, so it never lands in the bootstrapped repo) → `runPi()`
  adapts → `reinitAndPush()` resets history to one commit and **force-pushes** to
  the default branch.
- Events: `DurableObjectEventPublisher.bootstrapChanged()` → `WorkspaceEventsHub`
  → SPA `useWorkspaceStream.ts` patches `stores/agentRuns.ts` (`upsertBootstrap`)
  - the board block. `BlockNode.vue` reads `agentRuns.byBlock[frameId]` to render
    the "bootstrapping…" badge + subtask progress bar, flipping to a ready service or
    the shared `<AgentFailureCard>` (failure hint + retry). Tracing logs (pino) run
    controller→service→workflow→bootstrapper→harness, queryable in the Cloudflare
    dashboard.

## Service blueprints flow (in-repo map + board population)

A **Blueprinter** agent decomposes a repo into the canonical service → modules
tree and persists it **in the repo** under `blueprints/`, then the board is
reconciled from it. It is modelled as a normal pipeline step (`agentKind:
'blueprints'`), so it reuses the whole execution engine — no separate durable
runner. The map intentionally stops at modules: tasks are authored by people, not
derived from the blueprint (there is no longer a "feature" granularity level).

- In-repo artifact (`blueprints/`, rendered deterministically by the harness from
  the coerced tree): `blueprint.json` (canonical `BlueprintService`), `overview.md`
  (high-level, read first), `modules/<slug>.md` (deep-dive per module), and
  `version.json` (a tiny manifest — monotonic version + content hash + counts — for
  quick staleness checks). Strict shape enforced by `parseBlueprintService`
  (Valibot) at ingest; the harness coerces leniently then the worker/core validate.
- Harness: `handleBlueprint` (`executor-harness/src/blueprint.ts`) clones the
  target branch, reads any existing blueprint (update mode), runs Pi to emit the
  tree, renders the files, and **commits onto that branch** (no history reset /
  force-push) via `commitAll`+`pushBranch`. Served at `POST /blueprint`, polled on
  the shared `/jobs/{id}`. Every agent's global `~/.pi/agent/AGENTS.md` carries
  `BLUEPRINT_GUIDANCE` (pi.ts): read `overview.md` first, open a module file only
  when relevant.
- Worker: `ContainerAgentExecutor` builds a blueprint job for the `blueprints` kind
  — branch = the prior `coder` step's PR branch (`block.pullRequest.branch`) when
  present (mode `update`), else the repo default branch (mode `create`) — and
  dispatches it via `RunnerTransport.dispatch(id, body, 'blueprint')` (Cloudflare
  container only; `CompositeAgentExecutor` routes the kind to the container
  executor). The returned tree maps to `AgentRunResult.blueprintService`.
- Core: `ExecutionService.recordStepResult` ingests that tree — strict-parse, then
  `BoardScanService.reconcileBlueprint(frameId, service)` updates the run block's
  **service frame** in place (match modules by name, add missing, refresh
  descriptions, **never delete**, and never touch the authored tasks inside them),
  and emits a `board` event so the SPA refreshes.
- Triggers: `blueprints` is inserted after `coder` in the default pipelines (so the
  map + board refresh on the same implementation PR branch), and
  `BootstrapService.pollBootstrapJob` success starts the blueprint-only
  `pl_blueprint` pipeline against the new frame (best-effort) to create the initial
  map. A mapping-only run leaves a frame `ready` (not `done`).
- Nothing is persisted to a blueprint table: the in-repo `blueprints/` files are the
  source of truth and the board is the projection. There is **no** standalone "scan
  repository" command — repository decomposition is always the `blueprints` pipeline
  agent (which runs through the runner transport, so it works on every backend);
  `BoardScanService` is purely the reconciler the engine drives with its result.

## Requirements review flow (iterative gate step + dedicated window)

`requirements-review` is the FIRST step of the default pipelines — a special engine
gate (handled in `ExecutionService.evaluateRequirementsReview`, like `ci`/`conflicts`,
NOT a container/prose agent). The reviewer inspects a block's "collected requirements"
(description + linked PRD/RFC docs + tracker issues) and raises items, each with a
**severity**. The run **parks** on a durable decision-wait and the dedicated structured
window drives an iterative loop until the reviewer converges; only then does the run
advance to the architect. Every reviewer/incorporation call runs an LLM inline (via the
`ModelProvider` port) and returns the updated review, which the SPA patches directly.

The loop (one reviewer pass = one **iteration**; the initial review is iteration 1):

1. Reviewer raises findings → human **answers** the relevant, **dismisses** the irrelevant.
2. An **incorporation companion** folds the answers into ONE standard-format document
   (`incorporate`, status `merged`). The human inspects it and either re-reviews or
   **redoes** the merge with a freeform "do it differently" comment.
3. **Re-review** runs the reviewer against that document (`iteration++`). It converges
   (`incorporated` → the run advances), continues (`ready` → answer the new findings) or
   hits the cap (`exceeded`).
4. At the cap the human picks: **extra-round** (one more pass), **proceed** (advance with
   the last incorporated doc) or **stop-reset** (`cancel()` → block `planned`/editable;
   the last incorporated doc survives on the inspector as a base to rework from).
5. **Auto-pass**: if every outstanding finding is at or below the task's tolerated
   severity (`maxRequirementConcernAllowed`), the findings are recorded but the run
   advances with no human gate and no incorporation. All findings dismissed → **proceed**.

The cap + tolerated severity are per-task on the **merge preset** (`maxRequirementIterations`
default 6, `maxRequirementConcernAllowed` default `none`). There is NO quality-companion
grade gate any more — convergence is reviewer-driven.

- Wire contracts: `contracts/src/requirements.ts` (`RequirementReview` +
  `RequirementReviewItem`; review `status` ∈ `ready`/`merged`/`exceeded`/`incorporated`,
  plus `iteration`/`maxIterations`; `incorporateRequirementsSchema` carries the redo
  `feedback`; `resolveRequirementsExceededSchema` carries the choice). One **live review
  per block**. The document lives on `review.incorporatedRequirements`.
- Core: `RequirementReviewService` (`modules/requirements/`) — `review()`/`reReview()`
  generate items (reReview reviews the incorporated doc), `replyToItem()`/`setItemStatus()`
  mutate items, `incorporate()` requires no `open` items then runs the rework LLM (folding
  in the redo `feedback` + prior doc), `markIncorporated()`/`grantExtraRound()` settle the
  loop. `ExecutionService.{reReviewRequirements,proceedRequirements,resolveRequirementsExceeded}`
  call the service then drive the parked run (`resumeRequirementsRun` advances + signals;
  stop-reset cancels). The pure `disposeReview(items, {iteration,maxIterations,
concernThreshold})` (`requirements.logic.ts`) decides auto-pass / awaiting / exceeded.
  `REWORK_SYSTEM_PROMPT` (`@cat-factory/agents`) enforces the standard doc structure.
  Pass-through when the reviewer model isn't wired (tests/conformance) so pipelines run
  unchanged. Assembled by `createRequirementsModule` whenever `requirementReviewRepository`
  is wired (and passed into `ExecutionService` as `requirementReviewService`).
- Downstream consumption: `ExecutionService.resolveReworkedRequirements` reads the
  block's incorporated review (optional `requirementReviewRepository` dep). When
  present, `buildAgentContext` uses it as the block description (only for `task`-level
  blocks — reviews are task-scoped, so frame/module steps skip the lookup) and
  **drops** `contextDocs`/`contextTasks` (already folded in). The spec-writer then
  receives that same reworked description as its single-task input and applies it as an
  increment onto the baseline spec already committed on the branch (it is NOT a
  service-wide aggregate — an unmerged sibling task is invisible). Absent → original
  behavior. The rework LLM call rejects a length-truncated document (it would become a
  silently-incomplete spec for every downstream agent) rather than persisting it.
- Persistence: `requirement_reviews`, mirrored on **both** runtimes (parity is
  mandatory): the Cloudflare D1 table (`D1RequirementReviewRepository`) and the Node
  Postgres table (Drizzle `requirementReviews` in `db/schema.ts` +
  `DrizzleRequirementReviewRepository`, generated migration under `runtimes/node/drizzle/`).
  Items as a JSON column; `iteration`/`max_iterations` columns track the loop; the old
  `companion` column is gone. `getByBlock` returns the current one. Both facades wire the
  repo + model provider; the cross-runtime conformance suite asserts the agent-context
  substitution against both stores.
- Controller (shared `@cat-factory/server`): `RequirementReviewController` mounts
  `GET|POST /blocks/:blockId/requirement-review`, `POST /requirement-reviews/:id/items/:itemId/reply`,
  `PATCH …/items/:itemId`, `POST /requirement-reviews/:id/incorporate` (reviewId-scoped,
  no run drive), and the run-driving `POST /blocks/:blockId/requirement-review/{re-review,
proceed,resolve-exceeded}` (via `container.executionService`). Each facade wires the
  review repo + a model provider + the routing default ref + `resolveBlockModel`, so the
  reviewer resolves its model like an agent step (block pin > workspace default >
  Cloudflare Workers AI).
- Frontend: `stores/requirements.ts` (load/review/reply/setItemStatus/incorporate/
  reReview/proceed/resolveExceeded) +
  `components/requirements/RequirementsReviewWindow.vue` — the loop UI (answer/dismiss →
  incorporate → inspect doc → re-review or redo-with-comment → proceed; the 3-choice
  prompt on `exceeded`; "Iteration N / M"). It opens via the **universal result-view
  seam** (see "Conventions"), not a hardcoded mount. `InspectorPanel.vue` freezes a
  task's raw description once `incorporated` (the standardized doc takes focus), and after
  a stop-reset surfaces the last incorporated doc read-only as a base.

## Merge lifecycle flow (CI gate → CI-fixer → merger → notifications)

The tail of a build pipeline turns an open PR into a merged one — gated on **real**
CI and a **real** GitHub merge, so a task is `done` only when its PR actually merged
(the old bug: a task showed "merged" — `block.status === 'done'`, rendered by
`TaskExecution.vue` — purely from a confidence score, while CI was red and the PR
still open). Two new container agent kinds plus a special gate step implement it.

- **`ci` step (a polling Gate — see "Gates vs agents" below)** — auto-inserted
  second-to-last in the standard pipelines, after all code-producing steps. It is NOT
  an LLM/container agent: its `GateDefinition` reads the PR head's GitHub check runs via
  the `CiStatusProvider` port (worker `GitHubCiStatusProvider`), aggregates them
  (`ci.logic.ts` → green / pending / failure / none), and the shared
  `ExecutionService.evaluateGate` acts: green/none → finish + advance (polling
  **stops**, the agent is never spun up); pending → `awaiting_gate` (the durable driver
  sleeps `ciPollInterval` then calls `pollGate`); failure → dispatch a `ci-fixer`
  container job (up to the task preset's `ciMaxAttempts`, default 10), else raise a
  `ci_failed` notification + fail the run. A finished fixer job returns the gate to
  `checking` (it never advances the step). Pass-through when no `CiStatusProvider` is
  wired (tests / no GitHub).
- **`ci-fixer` (container kind)** — `executor-harness/src/ci-fixer.ts` (POST
  `/ci-fix`): clones the PR head branch, runs Pi to make CI pass, commits + pushes
  back onto the **same** branch (no new PR). `ContainerAgentExecutor` builds the body
  with `agentKind` overridden to `ci-fixer` and dispatch kind `ci-fix`.
- **`merger` (container kind)** — the **last** standard-pipeline step.
  `executor-harness/src/merger.ts` (POST `/merge`) clones the PR head branch, scores
  the diff vs base (complexity / risk / impact, each 0..1) and returns ONLY a JSON
  assessment — it makes **no** commits. `ExecutionService.resolveMergerStep` parses
  the assessment, compares it to the task's resolved **merge threshold preset**, and
  either merges for real (the `PullRequestMerger` port → worker
  `GitHubPullRequestMerger` → `GitHubClient.mergePullRequest` → block `done`) or
  raises a `merge_review` notification leaving the block `pr_ready`. A pipeline with
  **no** merger raises a `pipeline_complete` notification (confirm + merge) instead of
  auto-`done`.
- **Merge threshold presets** — a per-workspace library
  (`merge_threshold_presets`; `MergePresetService` +
  `D1MergePresetRepository`; `GET|POST|PATCH|DELETE /workspaces/:ws/merge-presets`).
  A task selects one via `Block.mergePresetId` (the inspector dropdown in
  `TaskModelSettings.vue`); none → the workspace default (lazily seeded from
  `DEFAULT_MERGE_PRESET` in kernel). Carries the auto-merge ceilings + `ciMaxAttempts`
  - the requirements-review knobs `maxRequirementIterations` (default 6) and
    `maxRequirementConcernAllowed` (default `none`); see "Requirements review flow".
- **Notifications** — a first-class, human-actionable surface (NOT a mid-pipeline
  gate). `notifications` table + `NotificationService`
  (orchestration) behind a `NotificationChannel` port: the canonical row is persisted
  - the in-app `notification` `WorkspaceEvent` is pushed (worker
    `InAppNotificationChannel` over `DurableObjectEventPublisher.notificationChanged`),
    with `CompositeNotificationChannel` as the seam for **future email/Slack** channels.
    `NotificationController` mounts `GET /notifications`, `POST /notifications/:id/act`
    (merge / confirm / retry by type), `POST …/dismiss`. SPA: `stores/notifications.ts`
  - the toolbar `NotificationsInbox.vue`; the snapshot carries open notifications +
    the preset library.

## Post-release health flow (Datadog gate → Agent-On-Call → notify/enrich)

After a release ships, the **`post-release-health`** gate (the LAST standard-pipeline
step, after `merger`) watches the team's Datadog monitors/SLOs for a window and, on a
regression, spawns an **`on-call`** agent to investigate — it never auto-reverts.

- **Polling gate** (a `GateDefinition` in `buildGateRegistry`, not a copy of the
  machinery): `wired()` = a `ReleaseHealthProvider` is configured; `probe()` reads the
  block's monitors/SLOs since a **release marker** (`step.gate.watchSince`, set on first
  entry) and combines the verdict with the watch window via `classifyReleaseHealth`
  (`release.logic.ts`) → `pass` (healthy + window elapsed; or no monitors configured →
  pass through immediately), `pending` (keep polling), `fail` (a monitor alerts / SLO
  breached). `attemptBudget` = the merge preset's `releaseMaxAttempts` (default 1);
  the window is `releaseWatchWindowMinutes` (default 30).
- **Provider**: the kernel `ReleaseHealthProvider` port is vendor-neutral and served by the
  pluggable `RegistryReleaseHealthProvider` (`integrations/modules/observability`) — a registry
  of per-vendor adapters (today only `DatadogObservabilityAdapter`, `integrations/modules/datadog`,
  which reads monitor state + SLO SLI-vs-target and recent error logs). The composite owns
  connection loading + decryption, config resolution up the frame chain, and the verdict
  reduction; an adapter is just the vendor reads, so a second provider is a new registry entry.
  Observability creds live on the backend (`observability_connections`: a `provider` discriminator
  - one sealed `credentials` JSON blob + a non-secret `summary`, sealed `cat-factory:observability`)
    — never in containers. Per-block monitor/SLO mapping is `release_health_configs` (resolved up the
    frame chain). Both tables mirror D1 ⇄ Drizzle; managed via `ReleaseHealthService` + the
    `GET|PUT|DELETE /workspaces/:ws/observability/connection` + `…/release-health-configs/:blockId`
    controller. The SPA splits this: the connection is an **Integrations** entry
    (`ObservabilityConnectionPanel.vue`), while the per-service monitor/SLO mapping lives in the
    **service inspector** (`ServiceReleaseHealthConfig.vue`, keyed by the selected frame's block id —
    no manual entry, disabled with a hint until a connection exists). Both use `stores/releaseHealth.ts`.
- **On-call agent** (`on-call` container kind, `executor-harness/src/on-call.ts`, `/on-call`):
  the gate escalates via `gatherHelperPriorOutputs` (renders the evidence bundle into the
  agent's prompt). The agent clones the released PR head, correlates the diff with the
  evidence, and returns ONLY a JSON assessment (`onCallAssessment`: culprit confidence +
  `revert`/`hold`/`monitor`). Its completion is resolved SPECIALLY (not the generic gate
  re-probe): `ExecutionService.resolveOnCallStep` parses it, raises a `release_regression`
  notification (Slack + in-app inbox), best-effort **enriches** any incident PagerDuty /
  incident.io already opened (the `IncidentEnrichmentProvider` port — annotate, NOT
  re-alert, since those systems page off the same signals), then finishes the gate step so
  the run completes (the human decides revert/acknowledge out-of-band).

## Gates vs agents (the step taxonomy)

A pipeline step's `agentKind` puts it in one of three buckets. Most engine handling
keys off which bucket, so know them before adding a step:

- **Agents** — a container or inline LLM does the work (`coder`, `architect`,
  `spec-writer`, `tester`, `merger`, the companions, …). Dispatched via the shared
  `CompositeAgentExecutor`; container kinds park on `awaiting_job`.
- **Polling Gates** — `ci` and `conflicts`. A gate is NOT an agent: it runs a
  **programmatic precheck** against a provider and only escalates to a helper container
  agent (`ci-fixer` / `conflict-resolver`) on a negative verdict. The skip-unless-needed
  contract is the whole point: a green CI / mergeable PR advances with **nothing spun
  up**. One generic machine drives every gate — `ExecutionService.evaluateGate` /
  `dispatchGateHelper` / `pollGate`, parking on the single `awaiting_gate` result while
  the precheck is pending. A gate is a `GateDefinition` entry
  (`modules/execution/gates.ts`) supplying only its differentiators: `wired()`, the
  `probe()` (→ `pass` / `pending` / `fail`), the `helperKind`, and `onExhausted`. The
  live loop state is `step.gate` (`GateStepState`: `phase` `checking`/`working`,
  `attempts`, `maxAttempts`, `headSha`); the gate kind is `step.agentKind`, not stored
  twice. **Adding a gate is a new registry entry, not a new copy of the machinery** —
  do not hand-roll another `evaluateX`/`pollX`/`awaiting_x` triple.
- **One-shot engine steps** — non-LLM steps with bespoke handling: `tracker` (files a
  ticket), `deployer` (provisions an env), `requirements-review` (inline reviewer + park
  loop). Not gates because they don't poll-or-escalate.

The same "precheck, then skip the expensive work if it's unnecessary" idea applies to
the inline requirements-incorporation companion: `hasNotesToIncorporate`
(`requirements.logic.ts`) short-circuits `runIncorporationCycle` so the rework +
re-review LLM calls are skipped when the human left nothing to fold in (every finding
dismissed, no answered replies, no redo feedback) — the review settles `incorporated`
directly and downstream falls back to the original description.

## Custom agents (manifest-driven extension — pre/post-ops over `RepoFiles`)

A deployment can ship its own agent kinds **without forking and without rebuilding the
executor-harness image**. Governing principle: _zero `switch(agentKind)` in the
container_ — the harness is a generic LLM-over-a-checkout runner, and all
mechanical/deterministic work is backend TypeScript. Full model + worked example:
[`backend/docs/custom-agents.md`](./backend/docs/custom-agents.md).

- **Three stages** (the container runs only the middle one): `preOps` (deterministic
  backend TS, reads/commits a targeted subset of the repo with NO checkout, via the
  `RepoFiles` kernel port) → `agent` (optional LLM step: `inline` / `container-explore`
  [prose or structured JSON → `result.custom`] / `container-coding`) → `postOps`
  (deterministic backend TS: parse `result.custom`, render artifact files, commit via
  `RepoFiles`). `preOps`/`postOps` are plain `RepoOp` functions.
- **Registration** (an import side effect, mirroring the model-provider seam):
  `registerAgentKind({ kind, systemPrompt, agent, preOps, postOps, presentation })`
  (`@cat-factory/agents`) + `registerPipeline(...)` (`@cat-factory/kernel`). A
  `container-*` surface implies the container requirement.
- **Live execution wiring**: `ExecutionService` runs a registered kind's `preOps` before
  dispatch and `postOps` after `recordStepResult`, over a per-run `RepoFiles` bound to the
  run's repo. The binding is the facade-wired `resolveRunRepoContext`
  (`ExecutionServiceDependencies` / `CoreDependencies`), composed from the GitHub client +
  the executor's `resolveRepoTarget` via `makeResolveRunRepoContext` (`@cat-factory/server`)
  — wired in ALL THREE facades (Worker `selectGitHubDeps`, Node `githubGateDeps`, local
  inherits via `buildNodeContainer`). Unwired (tests / no GitHub) ⇒ hooks skip, engine
  unchanged. `runRepoOps` lives in `@cat-factory/agents` (so orchestration drives it
  without importing the server layer). The cross-runtime conformance suite asserts a
  registered kind's pre-op read + post-op commit on both runtimes.
- **`RepoFiles`** (`@cat-factory/kernel` `ports/repo-files.ts`): a per-run, checkout-free
  facade over the GitHub Git Data + contents API (`getFile`/`listDirectory`/`headSha`/
  `createBranch`/`commitFiles`/`openPullRequest`) — pure HTTP, so runtime-symmetric across
  Worker/Node/local (the Worker's lack of a filesystem stops mattering).
- **Frontend**: the workspace snapshot carries `customAgentKinds` (kind + presentation +
  container flag; assembled in `WorkspaceController`), which the SPA merges into its palette
  catalog (`useAgentsStore().registerCustomKinds`) so a registered kind is a first-class
  palette block + result view. A structured kind's `result.custom` is recorded on the step
  (`step.custom`) and rendered by the shared `generic-structured` result view
  (`StepResultViewHost.vue` → `GenericStructuredResultView.vue`) — no bespoke UI.
- **NOT yet done**: the built-in agents (blueprints/spec-writer/coder/merger/…) are not
  yet migrated to this model — their rendering still lives in the harness. Converting them
  one at a time (parity-gated, image-bumped per conversion) then deleting the bespoke
  harness handlers is the remaining strangler work.

## Unified agent runs (failure + retry surface)

Both container-backed flows — task `execution` and repo `bootstrap` — persist to
one `agent_runs` D1 table (kind-scoped), and the board surfaces their failure +
retry uniformly:

- Storage: `D1ExecutionRepository`/`D1BootstrapJobRepository` both target
  `agent_runs WHERE kind=…`; `D1AgentRunRepository` reads across kinds
  (`getRef` for retry dispatch, `listStale` for the sweeper).
- Sweeper: `sweepStuckRuns` (worker `infrastructure/workflows/sweeper.ts`, driven
  from `index.ts` `scheduled`) re-drives stale `running` runs of **both** kinds —
  so an evicted bootstrap is now re-driven too (the old known limitation is gone).
- Retry: `POST /workspaces/:ws/agent-runs/:id/retry` (`modules/agentRuns/
AgentRunController.ts`) resolves the kind via `getRef`, then calls
  `bootstrap.service.retry` / `executionService.retry`; returns `{ kind, run }`.
- Frontend: `stores/agentRuns.ts` (`useAgentRunsStore`) merges `snapshot.executions`
  - `snapshot.bootstrapJobs` into a per-block `byBlock` summary; the shared
    `components/board/AgentFailureCard.vue` renders the rose banner + retry on the
    board card, the inspector, and `TaskExecution.vue`. A failed execution now leaves
    its block `blocked` (NOT the old success-looking `pr_ready`).

## Board / service / repo-linkage model

- A "service" on the board is just a `Block` with `level: 'frame'`,
  `parentId: null`. Modules are sub-frames; tasks are leaves. See
  `app/types/domain.ts`, `backend/packages/contracts/src/entities.ts`,
  migration `0001_init.sql`.
- **A Block carries no repo fields.** Repo↔block linkage lives in the
  `github_repos` projection table via its `block_id` column
  (`D1RepoProjectionRepository.linkBlock()`).
- **Execution resolves the repo at runtime** via `resolveRepoTarget(workspaceId,
blockId)` (worker `infrastructure/container.ts`): find the `github_repos` row
  whose `block_id === blockId`, else fall back to `repos[0]`. So to make a
  bootstrapped repo a board service that tasks target correctly, the repo
  projection row must be linked to the new frame's block id.
- A workspace has exactly **one** GitHub installation but may have **many** repos.
- `BoardScanService.reconcileBlueprint()` (orchestration `src/modules/boardScan/BoardScanService.ts`)
  is the engine's blueprint reconciler: it maps a `blueprints` step's decomposition
  tree onto the run's existing service frame in place (match modules by name, add
  missing, refresh descriptions, never delete), falling back to spawning a fresh
  frame + modules only when the target frame can't be resolved.
- Drag-drop: `useBlockDrag.ts` (`reparentAt()`) → `POST /blocks/:id/reparent` →
  `BoardService.reparent()`. Tasks can move into frames or modules; modules into
  frames; frames cannot nest (`canReparent` in `board.logic.ts`).

## Individual-usage subscriptions (per-user, not pooled)

Vendors flagged `individualOnly` in `SUBSCRIPTION_VENDORS` (today `claude`, `codex`, and
`glm`) are licensed for individual use, so they are NEVER in the per-workspace pool:
`ProviderSubscriptionService` refuses them (409). They live in a separate per-USER store
with a distinct restricted mode. (At run time `claude`/`codex` always lease a personal
credential, while `glm` is dual-mode: it leases one only when the user has their own GLM
subscription, else it runs on the poolable Cloudflare base.) Full model + safeguards:
[`backend/docs/individual-subscription-usage.md`](./backend/docs/individual-subscription-usage.md).

- **Double-encrypted at rest** (`personal_subscriptions` ⇄ Drizzle):
  `system.encrypt(personal.seal(token, password))`. The inner layer
  (`WebCryptoPersonalSecretCipher`, PBKDF2→AES-GCM) is keyed by the user's personal
  **password**, which is never stored — so the token needs BOTH the system key AND the
  password to recover. `PersonalSubscriptionService` (integrations) owns it;
  `GET|POST|DELETE /personal-subscriptions` (user-scoped) is the API.
- **Per-run activation** (`subscription_activations`): at start/retry the user supplies
  their password (cached client-side with a TTL) → `activateForRun` re-encrypts the raw
  token with the SYSTEM key only, scoped to the run, so the async container steps lease it
  without the user present. Cleared when the run reaches terminal (`emitInstance` →
  `deleteByExecution`) and swept on TTL (Worker cron ⇄ Node retention timer).
- **Gating**: `personalGateForBlock`/`personalGateForRun` (server) resolve the block's
  individual vendor via `individualVendorForModelId`; a missing user/credential/password
  → `428 credential_required {vendor,reason}`, which the SPA's
  `personalSubscriptions` store turns into a password modal (then retries). The run
  records `initiatedBy`; `ContainerAgentExecutor` leases the initiator's activation
  (`leasePersonalSubscriptionToken`) for an individual vendor instead of the pool.
- **No recurring**: `RecurringPipelineService.fire` refuses a block on an individual-usage
  model (can't unlock unattended).

## Multi-runtime facades & cross-runtime conformance

The backend ships to two deployment targets, both serving the **same**
`@cat-factory/server` Hono app; each facade in `backend/runtimes/*` supplies only its
differentiators behind the shared kernel ports + the `container.gateways` seam.

- **Cloudflare Worker** (`runtimes/cloudflare`, `@cat-factory/worker`): D1 (SQLite),
  Cloudflare **Workflows** for durable execution, Durable Objects for real-time +
  per-run Containers, queues/cron, the `workers-ai` binding. The gold-standard flows
  above (execution, bootstrap) run on this facade.
- **Node service** (`runtimes/node`, `@cat-factory/node-server`): **Postgres via
  Drizzle** (the single persistence — there is no in-memory store), **pg-boss** for
  durable execution (`PgBossWorkRunner` enqueues an `execution.advance` job;
  `driveExecution` runs the same advance/poll loop the `ExecutionWorkflow` does, with
  plain async sleeps instead of durable steps; `signalDecision` re-enqueues a parked
  run). `start()` connects to `DATABASE_URL`, runs `migrate()`, boots pg-boss + the
  execution worker, attaches the **real-time WebSocket transport** to the HTTP listener,
  and serves over `@hono/node-server`. Async GitHub ingest still falls back to the
  inline/not-enabled paths for now. **Real-time** is implemented: `start()` creates a
  per-workspace `NodeRealtimeHub` (in-memory subscriber registry), wires a
  `NodeEventPublisher` (decorated with `FanOutEventPublisher`) as the engine's
  `executionEventPublisher` + an `InAppNotificationChannel`, and `attachRealtime`
  (`runtimes/node/src/realtime.ts`) accepts the SAME raw-WebSocket + `?ticket=` protocol
  the Worker serves via a `ws` server on the HTTP `upgrade` event (`@hono/node-server`
  can't upgrade from a Hono `Response`, and the SPA speaks raw WebSocket — not socket.io —
  so this keeps the client unchanged across runtimes). The ticket mint/verify is the
  shared `@cat-factory/server` `auth/wsTicket.ts` used by both the Worker's
  `EventsController` and this upgrade handler. Single-process only for now (a
  multi-replica deployment would front the hub with Postgres LISTEN/NOTIFY).
  **Container agent steps** (coder/mocker/tester/playwright/blueprints/ci-fixer/
  conflict-resolver/merger) run via the **same** shared `CompositeAgentExecutor` +
  `ContainerAgentExecutor` the Worker uses (now in `@cat-factory/server`),
  dispatching to a workspace's **self-hosted runner pool** — the Node facade has no
  built-in per-run container runtime, so it resolves the manifest-driven
  `RunnerPoolTransport` (in `@cat-factory/integrations`) instead of a Cloudflare
  Container. A pool runs the same executor-harness image, so it serves **every** dispatch
  kind: runtime parity is the default (see "Keep the runtimes symmetric"), so there is no
  opt-in allow-list — a new harness kind reaches the pool automatically, exactly as it
  does a Cloudflare container.
  Wired in `runtimes/node/src/container.ts` when the prerequisites are set
  (`GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`, `PUBLIC_URL`, `AUTH_SESSION_SECRET`,
  `ENCRYPTION_KEY`); persistence (`runner_pool_connections`,
  `github_installations`, `github_repos`) mirrors the D1 tables in `db/schema.ts`. When
  unconfigured the composite still serves inline kinds but fails container kinds loudly
  (no silent useless one-shot LLM call). NOTE: populating `github_installations` /
  `github_repos` still needs the GitHub connect/sync integration on Postgres (the
  remaining follow-up); the executor reads those rows once present.
- **Local mode** (`runtimes/local`, `@cat-factory/local-server`): the Node facade with
  the runner backend swapped for a **per-run local container** (`LocalContainerRunnerTransport`
  over a `ContainerRuntimeAdapter` for Docker/Podman/OrbStack/Colima/Apple `container`,
  injected via `buildNodeContainer`'s `resolveTransport` seam) and GitHub reached via a
  **PAT** — both the push token (`mintInstallationToken` seam) and a PAT-backed
  `FetchGitHubClient` (`githubClient` seam) that wires the CI gate + merge / mergeability
  providers, so a local pipeline gates on real Actions CI and **merges for real**.
  Reuses Node's Postgres/pg-boss/gateways unchanged. So a developer runs the whole
  product locally — agent containers clone/push/open real PRs on github.com via the PAT.
  Container kinds need a target repo's `github_repos`/`github_installations` rows seeded
  (the `linkRepo` helper does this from PAT-read metadata, since local mode has no App
  connect flow).
- **Model provisioning** is composed per facade from `@cat-factory/agents`'
  `CompositeModelProvider` (+ opt-in `@cat-factory/provider-bedrock`): Worker =
  workers-ai binding + direct vendors + Cloudflare-REST + Bedrock; Node = direct
  vendors + Cloudflare-REST + Bedrock (no binding). Unconfigured providers aren't
  registered, so `resolve` throws a clear error instead of failing deep in the SDK.
- **Locally-run models (per-user)** — Ollama / LM Studio / llama.cpp / vLLM / a custom
  OpenAI-compatible runner. Configured per USER in the UI ("My local runners"), stored in
  the `local_model_endpoints` table (D1 ⇄ Drizzle parity), validated on the fly via
  `LocalModelEndpointService.testConnection` (probes `/v1/models`). Enabled models are
  appended to `GET /models` dynamically (id `"<provider>:<model>"`) as the `direct` flavour
  gated by the `localModels` capability (the per-user set of enabled model ids — usability
  is model-granular, not just per-runner) — NO API key. At run time the LLM proxy + the
  inline model provider resolve the **run initiator's** endpoint and SKIP the DB key lease
  (the keyless local branch; `isProxyableProvider` + `isLocalRunner`), exactly like the
  personal-subscription initiator model. `parseLocalModelId` turns the dynamic id into a
  `ModelRef`. The base URL is forwarded server-side, so it's constrained to a loopback/LAN
  host allow-list (`localRunnerUrlError`) at the write boundary + the test probe (public
  hosts and the link-local metadata endpoint are rejected — anti-SSRF). Runtime-neutral and
  runs on the cross-runtime conformance suite; in practice only local/Node deployments reach
  `localhost`.

**Cross-runtime conformance** keeps the facades behaviourally identical:
`@cat-factory/conformance` exposes `defineConformanceSuite(harness)` — the key backend
behaviour (workspaces, board, the execution engine driven via the shared
`FakeAgentExecutor`) as runtime-neutral assertions parameterised by a
`ConformanceHarness` (`makeApp(agentOptions) → { call, createWorkspace, drive }`). The
Worker invokes it from `runtimes/cloudflare/test/integration/conformance.spec.ts`
(real D1, inside workerd); the Node service from `runtimes/node/test/conformance.spec.ts`
and the local facade from `runtimes/local/test/conformance.spec.ts` (both real Postgres
via `DATABASE_URL`, the latter building through `buildLocalContainer` with a fake agent
executor so the local wiring can't drift). All run the **same** assertions, so a
repository that maps a column differently or an engine path only one facade wires fails
a test instead of shipping. `runtimes/node/test/durable-execution.spec.ts` additionally
drives a run to completion through the real pg-boss runner.

## Conventions

- Hexagonal layering: controllers (`@cat-factory/server`) → services
  (orchestration/integrations) → ports (kernel); infra adapters live in each runtime
  facade and implement the ports + the `gateways` seam, wired in that facade's
  `container.ts` via constructor injection of a single `dependencies` object. Opt-in
  integrations (GitHub / environments / bootstrap) wire only when configured.
- **Dedicated result-view seam (frontend):** an agent step opens the generic prose panel
  (`AgentStepDetail.vue`) UNLESS its archetype declares a `resultView` id (`app/utils/catalog.ts`).
  The `ui` store's step dispatch (`dispatchStepView`, used by both `openStepDetail` and
  `openApprovalDetail`) routes such a step to `ui.resultView`; `StepResultViewHost.vue`
  renders the component registered for that id (`STEP_RESULT_VIEWS`). Give a new agent a
  bespoke window by declaring `resultView` + registering a component — no caller changes.
  `requirements-review` is the first consumer (the review window).
- **Final answer must land in the reply, not the reasoning channel.** Any agent whose
  deliverable IS its final reply (a document, report, or JSON object the platform reads
  or parses — spec-writer, blueprinter, merger, on-call, task-estimator, the tester
  report, the reviewers/companions, the requirements reviewer + rework, the design /
  review / test phases) MUST append the shared `FINAL_ANSWER_IN_REPLY` fragment
  (`@cat-factory/agents`, `prompts/shared.ts`). Some reasoning models (seen on
  `@cf/moonshotai/kimi-k2.7-code`) emit the whole answer into their private
  reasoning/thinking channel and return an empty visible reply; the harness reads only
  the visible content, so that empty reply fails the run via `unusableFinalAnswerCause`
  (executor-harness `pi-workspace.ts`) even though the model "answered". The fragment
  names the channel. It is applied centrally for `systemPromptFor` kinds (via the track
  prompts / `roleSystemPrompt`) and inline on the four container constants in
  `ContainerAgentExecutor.ts`. Do NOT append it to side-effect agents whose product is a
  pushed commit (coder/build, ci-fixer, conflict-resolver, mocker, playwright,
  business-documenter): they legitimately end with no final text. Editing a versioned
  prompt (`agents/kinds/versions.ts`) means bumping its number.
- The Worker's integration tests use the real `workerd` + real local D1
  (`@cloudflare/vitest-pool-workers`); the Node tests use real Postgres
  (`DATABASE_URL`, a Postgres 18 service in CI); only the LLM is faked in both. Run
  the full backend suite with `pnpm test:run` from the repo root (builds, then runs
  every package's `test:run`); CI provides the Postgres service for the Node suite.
