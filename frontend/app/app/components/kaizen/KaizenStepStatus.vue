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
const { t } = useI18n()

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
  if (!g || g.grade == null) return 'text-muted'
  if (g.grade >= 5) return 'text-app-success-400'
  if (g.grade >= 4) return 'text-app-hue-lime'
  if (g.grade === 3) return 'text-app-warning-400'
  return 'text-app-error-400'
})
</script>

<template>
  <section v-if="grading" class="rounded-xl border border-default bg-default/50 p-4">
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-sparkles" class="h-4 w-4 text-app-hue-teal" />
      <h3 class="text-sm font-semibold text-default">{{ t('kaizen.grading.title') }}</h3>
      <span class="ms-auto flex items-center gap-1.5 text-xs">
        <template v-if="grading.status === 'scheduled'">
          <UIcon name="i-lucide-clock" class="h-3.5 w-3.5 text-dimmed" />
          <span class="text-muted">{{ t('kaizen.status.scheduled') }}</span>
        </template>
        <template v-else-if="grading.status === 'running'">
          <UIcon name="i-lucide-loader-circle" class="h-3.5 w-3.5 animate-spin text-app-hue-teal" />
          <span class="text-app-hue-teal">{{ t('kaizen.status.grading') }}</span>
        </template>
        <template v-else-if="grading.status === 'failed'">
          <UIcon name="i-lucide-circle-alert" class="h-3.5 w-3.5 text-app-error-400" />
          <span class="text-app-error-400">{{ t('kaizen.status.failed') }}</span>
        </template>
        <template v-else>
          <span class="font-semibold" :class="tone">{{
            t('kaizen.gradeValue', { grade: grading.grade })
          }}</span>
        </template>
      </span>
    </div>

    <p v-if="grading.status === 'scheduled'" class="mt-2 text-2xs text-dimmed">
      {{ t('kaizen.scheduledHint') }}
    </p>

    <template v-else-if="grading.status === 'complete'">
      <p v-if="grading.summary" class="mt-2 text-xs text-toned">{{ grading.summary }}</p>
      <div v-if="grading.recommendations.length" class="mt-2">
        <p class="text-2xs font-medium uppercase tracking-wide text-dimmed">
          {{ t('kaizen.recommendations') }}
        </p>
        <ul class="mt-1 list-disc space-y-0.5 ps-4 text-xs text-toned">
          <li v-for="(r, i) in grading.recommendations" :key="i">{{ r }}</li>
        </ul>
      </div>
      <p v-else class="mt-2 text-2xs text-app-success-400/80">
        {{ t('kaizen.noImprovements') }}
      </p>
      <p v-if="grading.graderModel" class="mt-2 text-3xs text-app-600">
        {{ t('kaizen.gradedBy', { model: grading.graderModel }) }}
      </p>
    </template>

    <p v-else-if="grading.status === 'failed'" class="mt-2 text-2xs text-app-error-400/80">
      {{ grading.error ?? t('kaizen.failedFallback') }}
    </p>
  </section>
</template>
