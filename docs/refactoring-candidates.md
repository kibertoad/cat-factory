# Refactoring candidates

High-impact refactoring opportunities identified across the backend engine, the
cross-runtime facades, and the frontend. Each entry is independent and can be scheduled
on its own. Sizes/structure reflect the tree at the time of writing.

The candidates are **ordered from least to most intrusive** — by blast radius and
disruption to existing code, not just effort. That ordering doubles as a recommended
sequence: land the contained, low-risk wins first and work down toward the structural
ones.

| #   | Candidate                                       | Area                | Impact    | Effort    |
| --- | ----------------------------------------------- | ------------------- | --------- | --------- |
| 1   | Shared OpenAI-compatible provider registry      | Cross-runtime       | Medium    | Low       |
| 2   | Generic row mappers                             | Backend persistence | Medium    | Low       |
| 3   | Store pattern factories                         | Frontend            | Medium    | Low       |
| 4   | Split the `ui.ts` store                         | Frontend            | High      | Medium    |
| 5   | Manifest-driven agent-kind registry             | Backend engine      | High      | Medium    |
| 6   | Module registry for the orchestration container | Backend DI          | High      | High      |
| 7   | Shared container builder (Node ⇄ Cloudflare)    | Cross-runtime       | High      | High      |
| 8   | Split `ExecutionService`                        | Backend engine      | Very high | Very high |

---

## 1. Shared OpenAI-compatible provider registry

**Files:** `backend/packages/agents/src/providers/endpoints.ts` (48 lines, holds
`DEFAULT_OPENAI_COMPATIBLE_BASE_URLS`) + per-facade gateway wiring
(`backend/runtimes/node/src/gateways.ts` and the Cloudflare equivalent).

**Problem.** The OpenAI-compatible vendor map (qwen / deepseek / moonshot / openai /
openrouter / litellm → base URL + env var) and the "if API key present, register a
resolver" loop are reconstructed per facade. Adding a vendor means edits in ~three places
with no compile-time sync guarantee.

**Approach.** Move registry construction into `@cat-factory/agents`
(`buildBaseProviderRegistry(env)`) driven by the single `DEFAULT_OPENAI_COMPATIBLE_BASE_URLS`
table; both facades call it and layer on their runtime-specific resolvers (workers-ai
binding, Cloudflare-REST, opt-in Bedrock).

**Why high-impact for the effort.** Low effort; a new vendor becomes a one-line table
entry that both runtimes pick up automatically. Least intrusive of the set — additive, a
small surface, no behavioural change.

## 2. Generic row mappers

**File:** `backend/packages/server/src/persistence/mappers.ts` — **419 lines**.

**Problem.** ~40 hand-written, manually-enumerated functions (`rowToWorkspace`,
`rowToBlock`, `blockInsertValues`, `blockPatchToColumns`, `rowToExecution`, …). A new
persisted field must be added to the row type, the `rowTo*` mapper, the `*InsertValues` /
`*PatchToColumns` writer, and the domain type — and a renamed column is only caught at
runtime if that mapper is exercised.

**Approach.** Introduce a small mapper factory driven by a per-entity field map (with
snake_case↔camelCase derivation and explicit JSON/serialized-column overrides), so each
entity declares its columns once and the read/insert/patch directions are generated. Keep
hand-written mappers only where shape genuinely diverges. Both D1 and Drizzle repos already
share this module, so the win lands on both runtimes at once.

**Why high-impact for the effort.** Low effort, removes a whole class of silent
schema-drift bugs, and shrinks the per-field change surface from 3–4 edits to 1. Contained
to one shared module, so the blast radius stays small.

## 3. Store pattern factories

**Files:** the upsert pattern appears in 13 stores under `frontend/app/app/stores/`
(`tasks`, `documents`, `notifications`, `agentRuns`, `bootstrap`, `accounts`,
`releaseHealth`, `pipelines`, `board`, `github`, …); the integration lifecycle
(probe / connect / disconnect / connectionFor) repeats across `tasks`, `documents`,
`providerConnections`.

**Problem.** Two duplicated patterns:

- Find-by-id upsert (`findIndex` → replace or prepend) reimplemented per store.
- Integration lifecycle (`available` flag + `probe()` + `connect()` + `disconnect()` +
  `connectionFor()`) reimplemented per integration store, with inconsistent error handling
  (some capture `probeError`, some swallow it).

**Approach.** Extract a shared `useUpsertList()` helper (find-by-key, replace-or-prepend,
optional Set-backed lookup for large lists) and a `createIntegrationStore()` factory that
standardizes probe/connect/disconnect + error handling. Stores keep only their
domain-specific bits.

**Why high-impact for the effort.** Low effort, removes ~20–30 duplicated lines per store,
and gives one place to fix/optimize list mutation and integration error handling. The
helpers are additive and adopted store-by-store, so each step is independently shippable.

## 4. Split the `ui.ts` store

**File:** `frontend/app/app/stores/ui.ts` — **735 lines**, ~109 state refs / handlers.

**Problem.** A single Pinia store owns 40+ unrelated UI concerns: modal/panel open-close
state (document import, task import, bootstrap, integrations, workspace/account settings),
navigation (selected/focus block, zoom, level-of-detail), transient context
(decision context, result-view dispatch, step detail), and vendor-specific UI
(sandbox, human-test, kaizen), plus per-modal deep-link params. Every modal interaction
touches this god object.

**Approach.** Split into domain-scoped stores — e.g. `uiModals`, `uiNavigation`,
`uiContext`, `uiVendor` — keeping the result-view dispatch seam
(`dispatchStepView`/`ui.resultView`) intact. Hot paths (zoom/pan/select) isolate from modal
state.

**Why high-impact.** Removes the central contention point for every new modal/panel,
shrinks the surface a feature must understand, and enables selective hydration. More
intrusive than the helpers above: the split ripples to every component that imports the
`ui` store, so consumers must be updated alongside it.

## 5. Manifest-driven agent-kind registry (finish the strangler work)

**File:** `backend/packages/server/src/agents/ContainerAgentExecutor.ts` — **1,795 lines**.

**Problem.** Two parallel hardcoded switches on `agentKind`:

- `switch (context.agentKind)` at ~line 1260 with 9 cases (`BLUEPRINTS`, `SPEC_WRITER`,
  `CI_FIXER`, `FIXER`, `CONFLICT_RESOLVER`, `MERGER`, `ON_CALL`, `TESTER`) building
  kind-specific job bodies + system prompts.
- A second `if (agentKind === …)` chain at ~line 1430 (`toRunResult`) coercing job output
  into domain shapes (`blueprintService`, `spec`, `mergeAssessment`, …).

`CLAUDE.md` explicitly flags this as unfinished strangler work: _"the built-in agents are
not yet migrated to this model — their rendering still lives in the harness."_ The public
extension seam already exists — `registerAgentKind` (`@cat-factory/agents`
`agents/kinds/registry.ts`) and `registerGate` (`@cat-factory/kernel`) — so custom agents
already avoid this switch; the built-ins are the holdout.

**Approach.** Register each built-in kind through the same `registerAgentKind` seam custom
agents use: a definition carrying `systemPrompt`, `buildJobBody`, and `toRunResult`. Both
switches collapse into registry lookups keyed off one source of truth. Convert one kind at
a time (parity-gated, image-bumped per conversion per `CLAUDE.md`), then delete the
bespoke branches.

**Why high-impact.** Removes a documented architectural debt, lets a deployment override
built-in prompts via the public seam, and means a new kind is a registration, not edits to
two switches in three files. Moderately intrusive: it touches the dispatch hot path and is
parity-gated/image-bumped per kind, but the one-kind-at-a-time path keeps each step small.

## 6. Module registry for the orchestration container

**File:** `backend/packages/orchestration/src/container.ts` — **1,894 lines**, 17
module-creation functions, **38 conditional spreads** (`...(x ? { x } : {})`) in the
`createCore()` return.

**Problem.** A monolithic composition root: all optional modules (GitHub, documents,
tasks, environments, runners, bootstrap, requirements, brainstorm, clarity, notifications,
slack, merge-presets, sandbox, settings, release-health, …) are wired linearly with
implicit ordering and ~38 conditional spreads. Adding an optional module touches the
creation function, the conditional wire-up, the return spread, and the `Core` interface.

**Approach.** A lightweight module-registry pattern: each module self-declares its
dependencies and a `create` factory; `createCore` resolves them in dependency order and
only instantiates modules whose prerequisites are configured (lazy/optional init). Order
becomes declared, not positional.

**Why high-impact.** Cuts the per-module change surface, makes optional wiring explicit and
testable, and removes the implicit-ordering footgun. Intrusive because it reshapes the
single composition root every module flows through. Pairs naturally with #7.

## 7. Shared container builder (Node ⇄ Cloudflare)

**Files:** `backend/runtimes/node/src/container.ts` (**1,833 lines**) and
`backend/runtimes/cloudflare/src/infrastructure/container.ts` (**1,843 lines**).

**Problem.** The two facade composition roots are near-identical: same repository wiring,
same service instantiation, same gateway composition — differing essentially only in which
concrete repository/gateway class is constructed. `CLAUDE.md`'s "keep the runtimes
symmetric" rule is currently enforced by hand: every new repository or integration must be
wired into **both** files, and forgetting one is a silent divergence caught only if a
conformance test happens to cover it.

**Approach.** Extract a `buildSharedContainer(config, repoFactory, gateways)` into
`@cat-factory/server` that holds the common wiring. Each facade supplies only a thin
`repoFactory` (D1 vs Drizzle constructors) and its gateways. The two ~1,840-line files drop
to a few hundred lines each, and parity becomes structural: there is one wiring list, not
two. Compose with #6 so the shared builder consumes the module registry.

**Why high-impact.** Eliminates the single largest parity-maintenance hazard in the repo
and makes "what does a container wire?" answerable in one place. Highly intrusive: it
rewrites both facade boot paths at once and must be conformance-verified on both runtimes.

> Note: the related "shared base repositories" idea (D1 ⇄ Drizzle dedup) was considered but
> **not** selected for this round; it can be revisited after #7 lands.

## 8. Split `ExecutionService` into step handlers + a completion-resolver registry

**File:** `backend/packages/orchestration/src/modules/execution/ExecutionService.ts` — **5,016 lines**, 67 methods, 46 injected dependencies.

**Problem.** A god class that owns run lifecycle, step orchestration, every decision gate
(requirements / clarity / brainstorm / human-test), agent dispatch, result recording,
spend metering, individual-vendor activation, approval gates, follow-ups, and companion
loops. Two methods concentrate the pain:

- `stepInstance()` — ~260-line guard chain with 27+ `if`/early-return branches keyed on
  step kind and gate type; branch _order_ is load-bearing and implicit (spend check must
  precede re-entrancy, gates must precede companion).
- `recordStepResult()` — ~400 lines of nested conditionals (decision parking, tester
  greenlight/withheld, PR open + issue writeback, blueprint/spec ingestion, companion and
  approval gates, follow-ups, custom post-ops, terminal finalization).

There are 23+ hardcoded `step.agentKind === CONSTANT` checks. Adding a step kind means
editing multiple branch chains, risking regressions in unrelated steps, and every test
must stand up the full service with all 46 deps.

**Approach.** Lift each step-kind branch into a `StepHandler` (`canHandle` / `handle`)
and register them in an ordered registry — mirroring the existing `GateDefinition`
registry the codebase already uses for gates (`kernel` `domain/gate-registry.ts`). Extend
the existing `StepCompletionResolver` seam (`buildStepResolverRegistry`) so
`recordStepResult` becomes a dispatch over resolvers instead of an inline conditional
tree. `ExecutionService` shrinks to lifecycle + the dispatch loop.

**Why high-impact.** Unblocks parallel feature work, makes per-kind logic unit-testable in
isolation, and removes the implicit-ordering hazard. The most intrusive item — it touches
the engine core that every run flows through — so it is best done incrementally, one step
kind at a time, behind the cross-runtime conformance suite.
