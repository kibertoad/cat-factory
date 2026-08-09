// The RUN OUTCOME summary, re-exported from `@cat-factory/contracts`.
//
// The reduction itself moved into the contracts package when the summary gained a second
// consumer: `GET /api/v1/runs/:runId/outcome` serves it to anything holding a workspace key, and
// the engine's PR verification report reduces the same run evidence for a reviewer. Three
// documents composed from one run cannot each own their own rules. The SPA's copy and the
// report's had already drifted on which tester steps count and on what `not covered` counts,
// so the same run produced different totals depending on where you read it.
//
// What lives on this side is PRESENTATION: the gap codes below map to translated copy in
// `OutcomeSummaryWindow.vue`, which is exactly the half the backend must not own (the backend
// does not localize prose; it emits machine-readable codes the SPA maps). The import path stays
// so the components that read it are unchanged.
export {
  composeRunOutcome,
  hasOutcomeToShow,
  RUN_OUTCOME_VERSION,
  parseRunOutcome,
} from '@cat-factory/contracts'
export type {
  ComposeRunOutcomeInput,
  OutcomeCheck,
  OutcomeCheckKind,
  OutcomeCheckState,
  OutcomeConcern,
  OutcomeDisposition,
  OutcomeEnvironment,
  OutcomeEnvironments,
  OutcomeEnvironmentOrigin,
  OutcomeEnvironmentState,
  OutcomePullRequest,
  OutcomeRequirement,
  OutcomeRequirements,
  OutcomeSource,
  OutcomeSources,
  OutcomeSpecJoin,
  OutcomeTests,
  OutcomeVisual,
  OutcomeVisuals,
  EnvironmentsGap,
  RequirementsGap,
  RunOutcome,
  RunUnavailableGap,
  SourcesGap,
  TestsGap,
  TestsVerdict,
  VisualsGap,
} from '@cat-factory/contracts'
