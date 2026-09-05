import type { Component } from 'vue'
import { defineModule } from '@modular-vue/core'
import { RESULT_VIEW_IDS, type ResultViewId } from '@cat-factory/contracts'
import type { ResultViewContribution } from './slots'
import { defineAsyncView } from '~/utils/asyncView'

/**
 * Every built-in window is CODE-SPLIT: a result window opens on a deliberate click (an agent
 * step, a gate, an outcome card), and there are more than twenty of them, so importing the
 * catalog statically put all of them plus their dependencies (markdown-it, the review windows'
 * prose readers) into the initial bundle of a board that may open none. `defineAsyncView`
 * returns an ordinary `Component`, so the slot entry, the exhaustiveness check below and
 * `StepResultViewHost`'s `<component :is>` mount are unchanged; only the fetch moves to the
 * open. It wraps `defineAsyncComponent` with the shared failure notice, so a window whose chunk
 * 404s after a deploy says so rather than opening onto nothing. A consumer window may be
 * contributed either way, and should copy this one.
 */
const OutcomeSummaryWindow = defineAsyncView(
  () => import('~/components/outcome/OutcomeSummaryWindow.vue'),
)
const RequirementsReviewWindow = defineAsyncView(
  () => import('~/components/requirements/RequirementsReviewWindow.vue'),
)
const ClarityReviewWindow = defineAsyncView(
  () => import('~/components/clarity/ClarityReviewWindow.vue'),
)
const BrainstormWindow = defineAsyncView(
  () => import('~/components/brainstorm/BrainstormWindow.vue'),
)
const TestReportWindow = defineAsyncView(() => import('~/components/testing/TestReportWindow.vue'))
const HumanTestWindow = defineAsyncView(() => import('~/components/humanTest/HumanTestWindow.vue'))
const VisualConfirmationWindow = defineAsyncView(
  () => import('~/components/visualConfirm/VisualConfirmationWindow.vue'),
)
const GateResultView = defineAsyncView(() => import('~/components/gates/GateResultView.vue'))
const ConsensusSessionWindow = defineAsyncView(
  () => import('~/components/consensus/ConsensusSessionWindow.vue'),
)
const GenericStructuredResultView = defineAsyncView(
  () => import('~/components/panels/GenericStructuredResultView.vue'),
)
const ServiceSpecWindow = defineAsyncView(() => import('~/components/spec/ServiceSpecWindow.vue'))
const FollowUpWindow = defineAsyncView(() => import('~/components/followUp/FollowUpWindow.vue'))
const BinaryCandidatesWindow = defineAsyncView(
  () => import('~/components/binaryCandidates/BinaryCandidatesWindow.vue'),
)
const ForkDecisionWindow = defineAsyncView(
  () => import('~/components/forkDecision/ForkDecisionWindow.vue'),
)
const PrReviewWindow = defineAsyncView(() => import('~/components/prReview/PrReviewWindow.vue'))
const BugFishingWindow = defineAsyncView(
  () => import('~/components/bugFishing/BugFishingWindow.vue'),
)
const MergerResultView = defineAsyncView(() => import('~/components/panels/MergerResultView.vue'))
const InitiativeTrackerWindow = defineAsyncView(
  () => import('~/components/initiative/InitiativeTrackerWindow.vue'),
)
const InitiativePlanningWindow = defineAsyncView(
  () => import('~/components/initiative/InitiativePlanningWindow.vue'),
)
const DocInterviewWindow = defineAsyncView(() => import('~/components/docs/DocInterviewWindow.vue'))
const RalphLoopResultView = defineAsyncView(
  () => import('~/components/ralph/RalphLoopResultView.vue'),
)
const JudgeResultView = defineAsyncView(() => import('~/components/judge/JudgeResultView.vue'))

/**
 * The first-party result-view registry (slice 2 of the modular-vue adoption —
 * backend/docs/adr/0049-modular-vue-adoption.md).
 *
 * Every built-in dedicated result window is contributed as a `ComponentEntry`
 * to the `resultViews` slot instead of living in a hardcoded `Record` in
 * `StepResultViewHost.vue`. The host reads the merged slot via
 * `resolveComponentRegistry` (`@modular-vue/core`) and mounts `get(viewId)`; a
 * step's/kind's `resultView` id (built-in or a custom kind's) selects the entry.
 *
 * A consumer deployment ships its OWN result window by contributing another
 * `ComponentEntry` to the SAME slot from a `registerAppModule` module — it then
 * mounts with zero host edits (the extensibility promise), paired against the
 * kind's `presentation.resultView` id exactly like the built-ins. Consumer ids
 * SHOULD be namespaced (`acme:report`) so they can't collide with a built-in;
 * `resolveComponentRegistry` throws on a duplicate id by default.
 *
 * Because these carry Vue components, this module is registered from the client
 * plugin (`plugins/modular.client.ts`), NOT from `createAppRegistry` — that
 * keeps the pure/unit-tested registry import graph free of `.vue` files (the
 * vitest config has no SFC transform).
 *
 * Built-in coverage is enforced at COMPILE time: {@link BUILT_IN_RESULT_VIEWS} is a
 * `Record<ResultViewId, Component>`, so a built-in added to the contract's
 * `RESULT_VIEW_IDS` picklist without a component here (or a stray id that isn't a
 * built-in) is a `nuxt typecheck` failure — a CI gate — rather than a runtime warning
 * that could ship. Consumer namespaced ids are validated separately by `pairById`.
 */
const BUILT_IN_RESULT_VIEWS: Record<ResultViewId, Component> = {
  // The run's non-code outcome summary: what changed in product terms, with the captured
  // evidence, and the diff one click away. RUN-keyed (no step), opened by `ui.openOutcome`.
  outcome: OutcomeSummaryWindow,
  'requirements-review': RequirementsReviewWindow,
  'clarity-review': ClarityReviewWindow,
  // Shared by both brainstorm stages (requirements + architecture); the window reads the stage.
  brainstorm: BrainstormWindow,
  tester: TestReportWindow,
  // The human-testing gate: env URL + confirm / request-fix / pull-main / recreate / destroy.
  'human-test': HumanTestWindow,
  // The visual-confirmation gate: actual-vs-reference screenshot gallery + approve / request-fix.
  'visual-confirm': VisualConfirmationWindow,
  // Shared by all polling gates (`ci` / `conflicts` / `human-review` / …); the window branches on kind.
  gate: GateResultView,
  // Opened for any step that ran the consensus mechanism (routed in `ui.dispatchStepView`).
  'consensus-session': ConsensusSessionWindow,
  // Default dedicated view for a registered CUSTOM kind's structured (`custom`) output —
  // a read-only JSON viewer, so a proprietary agent ships a result view with no bespoke code.
  'generic-structured': GenericStructuredResultView,
  // The service's prescriptive spec tree (+ Gherkin); opened directly via `ui.openServiceSpec`.
  'service-spec': ServiceSpecWindow,
  // The Follow-up companion: the Coder's surfaced loose ends / questions.
  'follow-ups': FollowUpWindow,
  // The implementation-fork decision: the proposer's approaches + the human's pick / custom.
  'fork-decision': ForkDecisionWindow,
  // The generated-candidate comparison: the candidates a generating step staged, side by side,
  // and the human's keep/discard decision (with the alternate ids they assigned).
  'binary-candidates': BinaryCandidatesWindow,
  // The PR deep-review: the reviewer's sliced, prioritized findings + the human's multi-select.
  'pr-review': PrReviewWindow,
  // The bug-fishing expedition: the per-angle catch, and the human's per-finding triage (each
  // marked finding spawns its own bug-fix task).
  'bug-fishing': BugFishingWindow,
  // The merger's verdict: PR complexity/risk/impact scores + the engine's decision (and why).
  merger: MergerResultView,
  // The initiative tracker: phases, per-item status + PR links, decisions, deviations, caveats.
  'initiative-tracker': InitiativeTrackerWindow,
  'initiative-planning': InitiativePlanningWindow,
  // The interactive document-interview gate: clarifying questions + answer / continue / proceed.
  'doc-interview': DocInterviewWindow,
  // The Ralph loop: the retry-until-done iteration history + the validation command + its output.
  'ralph-loop': RalphLoopResultView,
  // Shared by EVERY registered judge (the fourth step-taxonomy bucket): the rubric verdict's
  // score vs the task threshold, its findings, the round history, and the park's decision.
  judge: JudgeResultView,
}

/**
 * The built-in windows as slot entries, derived from `RESULT_VIEW_IDS` so the slot order matches
 * the canonical id order. Exhaustiveness is guaranteed by {@link BUILT_IN_RESULT_VIEWS}'s type.
 */
const RESULT_VIEW_CONTRIBUTIONS: readonly ResultViewContribution[] = RESULT_VIEW_IDS.map((id) => ({
  id,
  component: BUILT_IN_RESULT_VIEWS[id],
}))

/**
 * The first-party result-views module: contributes every built-in window to the
 * `resultViews` slot. Registered from the client plugin (see the note above).
 */
export const resultViewsModule = defineModule({
  id: 'cat-factory:result-views',
  version: '1.0.0',
  slots: { resultViews: [...RESULT_VIEW_CONTRIBUTIONS] },
})
