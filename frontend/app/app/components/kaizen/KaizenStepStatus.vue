<script setup lang="ts">
import { computed, watch } from 'vue'

// Per-step Kaizen grading status, shown inside the run window (NOT on the board). Reads
// the grading for this run's step from the kaizen store, lazily loading the run's
// gradings on first mount, and renders the scheduled→running→complete status plus the
// grade, summary and recommendations once available.
const props = defineProps<{
  /** The run (execution) id. */
  instanceId: string | null | undefined
  /** The step's index within the run. */
  stepIndex: number | null | undefined
}>()

const kaizen = useKaizenStore()

const grading = computed(() => {
  if (!props.instanceId || props.stepIndex == null) return null
  return kaizen.gradingForStep(props.instanceId, props.stepIndex)
})

// Load the run's gradings once when we have an id and nothing cached yet. The stream
// keeps them live afterwards.
watch(
  () => props.instanceId,
  (id) => {
    if (id && kaizen.gradingsFor(id).length === 0 && kaizen.available !== false) {
      void kaizen.loadForExecution(id)
    }
  },
  { immediate: true },
)

const tone = computed(() => {
  const g = grading.value
  if (!g || g.grade == null) return 'text-slate-400'
  if (g.grade >= 5) return 'text-emerald-400'
  if (g.grade >= 4) return 'text-lime-400'
  if (g.grade === 3) return 'text-amber-400'
  return 'text-rose-400'
})
</script>

<template>
  <section v-if="grading" class="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-sparkles" class="h-4 w-4 text-teal-400" />
      <h3 class="text-sm font-semibold text-slate-200">Kaizen grading</h3>
      <span class="ml-auto flex items-center gap-1.5 text-xs">
        <template v-if="grading.status === 'scheduled'">
          <UIcon name="i-lucide-clock" class="h-3.5 w-3.5 text-slate-500" />
          <span class="text-slate-400">Scheduled</span>
        </template>
        <template v-else-if="grading.status === 'running'">
          <UIcon name="i-lucide-loader-circle" class="h-3.5 w-3.5 animate-spin text-teal-400" />
          <span class="text-teal-300">Grading…</span>
        </template>
        <template v-else-if="grading.status === 'failed'">
          <UIcon name="i-lucide-circle-alert" class="h-3.5 w-3.5 text-rose-400" />
          <span class="text-rose-400">Failed</span>
        </template>
        <template v-else>
          <span class="font-semibold" :class="tone">{{ grading.grade }}/5</span>
        </template>
      </span>
    </div>

    <p v-if="grading.status === 'scheduled'" class="mt-2 text-[11px] text-slate-500">
      A Kaizen grading is queued for this step. It runs in the background after the run.
    </p>

    <template v-else-if="grading.status === 'complete'">
      <p v-if="grading.summary" class="mt-2 text-xs text-slate-300">{{ grading.summary }}</p>
      <div v-if="grading.recommendations.length" class="mt-2">
        <p class="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Recommendations
        </p>
        <ul class="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-300">
          <li v-for="(r, i) in grading.recommendations" :key="i">{{ r }}</li>
        </ul>
      </div>
      <p v-else class="mt-2 text-[11px] text-emerald-400/80">
        Smooth interaction — nothing to improve.
      </p>
      <p v-if="grading.graderModel" class="mt-2 text-[10px] text-slate-600">
        Graded by {{ grading.graderModel }}
      </p>
    </template>

    <p v-else-if="grading.status === 'failed'" class="mt-2 text-[11px] text-rose-400/80">
      {{ grading.error ?? 'The grading could not be completed.' }}
    </p>
  </section>
</template>
