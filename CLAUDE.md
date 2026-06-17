# CLAUDE.md — architecture & flow notes

Orientation for working in this repo. High-level product docs live in
[`README.md`](./README.md) and [`backend/README.md`](./backend/README.md) +
`backend/docs/`. This file captures the **runtime flows** that are spread across
many files and are otherwise slow to re-derive.

## Known environment quirks

- **Worker tests fail on Windows** with `config wrangler validation failed` / 47 errors
  and "no tests" output. This is a pre-existing Windows-only wrangler issue, not caused
  by code changes. Use `pnpm test:run` from `backend/packages/kernel` (or any non-worker
  package) to verify logic changes; the worker integration suite only runs cleanly on Linux/macOS.

## Layout

One pnpm workspace (single root lockfile). Packages are sorted by visibility:
**published libraries** live in `backend/packages/*` + `frontend/app`, **private
packages** (the harnesses) in `backend/internal/*`, and the example
**deployments** (which carry the `wrangler.toml`s and config and depend on the
libraries) in `deploy/*`. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the
package/publish table.

- `frontend/app` — `@cat-factory/app`, the reusable **Nuxt layer** (`ssr: false`):
  the SPA source under `app/` (stores in `app/stores`, composables in
  `app/composables`, components in `app/components`, wire types in `app/types`).
  Published to npm; consumed by a deployment via `extends: ['@cat-factory/app']`.
- `backend/packages/contracts` — Valibot wire contracts shared by SPA + Worker.
- `backend/packages/prompt-fragments` — versioned best-practice prompt fragments.
- `backend/packages/core` — framework-agnostic domain: module services
  (`src/modules/*`), pure logic, and repository **ports** (`src/ports`).
- `backend/packages/worker` — `@cat-factory/worker`, the reusable Cloudflare Worker
  **library**: Hono controllers (`src/modules/*/?*Controller.ts`), D1 repos + infra
  (`src/infrastructure/*`), the DI composition root
  (`src/infrastructure/container.ts`), Durable Objects, Workflows. Exposes
  `createApp()`, the default fetch/scheduled/queue handler, and the DO/Workflow
  classes. Ships its D1 `migrations/`. Carries **no** production config; its own
  `wrangler.toml` is a stripped test/dev config (the vitest workers pool reads it).
- `backend/internal/executor-harness` — the payload that runs **inside** each
  per-run Cloudflare Container (the Pi coding-agent harness). Private (not on npm);
  its Docker image is published to **GHCR** by `docker-publish.yml`.
- `backend/internal/benchmark-harness` — headless agent benchmarking (`cat-bench`);
  private, not published.
- `deploy/backend` — example Worker deployment: a one-line `src/index.ts`
  re-exporting `@cat-factory/worker` + the full production `wrangler.toml`
  (`[vars]`, the GHCR runner `image`, `migrations_dir` →
  `node_modules/@cat-factory/worker/migrations`).
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
  `docker-publish.yml` republishes the GHCR runner image, gated on image-affecting
  paths (incl. the harness `package.json`, so a version bump re-tags the image).

## Execution flow (the canonical async + observable pattern)

This is the gold-standard pattern for long-running agent work. Anything new that
runs an agent in a container should mirror it.

1. `ExecutionService.start()` (core `modules/execution/ExecutionService.ts`)
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
- `BootstrapService.bootstrap()` (core `modules/bootstrap/BootstrapService.ts`):
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
  `startBootstrap` pre-flights (target exists, reachable, empty — only
  README/.gitignore/license/**AGENTS.md** tolerated, see `isBootstrapBoilerplate`),
  mints GH + proxy tokens, and dispatches `POST /bootstrap` (async, short timeout);
  `pollBootstrap` reads `GET /jobs/{id}` and maps the harness job view to running
  (with subtasks) / done (outcome) / failed.
- Harness: `/bootstrap` starts a **background job** in a `JobRegistry` (the same
  generic registry as `/run`), keyed by the job id; `handleBootstrap()`
  (`executor-harness/src/bootstrap.ts`) threads `onProgress`/`signal` so Pi's
  todo-tool counts surface as `subtasks`. Sequence: clone (or empty dir) →
  `writeAgentsContext()` writes `AGENTS.md` → `runPi()` adapts → `reinitAndPush()`
  resets history to one commit and **force-pushes** to the default branch.
- Events: `DurableObjectEventPublisher.bootstrapChanged()` → `WorkspaceEventsHub`
  → SPA `useWorkspaceStream.ts` patches `stores/agentRuns.ts` (`upsertBootstrap`)
  - the board block. `BlockNode.vue` reads `agentRuns.byBlock[frameId]` to render
    the "bootstrapping…" badge + subtask progress bar, flipping to a ready service or
    the shared `<AgentFailureCard>` (failure hint + retry). Tracing logs (pino) run
    controller→service→workflow→bootstrapper→harness, queryable in the Cloudflare
    dashboard.

## Service blueprints flow (in-repo map + board population)

A **Blueprinter** agent decomposes a repo into the canonical service → modules →
features tree and persists it **in the repo** under `blueprints/`, then the board
is reconciled from it. It is modelled as a normal pipeline step (`agentKind:
'blueprints'`), so it reuses the whole execution engine — no separate durable
runner.

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
  the shared `/jobs/{id}`. Every agent's `AGENTS.md` carries `BLUEPRINT_GUIDANCE`
  (pi.ts): read `overview.md` first, open a module file only when relevant.
- Worker: `ContainerAgentExecutor` builds a blueprint job for the `blueprints` kind
  — branch = the prior `coder` step's PR branch (`block.pullRequest.branch`) when
  present (mode `update`), else the repo default branch (mode `create`) — and
  dispatches it via `RunnerTransport.dispatch(id, body, 'blueprint')` (Cloudflare
  container only; `CompositeAgentExecutor` routes the kind to the container
  executor). The returned tree maps to `AgentRunResult.blueprintService`.
- Core: `ExecutionService.recordStepResult` ingests that tree — strict-parse, then
  `BoardScanService.reconcileBlueprint(frameId, service)` updates the run block's
  **service frame** in place (match modules/tasks by name, add missing, refresh
  descriptions, **never delete**), and emits a `board` event so the SPA refreshes.
- Triggers: `blueprints` is inserted after `coder` in the default pipelines (so the
  map + board refresh on the same implementation PR branch), and
  `BootstrapService.pollBootstrapJob` success starts the blueprint-only
  `pl_blueprint` pipeline against the new frame (best-effort) to create the initial
  map. A mapping-only run leaves a frame `ready` (not `done`).
- Not persisted to `repo_blueprints` on the pipeline path (the in-repo files are the
  source of truth and the board is the projection); the manual board-scan `scan`
  command still populates that table.

## Requirements review flow (stateless, synchronous reviewer agent)

A **reviewer** agent inspects a block's "collected requirements" — its
description plus any linked PRD/RFC docs and tracker issues — and raises a list of
review items (gaps / clarifications / assumptions / risks / questions). A human
answers or dismisses each; once all are settled the agent folds the answers back
into the block's description. Unlike `execution` / `bootstrap` this flow is
**stateless and synchronous**: no container, no durable driver, no real-time
events — every call runs an LLM inline (via the `ModelProvider` port, like the
document planner) and returns the updated entity, which the SPA patches directly.

- Wire contracts: `contracts/src/requirements.ts` (`RequirementReview` +
  `RequirementReviewItem`, item `category`/`severity`/`status`, request bodies).
  One **live review per block** (a new run replaces the prior one).
- Core: `RequirementReviewService` (`modules/requirements/`) — `review()` gathers
  context + LLM-generates items, `replyToItem()`/`setItemStatus()` mutate items,
  `incorporate()` requires every item settled (resolved/dismissed) then rewrites
  the block description via `blockRepository.update`. Pure prompt/parse logic is in
  `requirements.logic.ts`. Assembled by `createRequirementsModule` whenever
  `requirementReviewRepository` is wired; the model + linked doc/task repos are
  optional within the module.
- Persistence: `requirement_reviews` D1 table (migration `0021`,
  `D1RequirementReviewRepository`) — items as a JSON column, keyed by review id,
  `getByBlock` returns the current one.
- Worker: `RequirementReviewController` (`modules/requirements/`) mounts
  `GET|POST /blocks/:blockId/requirement-review`,
  `POST /requirement-reviews/:id/items/:itemId/reply`,
  `PATCH …/items/:itemId`, `POST …/:id/incorporate`. `selectRequirementsDeps`
  wires the repo + a `CloudflareModelProvider` + the agents' routing default ref +
  `resolveBlockModel`, so the reviewer resolves its model exactly like an agent
  step: a block's pinned model wins, else the default — which falls back to
  **Cloudflare Workers AI** unless a direct provider key is set (no key required).
- Frontend: `stores/requirements.ts` (load/review/reply/setItemStatus/incorporate;
  patches the board with the rewritten block on incorporate),
  `components/requirements/RequirementReviewModal.vue` (triggered from
  `InspectorPanel.vue`'s "Review requirements" button; shows an open-item count
  badge), `ui.requirementReviewBlockId` drives the modal. No stream event — the
  responses carry the updated review.

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
  `github_repos` projection table via its `block_id` column (migration
  `0004_github_projections.sql`; `D1RepoProjectionRepository.linkBlock()`).
- **Execution resolves the repo at runtime** via `resolveRepoTarget(workspaceId,
blockId)` (worker `infrastructure/container.ts`): find the `github_repos` row
  whose `block_id === blockId`, else fall back to `repos[0]`. So to make a
  bootstrapped repo a board service that tasks target correctly, the repo
  projection row must be linked to the new frame's block id.
- A workspace has exactly **one** GitHub installation but may have **many** repos.
- `BoardScanService.spawnBlueprint()` (core `modules/boardScan/BoardScanService.ts`)
  materialises a scanned repo as frame→modules→tasks but does **not** link the
  repo to the frame today.
- Drag-drop: `useBlockDrag.ts` (`reparentAt()`) → `POST /blocks/:id/reparent` →
  `BoardService.reparent()`. Tasks can move into frames or modules; modules into
  frames; frames cannot nest (`canReparent` in `board.logic.ts`).

## Conventions

- Hexagonal layering: controllers (worker) → services (core) → ports; infra
  adapters implement ports and are wired in `container.ts` via constructor
  injection of a single `dependencies` object. Opt-in integrations
  (GitHub / environments / board-scan / bootstrap) wire only when configured.
- Integration tests use the real `workerd` + real local D1
  (`@cloudflare/vitest-pool-workers`); only the LLM is faked. `pnpm test` from
  `backend/`.
