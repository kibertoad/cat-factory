# `@cat-factory/orchestration` — delivery-workflow engine + domain composition root

**Entry:** `src/index.ts`; `src/container.ts` — `createCore()`, the domain composition root
(the `CoreDependencies`/`Core` contract + the always-present spine assembly). The ~30
optional-module factory functions live in `src/container/modules.ts`, and their optional
wiring flows through the typed `ModuleRegistry` in `src/container/module-registry.ts` (each
optional module is `build(key, factory)`-declared once and emitted via `...modules.assemble()`
— see `docs/refactoring-candidates.md` #6). `Core` = `CoreSpine` (always present) +
`OptionalCoreModules` (registry-assembled).

**Where things live** (`src/modules/*`, one dir per concern):

- `execution/` — **the run engine; start here for anything about how a pipeline step is
  driven.** The two largest files are `ExecutionService.ts` (run lifecycle:
  start/retry/restart/cancel, decisions/approvals, the merge subgraph) +
  `RunDispatcher.ts` (the per-step dispatch + completion spine and its four registries),
  each ratcheted by `scripts/check-file-size.mjs`. Their extracted collaborators sit
  beside them: `RunAdmission` (the start/retry/restart `assert*` preflights),
  `review-kinds.ts` (the requirements/clarity/brainstorm `ReviewKind` factories),
  `DeployerStepController` (the deployer provision fan-out + env projection),
  `FollowUpGateController` (the follow-up companion gate + its human-action API), plus
  `RunStateMachine`, `StepGraph`, the gate/companion/review controllers, and `*.logic.ts`
  helpers (`ci.logic`, `release.logic`, `stepGating.logic`, …). The run/step lifecycle
  reference is `docs/execution-state-machine.md`.
- `bootstrap/`, `pipelines/`, `board/`, `boardScan/`, `requirements/`, `merge/`,
  `notifications/`, `releaseHealth/`, `review/`, `estimation/`, `kaizen/`, `sandbox/`,
  `recurring/`, `settings/`, … — the other module services.
- `validation/` — request validation.

**See also:** `CLAUDE.md` → "Execution flow", "Merge lifecycle flow", "Requirements review
flow", "Gates vs agents"; `docs/execution-state-machine.md`; `docs/modularisation.md` +
`docs/refactoring-candidates.md` for the god-file backlog.
