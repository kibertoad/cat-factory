# CLAUDE.md — architecture & flow notes

Orientation for working in this repo. High-level product docs live in
[`README.md`](./README.md) and [`backend/README.md`](./backend/README.md) +
`backend/docs/`. This file captures the **runtime flows** that are spread across
many files and are otherwise slow to re-derive.

## Layout

- `app/` — Nuxt SPA (`ssr: false`). Stores in `app/stores`, composables in
  `app/composables`, components in `app/components`, wire types in `app/types`.
- `backend/packages/contracts` — Valibot wire contracts shared by SPA + Worker.
- `backend/packages/core` — framework-agnostic domain: module services
  (`src/modules/*`), pure logic, and repository **ports** (`src/ports`).
- `backend/packages/worker` — Cloudflare Worker: Hono controllers
  (`src/modules/*/?*Controller.ts`), D1 repos + infra (`src/infrastructure/*`),
  the DI composition root (`src/infrastructure/container.ts`), Durable Objects,
  Workflows.
- `backend/packages/implementer-harness` — the payload that runs **inside** each
  per-run Cloudflare Container (the Pi coding-agent harness).

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
4. Inside the container, `runPi()` (`implementer-harness/src/pi.ts`) streams
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
  (`implementer-harness/src/bootstrap.ts`) threads `onProgress`/`signal` so Pi's
  todo-tool counts surface as `subtasks`. Sequence: clone (or empty dir) →
  `writeAgentsContext()` writes `AGENTS.md` → `runPi()` adapts → `reinitAndPush()`
  resets history to one commit and **force-pushes** to the default branch.
- Events: `DurableObjectEventPublisher.bootstrapChanged()` → `WorkspaceEventsHub`
  → SPA `useWorkspaceStream.ts` patches `stores/agentRuns.ts` (`upsertBootstrap`)
  + the board block. `BlockNode.vue` reads `agentRuns.byBlock[frameId]` to render
  the "bootstrapping…" badge + subtask progress bar, flipping to a ready service or
  the shared `<AgentFailureCard>` (failure hint + retry). Tracing logs (pino) run
  controller→service→workflow→bootstrapper→harness, queryable in the Cloudflare
  dashboard.

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
  + `snapshot.bootstrapJobs` into a per-block `byBlock` summary; the shared
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
