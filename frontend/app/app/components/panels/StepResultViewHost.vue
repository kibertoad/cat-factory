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
import TestReportWindow from '~/components/testing/TestReportWindow.vue'
import GateResultView from '~/components/gates/GateResultView.vue'
import ConsensusSessionWindow from '~/components/consensus/ConsensusSessionWindow.vue'

const ui = useUiStore()

const STEP_RESULT_VIEWS: Record<string, Component> = {
  'requirements-review': RequirementsReviewWindow,
  tester: TestReportWindow,
  // Shared by both polling gates (`ci` + `conflicts`); the window branches on agentKind.
  gate: GateResultView,
  // Opened for any step that ran the consensus mechanism (routed in `ui.dispatchStepView`).
  'consensus-session': ConsensusSessionWindow,
}

const active = computed<Component | null>(() => {
  const view = ui.resultView?.view
  return view ? (STEP_RESULT_VIEWS[view] ?? null) : null
})
</script>

<template>
  <component :is="active" v-if="active" />
</template>
