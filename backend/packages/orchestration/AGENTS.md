# `@cat-factory/orchestration` — delivery-workflow engine + domain composition root

**Entry:** `src/index.ts`; `src/container.ts` — `createCore()`, the domain composition root
that assembles the module services (~2.1k lines; a monolith flagged in
`docs/refactoring-candidates.md` #6).

**Where things live** (`src/modules/*`, one dir per concern):

- `execution/` — **the run engine; start here for anything about how a pipeline step is
  driven.** The god files live here: `ExecutionService.ts` + `RunDispatcher.ts` (the run/step
  spine), plus `RunStateMachine`, `StepGraph`, the gate/companion/review controllers, and
  `*.logic.ts` helpers (`ci.logic`, `release.logic`, `stepGating.logic`, …). The
  run/step lifecycle reference is `docs/execution-state-machine.md`.
- `bootstrap/`, `pipelines/`, `board/`, `boardScan/`, `requirements/`, `merge/`,
  `notifications/`, `releaseHealth/`, `review/`, `estimation/`, `kaizen/`, `sandbox/`,
  `recurring/`, `settings/`, … — the other module services.
- `validation/` — request validation.

**See also:** `CLAUDE.md` → "Execution flow", "Merge lifecycle flow", "Requirements review
flow", "Gates vs agents"; `docs/execution-state-machine.md`; `docs/modularisation.md` +
`docs/refactoring-candidates.md` for the god-file backlog.
