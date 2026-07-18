import { defineModule } from '@modular-vue/core'
import { RESULT_VIEW_IDS } from '@cat-factory/contracts'
import RequirementsReviewWindow from '~/components/requirements/RequirementsReviewWindow.vue'
import ClarityReviewWindow from '~/components/clarity/ClarityReviewWindow.vue'
import BrainstormWindow from '~/components/brainstorm/BrainstormWindow.vue'
import TestReportWindow from '~/components/testing/TestReportWindow.vue'
import HumanTestWindow from '~/components/humanTest/HumanTestWindow.vue'
import VisualConfirmationWindow from '~/components/visualConfirm/VisualConfirmationWindow.vue'
import GateResultView from '~/components/gates/GateResultView.vue'
import ConsensusSessionWindow from '~/components/consensus/ConsensusSessionWindow.vue'
import GenericStructuredResultView from '~/components/panels/GenericStructuredResultView.vue'
import ServiceSpecWindow from '~/components/spec/ServiceSpecWindow.vue'
import FollowUpWindow from '~/components/followUp/FollowUpWindow.vue'
import ForkDecisionWindow from '~/components/forkDecision/ForkDecisionWindow.vue'
import PrReviewWindow from '~/components/prReview/PrReviewWindow.vue'
import MergerResultView from '~/components/panels/MergerResultView.vue'
import InitiativeTrackerWindow from '~/components/initiative/InitiativeTrackerWindow.vue'
import InitiativePlanningWindow from '~/components/initiative/InitiativePlanningWindow.vue'
import DocInterviewWindow from '~/components/docs/DocInterviewWindow.vue'
import RalphLoopResultView from '~/components/ralph/RalphLoopResultView.vue'
import type { ResultViewContribution } from './slots'

/**
 * The first-party result-view registry (slice 2 of the modular-vue adoption —
 * docs/initiatives/modular-vue-adoption.md).
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
 */
export const RESULT_VIEW_CONTRIBUTIONS: readonly ResultViewContribution[] = [
  { id: 'requirements-review', component: RequirementsReviewWindow },
  { id: 'clarity-review', component: ClarityReviewWindow },
  // Shared by both brainstorm stages (requirements + architecture); the window reads the stage.
  { id: 'brainstorm', component: BrainstormWindow },
  { id: 'tester', component: TestReportWindow },
  // The human-testing gate: env URL + confirm / request-fix / pull-main / recreate / destroy.
  { id: 'human-test', component: HumanTestWindow },
  // The visual-confirmation gate: actual-vs-reference screenshot gallery + approve / request-fix.
  { id: 'visual-confirm', component: VisualConfirmationWindow },
  // Shared by all polling gates (`ci` / `conflicts` / `human-review` / …); the window branches on kind.
  { id: 'gate', component: GateResultView },
  // Opened for any step that ran the consensus mechanism (routed in `ui.dispatchStepView`).
  { id: 'consensus-session', component: ConsensusSessionWindow },
  // Default dedicated view for a registered CUSTOM kind's structured (`custom`) output —
  // a read-only JSON viewer, so a proprietary agent ships a result view with no bespoke code.
  { id: 'generic-structured', component: GenericStructuredResultView },
  // The service's prescriptive spec tree (+ Gherkin); opened directly via `ui.openServiceSpec`.
  { id: 'service-spec', component: ServiceSpecWindow },
  // The Follow-up companion: the Coder's surfaced loose ends / questions.
  { id: 'follow-ups', component: FollowUpWindow },
  // The implementation-fork decision: the proposer's approaches + the human's pick / custom.
  { id: 'fork-decision', component: ForkDecisionWindow },
  // The PR deep-review: the reviewer's sliced, prioritized findings + the human's multi-select.
  { id: 'pr-review', component: PrReviewWindow },
  // The merger's verdict: PR complexity/risk/impact scores + the engine's decision (and why).
  { id: 'merger', component: MergerResultView },
  // The initiative tracker: phases, per-item status + PR links, decisions, deviations, caveats.
  { id: 'initiative-tracker', component: InitiativeTrackerWindow },
  { id: 'initiative-planning', component: InitiativePlanningWindow },
  // The interactive document-interview gate: clarifying questions + answer / continue / proceed.
  { id: 'doc-interview', component: DocInterviewWindow },
  // The Ralph loop: the retry-until-done iteration history + the validation command + its output.
  { id: 'ralph-loop', component: RalphLoopResultView },
]

// Dev guard: the first-party entries must cover EXACTLY the canonical built-in
// id set (`@cat-factory/contracts` `RESULT_VIEW_IDS`) — a built-in added to the
// picklist but not registered here (or vice versa) is a wiring bug. Custom
// consumer ids are namespaced and validated separately by `pairById`'s `missing`
// bucket, so they're intentionally not part of this equality check.
if (import.meta.dev) {
  const registered = new Set(RESULT_VIEW_CONTRIBUTIONS.map((v) => v.id))
  const canonical = new Set<string>(RESULT_VIEW_IDS)
  const missing = [...canonical].filter((id) => !registered.has(id))
  const extra = [...registered].filter((id) => !canonical.has(id))
  if (missing.length || extra.length) {
    console.error(
      `[result-views] built-in registry drift vs RESULT_VIEW_IDS — ` +
        `missing: [${missing.join(', ')}], unexpected: [${extra.join(', ')}]`,
    )
  }
}

/**
 * The first-party result-views module: contributes every built-in window to the
 * `resultViews` slot. Registered from the client plugin (see the note above).
 */
export const resultViewsModule = defineModule({
  id: 'cat-factory:result-views',
  version: '1.0.0',
  slots: { resultViews: [...RESULT_VIEW_CONTRIBUTIONS] },
})
