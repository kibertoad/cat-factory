# `@cat-factory/orchestration`: delivery-workflow engine + domain composition root

**Entry:** `src/index.ts`; `src/container.ts`: `createCore()`, the domain composition root
(the `Core` contract + the always-present spine assembly). Its dependency contract,
`CoreDependencies`, is ~815 lines of pure declaration and lives in its own
`src/container/dependencies.ts`, re-exported from `container.ts` so every import site is
unchanged: add a new dependency field there, not here. The ~30
optional-module factory functions live in `src/container/modules.ts` (the inline iterative-review
ones (requirements / clarity / brainstorm) in `src/container/review-modules.ts`, re-exported from
`modules.ts`), and their optional
wiring flows through the typed `ModuleRegistry` in `src/container/module-registry.ts` (each
optional module is `build(key, factory)`-declared once and emitted via `...modules.assemble()`:
see `docs/refactoring-candidates.md` #6). `Core` = `CoreSpine` (always present) +
`OptionalCoreModules` (registry-assembled). `createCore` itself is kept under its per-function
line budget by four verbatim slice extractions, each registering in the SAME order (which IS
dependency order for the registry) and returning only what the rest of `createCore` consumes:
`container/foundation.ts` (notifications/settings, board/workspace/account/user + account
onboarding), `container/platform-modules.ts` (observability, the provisioning event log, the
preflight → shared-stacks → environments → handler-seeder chain, and the documents → fragment
library → skill library chain), `container/engine-collaborators.ts` (the services the engine needs
BEFORE it is constructed) and `container/engine-dependent-modules.ts` (the modules that drive the
assembled engine). Grow one of these rather than `container.ts` itself.

**Where things live** (`src/modules/*`, one dir per concern):

- `execution/`: **the run engine; start here for anything about how a pipeline step is
  driven.** The two largest files are `ExecutionService.ts` (run lifecycle:
  start/retry/restart/cancel, decisions/approvals, the merge subgraph) +
  `RunDispatcher.ts` (the per-step dispatch + completion spine and its four registries),
  each ratcheted by `scripts/check-file-size.mjs`. Their extracted collaborators sit
  beside them: `dispatcher-registries.ts` (the three built-in dispatch registries (step
  handlers, completion interceptors, post-completion/terminal resolvers) built over the
  `DispatcherRegistryDeps` seam the dispatcher assembles), `RunAdmission` (the
  start/retry/restart `assert*` preflights),
  `review-kinds.ts` (the requirements/clarity/brainstorm `ReviewKind` factories),
  `StepDecisionController` (the HUMAN decision surface on a parked run; resolve / approve /
  request-changes / reject / merge / decline-to-merge and the human-review fix request; the
  engine keeps thin delegates because the HTTP + public-API controllers reach it through the
  facade), `PollRunningController` + `PollCompletionController` (the RUNNING and SETTLED halves
  of the agent-poll branch tree), `OneShotStepController` (the one-shot engine steps `tracker` /
  `bug-intake` / `initiative-committer`),
  `DeployerStepController` (the deployer provision fan-out + env projection; the fourth
  one-shot step, which had its own controller first),
  `FollowUpGateController` (the follow-up companion gate + its human-action API),
  `RunMergePolicy` (which merge preset governs a run + settling its merge track record when a
  human merges or declines), `PostMergeBoardController` (the BOARD-shaped follow-up a merged task
  triggers; materialising its assigned module and starting the dependents it was blocking; it
  reads the board rather than execution state and is best-effort, which is what separated it from
  the run state machine), `GateStepController` + `GateHelperDispatcher` (the polling-gate
  state machine and its escalation half) and `extension-contexts.ts` (the shared `GateContext` /
  `JudgeContext` the two extension families are handed; built beside each other so neither can
  drift), `JudgeStepController` + `JudgeService` (the **judge** driver (rubric assessment vs the
  task's threshold, disposed as advance / park / bounce / fail) and its inline LLM assessor),
  `linked-context.ts` (resolving a block's attached docs/issues UNION the refs its description
  names; shared by `AgentContextBuilder` and the inline initiative interviewer, which builds its
  own prompt and would otherwise see a different set of attachments than the analyst and planner
  that follow it),
  plus `RunStateMachine`, `StepGraph`, the companion/review
  controllers, and `*.logic.ts` helpers (`ci.logic`, `release.logic`, `stepGating.logic`, …), and
  `PrVerificationReportController` + `prReport.logic.ts` (the **PR verification report**:
  composed from the settled run's own state and published onto its PR through the
  `PrVerificationReportPublisher` port). Every untrusted value it interpolates crosses kernel's
  shared `hostMarkdown` boundary (`shared/host-markdown.logic.ts`: auto-link triggers, table
  cells, code fences), which lives there rather than here because the tracker-issue writebacks
  in `@cat-factory/integrations` render through the SAME escapes; the composer scrubs free text
  with `redactSecrets` before either the prose or the JSON block sees it. `ExecutionServiceDependencies.ts` holds the engine's
  injected-collaborator contract, re-exported from `ExecutionService.ts`. `runStart.ts` holds the two
  funnels every path that brings a run to life passes through (the atomic live-run CLAIM and the
  HAND-OFF to the durable runner, the SPA and the outbound lifecycle sink) because
  `start`/`retry`/`restartFrom` differ only in the block patch they write between them, so the order
  across them is owned in one place rather than three. The run/step lifecycle
  reference is `docs/execution-state-machine.md`.
- `merge/`: the merge policy + its evidence: `RiskPolicyService` (the per-workspace
  merge-threshold preset library, including the per-class `classRules`), `MergeTrackRecordService`
  (deterministic change classification + the persisted record of every merge decision, the
  reviewer-effort tag, and the per-class SQL rollups) and `externalMergeObserver` (attributing a
  PR merged directly on the provider). See CLAUDE.md → "Merge track record".
- `observability/`: the read side of telemetry: `LlmObservabilityService` (per-call metrics),
  `PlatformObservabilityService` (deployment health) and `ReportsService` + `reports.logic.ts`
  (**Reports**; cross-cutting usage analytics: spend by model/agent kind and spend + run activity
  by workspace/service/task type, over the `ReportsRepository` port; see CLAUDE.md → "Reports" and
  `backend/docs/reports.md`). `ReportsService` lives in its own `reports/` dir beside them.
  `GateOutcomeRecorder` is the one WRITER here: the gate machine hands it each polling gate that
  reaches a terminal verdict, and it projects the flat row the dashboard's attempt statistics
  aggregate. Its row id is DERIVED from the run (`<runId>:<stepIndex>:<outcome>`), not minted,
  because the durable drivers replay. See CLAUDE.md → "Telemetry & agent-context observability".
- `debug/`: the read service behind the PUBLIC remote **run debugging** surface (`/api/v1/debug/*`):
  `RunDebugService` issues the bounded reads (a keyset-paged run index plus the four telemetry
  sinks, each independently optional; the body search and slice windows ride to the stores in
  SQL), `debug.logic.ts` holds the pure projections; the `debugText` slice-and-say-so shape
  (offset-windowed, match-offset-carrying), the step/call/snapshot projections, the rollup fold,
  and `deriveSignals` (the precomputed diagnostic hints the overview leads with), and
  `promptMessages.ts` owns the lenient `?view=messages` parse of a stored prompt delta into
  independently-budgeted per-message rows. Every bound lives in the contract or the SQL, never
  here. See `backend/docs/debug-api.md`.
- `bootstrap/`, `pipelines/`, `board/`, `boardScan/`, `requirements/`,
  `notifications/`, `releaseHealth/`, `review/`, `estimation/`, `kaizen/`, `sandbox/`,
  `recurring/`, `settings/`, …: the other module services. In `review/`, EVERY write to a review
  goes through `IterativeReviewService.mutateReview` (load → apply → rev-guarded
  `compareAndSwap`, reloading and re-applying on a lost race) and a fresh run publishes with the
  atomic `replaceForBlock`: a blind `upsert` drops a concurrent editor's answer. `review/` also
  owns the two things every inline reviewer shares: `product-context.ts` (which system the work
  belongs to, STATING an unresolved one) and `IterativeReviewService.systemPromptFor`, which composes
  each kind's `{ role, directives }` pair so a per-workspace prompt override replaces the role only.
  See CLAUDE.md → "Requirements review".
- `validation/`: request validation.

**See also:** `CLAUDE.md` → "Execution flow", "Merge lifecycle flow", "Merge track record",
"Requirements review flow", "Gates vs agents" (the four step buckets, judges included); `docs/execution-state-machine.md`; `docs/modularisation.md` +
`docs/refactoring-candidates.md` for the god-file backlog.
