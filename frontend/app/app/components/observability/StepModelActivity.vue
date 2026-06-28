<script setup lang="ts">
import { computed } from 'vue'
import type { StepMetrics } from '~/types/execution'
import StepMetricsBar from '~/components/observability/StepMetricsBar.vue'

// The shared "Model activity" block: the LLM observability rollup (StepMetricsBar) under
// a labelled header with a "View all calls →" link into the full per-call panel. Used by
// every step surface that shows a single step's metrics (the step metadata card, the
// gate / tester result windows) so the embedded-observability treatment can't drift.
// The "View all calls →" link opens the run-level panel, so it appears for any step that
// belongs to a run — including a gate, whose programmatic precheck records no per-step
// calls (the bar is omitted, but the link still reaches the helper agents' calls). Renders
// nothing only when there's neither a run to inspect nor any recorded calls.
const props = defineProps<{
  metrics?: StepMetrics | null
  /** The run whose per-call panel the header link / bar click opens. */
  instanceId?: string
}>()

const ui = useUiStore()
const { t } = useI18n()
const hasCalls = computed(() => !!props.metrics && props.metrics.calls > 0)

function openObservability() {
  if (props.instanceId) ui.openObservability(props.instanceId)
}
</script>

<template>
  <div v-if="instanceId || hasCalls">
    <div class="mb-1 flex items-center justify-between">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {{ t('observability.modelActivity') }}
      </span>
      <button
        v-if="instanceId"
        class="text-[11px] text-sky-400 hover:text-sky-300"
        @click="openObservability"
      >
        {{ t('observability.viewAllCalls') }}
      </button>
    </div>
    <StepMetricsBar
      v-if="hasCalls && metrics"
      :metrics="metrics"
      clickable
      @inspect="openObservability"
    />
  </div>
</template>
