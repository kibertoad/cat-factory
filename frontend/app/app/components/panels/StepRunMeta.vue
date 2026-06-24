<script setup lang="ts">
import { computed } from 'vue'
import type { PipelineStep } from '~/types/execution'
import { useStepTimer } from '~/composables/useStepTimer'
import StepModelActivity from '~/components/observability/StepModelActivity.vue'

// Shared run-metadata + observability block for the step-backed result windows
// (the CI/conflicts gate, the tester report). It carries the facts every step has in
// common — step position, live duration, model, run id, and the LLM model-activity
// rollup — so each window keeps only its own bespoke detail (the gate's verdict, the
// tester's scenarios) and the universal "which run is this / how did the model do"
// facts read the same everywhere. Laid out as a stack of labelled fields to drop into
// a window's sidebar; the canonical full-width version lives in StepMetadataCard.
const props = defineProps<{
  step: PipelineStep
  /** The enclosing run; copyable + opens the per-call observability panel. */
  instanceId?: string
  /** 1-based position in the pipeline, shown as "N of M" when both are given. */
  stepNumber?: number
  totalSteps?: number
  /** The run failed: freezes the clock and reports a mid-flight step honestly. */
  runFailed?: boolean
  /** Epoch ms the run failed, so the frozen duration is the failure time. */
  failureAt?: number | null
}>()

const models = useModelsStore()

const { isRunning, durationLabel } = useStepTimer({
  step: () => props.step,
  runFailed: () => props.runFailed ?? false,
  failureAt: () => props.failureAt,
})

const modelLabel = computed(() => (props.step.model ? models.labelForRef(props.step.model) : null))
const runId = computed(() => props.step.runId ?? props.instanceId ?? null)

function formatClock(ms?: number | null): string | null {
  return ms ? new Date(ms).toLocaleString() : null
}

async function copyRunId() {
  if (runId.value) await navigator.clipboard?.writeText(runId.value)
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div v-if="stepNumber && totalSteps">
      <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Step</h4>
      <p class="text-[12px] text-slate-300">{{ stepNumber }} of {{ totalSteps }}</p>
    </div>

    <div v-if="durationLabel">
      <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Duration
      </h4>
      <p class="flex items-center gap-1.5 text-[12px] tabular-nums text-slate-300">
        <UIcon
          v-if="isRunning"
          name="i-lucide-loader-circle"
          class="h-3 w-3 animate-spin text-indigo-400"
        />
        {{ durationLabel }}
        <span v-if="isRunning" class="text-[11px] text-slate-500">elapsed</span>
      </p>
    </div>

    <div v-if="formatClock(step.startedAt)">
      <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Started</h4>
      <p class="text-[12px] text-slate-300">{{ formatClock(step.startedAt) }}</p>
    </div>

    <div v-if="formatClock(step.finishedAt)">
      <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Finished
      </h4>
      <p class="text-[12px] text-slate-300">{{ formatClock(step.finishedAt) }}</p>
    </div>

    <div v-if="step.model">
      <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Model</h4>
      <p class="break-all text-[12px] text-slate-300" :title="step.model">
        {{ modelLabel ?? step.model }}
      </p>
    </div>

    <div v-if="runId">
      <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Run</h4>
      <p
        class="cursor-pointer break-all font-mono text-[12px] text-slate-400 hover:text-slate-200"
        :title="`${runId} — click to copy`"
        @click="copyRunId"
      >
        {{ runId }}
      </p>
    </div>

    <!-- The model-activity rollup, embedded inline. The "View all calls →" link opens the
         run's observability panel even when this step recorded no calls (e.g. a gate that
         passed its precheck with no helper spun up), so every window reaches it the same
         way; the metrics bar shows only when the step itself made calls. -->
    <StepModelActivity :metrics="step.metrics" :instance-id="instanceId" />
  </div>
</template>
