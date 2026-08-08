# Glossary & naming map

A single lookup for the vocabulary and naming traps that otherwise take grepping to resolve.
When code and docs use different words for the same thing, this is the reconciliation.

## Domain nouns: the unit of work

The canonical domain entity is a **`Block`**. The same underlying thing is called three names
depending on the layer: there is one entity, not three:

| Name      | Where it's used                                                    | Source of truth                                              |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| **block** | the domain + persistence + most of the API                         | `backend/packages/contracts/src/entities.ts` (`blockSchema`) |
| **task**  | at the **tracker/issue** boundary (linked GitHub/Jira/etc. issues) | `backend/packages/contracts/src/tasks.ts`                    |
| **card**  | the **UI/board** rendering of a block                              | `entities.ts` / `events.ts` (render metadata on the block)   |

### "task" means two different things

Both are in `backend/packages/contracts/src/primitives.ts`:

- **Block level**: `blockLevelSchema = ['frame', 'module', 'task', 'epic']`. A "service" on
  the board is a block with `level: 'frame'`, `parentId: null`; modules are sub-frames; **tasks
  are the leaves**. (See `CLAUDE.md` → "Board / service / repo-linkage model".)
- **Block type**: `blockTypeSchema`, a _separate_ axis (`taskType` field) chosen by the human
  at creation; drives the card's icon/badge and which pipeline runs.

So `level: 'task'` (a leaf in the hierarchy) is unrelated to the block **type** axis. Don't
conflate them.

## Runtime facades: directory ↔ package name

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
`backend/runtimes/cloudflare/src/infrastructure/ai/` with identical basenames:
`CompositeAgentExecutor`, `ContainerAgentExecutor`, `ContainerRepoBootstrapper`,
`RunnerJobClient`. The rule:

- `…/packages/server/src/agents/*` = the **runtime-neutral shared abstraction** (used by every
  facade).
- `…/runtimes/cloudflare/src/infrastructure/ai/*` = the **Cloudflare wiring** of that abstraction.

When a search returns two hits, the one under a `runtimes/*` facade is the platform wiring.

## Executor vocabulary: runner / executor / transport / provider

These are used near-interchangeably; the definitions are the kernel ports
(`backend/packages/kernel/src/ports/`):

- **executor**: runs an agent _step_ to a result (`agent-executor.ts`; `CompositeAgentExecutor`
  routes a step's kind to the right one).
- **transport**: _how_ a job is dispatched to a container backend (`runner-transport.ts`):
  `CloudflareContainerTransport`, `RunnerPoolTransport`, `LocalContainerRunnerTransport`,
  `NativeRoutingRunnerTransport`. Each backend implements the same `RunnerTransport` port.
- **runner / work-runner**: the _durable driver_ that advances a run (`work-runner.ts`): the
  Worker's Workflows driver, Node's `PgBossWorkRunner`.
- **provider**: a pluggable vendor implementation behind a port (a **model** provider, a
  **CI-status** provider, a **release-health** provider, a **VCS** provider). Not a job runner.

## MCP: one protocol, two unrelated surfaces

"MCP" names two things in this repo that share nothing but the protocol; a search for it hits both.

- **Tool server** (consuming): an MCP server an AGENT may call, registered on the
  `AgentKindRegistry` (`registerToolServer` / `assignToolServers`) and wired into the run
  container's agent CLI. Doc: `backend/docs/mcp-tool-servers.md`.
- **`@cat-factory/mcp-server`** (serving, `sdk/mcp`): the public `/api/v1` surface exposed AS an
  MCP server for external hosts, both as the `cat-factory-mcp` stdio binary and the hosted
  `POST /api/v1/mcp` endpoint. Doc: `sdk/mcp/README.md`.

So a "tool server" is always the consuming side; the package literally named `mcp-server` is the
serving side, and neither imports the other.

## Gatekeeper: one pattern, three packages

"Gatekeeper" names a credential-holding front-end over the public API (the Cloudflare OS
integration pattern), and it is spread across three packages that a search hits together. None of
them is part of the backend: all three consume `/api/v1` and the outbound webhook contract as an
outside integrator would.

| Piece                   | Package                            | What it is                                                                        | Taken by |
| ----------------------- | ---------------------------------- | --------------------------------------------------------------------------------- | -------- |
| `sdk/gatekeeper`        | `@cat-factory/gatekeeper-bindings` | the GENERATED per-operation policy table (`minScope`, consequence, invoke thunks) | install  |
| `sdk/gatekeeper-worker` | `@cat-factory/gatekeeper-worker`   | the hand-written Worker machinery: capability surface, key broker, approval inbox | install  |
| `deploy/gatekeeper`     | `@cat-factory/deploy-gatekeeper`   | the unpublished deployment template: the policy file and wrangler bindings        | copy     |

So "the bindings" are data, "the worker" is machinery, and "the template" is the one file an
operator really writes (`policy.config.ts`). Docs: each package's README; design record:
`docs/initiatives/cloudflare-os-gatekeeper.md`.

## Concept indexes, where the cross-cutting things live

Short "where X lives" pointers for concepts that are spread across many files with no single
home.

### Gates

The step taxonomy is `CLAUDE.md` → "Gates vs agents". Code:

- Pure gate logic + the gate/helper **agent-kind constants**:
  `backend/packages/kernel/src/domain/gate-logic.ts`.
- The built-in gate suite (`ci`, `conflicts`, `post-release-health`, `on-call`):
  `@cat-factory/gates` (`backend/packages/gates/src/gates.ts` + `providers.ts`), registered via
  the public `registerGate` seam.
- Gate _consumption_ (the engine driving them): `backend/packages/orchestration/src/modules/
execution/` (`GateStepController.evaluate` / `GateHelperDispatcher.dispatch` / `pollGate`).

### Judges

The FOURTH step-taxonomy bucket (`CLAUDE.md` → "Gates vs agents"): an inline LLM verdict against
a **rubric**, compared to a per-task threshold, disposed as advance / park / **bounce** / fail.
Distinct from a gate (whose `probe()` is a cheap programmatic precheck) and from a step resolver
(which cannot park or loop a run). Code:

- The registry + the definition a deployment supplies:
  `backend/packages/kernel/src/domain/judge-registry.ts`; the pure disposition rules:
  `judge-logic.ts` (`disposeJudgeVerdict` / `renderJudgeRework`).
- Judge _consumption_ (the engine driving them):
  `backend/packages/orchestration/src/modules/execution/JudgeStepController.ts`; the inline
  assessor behind it: `JudgeService.ts`.
- The worked example: `backend/internal/example-custom-agent` (`scope-adherence`).
- Design + non-goals: `docs/initiatives/judge-registry.md`.

### Reusable operations vs custom task types

**"Reusable operation" is the product word for a PATTERN, not a type, a registry or a wire
field.** The mechanism is the custom TASK TYPE everywhere an id or a schema appears
(`TaskTypeRegistry`, the snapshot's `customTaskTypes`, the persisted `taskTypeFields.custom`),
exactly as "initiative preset" is the product word over `InitiativePresetRegistration`. Do not go
looking for an `OperationRegistry`: there is none, deliberately.

A registered `CustomTaskType` is an operation once it carries the whole bundle: `fields` (the
per-case form, folded into every agent's prompt), `defaultFragmentIds` (its standing context) and
`defaultPipelineId` (its canned pipeline). Carrying only `presentation` it is a work-item
CLASSIFICATION: a badge and a card. Code:

- The registry + the run-time projection: `kernel/src/domain/task-type-registry.ts` +
  `task-type-context.ts` (`describeCustomTaskType`); the wire descriptor:
  `contracts/src/task-types.ts`.
- Creation-time resolution (fragment union, pipeline pin, field validation):
  `orchestration/src/modules/board/taskTypeCreationDefaults.ts`.
- The prompt fold: `agents/src/agents/prompts/standard.ts` (`customTaskTypeSection`), emitted at
  three sites (see the doc: missing one silently drops an operation's parameters).
- The worked example: `backend/internal/example-custom-agent` (`org:introduce-api`).
- Model + boundary against initiative presets: `backend/docs/reusable-operations.md`.

### Agent kinds

`agentKindSchema` is an **open `v.string()`** (`contracts/src/primitives.ts`), not a closed
enum: the kinds are string constants across two homes:

- **Gate + helper kinds** (`ci`, `ci-fixer`, `conflicts`, `conflict-resolver`,
  `post-release-health`, `on-call`, `fixer`, `human-review`): defined in
  `kernel/src/domain/gate-logic.ts` as `*_AGENT_KIND` constants.
- **Catalog agent kinds** (coder, spec-writer, blueprints, tester, merger, the companions, …):
  `@cat-factory/agents` under `src/agents/kinds/` + `src/agents/prompts/`.
- **Custom/registered kinds**: added via `registerAgentKind` (`CLAUDE.md` → "Custom agents").
- **Judge kinds**: a deployment's own, registered on the app-owned `JudgeRegistry`; the platform
  ships none (see "Judges" above).

### Bug-triage step vocabulary

The recurring `pl_bug_triage` pipeline (`BUG_TRIAGE_PIPELINE_ID`, `kernel/src/domain/seed.ts`;
full design in [`backend/docs/bug-triage-pipeline.md`](../backend/docs/bug-triage-pipeline.md))
introduces three kinds whose names invite confusion:

- **`bug-intake`**: a one-shot **non-LLM engine step** (like `tracker`), NOT an agent. It is the
  **inbound dual of `tracker`**: `tracker` FILES a new ticket from an analysis; `bug-intake` PULLS
  one matching open issue from the schedule's configured tracker board, marks it in-progress, and
  reseeds the recurring block from it. Config lives on the **schedule** (`issueIntake`), not the
  pipeline. No matching issue ⇒ the run completes successfully with the rest of the steps skipped.
  Trap: an inbound tracker WEBHOOK does not run this step; it fires the SCHEDULE, which then runs
  it unchanged. So "push-driven intake" and "the recurring intake" are the same code reached
  sooner, and the fired run may legitimately pick a different, older issue than the one that
  triggered it (see `backend/docs/adr/0032-tracker-webhook-intake.md`).
- **`bug-investigator`**: a **structured `container-explore`** registered kind (read-only,
  multi-repo). Its `clarity`/`questions` drive the adjacent `clarity-review` gate; `clear`
  auto-passes with no human park.
- **`repro-test`**: a **structured `container-coding`** registered kind that writes a failing
  reproduction test. Trap: it **SEEDS the shared work branch (`cat-factory/<blockId>`) but does
  NOT open the PR** (`opensPr: false`); the following `coder` resumes that branch and opens the one
  PR. A `not_reproducible` concession NEVER fails the run (`noChangesTolerated: true`).
- **Reproduction proof**: the MACHINE verification of that kind's claim, distinct from the claim
  itself: its `outcome` field is the model's own assertion, while the proof is the harness running
  the declared `command` against the pre-fix tree and the final tree. Only red-then-green counts
  (`reproduced`); anything else is `inconclusive`, and a concession is recorded as
  `declared_infeasible` with the agent's stated alternative verification. Opted in per task via
  the `coder.reproductionProof` tri-state, published on the run's PR report. See
  [`backend/docs/adr/0033-bugfix-reproduction-proof.md`](../backend/docs/adr/0033-bugfix-reproduction-proof.md).

### Bug hunt vs bug intake vs bug triage

Three names that all mean "get a bug off a tracker board and fix it", and pointing at the wrong
one is the usual confusion:

- **`bug-triage`** (`pl_bug_triage`): the recurring PIPELINE. A schedule fires it on a cadence and
  it claims the OLDEST matching open issue unattended. `availability: 'recurring'`, so a one-off
  manual start is refused. Full design in
  [`backend/docs/bug-triage-pipeline.md`](../backend/docs/bug-triage-pipeline.md).
- **`bug-intake`**: the non-LLM engine STEP inside that pipeline (see the step vocabulary above).
  It is the part that does the claiming; it exists only as a pipeline step and has no interactive
  surface.
- **Bug hunt**: the INTERACTIVE surface, and not a pipeline or a step at all. A human picks a
  tracker board, a `bug-hunter` inline model rates its open + UNASSIGNED bugs on impact against
  complexity, and the human confirms one; the confirmed candidate is adopted as a `bug` task on
  `pl_bugfix` (the ONE-OFF bug-fix pipeline, not `pl_bug_triage`). It persists nothing of its own.
  Full design in [`backend/docs/bug-hunt.md`](../backend/docs/bug-hunt.md).

Two traps. **`bug-hunter` is an inline agent kind for the RATING only**: it never touches a
checkout and never becomes a pipeline step; the actual work runs through `pl_bugfix` afterwards.
And a hunt filters to UNASSIGNED issues while the recurring intake does not: intake works a
backlog the team already agreed to, a hunt looks for work nobody has taken.

### D1 ⇄ Drizzle migration parity

Every persisted table has two schemas that must stay in step (`CLAUDE.md` → "Keep the runtimes
symmetric"):

- **Cloudflare (D1/SQLite)**: hand-numbered SQL across **five** dirs at the
  `backend/runtimes/cloudflare/` package root: `migrations/` (+ `telemetry-migrations/`,
  `sandbox-migrations/`, `migrations-provisioning/`, `audit-migrations/`), one per D1 binding.
  Duplicate numeric prefixes are fine (they apply in lexical order).
- **Node (Drizzle/Postgres)**: one `backend/runtimes/node/drizzle/` dir of generated migrations
  - the single source of truth `backend/runtimes/node/src/db/schema.ts`. It is a content-addressed
    DAG (`prevIds`), not a linear journal: see `CLAUDE.md` → "Resolving conflicting Drizzle
    migrations (post-merge)".

The two systems share no naming convention, so correlating a pair means reading the SQL bodies;
the cross-runtime conformance suite (`backend/internal/conformance`) is what actually asserts the
two stores behave identically.
