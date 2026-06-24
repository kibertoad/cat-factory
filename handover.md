# Handover — complexity & technical-debt reduction

A behaviour-preserving refactor program to make the codebase more maintainable
**without losing any features**. Every change is extract-method / extract-class /
collapse-twins / move-file — no behaviour, API, wire-shape or schema changes.

This doc tracks what's landed and what's left, with enough detail to execute.

---

## Ground rules (apply to every remaining step)

- **No feature/behaviour loss.** If a refactor would change an observable output, stop
  and flag it. Move method bodies _verbatim_; inject dependencies.
- **Keep the runtimes symmetric.** Any shared-behaviour change lands in every facade in
  the same change + a conformance assertion (see `CLAUDE.md`).
- **One concern per PR.** Each extraction is independently shippable and revertible.
- **Changeset per versioned-package change** (`.changeset/*.md`; `patch` for internal
  refactors). Empty changeset for docs/test-only.
- **Verification per PR** (from repo root unless noted):
  - `pnpm build` — full workspace tsc project-reference build. **Run this first** after
    pulling `main`; it refreshes the built `.d.ts` of workspace deps (a stale build shows
    phantom errors like `reasoningText`/`ConsensusSession` that vanish after a rebuild).
  - `cd <pkg> && pnpm typecheck` — per package.
  - `cd backend/packages/orchestration && pnpm test:run` — 151 pure unit tests, fast, no DB.
  - `npx oxlint <files>` + `npx oxfmt --check <files>` — lint + format.
- **Windows caveat:** the cross-runtime **conformance** suite (the real behavioural safety
  net for engine changes) only runs on Linux/macOS + Postgres/workerd. On Windows rely on
  typecheck + the orchestration unit tests + CI. Worker vitest fails on Windows (known
  wrangler issue) — see `CLAUDE.md`.

### Gotchas learned

- **Changeset cwd drift:** `Write` with a _relative_ path resolves against the shell's
  current dir, which drifts after a `cd` into a package. Always write changesets with the
  **absolute** repo-root path `C:\sources\cat-factory\.changeset\<name>.md`.
- **Pre-existing typecheck noise:** two `ai`-SDK test files
  (`ai-agent-web-search.test.ts`, `InstrumentedModelProvider.test.ts`) have
  `LanguageModelV3`-shape typecheck errors unrelated to this work. They're excluded from
  the build and don't block `test:run`. Filter them out when reading `pnpm typecheck`.

### The collaborator-extraction pattern (used by Phase 2)

When pulling flow-control out of `ExecutionService`: the collaborator owns its cohesive
logic; **shared** engine primitives stay on the engine and are injected as constructor
callbacks (arrow wrappers: `runAgent: (ctx, opts) => this.runAgent(ctx, opts)`). This
keeps a single home for shared state-machine primitives and avoids circular deps. See
`MergeResolver.ts` / `CompanionController.ts` / `TesterController.ts` for the shape.

---

## Done (merged / in review)

| PR   | Scope                                                                                                                                                                                     | Status    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| #131 | **Phase 0** privileged-App Node/local parity fix + **Phase 1** review-service collapse (`IterativeReviewService` base; `RequirementReviewService`/`ClarityReviewService` thin subclasses) | merged    |
| #133 | **Phase 2.1** extract `AgentContextBuilder` (pure-read per-step context + service-frame resolution)                                                                                       | merged    |
| #134 | **Phase 2.2** extract `MergeResolver` + `CompanionController` + `TesterController`                                                                                                        | merged    |
| #135 | **Phase 2.3** extract `ReviewGateController` (requirements + clarity gate handlers, unified by kind)                                                                                      | in review |

`ExecutionService` is now **~2,970 lines**, down from ~4,108 at the start.

The requirements + clarity gate flows are now ONE kind-parameterised collaborator
(`modules/execution/ReviewGateController.ts`): a `ReviewKind<TReview>` supplies each
subject's differentiators (review service, live event, `agentKind`, and the clarity
investigation thread), the controller owns the shared control flow once, and the
ExecutionService public methods are thin delegators (HTTP controllers untouched). The
shared state-machine primitives (`parkStepOnDecision`, `advancePastResolvedGate`,
`dispatchIterationCap`) stay on the engine and are injected. Local guard:
`ReviewGateController.test.ts` (16 control-flow tests, both gate branches). Build + both
typechecks + 167 orchestration unit tests + lint/format green on Windows; the parked-run
loop end-to-end is verified by the requirements + clarity conformance fixtures in CI.

---

## Remaining steps (priority order)

### 1. (DONE — PR #135) Finish Phase 2 — `ReviewGateController`

Extracted: the requirements-review + clarity-review **gate** handlers are now one
kind-parameterised `ReviewGateController` (see the "Done" note above). The shared engine
primitives (`parkStepOnDecision`, `assertNotIterativeGate`, `advancePastResolvedGate`,
`dispatchIterationCap`) stayed on the engine and are injected; the public controller-facing
API is unchanged (thin delegators). **Verify on the PR via CI conformance** — the
requirements + clarity fixtures exercise the parked-run/resume loop end-to-end; Windows can
only run typecheck + the orchestration unit tests.

**Still optional — item 5 of the plan:** generalise the gate registry
(`modules/execution/gates.ts`) to cover the scattered `if (step.agentKind === KIND)`
dispatch in `stepInstance` / `recordStepResult`, replacing the if-ladders with a per-kind
handler table. Not started; independent of the above.

### 2. (DONE — branch `refactor/phase3-buildjobbody`) Phase 3 — tame `ContainerAgentExecutor.buildJobBody`

Done: extracted a `ModelRouter` collaborator (`backend/packages/server/src/agents/ModelRouter.ts`)
owning the routing policy (block pin → workspace default → env + "subscriptions always
win" for pooled + dual-mode individual GLM); `resolveModel`/`isQuotaBased`/`buildJobBody`
delegate to it. Extracted a `resolveAuth` helper (Pi proxy session vs. leased subscription
credential) and replaced the 8 inline `agentKind` bodies with a shared `common` body +
`webTools` + a per-kind `buildKindBody` table (each branch is now just its delta). The
`buildJobBody` method went ~416 → ~75 lines. `startJob`/`pollJob` + the `RunnerTransport`
seam untouched; the dispatched body shape per kind is byte-identical (proven by the new
`test/containerAgentJobBody.spec.ts` characterization snapshot — captured pre-refactor,
unchanged after). Plus `test/modelRouter.spec.ts` (10 unit tests for routing precedence +
the subscription overrides). Verified: full workspace `pnpm build` + server `pnpm test:run`
(93) + orchestration `pnpm test:run` (169) + lint/format, all green on Windows. Changeset
`container-executor-model-router-job-table.md`. **Open the PR and let CI run the Worker
integration suite** (real dispatch shapes) to confirm cross-runtime.

### 3. Phase 4 — frontend structure

1. **(DONE — branch `refactor/phase4-split-useapi`, commit `ae42a74`)** Split
   `frontend/app/app/composables/useApi.ts` (~1,186 lines, 100+ endpoints) into per-domain
   factory modules under `composables/api/*` (auth, fragments, models, accounts,
   workspaces, board, execution, documents, tasks, reviews, notifications, presets,
   releaseHealth, recurring, github, slack, bootstrap). Each `*Api(ctx)` factory takes a
   shared `ApiContext` (the authed `$fetch` instance + the `ws`/`scope`/`pwHeaders`
   helpers, in `api/context.ts`) and returns its methods; `useApi()` builds the context
   once and spreads every group into the same flat client, so all call sites stay
   `useApi().someMethod(...)`. Method-name set is byte-identical old vs new (both `comm`
   diff directions empty). The `api/*` files sit two levels deep so Nuxt does NOT
   auto-import the factories. Verified on Windows: `nuxt typecheck` + `oxlint` + `oxfmt`
   - 43 frontend unit tests green. Changeset `split-useapi-into-domain-modules.md`
     (`@cat-factory/app` patch). **Open the PR; no CI conformance impact (frontend-only).**
2. **(DONE — branch `refactor/phase4-decompose-agent-step-detail`)** Decomposed
   `frontend/app/app/components/panels/AgentStepDetail.vue` (1,264 → 737 lines). The
   live clock → `useStepTimer`; the prose reader (outline / collapse / scroll-spy +
   scroll refs) → `useStepProse`; the GitHub-style approval-review state machine
   (per-block comments, edit-then-approve, request-changes/reject + highlight syncing)
   → `useStepApproval`. The two cleanly-presentational sections moved to child
   components `StepMetadataCard.vue` (state/timing/model/run + subtasks/metrics/
   standards/decision/approval/companion verdicts) and `StepTestReport.vue`. The
   template's DOM relationships (scroll-spy refs + in-document review highlights) are
   byte-identical — only script logic + two display sections were extracted; the parent
   is now orchestration only. Verified on Windows: `nuxt typecheck` + `oxlint` + `oxfmt`
   - 43 frontend unit tests green. Changeset `decompose-agent-step-detail.md`
     (`@cat-factory/app` patch). **Open the PR; frontend-only, no CI conformance impact.**
3. **Refactor `frontend/app/app/stores/ui.ts`** (~413 lines, 13 modal refs) to a single
   overlay registry (`{ active: OverlayId | null, payload }`) + typed open/close helpers;
   update the ~13 call sites.
4. **Unify the two Vue review windows** (`RequirementsReviewWindow.vue` +
   `ClarityReviewWindow.vue`, ~615 lines each) into one `<IterativeReviewWindow>` driven by
   a `kind` prop, registered once in `STEP_RESULT_VIEWS` (both archetypes already declare
   `resultView` in `app/utils/catalog.ts`) — the frontend half of the Phase-1 unification.
5. **Add component tests** for the extracted pieces (the timer composable, the overlay
   registry, the unified review window). Frontend currently has only store specs and zero
   component tests — establish the Vitest + `@vue/test-utils` harness, scoped to what
   these steps touch.
   - **Verify:** `cd frontend/app && pnpm test:run`; manual smoke via the local facade
     (`deploy/local`, `startLocal()`) driving a task through requirements-review → coder →
     ci → merger.

### 4. Phase 5 (optional, defer unless churn hurts)

- Lift the genuinely-identical container-builder helpers shared by
  `runtimes/cloudflare/src/infrastructure/container.ts` and `runtimes/node/src/container.ts`
  (model-provider resolver shape, App-registry assembly, GitHub-client/Slack composition)
  into a shared `@cat-factory/server` composition module.
- Close conformance gaps (GitHub integration wiring, real-time delivery, durable-execution
  parity) so drift fails a test. Do NOT merge the 49 D1 repo files with the Drizzle
  megafile — the abstraction cost exceeds the duplication cost.

---

## Where things live

- Full plan + running progress notes:
  `~/.claude/plans/analyse-code-from-perspective-shimmering-pike.md`.
- Architecture & runtime-flow orientation: `CLAUDE.md` (read the "Keep the runtimes
  symmetric", "Execution flow", "Gates vs agents" and "Requirements review flow" sections
  before touching the engine).
- Extraction examples to mirror: `backend/packages/orchestration/src/modules/execution/`
  (`AgentContextBuilder.ts`, `MergeResolver.ts`, `CompanionController.ts`,
  `TesterController.ts`) and `modules/review/IterativeReviewService.ts`.
