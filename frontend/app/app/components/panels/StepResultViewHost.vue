<script setup lang="ts">
// Universal dedicated-result-view host. An agent archetype can declare a `resultView`
// id (see `~/utils/catalog`); when a step of that kind is opened, `ui.resultView` is set
// and this host renders the matching registered window instead of the generic
// `AgentStepDetail` prose panel. Adding a bespoke visualization for a new agent is just:
//   1. declare `resultView: '<id>'` on its archetype, and
//   2. register `'<id>': <Component>` below.
// No caller changes — every board/inspector entry point already routes through
// `ui` dispatch. Each registered window builds on `useResultView(viewId, { onOpen })`,
// which owns the seam contract (open/blockId/close + Escape + load-on-open) so a new
// window can't reintroduce the route-dependent empty-state bug by forgetting to fetch
// on mount — declare an `onOpen` loader and it fires on every open.
import { computed, type Component } from 'vue'
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
import MergerResultView from '~/components/panels/MergerResultView.vue'
import InitiativeTrackerWindow from '~/components/initiative/InitiativeTrackerWindow.vue'

const ui = useUiStore()

const STEP_RESULT_VIEWS: Record<string, Component> = {
  'requirements-review': RequirementsReviewWindow,
  'clarity-review': ClarityReviewWindow,
  // Shared by both brainstorm stages (requirements + architecture); the window reads the stage.
  brainstorm: BrainstormWindow,
  tester: TestReportWindow,
  // The human-testing gate: env URL + confirm / request-fix / pull-main / recreate / destroy.
  'human-test': HumanTestWindow,
  // The visual-confirmation gate: actual-vs-reference screenshot gallery + approve / request-fix.
  'visual-confirm': VisualConfirmationWindow,
  // Shared by both polling gates (`ci` + `conflicts`); the window branches on agentKind.
  gate: GateResultView,
  // Opened for any step that ran the consensus mechanism (routed in `ui.dispatchStepView`).
  'consensus-session': ConsensusSessionWindow,
  // Default dedicated view for a registered CUSTOM kind's structured (`custom`) output —
  // a read-only JSON viewer, so a proprietary agent ships a result view with no bespoke code.
  'generic-structured': GenericStructuredResultView,
  // The service's prescriptive spec tree (+ Gherkin), opened from the inspector's "View
  // Requirements" button. Not a pipeline-step view — opened directly via `ui.openServiceSpec`.
  'service-spec': ServiceSpecWindow,
  // The future-looking Follow-up companion: the Coder's surfaced loose ends / questions.
  // Opened directly via `ui.openFollowUps` (the blinking chip + the `followup_pending` card).
  'follow-ups': FollowUpWindow,
  // The merger's verdict: the PR's complexity/risk/impact scores + the engine's auto-merge
  // or awaiting-review decision (and why), instead of the agent's raw JSON.
  merger: MergerResultView,
  // The initiative tracker: phases, per-item status + PR links, decisions, deviations,
  // caveats. Opened from the initiative card / inspector (`ui.openInitiativeTracker`) and
  // as the planner step's result view.
  'initiative-tracker': InitiativeTrackerWindow,
}

const active = computed<Component | null>(() => {
  const view = ui.resultView?.view
  if (!view) return null
  const component = STEP_RESULT_VIEWS[view] ?? null
  // An archetype declared a `resultView` id with no registered component — this used to
  // silently fall back to the prose panel. The backend now validates `resultView` against the
  // canonical id set, so this should only fire mid-development of a new view; make it loud.
  if (!component && import.meta.dev) {
    console.warn(
      `[StepResultViewHost] no component registered for resultView "${view}". ` +
        `Add it to STEP_RESULT_VIEWS (and to RESULT_VIEW_IDS in @cat-factory/contracts).`,
    )
  }
  return component
})
</script>

<template>
  <component :is="active" v-if="active" />
</template>
