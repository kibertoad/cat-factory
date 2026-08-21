<script setup lang="ts">
// Compact display of a task's triage scores (Complexity / Risk / Impact), shown on the inspector
// once a step has produced them. Read-only: a `task-estimator` step FORECASTS them before the work
// starts and a `task-reassessor` step MEASURES them afterwards from the change that landed, so the
// section says which reading it is showing, names the reading it corrected, and shows the earlier
// number beside each axis that actually moved. Hidden when no estimate exists.
import { computed } from 'vue'
import type { Block } from '~/types/domain'
import { estimateBasisLabelKey } from '~/utils/estimateGating'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'

const props = defineProps<{ block: Block }>()
const { t, n } = useI18n()

const estimate = computed(() => props.block.estimate ?? null)

/**
 * The three axes with both readings, so the template asks nothing about which one to show.
 *
 * `was` is present only where the superseded reading DIFFERS. An axis whose score did not move
 * renders "was 40% 40%", which reads as a correction that did not happen; and the interesting
 * thing about a re-measurement is exactly which axes it moved.
 */
const AXES = computed(() => {
  const current = estimate.value
  const prior = current?.supersedes ?? null
  return (
    [
      { key: 'complexity', label: t('inspector.estimate.complexity') },
      { key: 'risk', label: t('inspector.estimate.risk') },
      { key: 'impact', label: t('inspector.estimate.impact') },
    ] as const
  ).map((axis) => ({
    ...axis,
    was:
      prior && current && prior[axis.key] !== current[axis.key]
        ? n(prior[axis.key], { key: 'percent' })
        : null,
  }))
})

/**
 * What this reading is, in one line. Which key that is lives in `utils/estimateGating`, beside the
 * rest of the estimate presentation vocabulary and under test: `basis` is PERSISTED and read back
 * without a schema pass, so absent, known and unrecognised are three distinct answers.
 */
const basisLabel = computed(() => t(estimateBasisLabelKey(estimate.value?.basis)))

/**
 * What the current reading REPLACED, named by ITS basis rather than left implicit.
 *
 * A "was 80%" chip beside a header reading "Forecast before the work started" says the earlier
 * number was an earlier forecast, and after a re-run of the estimator on a measured task that is
 * the wrong way round: the superseded reading is the MEASUREMENT. The backend summary prefixes the
 * same movement with the same label for the same reason.
 */
const supersededLabel = computed(() => {
  const prior = estimate.value?.supersedes
  if (!prior) return null
  return t('inspector.estimate.supersededBasis', {
    basis: t(estimateBasisLabelKey(prior.basis)),
  })
})

/** Cool→hot bar colour by severity (low = sky, mid = amber, high = rose). */
function barClass(n: number): string {
  if (n >= 0.66) return 'bg-rose-500'
  if (n >= 0.33) return 'bg-amber-500'
  return 'bg-sky-500'
}
</script>

<template>
  <InspectorSection
    v-if="estimate"
    :title="t('inspector.estimate.title')"
    :hint="t('inspector.estimate.hint')"
    icon="i-lucide-gauge"
    default-open
  >
    <div class="space-y-1.5 rounded-lg border border-slate-800 bg-slate-900/40 p-2.5">
      <p class="text-[11px] text-slate-500" data-testid="task-estimate-basis">{{ basisLabel }}</p>
      <p
        v-if="supersededLabel"
        class="text-[11px] text-slate-500"
        data-testid="task-estimate-superseded"
      >
        {{ supersededLabel }}
      </p>
      <div v-for="axis in AXES" :key="axis.key" class="flex items-center gap-2">
        <span class="w-20 shrink-0 text-xs text-slate-400">{{ axis.label }}</span>
        <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
          <div
            class="h-full rounded-full"
            :class="barClass(estimate[axis.key])"
            :style="{ width: `${Math.round(estimate[axis.key] * 100)}%` }"
          />
        </div>
        <span
          v-if="axis.was"
          class="shrink-0 text-[11px] tabular-nums text-slate-500"
          :data-testid="`task-estimate-was-${axis.key}`"
          >{{ t('inspector.estimate.was', { value: axis.was }) }}</span
        >
        <span class="w-9 shrink-0 text-end text-xs tabular-nums text-slate-300">{{
          n(estimate[axis.key], { key: 'percent' })
        }}</span>
      </div>
      <p v-if="estimate.rationale" class="pt-1 text-xs leading-relaxed text-slate-500">
        {{ estimate.rationale }}
      </p>
    </div>
  </InspectorSection>
</template>
