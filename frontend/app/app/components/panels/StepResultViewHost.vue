<script setup lang="ts">
// Universal dedicated-result-view host. An agent archetype can declare a `resultView`
// id (see `~/utils/catalog`); when a step of that kind is opened, `ui.resultView` is set
// and this host renders the matching registered window instead of the generic
// `AgentStepDetail` prose panel. Adding a bespoke visualization for a new agent is just:
//   1. declare `resultView: '<id>'` on its archetype, and
//   2. register `'<id>': <Component>` below.
// No caller changes — every board/inspector entry point already routes through
// `ui` dispatch.
import { computed, type Component } from 'vue'
import RequirementsReviewWindow from '~/components/requirements/RequirementsReviewWindow.vue'
import TestReportWindow from '~/components/testing/TestReportWindow.vue'

const ui = useUiStore()

const STEP_RESULT_VIEWS: Record<string, Component> = {
  'requirements-review': RequirementsReviewWindow,
  tester: TestReportWindow,
}

const active = computed<Component | null>(() => {
  const view = ui.resultView?.view
  return view ? (STEP_RESULT_VIEWS[view] ?? null) : null
})
</script>

<template>
  <component :is="active" v-if="active" />
</template>
