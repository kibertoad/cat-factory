# ADR 0011: Inline test quality-control (QC) companion loop for Tester steps

- **Status:** Accepted (implemented)
- **Date:** 2026-07-02
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/agents`, `@cat-factory/orchestration`, both runtime facades)

## Context

The `tester-api` / `tester-ui` agents return a structured report, and the engine
concludes the Tester step (advance on greenlight, loop a fixer otherwise) purely from
the report's `greenlight` flag plus its blocking concerns and failed outcomes. Nothing
checked whether the report was itself a complete, honest account of what was tested. In
practice a Tester could list many areas in `tested`, describe them in prose, but record
only a single happy-path outcome and greenlight — the run then "passed" even though most
listed scenarios showed no discrete recorded check, and the step was treated as
successfully completed regardless.

## Decision

Add an inline **test quality-control (QC) companion** (`tester-qc`) that audits a
Tester's report for coverage/coherence before the greenlight/fixer decision, and, when
the report is inadequate, loops the Tester for a focused additional pass:

- Modelled on the existing `followUps` per-step companion pattern (an inline loop owned
  by the producing step) rather than a separate companion pipeline step, because it must
  intercept the report inside the Tester gate, before the greenlight/fixer branch runs.
- `tester-qc` is an inline LLM companion (no container) of `tester-api`/`tester-ui`,
  never a standalone pipeline step. A pipeline declares it per Tester step
  (`pipeline.testerQuality`), enabled by default, toggleable in the pipeline builder,
  with optional gating on the task's estimate.
- On an inadequate verdict with budget remaining, the engine reclaims the container and
  re-dispatches the Tester with the QC's gaps folded into `priorOutputs`, asking it not
  to re-test areas already covered with a passing outcome and no concern.
- The iteration cap is a per-workspace merge-preset knob (`maxTesterQualityIterations`,
  default 3), tracked independently of the existing CI/fixer attempt budget so a
  coverage loop and a fix loop never consume each other's budget.
- The reviewer resolves its model the same way the requirements reviewer does (block pin
  → workspace per-kind default → routing default) and is a pass-through wherever it
  isn't wired, so existing Tester behaviour is unchanged when the companion is off, out
  of budget, gated out, or unconfigured.

## Rationale

- **Reuse the `followUps` shape, not a new companion-step abstraction.** The QC audit
  has to run inside the Tester's own gate, before the pass/fail branch — the separate
  companion-step model can't intercept there, so the per-step inline-loop pattern was
  the correct fit.
- **A dedicated iteration counter avoids budget interference.** Coupling the QC loop to
  the CI-fixer's attempt budget would let one kind of rework starve the other; giving it
  its own counter and merge-preset knob keeps them independent.
- **Pass-through everywhere it can't run** preserves every existing Tester behaviour and
  test when the feature is absent, which kept the blast radius of adding the companion
  contained to the paths that opt in.

## Consequences

- Adding the field to the pipeline entity schema alone was not sufficient: the create/
  update/clone request schemas and `PipelineService` did not carry `testerQuality` (nor
  the sibling `followUps`), and the `pipelines` table had no column for either — so a
  custom pipeline's builder toggle was silently dropped on save until a follow-up change
  added `follow_ups` + `tester_quality` JSON columns (mirrored D1 ⇄ Drizzle) and threaded
  the fields through the request schemas and mapper. Future per-step companion toggles
  should land the persistence column in the same change as the request-schema field, not
  just the entity schema.
- The conformance suite gained an injectable `testerQualityReviewer` seam
  (`FakeTesterQualityReviewer`) so the full audit → loop → conclude cycle can be
  exercised on every runtime without a real model.
- Tester prompts now require an outcome per listed `tested` area, tightening what counts
  as an adequate report independent of the QC companion itself.
