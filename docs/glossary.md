# Glossary & naming map

A single lookup for the vocabulary and naming traps that otherwise take grepping to resolve.
When code and docs use different words for the same thing, this is the reconciliation.

## Domain nouns — the unit of work

The canonical domain entity is a **`Block`**. The same underlying thing is called three names
depending on the layer — there is one entity, not three:

| Name      | Where it's used                                                    | Source of truth                                              |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| **block** | the domain + persistence + most of the API                         | `backend/packages/contracts/src/entities.ts` (`blockSchema`) |
| **task**  | at the **tracker/issue** boundary (linked GitHub/Jira/etc. issues) | `backend/packages/contracts/src/tasks.ts`                    |
| **card**  | the **UI/board** rendering of a block                              | `entities.ts` / `events.ts` (render metadata on the block)   |

### "task" means two different things

Both are in `backend/packages/contracts/src/primitives.ts`:

- **Block level** — `blockLevelSchema = ['frame', 'module', 'task', 'epic']`. A "service" on
  the board is a block with `level: 'frame'`, `parentId: null`; modules are sub-frames; **tasks
  are the leaves**. (See `CLAUDE.md` → "Board / service / repo-linkage model".)
- **Block type** — `blockTypeSchema`, a _separate_ axis (`taskType` field) chosen by the human
  at creation; drives the card's icon/badge and which pipeline runs.

So `level: 'task'` (a leaf in the hierarchy) is unrelated to the block **type** axis. Don't
conflate them.

## Runtime facades — directory ↔ package name

The three runtime facades under `backend/runtimes/*` don't all share their directory name with
their published package name (the `worker` name predates the `runtimes/` layout):

| Directory                     | Published package           | Platform                                    |
| ----------------------------- | --------------------------- | ------------------------------------------- |
| `backend/runtimes/cloudflare` | **`@cat-factory/worker`**   | Cloudflare Worker (D1, DO, Workflows)       |
| `backend/runtimes/node`       | `@cat-factory/node-server`  | Node.js service (Drizzle/Postgres, pg-boss) |
| `backend/runtimes/local`      | `@cat-factory/local-server` | local mode (Node + local containers + PAT)  |

And the example deployments under `deploy/*` rename the axis again: the **Cloudflare** deploy is
`deploy/backend` (`@cat-factory/deploy-backend`), not `deploy/cloudflare`. `deploy/node`,
`deploy/local`, `deploy/frontend` map straight through.

### Shared abstraction vs facade wiring (same class name, two files)

Four classes exist under **both** `backend/packages/server/src/agents/` and
`backend/runtimes/cloudflare/src/infrastructure/ai/` with identical basenames —
`CompositeAgentExecutor`, `ContainerAgentExecutor`, `ContainerRepoBootstrapper`,
`RunnerJobClient`. The rule:

- `…/packages/server/src/agents/*` = the **runtime-neutral shared abstraction** (used by every
  facade).
- `…/runtimes/cloudflare/src/infrastructure/ai/*` = the **Cloudflare wiring** of that abstraction.

When a search returns two hits, the one under a `runtimes/*` facade is the platform wiring.

## Executor vocabulary — runner / executor / transport / provider

These are used near-interchangeably; the definitions are the kernel ports
(`backend/packages/kernel/src/ports/`):

- **executor** — runs an agent _step_ to a result (`agent-executor.ts`; `CompositeAgentExecutor`
  routes a step's kind to the right one).
- **transport** — _how_ a job is dispatched to a container backend (`runner-transport.ts`):
  `CloudflareContainerTransport`, `RunnerPoolTransport`, `LocalContainerRunnerTransport`,
  `NativeRoutingRunnerTransport`. Each backend implements the same `RunnerTransport` port.
- **runner / work-runner** — the _durable driver_ that advances a run (`work-runner.ts`): the
  Worker's Workflows driver, Node's `PgBossWorkRunner`.
- **provider** — a pluggable vendor implementation behind a port (a **model** provider, a
  **CI-status** provider, a **release-health** provider, a **VCS** provider). Not a job runner.

## Concept indexes — where the cross-cutting things live

Short "where X lives" pointers for concepts that are spread across many files with no single
home.

### Gates

The step taxonomy is `CLAUDE.md` → "Gates vs agents". Code:

- Pure gate logic + the gate/helper **agent-kind constants** —
  `backend/packages/kernel/src/domain/gate-logic.ts`.
- The built-in gate suite (`ci`, `conflicts`, `post-release-health`, `on-call`) —
  `@cat-factory/gates` (`backend/packages/gates/src/gates.ts` + `providers.ts`), registered via
  the public `registerGate` seam.
- Gate _consumption_ (the engine driving them) — `backend/packages/orchestration/src/modules/
execution/` (`evaluateGate` / `dispatchGateHelper` / `pollGate` in the run engine).

### Agent kinds

`agentKindSchema` is an **open `v.string()`** (`contracts/src/primitives.ts`), not a closed
enum — the kinds are string constants across two homes:

- **Gate + helper kinds** (`ci`, `ci-fixer`, `conflicts`, `conflict-resolver`,
  `post-release-health`, `on-call`, `fixer`, `human-review`) — defined in
  `kernel/src/domain/gate-logic.ts` as `*_AGENT_KIND` constants.
- **Catalog agent kinds** (coder, spec-writer, blueprints, tester, merger, the companions, …) —
  `@cat-factory/agents` under `src/agents/kinds/` + `src/agents/prompts/`.
- **Custom/registered kinds** — added via `registerAgentKind` (`CLAUDE.md` → "Custom agents").

### D1 ⇄ Drizzle migration parity

Every persisted table has two schemas that must stay in step (`CLAUDE.md` → "Keep the runtimes
symmetric"):

- **Cloudflare (D1/SQLite)** — hand-numbered SQL across **four** dirs at the
  `backend/runtimes/cloudflare/` package root: `migrations/` (+ `telemetry-migrations/`,
  `sandbox-migrations/`, `migrations-provisioning/`). Duplicate numeric prefixes are fine (they
  apply in lexical order).
- **Node (Drizzle/Postgres)** — one `backend/runtimes/node/drizzle/` dir of generated migrations
  - the single source of truth `backend/runtimes/node/src/db/schema.ts`. It is a content-addressed
    DAG (`prevIds`), not a linear journal — see `CLAUDE.md` → "Resolving conflicting Drizzle
    migrations (post-merge)".

The two systems share no naming convention, so correlating a pair means reading the SQL bodies;
the cross-runtime conformance suite (`backend/internal/conformance`) is what actually asserts the
two stores behave identically.
