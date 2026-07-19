# Refactoring candidates

High-impact refactoring opportunities identified across the backend engine, the
cross-runtime facades, and the frontend. Each entry is independent and can be scheduled
on its own. Sizes/structure reflect the tree at the time of writing.

The candidates are **ordered from least to most intrusive** — by blast radius and
disruption to existing code, not just effort. That ordering doubles as a recommended
sequence: land the contained, low-risk wins first and work down toward the structural
ones.

| #   | Candidate                                       | Area           | Impact    | Effort |
| --- | ----------------------------------------------- | -------------- | --------- | ------ |
| 5   | Finish the manifest-driven agent-kind registry  | Backend engine | High      | Medium |
| 6   | Module registry for the orchestration container | Backend DI     | High      | High   |
| 7   | Shared base repositories (D1 ⇄ Drizzle)         | Cross-runtime  | High      | High   |
| 8   | Shared container builder (Node ⇄ Cloudflare)    | Cross-runtime  | Very high | High   |

See [Recently landed](#recently-landed) at the bottom for candidates that have since
shipped and were removed from the active list.

---

## 5. Finish the manifest-driven agent-kind registry (strangler work)

**Files:** `backend/packages/server/src/agents/jobBody.ts` (**440 lines**, holds the
remaining `switch (context.agentKind)` in `buildBespokeKindBody`) and
`backend/packages/server/src/agents/containerAgentResult.ts` (**285 lines**, holds the
remaining `toRunResult` `agentKind === …` chain). The dispatcher itself
(`ContainerAgentExecutor.ts`) is down to **975 lines** (from ~1,795).

**Problem.** The generic seam is now in place — a registered kind (custom _or_ migrated
built-in) that declares an `agent` step dispatches through `registeredAgentStep` →
`buildRegisteredAgentBody` with **no per-kind case**, and `ContainerAgentExecutor` builds
one shared `common` body + resolves auth once. But the built-in kinds are still the holdout,
in **two parallel switches**:

- `buildBespokeKindBody` (`jobBody.ts`) — a `switch (context.agentKind)` with the 9
  remaining built-in cases (`BLUEPRINTS`, `SPEC_WRITER`, `CI_FIXER`, `FIXER`,
  `CONFLICT_RESOLVER`, `MERGER`, `ON_CALL`, `TESTER`, `UI_TESTER`) building kind-specific
  job bodies + system prompts.
- `toRunResult` (`containerAgentResult.ts`) — an `if (agentKind === …)` chain coercing job
  output into domain shapes (`blueprintService`, `spec`, `mergeAssessment`, `onCallAssessment`,
  `testReport`, …) for those same kinds.

`CLAUDE.md` still flags this as unfinished strangler work: _"the built-in agents are not yet
migrated to this model — their rendering still lives in the harness."_

**Approach.** Convert the remaining built-ins onto the same `registerAgentKind` seam the
generic path already uses — a definition carrying `systemPrompt`, `buildJobBody`, and
`toRunResult` — one kind at a time (parity-gated, image-bumped per conversion per
`CLAUDE.md`), then delete each bespoke `switch`/`if` branch. Both switches collapse into
registry lookups keyed off one source of truth as the last kind migrates.

**Why high-impact.** Removes a documented architectural debt, lets a deployment override
built-in prompts via the public seam, and means a new kind is a registration, not edits to
two switches. The seam and the generic path already exist, so the remaining work is the
per-kind migration — moderately intrusive (it touches the dispatch hot path) but each step
is small and independently shippable.

**Status (further along than first written).** The bespoke _harness_ handlers are already
gone: every built-in kind now synthesizes an `AgentStepSpec` and dispatches through the ONE
generic `buildRegisteredAgentBody` path (see `buildMigratedBuiltInBody` in `jobBody.ts`) with
`kind:'agent'` — no per-kind harness endpoint, no image bump per conversion. What remains are
two thin _backend_ switches: `buildMigratedBuiltInBody` (built-in kind → its synthesized spec

- system/user prompt) and the `toRunResult` `agentKind === …` coercion chain
  (`containerAgentResult.ts`). The final step of this candidate is to fold those two into
  registry lookups off a single `registerAgentKind`-style definition per built-in (carrying its
  `buildJobBody` + `toRunResult`), so the switches collapse and a deployment can override a
  built-in's prompt through the public seam.

## 6. Module registry for the orchestration container

**File:** `backend/packages/orchestration/src/container.ts` — **2,146 lines**, ~17
module-creation functions, **~58 conditional spreads** (`...(x ? { x } : {})`) in the
`createCore()` return.

**Problem.** A monolithic composition root: all optional modules (GitHub, documents,
tasks, environments, runners, bootstrap, requirements, brainstorm, clarity, notifications,
slack, merge-presets, sandbox, settings, release-health, …) are wired linearly with
implicit ordering and dozens of conditional spreads (up from ~38 when this was first
written — the footgun is growing). Adding an optional module touches the creation function,
the conditional wire-up, the return spread, and the `Core` interface.

**Approach.** A lightweight module-registry pattern: each module self-declares its
dependencies and a `create` factory; `createCore` resolves them in dependency order and
only instantiates modules whose prerequisites are configured (lazy/optional init). Order
becomes declared, not positional.

**Why high-impact.** Cuts the per-module change surface, makes optional wiring explicit and
testable, and removes the implicit-ordering footgun. Intrusive because it reshapes the
single composition root every module flows through. Pairs naturally with #8.

## 7. Shared base repositories (D1 ⇄ Drizzle)

**Files:** the ~39 D1 repositories under
`backend/runtimes/cloudflare/src/infrastructure/repositories/` and their ~39 Drizzle twins
(now split per-domain under `backend/runtimes/node/src/repositories/drizzle/`, see
[Recently landed](#recently-landed) #2).

**Problem.** Every persisted table has **two** repository implementations — a D1 (SQLite)
one and a Drizzle (Postgres) one — that are behaviourally identical port implementations
differing only in the SQL dialect and the row shape. `CLAUDE.md`'s "keep the runtimes
symmetric" rule means every schema change, every new batch (`listByIds`-shaped) read, and
every new table must be written **twice**, and drift is caught only if a conformance test
happens to cover it. The shared `mappers.ts` (the field-map factory, now landed — see
[Recently landed](#recently-landed)) already removes the row↔domain duplication; the
query/CRUD bodies are what remain duplicated.

**Approach.** Extract the common CRUD/query shape (single-row read, batch `IN` read,
insert/patch via the shared mappers, chunked deletes) into a small dialect-parameterized base
so each concrete repository declares only its table + its genuinely dialect-specific queries.
The conformance suite already asserts parity, so the extraction can be verified per-repo.
This was previously deferred (see the note under #8); with the Drizzle file now split
([Recently landed](#recently-landed) #2) each pair sits side-by-side and the dedup is far
more tractable.

**Why high-impact.** Halves the per-table maintenance cost and turns "keep the runtimes
symmetric" from a hand-enforced rule into a structural property. Highly intrusive — it
reshapes both facades' persistence layers — so it is best done one repository pair at a time
behind the cross-runtime conformance suite. Compose with the now-landed Drizzle split and #8.

## 8. Shared container builder (Node ⇄ Cloudflare)

**Files:** `backend/runtimes/node/src/container.ts` (**2,453 lines**) and
`backend/runtimes/cloudflare/src/infrastructure/container.ts` (**2,258 lines**).

**Problem.** The two facade composition roots are near-identical: same repository wiring,
same service instantiation, same gateway composition — differing essentially only in which
concrete repository/gateway class is constructed. `CLAUDE.md`'s "keep the runtimes
symmetric" rule is currently enforced by hand: every new repository or integration must be
wired into **both** files, and forgetting one is a silent divergence caught only if a
conformance test happens to cover it. (The model-provider wiring is already shared via
`createScopedModelProviderResolver` — see [Recently landed](#recently-landed) #1 — which is
the proof-of-shape for doing the same to the rest of the container.)

**Approach.** Extract a `buildSharedContainer(config, repoFactory, gateways)` into
`@cat-factory/server` that holds the common wiring. Each facade supplies only a thin
`repoFactory` (D1 vs Drizzle constructors) and its gateways. The two ~2,300–2,450-line files
drop to a few hundred lines each, and parity becomes structural: there is one wiring list,
not two. Compose with #6 (so the shared builder consumes the module registry) and #7 (so the
`repoFactory` hands over deduped base repositories).

**Why high-impact.** Eliminates the single largest parity-maintenance hazard in the repo
and makes "what does a container wire?" answerable in one place. Highly intrusive: it
rewrites both facade boot paths at once and must be conformance-verified on both runtimes.

---

## Documentation follow-ups

Not code refactors, but recorded here so they aren't lost. The package-map completeness +
drift guard, the per-package `AGENTS.md` orientation layer, and `docs/glossary.md` have
landed; the remaining optional item:

- **Slim `CLAUDE.md` + move the flow narratives to co-located `docs/flows/*`.** `CLAUDE.md`
  is ~1,400 lines loaded every session, mixing durable working rules with long runtime-flow
  narratives (execution, bootstrap, blueprints, requirements review, merge/gate lifecycle,
  post-release health). Those narratives are the deepest well of otherwise-undocumented
  knowledge but live nowhere near the code they describe. A future pass could keep the rules +
  a concept index in `CLAUDE.md` and move each flow into a `docs/flows/<flow>.md` linked from
  both `CLAUDE.md` and the owning package's `AGENTS.md` — cutting per-session tokens and
  drift. Deferred because it is high-blast-radius (every inbound "CLAUDE.md → section" link
  moves) and pure documentation; do it as its own change, not folded into unrelated work.

---

## Recently landed

Removed from the active list because they have shipped. Kept here as a short audit trail.

### 1. Shared OpenAI-compatible provider registry ✅

The OpenAI-compatible vendor map and base-URL resolution are now unified in
`@cat-factory/agents`: `DEFAULT_OPENAI_COMPATIBLE_BASE_URLS` is the single table and
`resolveOpenAiCompatibleBaseUrl(provider, override)` the single resolver, both facades
routing through it (`baseUrlForNode` / the Worker's `baseUrlFor`). The "if key present,
register a resolver" loop is now the shared `createScopedModelProviderResolver`
(`@cat-factory/server`), consumed by both `runtimes/node/src/modelProvider.ts` and
`runtimes/cloudflare/src/infrastructure/container.ts`. Adding a vendor is now a one-line
table entry both runtimes pick up.

### 2. Split the monolithic Drizzle repositories file ✅

The ~5,000-line `backend/runtimes/node/src/repositories/drizzle.ts` (39 repository classes
in one module) is split into per-domain files under `repositories/drizzle/` — `board.ts`,
`execution.ts`, `accounts.ts`, `telemetry.ts`, `settings.ts`, `reviews.ts`, `kaizen.ts`,
`initiatives.ts`, `sandbox.ts`, `connections.ts`, plus a small `_shared.ts` for the one
cross-domain helper. `drizzle.ts` remains as a thin barrel that assembles the
`CoreRepositories` set (`createDrizzleRepositories`) and re-exports the handful of classes
consumed directly, so every `./repositories/drizzle.js` importer (index/container/test
harness) is unchanged. Pure code movement — no schema or behavioural change — verified by
the cross-runtime conformance suite. This is the precursor that makes #7 (shared base
repositories) tractable: each Drizzle repo now sits in its own file next to its D1 twin.

### 2 (candidate). Generic row mappers ✅

`backend/packages/server/src/persistence/mappers.ts` now drives EVERY non-divergent
row↔domain mapper off a declared field table. The `blocks` win (a single `blockFields`
table generating read/insert/patch) landed earlier; the two remaining hand-enumerated read
mappers — `rowToWorkspace` and `rowToPipeline` — are now folded onto the same "declare each
column once" pattern via a small read-only path (`makeRowReader` + the `readScalar` /
`readNullable` / `readJson` / `readOptJson` / `readFlag` / `readOptScalar` builders). These
two are read-only in this module (their repos bind columns positionally on write), so they
declare only the READ direction rather than a full three-way `FieldMapper`. `rowToExecution`
stays deliberately bespoke — it packs/unpacks a `detail` JSON envelope with tolerant
per-field parsers, a shape the factory doesn't model. So the only hand-written mappers left
are the genuinely-divergent ones. Verified by `test/mappers.spec.ts` (the flag / version /
availability / optional-JSON read semantics are pinned).

### 3 (candidate). Finish the store pattern-factory adoption ✅

Every plain find-by-key upsert store now routes list mutation through the shared
`useUpsertList` composable; the last holdout — the `agentRuns` store's `envConfigRepairJobs`
list (a plain prepend + replace-in-place, no monotonic guard) — is migrated, so the only
remaining hand-rolled `findIndex` sites are the deliberately-divergent monotonic/reconcile-guarded
stores (`execution`, `board`, `workspace`, `environmentTest`, and `agentRuns`' bootstrap list)
plus `infraConfig`'s composite-key `upsertInto`. The `useSourceIntegration` factory already
backs the document + task source stores. Verified by `app/stores/agentRuns.spec.ts`.

### 4 (candidate). Split the `ui.ts` store ✅

The 828-line `stores/ui.ts` god-store (40+ unrelated UI concerns) is decomposed into three
cohesive, independently-testable slices under `stores/ui/`: `navigation.ts` (selection /
focus / zoom / LOD — the hot paths, isolated from modal state), `resultViews.ts` (the
`dispatchStepView` / `ui.resultView` overlay seam + the observability + Kaizen panels), and
`modals.ts` (every modal / panel open-close flag, hub came-from markers, deep-link params,
and the startup + AI-onboarding advisories). `ui.ts` is now a thin facade that composes the
three and re-exports the SAME public surface (all 184 keys, verified identical), so every
existing `useUiStore()` consumer is untouched — the split is internal. Promoting a slice to a
separately-consumed store (for selective hydration) is a future, opt-in follow-up; the
maintainability win (each concern in its own file, no central contention point) is realized
now. Verified by `nuxt typecheck`.

### 8 (original). Split `ExecutionService` into step handlers + a completion-resolver registry ✅

`ExecutionService.ts` is down to ~2,549 lines (from 5,016), with the spine extracted into
`RunDispatcher` / `RunStateMachine` / `StepGraph` / the gate controllers + sub-facades, and
the constructor trimmed of its vestigial fields. The step-handler and completion-resolver
registries (`step-handler-registry.ts`, `buildStepResolverRegistry`) are in place. The
run/step lifecycle reference (and the recorded decision not to adopt XState) lives in
[`execution-state-machine.md`](./execution-state-machine.md).

> **Follow-on watch item.** The split moved much of the complexity into
> `RunDispatcher.ts` (**2,779 lines**, ~30 injected deps, a ~256-line `pollAgentJob`),
> which is now the largest engine file. It is not yet a headline candidate — it is a clean,
> freshly-extracted seam — but if it keeps accreting per-kind polling logic it is the next
> place to apply the same handler-registry treatment.

### Engine god-file split, round 2 (+ the re-accretion guard) ✅

The watch item above came true — by the July 2026 quality review
([`code-quality-observability-extensibility-review-2026-07.md`](./code-quality-observability-extensibility-review-2026-07.md)
§4/#5) `RunDispatcher.ts` had regrown to **4,217** lines and `ExecutionService.ts` to
**3,707**. The split was resumed along the review's prescription, pure code movement with no
behaviour change (verified by the full orchestration suite + cross-runtime conformance):

- `ExecutionService.ts` → **~2,775 lines**: the start/retry/restart `assert*` admission
  family (frame type, tester infra, deployer config/ordering, binary storage, provider/preset
  satisfiability, budget, task limit, dependencies) moved to **`RunAdmission.ts`**, and the
  requirements/clarity/brainstorm `ReviewKind` builders + the clarity investigation helpers
  moved to **`review-kinds.ts`** (plain factories over a shared deps closure).
- `RunDispatcher.ts` → **~3,135 lines**: the deterministic deployer family (the multi-frame
  provision fan-out, the async deploy-job poll, the environment projection) moved to
  **`DeployerStepController.ts`**, and the follow-up companion gate + its human-action API
  (file / queue / answer / dismiss) moved to **`FollowUpGateController.ts`** — both wired as
  controller collaborators exactly like the existing gate controllers, with the completion
  hub + shared poll folds injected back as callbacks so the paths can't drift.
- **Re-accretion now fails CI instead of an audit**: `scripts/check-file-size.mjs` (run in
  the `repo-guards` job) enforces a soft 1,500-line budget on non-test source files, with
  shrink-only ratcheted allowances for the remaining legacy oversized files (the DI roots,
  `entities.ts`, `suite.ts`, …). Lower a file's allowance in the PR that shrinks it.
