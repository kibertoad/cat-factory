# ExecutionService split — progress tracker

Refactoring candidate **#8** from [`docs/refactoring-candidates.md`](./refactoring-candidates.md):
split the 5,148-line `ExecutionService` god class into an engine-internal **StepHandler registry**
(driving `stepInstance`) plus the existing **StepCompletionResolver** seam (driving
`recordStepResult`). Full plan: `/root/.claude/plans/plan-the-largest-most-unified-stream.md`.

Incremental + behaviour-preserving: one step kind per phase, each kept green on the cross-runtime
conformance suite (both Cloudflare D1 and Node Postgres).

## Key decisions

- **StepHandler registry is engine-internal** (built-ins constructed in-engine, closing over `this`,
  mirroring `buildStepResolverRegistry`). NOT a public registration seam — `registerGate` /
  `registerStepResolver` remain the external extension story.
- **Registry lives in orchestration** (`modules/execution/step-handler-registry.ts`), not kernel:
  its outcome type `AdvanceResult` is orchestration-local and there's no external registrant to keep
  free of the orchestration dep. (`StepResolution.control`, a public seam type, still goes in kernel.)

## Status legend

⬜ not started · 🟡 in progress · ✅ done (conformance green) · ⏭️ deferred

## Phases

| #   | Phase                                                   | Status |
| --- | ------------------------------------------------------- | ------ |
| 0   | StepHandler registry scaffolding (fallthrough, no-op)   | done   |
| 1   | Deterministic one-shot step handlers (deployer/tracker) | done   |
| 2   | Post-completion resolvers (blueprint/spec/estimate)     | done   |
| 3   | Verdict interceptors (tester/companion short-circuits)  | done   |
| 4   | Decision/polling/companion gate step handlers           | done   |
| 5   | Container-agent default handler + cleanup               | done   |

## Phase 0 — scaffolding

**Goal:** wire the StepHandler dispatch into `stepInstance` with a single fallthrough handler that
delegates the entire current per-kind body unchanged. Zero behaviour change; the safety net every
later phase relies on.

Checklist:

- [x] `kernel/.../step-resolver-registry.ts`: add `control?: 'park' | 'loop' | 'advance'` to `StepResolution` (defined now, consumed from Phase 3).
- [x] New `orchestration/.../execution/step-handler-registry.ts`: `StepHandler` + `StepHandlerContext` types.
- [x] `ExecutionService`: `stepHandlerCache`, `buildStepHandlerRegistry()` (one fallthrough handler), `dispatchStepHandler()`, extract per-kind body into `runStepBody()`.
- [x] Conformance green on both runtimes.
- [x] Changeset for `@cat-factory/kernel` + `@cat-factory/orchestration`.

## Phase 1 — deterministic one-shot step handlers

**Scope (as shipped):** `DeployerStepHandler` (order 100, claims a `deployer` step only when an
env-provisioning provider is wired) and `TrackerStepHandler` (order 110) — both built inline in
`buildStepHandlerRegistry` closing over `this` (mirroring the merger resolver), each delegating to
the existing `runDeployer`/`runTracker` + `recordStepResult`. Their branches are deleted from
`runStepBody`.

**Resequencing note (ordering finding):** the plan also slated the `task-estimator` /
`spec-writer noBusinessSpecs` → resolver conversions for Phase 1. Deferred to the artifact-resolver
phase, because the existing `StepCompletionResolver` dispatch point runs _after_ the approval gate,
whereas the inline `task-estimator` branch sets `step.output = summarizeEstimate(...)` _before_ it
(an approval proposal would otherwise change from the readable summary to the raw JSON). Those
resolver conversions need the resolver-ordering handled deliberately, so they move to Phase 2 where
spec ingestion already lives (and spec-writer can be migrated atomically).

- **Phase 1 done.** Green on both runtimes: Cloudflare conformance 126 ✓; Node execution 40 +
  durable-execution 1 + integration (covers deployer/tracker) 32 = 73 ✓.

## Phase 2 — post-completion resolvers

**Design:** added a `phase` discriminator to the kernel `StepCompletionResolver` seam —
`'terminal'` (default, the existing LATE dispatch slot just before finalize/advance, where the
merger and any deployment-registered resolver run) vs `'post-completion'` (a new EARLY dispatch
slot, run right after the step output is recorded and BEFORE the reviewable-output rendering +
follow-up/approval gates read `step.output`). The early slot sits exactly where the old inline
ingestion branches were, so ordering is preserved.

**Migrated to `post-completion` resolvers** (lifted verbatim from inline `recordStepResult`
branches): `blueprints` (blueprint ingest/reconcile), `spec-writer` (spec ingest + `noBusinessSpecs`
flag — spec-writer now migrated atomically), `task-estimator` (estimate persist + `step.output`
summary; the early slot is what keeps the summary in the approval proposal, resolving the Phase-1
ordering finding).

**Deliberately left inline** (kind-agnostic, keyed on result shape, not `agentKind` — the plan's
"cross-cutting stays inline" rule): PR-open + issue writeback (`result.pullRequest`) and the
reviewable-artifact output replacement (`reviewableArtifactOutput(result)`). A per-`agentKind`
resolver is the wrong tool for these; revisit only if a verdict-gate-style abstraction emerges.

- **Phase 2 done.** Green on both runtimes: Cloudflare conformance 126 ✓; Node conformance (all
  six specs) + durable-execution 127 ✓; orchestration execution/registry/estimation unit 161 ✓.

## Phase 3 — completion-path verdict interceptors

**Design correction:** the plan slated tester/companion verdicts as `StepCompletionResolver`s
driven by the Phase-0 `control` enum. But these branches run at the _top_ of `recordStepResult`,
**short-circuit** it, and return a full `AdvanceResult` (park needs a decisionId, loop needs a
jobId) — which a bare `control` enum can't carry, and which the kernel resolver seam (returns
`StepResolution`) structurally can't express. So instead I added an engine-internal
**`StepCompletionInterceptor`** (sibling to `StepHandler`, in `step-handler-registry.ts`):
`canIntercept` + `intercept(ctx) → AdvanceResult | null`. The two inline branches
(`companion-verdict`, `tester-verdict`) became interceptors built inline in
`buildStepCompletionInterceptors`, dispatched at the top of `recordStepResult`; `null` falls
through to the normal spine (a tester greenlight, or a companion whose block can't load). The now-
superseded `control` field was **removed** from the kernel `StepResolution` (it was unused — added
Phase 0, merged in #373; pre-1.0, safe to drop).

- **Phase 3 done.** Green on both runtimes: Cloudflare conformance 126 ✓; Node execution/agents/core
  conformance + durable-execution 83 ✓; orchestration unit 161 ✓.

## Phase 4 — dispatch-path gate step handlers

Lifted the remaining `runStepBody` branches into StepHandlers (built inline in
`buildStepHandlerRegistry`, explicit `order` preserving the original precedence):
`review-gate` (order 120 — the four requirements/clarity/brainstorm reviewers via
`ReviewGateController`, a per-case `switch` so `evaluate`'s `TReview` generic infers),
`human-test` (130), `visual-confirm` (140), `polling-gate` (150 — `canHandle` = the gate
registry lookup, so it claims exactly the registered gate kinds: ci/conflicts/
post-release-health/human-review), `inline-companion` (160 — container-backed companions
deliberately don't match; they fall through to the container dispatch + the Phase-3
interceptor). `runStepBody` now contains only the generic container/inline-agent tail.

- **Phase 4 done.** Green on both runtimes: Cloudflare conformance 126 ✓; Node conformance
  (all six specs) + durable-execution 127 ✓; orchestration unit 161 ✓.

## Phase 5 — container-agent default handler + cleanup

Renamed the temporary `runStepBody` fallthrough to `handleAgentStep` (the legitimate generic
container/inline-agent handler, `kind: 'agent'`, lowest priority) now that all the specific kinds
are claimed by their own handlers. The `stepInstance` per-kind body is gone: the method is now an
**81-line run-lifecycle preamble** (existence → spend → paused-resume → re-entrancy → start-step →
block load → estimate gate) + a single `dispatchStepHandler` call.

**Left as-is (deliberately):** the preamble's re-entrancy guards and `assertNotIterativeGate` (both
keyed on `agentKind` but legitimate — the former is the lifecycle spine, the latter a correctness
guard in the approval-resolution methods with distinct user-facing messages per kind; re-homing it
onto handler flags would obscure those messages and add indirection).

## Outcome

What the split achieved (primary goals from the candidate doc):

- The **load-bearing-but-implicit ordering** of the old ~290-line `stepInstance` `if`/early-return
  chain is now an explicit `order` field on each handler — adding a kind can't silently reorder.
- **Dispatch-time `step.agentKind ===` checks** are localized into each handler's `canHandle`
  (and the post-completion/verdict logic into the resolver `phase` / interceptor registries),
  instead of scattered across two ~260–290-line methods.
- Each handler / resolver / interceptor is independently readable and testable.

What it intentionally did NOT do: handlers/resolvers/interceptors are built **inline** in the engine
(closing over `this`, mirroring the existing `buildStepResolverRegistry` merger pattern), NOT
extracted into a `handlers/` folder behind a large `StepHandlerEngine` interface. That extraction
would shrink the file's line count further but only by introducing a wide, leaky engine seam
inconsistent with the codebase's inline-built-in convention — net-negative for the engine-internal
design we chose. So `ExecutionService.ts` is **restructured, not dramatically shortened** (5,148 →
5,339 lines; the registry scaffolding + per-handler doc comments offset the removed `if`-branches).
The implicit-ordering hazard and scattered dispatch checks — the actual debt — are gone.

- **Phase 5 done.** Final verification green on both runtimes: Cloudflare conformance 126 ✓; full
  Node suite 191 ✓ (all conformance specs + durable-execution + local mode); full orchestration
  vitest 296 ✓.

## Notes / running log

- **Phase 0 done.** Wired the registry with a single fallthrough handler; `stepInstance` now
  runs the preamble then `dispatchStepHandler` → `runStepBody` (the unchanged per-kind body).
  Verified green: **Cloudflare** conformance 126 ✓; **Node** execution conformance 40 ✓ +
  durable-execution (pg-boss) 1 ✓ + core/agents/misc/integration conformance 86 ✓; orchestration
  execution + registry unit tests 161 ✓. Pre-existing repo-wide `.test.ts` typecheck drift
  (`onMissingEstimate`, AI-SDK `LanguageModelV3` mismatch) is unrelated and present on the base
  branch — src builds clean.

---

# Take 2 — extract the spine, then the leaves

Take 1 (Phases 0–5 above) made the dispatch ordering explicit but **did not break the
monolith**: the file grew (5,148 → 5,346 lines) and the ~46-dep constructor stayed. The
post-mortem: it split along the wrong axis — it extracted the _variant_ per-`agentKind`
branches into registries but left the **invariant run/step state-machine spine** scattered as
private methods, so every extracted controller was handed that spine as a _fat per-callback
bag_ (`ReviewGateControllerDeps` alone took 18 callbacks; its own doc comment described the
missing abstraction verbatim). Relocating leaves while the trunk stays a god object — and
duplicating the spine wiring — is why the file didn't shrink.

**Take 2's principle: extract the invariant spine into cohesive collaborators FIRST, then the
variant units depend on a small surface.** Success is measured by file size AND per-unit
dependency count dropping _together_.

## Status (take 2)

| #   | Phase                                                 | Status          |
| --- | ----------------------------------------------------- | --------------- |
| 1   | `StepGraph` — pure sync step/cursor mutators          | done            |
| 2   | `RunStateMachine` — async instance/block spine        | done            |
| —   | XState evaluation (spike + decision)                  | done (rejected) |
| 3   | Debag the 5 gate controllers onto the spine           | done            |
| 4   | Move handlers/interceptors out of the file            | deferred        |
| 5   | Gate-action sub-facades + re-point server controllers | not started     |
| 6   | Trim constructor + final cleanup                      | not started     |

`ExecutionService.ts`: **5,346 → 4,848 lines** so far. Every phase landed as its own commit,
green on both runtimes (Cloudflare conformance 126, Node conformance/durable-execution 41,
orchestration unit incl. controller specs).

- **Phase 1 — `StepGraph`** (`execution/StepGraph.ts`, constructed with just a `Clock`): the
  pure step/cursor mutators (`startStep` / `finishStep` / `pauseStepForInput` /
  `resetStepForRerun` + the companion rework loop `companionProducerIndex` /
  `rerunProducerThrough` / `loopCompanionProducer`). Zero deps beyond the clock.
- **Phase 2 — `RunStateMachine`** (`execution/RunStateMachine.ts`, composes `StepGraph`): the
  async instance/block spine — `persistInstance` / `emitInstance` (+ metrics rollup, Kaizen
  scheduling, terminal personal-credential cleanup), `updateBlockProgress` /
  `refreshBlockProgress`, `parkStepOnDecision` / `advancePastResolvedGate`, `finalizeBlock`,
  `failRun`, `stopRunContainer`, and the park-related notifications. The merge/auto-start
  subgraph (`finalizeMerge` / `applyModuleAssignment` / `autoStartDependents`) deliberately
  stays on the engine (`finalizeBlock` here only flips status + raises the no-merger
  notification). `ExecutionService` delegates; its public `failRun` is a thin pass-through so
  the driver-facing API is unchanged.
- **XState evaluation.** A v5 pure-reducer spike confirmed adoption is _feasible_ but not
  worthwhile (durable/persisted state is already the runtime; snapshot persistence collides
  with the conformance-pinned `ExecutionInstance` shape; the hard parts are untouched). Full
  rationale + the lifecycle Mermaid diagrams: [`execution-state-machine.md`](./execution-state-machine.md).
- **Phase 3 — debag the controllers.** `ReviewGateController` (18 callbacks → `stateMachine` +
  `stepGraph` + 5 own deps), `CompanionController`, `TesterController`, `HumanTestController`,
  `VisualConfirmationController` now take the cohesive `RunStateMachine` + `StepGraph`
  collaborators instead of duplicated callback bags. Controller unit tests updated to grouped
  fakes.

## Remaining work (deferred follow-ups)

- **Phase 4 — move the handlers/interceptors out of the file (`buildStepHandlerRegistry` /
  `buildStepCompletionInterceptors`).** SCOPING FINDING: the handler registry is a thin
  _dispatch table_ whose bodies call ~13 engine internals (`recordStepResult`,
  `handleAgentStep`, `evaluateGate` / `dispatchGateHelper`, `runDeployer`, `runTracker`,
  `gateFor`, pre/post-ops) plus the five controllers and the review kinds. Relocating it as-is
  would re-create the callback-bag smell. Doing it well requires **first extracting a second
  collaborator, `RunDispatcher`** (those engine-internal dispatch methods), so the handlers can
  depend on a cohesive surface — a move on par with Phase 2 in size/risk. Not a thin
  relocation; schedule deliberately.
- **Phase 5 — gate-action sub-facades.** The ~40 public gate-action methods
  (`reviewRequirements`/`incorporate`/`reReview`/`proceed`/`resolveExceeded` ×
  {requirements, clarity, brainstorm}; the human-test / visual-confirm actions; `approveStep` /
  `rejectStep` / `requestStepChanges` / `resolveDecision`; follow-up actions; `mergePr`) are
  mostly 3-line delegations. Group into per-feature sub-facades exposed as getters on the
  still-injected `executionService` and re-point the ~12 server controllers — WITHOUT rewiring
  the composition roots (keeps the runtimes symmetric). Independent of Phase 4 and the bigger
  line win.
- **Phase 6 — trim the constructor + final cleanup** once Phases 4–5 land (deps now owned by
  collaborators drop off; e.g. the `kaizenScheduler` / `llmObservability` fields already moved
  to `RunStateMachine` in phase 2).
