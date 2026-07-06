---
'@cat-factory/orchestration': minor
'@cat-factory/conformance': patch
---

Technological-migration initiative — slice T2: phase-template ingest normalization.

The generic counterpart to T1's planner prompt fold: when an initiative preset declares a
`phaseTemplate`, the plan draft is now normalized against it at ingest, BEFORE the preset's own
`seedPlan` hook. This is plan-SHAPE enforcement only (which phases the plan presents, and in what
order) and stays deliberately separate from `seedPlan`'s per-item decoration.

- **orchestration**: new pure `normalizeDraftAgainstPhaseTemplate(template, draft)`
  (`initiative.logic.ts`) — matches planned phases to template phases by `id` VERBATIM, reorders
  them into template order (preserving the planner's `title`/`goal`), appends any extra phases
  after the template ones when `allowAdditionalPhases` is set, and throws `ValidationError` on a
  missing `required` phase or a disallowed extra (an id-less phase counts as an extra). Wired into
  `InitiativeService.seedPlanDraft` ahead of the `seedPlan` hook and gated on the resolved preset's
  `phaseTemplate`, so a preset with no template (including `preset_generic`) ingests byte-for-byte
  as before. Pure + deterministic, so re-ingesting the same draft stays idempotent.
- **conformance**: `defineInitiativeSuite` now drives `InitiativeService.ingestPlan` over each
  facade's real store — asserting an out-of-order plan is reordered into template order and
  persisted, and a plan missing a required phase is rejected with nothing written — so the two
  stores can't drift on a template-shaped plan.
