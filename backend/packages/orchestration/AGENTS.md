# `@cat-factory/orchestration` — delivery-workflow engine + domain composition root

**Entry:** `src/index.ts`; `src/container.ts` — `createCore()`, the domain composition root
(the `Core` contract + the always-present spine assembly). Its dependency contract,
`CoreDependencies`, is ~815 lines of pure declaration and lives in its own
`src/container/dependencies.ts`, re-exported from `container.ts` so every import site is
unchanged — add a new dependency field there, not here. The ~30
optional-module factory functions live in `src/container/modules.ts`, and their optional
wiring flows through the typed `ModuleRegistry` in `src/container/module-registry.ts` (each
optional module is `build(key, factory)`-declared once and emitted via `...modules.assemble()`
— see `docs/refactoring-candidates.md` #6). `Core` = `CoreSpine` (always present) +
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

- `execution/` — **the run engine; start here for anything about how a pipeline step is
  driven.** The two largest files are `ExecutionService.ts` (run lifecycle:
  start/retry/restart/cancel, decisions/approvals, the merge subgraph) +
  `RunDispatcher.ts` (the per-step dispatch + completion spine and its four registries),
  each ratcheted by `scripts/check-file-size.mjs`. Their extracted collaborators sit
  beside them: `dispatcher-registries.ts` (the three built-in dispatch registries — step
  handlers, completion interceptors, post-completion/terminal resolvers — built over the
  `DispatcherRegistryDeps` seam the dispatcher assembles), `RunAdmission` (the
  start/retry/restart `assert*` preflights),
  `review-kinds.ts` (the requirements/clarity/brainstorm `ReviewKind` factories),
  `DeployerStepController` (the deployer provision fan-out + env projection),
  `FollowUpGateController` (the follow-up companion gate + its human-action API),
  `RunMergePolicy` (which merge preset governs a run + settling its merge track record when a
  human merges or declines), `GateStepController` + `GateHelperDispatcher` (the polling-gate
  state machine and its escalation half) and `extension-contexts.ts` (the shared `GateContext` /
  `JudgeContext` the two extension families are handed — built beside each other so neither can
  drift), `JudgeStepController` + `JudgeService` (the **judge** driver — rubric assessment vs the
  task's threshold, disposed as advance / park / bounce / fail — and its inline LLM assessor),
  plus `RunStateMachine`, `StepGraph`, the companion/review
  controllers, and `*.logic.ts` helpers (`ci.logic`, `release.logic`, `stepGating.logic`, …), and
  `PrVerificationReportController` + `prReport.logic.ts` (the **PR verification report**:
  composed from the settled run's own state and published onto its PR through the
  `PrVerificationReportPublisher` port). Every untrusted value it interpolates crosses kernel's
  shared `hostMarkdown` boundary (`shared/host-markdown.logic.ts` — auto-link triggers, table
  cells, code fences), which lives there rather than here because the tracker-issue writebacks
  in `@cat-factory/integrations` render through the SAME escapes; the composer scrubs free text
  with `redactSecrets` before either the prose or the JSON block sees it. `ExecutionServiceDependencies.ts` holds the engine's
  injected-collaborator contract, re-exported from `ExecutionService.ts`. The run/step lifecycle
  reference is `docs/execution-state-machine.md`.
- `merge/` — the merge policy + its evidence: `RiskPolicyService` (the per-workspace
  merge-threshold preset library, including the per-class `classRules`), `MergeTrackRecordService`
  (deterministic change classification + the persisted record of every merge decision, the
  reviewer-effort tag, and the per-class SQL rollups) and `externalMergeObserver` (attributing a
  PR merged directly on the provider). See CLAUDE.md → "Merge track record".
- `bootstrap/`, `pipelines/`, `board/`, `boardScan/`, `requirements/`,
  `notifications/`, `releaseHealth/`, `review/`, `estimation/`, `kaizen/`, `sandbox/`,
  `recurring/`, `settings/`, … — the other module services.
- `validation/` — request validation.

**See also:** `CLAUDE.md` → "Execution flow", "Merge lifecycle flow", "Merge track record",
"Requirements review flow", "Gates vs agents" (the four step buckets, judges included); `docs/execution-state-machine.md`; `docs/modularisation.md` +
`docs/refactoring-candidates.md` for the god-file backlog.
