<script setup lang="ts">
// Compact display of a task's estimator triage (Complexity / Risk / Impact), shown on the
// inspector once a `task-estimator` step has run. Read-only — produced by the estimator,
// used to gate consensus steps. Hidden when no estimate exists.
import { computed } from 'vue'
import type { Block } from '~/types/domain'

const props = defineProps<{ block: Block }>()
const { t, n } = useI18n()

const estimate = computed(() => props.block.estimate ?? null)

const AXES = computed(
  () =>
    [
      { key: 'complexity', label: t('inspector.estimate.complexity') },
      { key: 'risk', label: t('inspector.estimate.risk') },
      { key: 'impact', label: t('inspector.estimate.impact') },
    ] as const,
)

/** Cool→hot bar colour by severity (low = sky, mid = amber, high = rose). */
function barClass(n: number): string {
  if (n >= 0.66) return 'bg-rose-500'
  if (n >= 0.33) return 'bg-amber-500'
  return 'bg-sky-500'
}
</script>

<template>
  <section v-if="estimate" class="space-y-2">
    <div
      class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400"
    >
      <UIcon name="i-lucide-gauge" class="h-3.5 w-3.5" />
      {{ t('inspector.estimate.title') }}
    </div>
    <div class="space-y-1.5 rounded-lg border border-slate-800 bg-slate-900/40 p-2.5">
      <div v-for="axis in AXES" :key="axis.key" class="flex items-center gap-2">
        <span class="w-20 shrink-0 text-xs text-slate-400">{{ axis.label }}</span>
        <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
          <div
            class="h-full rounded-full"
            :class="barClass(estimate[axis.key])"
            :style="{ width: `${Math.round(estimate[axis.key] * 100)}%` }"
          />
        </div>
        <span class="w-9 shrink-0 text-right text-xs tabular-nums text-slate-300">{{
          n(estimate[axis.key], { key: 'percent' })
        }}</span>
      </div>
      <p v-if="estimate.rationale" class="pt-1 text-xs leading-relaxed text-slate-500">
        {{ estimate.rationale }}
      </p>
    </div>
  </section>
</template>
