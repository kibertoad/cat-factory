# Refactoring candidates

High-impact refactoring opportunities identified across the backend engine, the
cross-runtime facades, and the frontend. Each entry is independent and can be scheduled
on its own. Sizes/structure reflect the tree at the time of writing.

The candidates are **ordered from least to most intrusive**: by blast radius and
disruption to existing code, not just effort. That ordering doubles as a recommended
sequence: land the contained, low-risk wins first and work down toward the structural
ones.

| #   | Candidate                                       | Area          | Impact    | Effort | Status                                     |
| --- | ----------------------------------------------- | ------------- | --------- | ------ | ------------------------------------------ |
| 6   | Module registry for the orchestration container | Backend DI    | High      | High   | registry + split landed; DI-graph deferred |
| 7   | Shared base repositories (D1 ⇄ Drizzle)         | Cross-runtime | High      | High   | todo                                       |
| 8   | Shared container builder (Node ⇄ Cloudflare)    | Cross-runtime | Very high | High   | todo                                       |

See [Recently landed](#recently-landed) at the bottom for candidates that have since
shipped and were removed from the active list.

---

## 6. Module registry for the orchestration container: **landed (registry + split); DI-graph deferred**

**File:** `backend/packages/orchestration/src/container.ts` (was **3,019 lines**), now split
into `container.ts` (~1,890 lines: the `CoreDependencies`/`Core` contract + the spine
assembly), `container/modules.ts` (the ~30 optional-module factory functions), and
`container/module-registry.ts` (the `ModuleRegistry`).

**Problem (as landed).** A monolithic composition root: all optional modules (GitHub,
documents, tasks, environments, runners, bootstrap, requirements, brainstorm, clarity,
notifications, slack, merge-presets, sandbox, settings, release-health, …) were wired
linearly, each as a `const x = createX(...)` local **plus** a matching
`...(x ? { x } : {})` conditional spread in the `createCore()` return; ~40 of each, up from
~38 when this was first written (the footgun was growing). Adding an optional module touched
the creation function, the conditional wire-up, the return spread, and the `Core` interface:
a four-site edit.

**What landed.** The optional set is now DECLARED through a typed `ModuleRegistry`
(`container/module-registry.ts`): each module is `build(key, factory)`-declared once,
instantiated only when its factory yields a value (prerequisites configured), kept in the local
`build` returns so a downstream factory can thread it in (`get(key)` reads any built module for a
reader that holds no local), and emitted in ONE place via `...modules.assemble()` at the
return, so the ~40 conditional return-spreads are gone and adding a module is a `build(...)`
call plus its `OptionalCoreModules` field (down from four sites to two). `Core` is split into
`CoreSpine` (always-present) + `OptionalCoreModules` (the registry-assembled optionals), and
the ~30 `createXModule` factories moved to `container/modules.ts`, cutting the god-file from
3,019 to ~1,890 lines. Behaviour is unchanged (the registration order below IS the old
positional order) verified by the orchestration suite (824 tests) + cross-runtime
conformance, with a dedicated `module-registry.spec.ts` pinning the registry's contract.

**Deferred (intentionally).** The registry is a sequential builder, NOT a topological DI
graph: the core spine keeps genuine circular late-bindings (account ⇄ spend, engine ⇄
initiative loop) that a declarative dependency resolver can't express cleanly, so the spine
stays explicit and only the acyclic optional modules flow through the registry. Promoting the
registry to a full declared-dependency graph (each module naming its prerequisites, resolved
in dependency order) is the remaining slice, but the change-surface + footgun win is realized
now. Pairs naturally with #8 (the shared container builder consumes this registry).

## 7. Shared base repositories (D1 ⇄ Drizzle)

**Files:** the ~39 D1 repositories under
`backend/runtimes/cloudflare/src/infrastructure/repositories/` and their ~39 Drizzle twins
(now split per-domain under `backend/runtimes/node/src/repositories/drizzle/`, see
[Recently landed](#recently-landed) #2).

**Problem.** Every persisted table has **two** repository implementations: a D1 (SQLite)
one and a Drizzle (Postgres) one: that are behaviourally identical port implementations
differing only in the SQL dialect and the row shape. `CLAUDE.md`'s "keep the runtimes
symmetric" rule means every schema change, every new batch (`listByIds`-shaped) read, and
every new table must be written **twice**, and drift is caught only if a conformance test
happens to cover it. The shared `mappers.ts` (the field-map factory, now landed: see
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
symmetric" from a hand-enforced rule into a structural property. Highly intrusive (it
reshapes both facades' persistence layers) so it is best done one repository pair at a time
behind the cross-runtime conformance suite. Compose with the now-landed Drizzle split and #8.

## 8. Shared container builder (Node ⇄ Cloudflare)

**Files:** `backend/runtimes/node/src/container.ts` (**3,085 lines**) and
`backend/runtimes/cloudflare/src/infrastructure/container.ts` (**2,710 lines**).

**Problem.** The two facade composition roots are near-identical: same repository wiring,
same service instantiation, same gateway composition; differing essentially only in which
concrete repository/gateway class is constructed. `CLAUDE.md`'s "keep the runtimes
symmetric" rule is currently enforced by hand: every new repository or integration must be
wired into **both** files, and forgetting one is a silent divergence caught only if a
conformance test happens to cover it. (The model-provider wiring is already shared via
`createScopedModelProviderResolver`: see [Recently landed](#recently-landed) #1, which is
the proof-of-shape for doing the same to the rest of the container.)

**Approach.** Extract a `buildSharedContainer(config, repoFactory, gateways)` into
`@cat-factory/server` that holds the common wiring. Each facade supplies only a thin
`repoFactory` (D1 vs Drizzle constructors) and its gateways. The two ~2,700–3,100-line files
drop to a few hundred lines each, and parity becomes structural: there is one wiring list,
not two. Compose with #6 (so the shared builder consumes the module registry) and #7 (so the
`repoFactory` hands over deduped base repositories).

**Why high-impact.** Eliminates the single largest parity-maintenance hazard in the repo
and makes "what does a container wire?" answerable in one place. Highly intrusive: it
rewrites both facade boot paths at once and must be conformance-verified on both runtimes.

---

## Documentation follow-ups

Not code refactors, but recorded here so they aren't lost. The package-map completeness +
drift guard, the per-package `AGENTS.md` orientation layer, `docs/glossary.md`, and the
`CLAUDE.md` slim-down have landed; the remaining optional item:

- **Move the surviving flow entries to co-located `docs/flows/*`.** `CLAUDE.md` has been cut
  roughly in half: the flow narratives are now a short INDEX (what the flow is + the trap a
  change would hit + a link to its ADR/initiative doc), the rules those flows established are
  hoisted into state-once sections (concurrency/idempotency, untrusted text, degrade loudly,
  harness rules), the package-by-package layout defers to the root README's CI-guarded table,
  and three descriptive sections whose content lives in `backend/docs/` were dropped outright.
  What remains for a future pass is relocation rather than deletion: each index entry could
  become a `docs/flows/<flow>.md` linked from both `CLAUDE.md` and the owning package's
  `AGENTS.md`, for the flows that have no ADR/initiative doc of their own (built-in catalog
  lifecycle, repo bootstrap, blueprints, merge lifecycle, consensus panels). Still deferred
  because it is pure relocation with inbound-link blast radius; do it as its own change.

---

## Recently landed

Removed from the active list because they have shipped. Kept here as a short audit trail.

### 5. Finish the manifest-driven agent-kind registry ✅

**Every container agent kind the platform ships is now an ordinary `registerAgentKind` entry.**
Both switches this candidate named are deleted: `buildMigratedBuiltInBody`'s
`switch (context.agentKind)` in `jobBody.ts` (the implementer / read-only explorers / in-place
fixers / conflict-resolver / merger / on-call / testers), and the `agentKind === …` coercion chain
in `containerAgentResult.ts`. `buildKindBody` is one line — compose the prompt, resolve the step
spec off the registry, build the generic body — and `coerceCustomResult` is one registry lookup.
The two hard-coded Sets that shadowed the registry (`CONTAINER_AGENT_KINDS`,
`MULTI_REPO_FANOUT_BUILTIN_KINDS`) went with them: "does this kind need a checkout" and "does it
fan out across peer repos" are read off the kind's own declaration now.

**The blocker was the seam, exactly as recorded.** These kinds' prompts have to name a BRANCH, and
`AgentRunContext` describes the work rather than the checkout. Kernel gained
`AgentDispatchContext` (`baseBranch` / `workBranch` / `multiRepo`), passed to a kind's own
`userPrompt` on a container dispatch and absent for an inline caller, plus a `userPromptSuffix`
form for a kind (the on-call agent) whose text is a closing instruction on top of the generic
prompt rather than a replacement for it. The rest of what the switch encoded became declarative
knobs on `AgentStepSpec` that a deployment's own kind wants too: `clone.requirePr` /
`clone.prFallback` / `clone.mergeBase`, `testInfra`, `image`, `localWrites`, and a
`standardsDelivery: 'none'` tier for a kind that judges rather than produces.

**Parity was gated on the existing snapshot suite** (`test/containerAgentJobBody.spec.ts` drives
every kind through the public `startJob` and diffs the whole body). Every body came out
byte-identical bar one intended change: `merger` and `on-call` were bypassing the shared prompt
chain, so they now receive the effort-report guidance and — the actual bug — the skill and
tool-server sections a deployment's `assignSkills('merger', …)` had always been silently dropped
from.

Still open from this candidate's neighbourhood: the inline `merger` step resolver is deliberately
NOT externalized (it owns terminal block status and executes a policy-gated real merge, so it
keeps engine-internal access rather than the minimal public `ResolverContext`).

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
in one module) is split into per-domain files under `repositories/drizzle/`: `board.ts`,
`execution.ts`, `accounts.ts`, `telemetry.ts`, `settings.ts`, `reviews.ts`, `kaizen.ts`,
`initiatives.ts`, `sandbox.ts`, `connections.ts`, plus a small `_shared.ts` for the one
cross-domain helper. `drizzle.ts` remains as a thin barrel that assembles the
`CoreRepositories` set (`createDrizzleRepositories`) and re-exports the handful of classes
consumed directly, so every `./repositories/drizzle.js` importer (index/container/test
harness) is unchanged. Pure code movement, no schema or behavioural change, verified by
the cross-runtime conformance suite. This is the precursor that makes #7 (shared base
repositories) tractable: each Drizzle repo now sits in its own file next to its D1 twin.

### 2 (candidate). Generic row mappers ✅

`backend/packages/server/src/persistence/mappers.ts` now drives EVERY non-divergent
row↔domain mapper off a declared field table. The `blocks` win (a single `blockFields`
table generating read/insert/patch) landed earlier; the two remaining hand-enumerated read
mappers (`rowToWorkspace` and `rowToPipeline`) are now folded onto the same "declare each
column once" pattern via a small read-only path (`makeRowReader` + the `readScalar` /
`readNullable` / `readJson` / `readOptJson` / `readFlag` / `readOptScalar` builders). These
two are read-only in this module (their repos bind columns positionally on write), so they
declare only the READ direction rather than a full three-way `FieldMapper`. `rowToExecution`
stays deliberately bespoke: it packs/unpacks a `detail` JSON envelope with tolerant
per-field parsers, a shape the factory doesn't model. So the only hand-written mappers left
are the genuinely-divergent ones. Verified by `test/mappers.spec.ts` (the flag / version /
availability / optional-JSON read semantics are pinned).

### 3 (candidate). Finish the store pattern-factory adoption ✅

Every plain find-by-key upsert store now routes list mutation through the shared
`useUpsertList` composable; the last holdout: the `agentRuns` store's `envConfigRepairJobs`
list (a plain prepend + replace-in-place, no monotonic guard): is migrated, so the only
remaining hand-rolled `findIndex` sites are the deliberately-divergent monotonic/reconcile-guarded
stores (`execution`, `board`, `workspace`, `environmentTest`, and `agentRuns`' bootstrap list)
plus `infraConfig`'s composite-key `upsertInto`. The `useSourceIntegration` factory already
backs the document + task source stores. Verified by `app/stores/agentRuns.spec.ts`.

### 4 (candidate). Split the `ui.ts` store ✅

The 828-line `stores/ui.ts` god-store (40+ unrelated UI concerns) is decomposed into three
cohesive, independently-testable slices under `stores/ui/`: `navigation.ts` (selection /
focus / zoom / LOD; the hot paths, isolated from modal state), `resultViews.ts` (the
`dispatchStepView` / `ui.resultView` overlay seam + the observability + Kaizen panels), and
`modals.ts` (every modal / panel open-close flag, hub came-from markers, deep-link params,
and the startup + AI-onboarding advisories). `ui.ts` is now a thin facade that composes the
three and re-exports the SAME public surface (all 184 keys, verified identical), so every
existing `useUiStore()` consumer is untouched: the split is internal. Promoting a slice to a
separately-consumed store (for selective hydration) is a future, opt-in follow-up; the
maintainability win (each concern in its own file, no central contention point) is realized
now. Verified by `nuxt typecheck`.

### 8 (original). Split `ExecutionService` into step handlers + a completion-resolver registry ✅

`ExecutionService.ts` is down to ~2,549 lines (from 5,016), with the spine extracted into
`RunDispatcher` / `RunStateMachine` / `StepGraph` / the gate controllers + sub-facades, and
the constructor trimmed of its vestigial fields. The step-handler and completion-resolver
registries (`step-handler-registry.ts`, `buildStepResolverRegistry`) are in place. The
run/step lifecycle reference (and the recorded decision not to adopt XState) lives in
[`execution-state-machine.md`](../execution-state-machine.md).

> **Follow-on watch item.** The split moved much of the complexity into
> `RunDispatcher.ts` (**2,779 lines**, ~30 injected deps, a ~256-line `pollAgentJob`),
> which is now the largest engine file. It is not yet a headline candidate (it is a clean,
> freshly-extracted seam) but if it keeps accreting per-kind polling logic it is the next
> place to apply the same handler-registry treatment.

### Engine god-file split, round 2 (+ the re-accretion guard) ✅

The watch item above came true: by the July 2026 quality review
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
  (file / queue / answer / dismiss) moved to **`FollowUpGateController.ts`**; both wired as
  controller collaborators exactly like the existing gate controllers, with the completion
  hub + shared poll folds injected back as callbacks so the paths can't drift.
- **Re-accretion now fails CI instead of an audit**: `scripts/check-file-size.mjs` (run in
  the `repo-guards` job) enforces a soft 1,500-line budget on non-test source files, with
  shrink-only ratcheted allowances for the remaining legacy oversized files (the DI roots,
  `entities.ts`, `suite.ts`, …). Lower a file's allowance in the PR that shrinks it.
