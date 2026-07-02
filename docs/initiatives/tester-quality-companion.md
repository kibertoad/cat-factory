# Initiative: Test quality-control companion

## Goal & rationale

The `tester` agents (`tester-api` / `tester-ui`) return a structured report and the engine
concludes the step (greenlight → advance, or withheld → fixer loop) purely from
`greenlight` + blocking concerns + failed outcomes. Nothing checks whether the report is a
**complete, honest account of what was tested**. In practice a Tester can list many areas in
`tested`, describe them in the prose `summary`, but record a single happy-path `outcome` and
greenlight — the run then "passes" with most scenarios showing **"No discrete check recorded"**
in the Test Report window, yet the step is treated as successfully completed.

This initiative adds a **test quality-control (QC) companion**: after the Tester produces a
report, an inline reviewer audits it for coverage/coherence **before** the greenlight/fixer
decision and, when the report is inadequate, **loops the Tester** for a focused additional pass
(carrying forward what was already covered). Enabled by default; toggled per-Tester-step in the
pipeline builder; optionally gated on the task's impact/risk/complexity estimate.

Design decisions (confirmed with the requester):

- **Loop the Tester**, folding the prior report + the QC's gaps into context and asking it NOT
  to re-test areas already covered with a passing outcome and no concern.
- **Toggle lives in the pipeline builder**, per pipeline (like the Follow-up companion), with
  optional estimate gating (like the conditional companions).
- **Iteration cap** is a new merge-preset knob `maxTesterQualityIterations` (default **3**),
  independent of the CI/fixer budget.

## Target pattern (the reference implementation — PR 1)

The QC companion is modelled on the **`followUps`** per-step companion (an inline loop owned by
the producing step), NOT the separate companion-STEP model — because it must intercept the
report inside the Tester gate, before `resolveTesterResult`'s greenlight/fixer branch.

- **Kind**: `tester-qc` (`TESTER_QC_AGENT_KIND`, in `@cat-factory/contracts`). A companion of
  `tester-api`/`tester-ui`; never a standalone pipeline step. Inline LLM (no container).
- **Pipeline shape**: `pipeline.testerQuality: (TesterQualityConfig | null)[]` parallel to
  `agentKinds` (`{ enabled, gating? }`; `null`/absent on a Tester step ⇒ enabled, no gating).
- **Run-step state**: `step.testerQuality: TesterQualityStepState` (`enabled`, `attempts`,
  `maxAttempts`, optional `gating`, `verdicts[]`, `exceeded?`), copied at run start in
  `ExecutionService` alongside `gating`/`followUps`; `maxAttempts` refreshed from the resolved
  merge preset on the first report (like the fixer budget).
- **Reviewer**: `TesterQualityReviewService` (inline, resolves its model like the requirements
  reviewer: block pin → workspace per-kind default → routing default; pass-through when unwired).
  Built in `createCore` (`createTesterQualityReviewer`) and injected into `ExecutionService`
  → `TesterController` as `qualityReviewer`.
- **Gate**: `TesterController.runQualityGate` runs before the greenlight/fixer branch. Inadequate
  - budget left ⇒ reclaim container + `dispatchTester(..., qualityFeedback)` (a QC-driven re-run,
    the gaps folded into `priorOutputs` as a `tester-qc` entry). Adequate / budget spent / gated-out
    / unwired ⇒ `null` (proceed). Pure helpers in `testerQuality.logic.ts`.
- **Persistence**: no new table (QC state lives in the execution row). Only the preset knob adds a
  column: `max_tester_quality_iterations` — D1 migration `0031_*` ⇄ Drizzle
  `20260701235746_breezy_morbius`, both repos + `DEFAULT_MERGE_PRESET` + seeds (version bumped 1→2).

## Conventions & gotchas

- **Valibot declaration order**: `testerQualityConfigSchema` is referenced by `pipelineSchema`, so
  it must be declared BEFORE it in `entities.ts` (step-state/verdict schemas can stay lower).
- **QC re-runs use their own counter** (`step.testerQuality.attempts`), never the fixer budget
  (`step.test.attempts`), so a coverage loop and a fix loop don't consume each other's budget.
- **Pass-through everywhere it can't run**: companion off, no model resolves, budget spent, or
  gated out ⇒ the gate returns `null` and the Tester behaves exactly as before. Existing
  `TesterController` tests (no `qualityReviewer`, no `step.testerQuality`) are unchanged.
- **Runtime symmetry**: the preset column is mirrored D1 ⇄ Drizzle with a conformance assertion
  (`suite.ts`, the merge-presets round-trip). Bumping the seed `version` to 2 required updating the
  catalog-version + reseed assertions in the conformance suite.
- **The pipeline create/update/clone API must thread `testerQuality`** (PR 2): the field lives on
  the `pipelineSchema` ENTITY, but the `createPipelineSchema`/`updatePipelineSchema` REQUEST bodies
  and `PipelineService` did not carry it — Valibot silently strips unknown keys, so a custom
  pipeline's builder toggle was dropped on save. PR 2 adds it (an `alignedTesterQuality` helper +
  the request-schema fields), and fixed the identical pre-existing gap for the sibling `followUps`
  toggle (same latent bug). The QC companion's optional estimate GATE is validated like companion
  gating (`assertValidTesterQualityGating`: threshold set + a preceding `task-estimator`), but on
  the Tester step itself rather than a companion row.
- **Conformance drives the loop through an injected reviewer**: `createCore` now honours a
  `testerQualityReviewer` override (else it builds the model-derived one), and the suite injects
  a `FakeTesterQualityReviewer` (a scripted verdict sequence) via a `ConformanceAppOptions` seam
  threaded through all three facade harnesses — so the full audit → loop → conclude loop runs on
  every runtime without a model, asserting the verdicts + counters persist identically.

## Per-item status

| Area                                                                                                                                            | Status | PR        |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------- |
| Contracts: `testerQuality` pipeline field + step state + verdict + `TESTER_QC_AGENT_KIND` + preset knob                                         | done   | (this PR) |
| Kernel: `DEFAULT_MERGE_PRESET` + seed knob + version bump                                                                                       | done   | (this PR) |
| Agents: `TESTER_QC_SYSTEM_PROMPT` (+ tester prompts require an outcome per `tested` area)                                                       | done   | (this PR) |
| Orchestration: `TesterQualityReviewService`, `testerQuality.logic`, `TesterController` gate + re-dispatch, start-time copy, `createCore` wiring | done   | (this PR) |
| Runtimes: preset column + migration (D1 + Drizzle) + repos symmetric                                                                            | done   | (this PR) |
| Conformance: preset round-trip assertion + version bump                                                                                         | done   | (this PR) |
| `TesterController` QC unit tests (loop / adequate / budget-spent / disabled)                                                                    | done   | (this PR) |
| Frontend: pipeline-builder toggle + gating panel; QC verdicts in the Test Report window; i18n                                                   | done   | PR 2      |
| Persist `testerQuality` (+ the sibling `followUps`) through the pipeline create/update/clone API + QC-gating estimator validation               | done   | PR 2      |
| Conformance: full QC loop driven through a fake reviewer via the harness                                                                        | done   | PR 2      |
