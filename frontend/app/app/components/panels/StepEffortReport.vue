<script setup lang="ts">
// The container agent's effort self-assessment, surfaced in run details: how hard the work was
// (1..10), what reduced its effectiveness, and the key obstacles it hit. Populated by the harness
// from the agent's sentinel file and recorded on the step (`step.effortReport`). Rendered only when
// present, so a run on an older harness image (or an agent that wrote none) shows nothing.
import type { AgentEffortReport } from '~/types/execution'

const props = defineProps<{ report: AgentEffortReport }>()
const { t } = useI18n()

// Clamp for the bar width; the schema already bounds 1..10 but be defensive against a stray value.
const difficultyPct = computed(() =>
  Math.min(100, Math.max(0, (props.report.difficulty / 10) * 100)),
)
// Colour the difficulty by band: easy (emerald) → moderate (amber) → hard (rose).
const difficultyClass = computed(() =>
  props.report.difficulty >= 8
    ? 'bg-rose-400'
    : props.report.difficulty >= 5
      ? 'bg-amber-400'
      : 'bg-emerald-400',
)
</script>

<template>
  <section
    data-testid="step-effort-report"
    class="scroll-mt-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4"
  >
    <div
      class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400"
    >
      <UIcon name="i-lucide-gauge" class="h-3.5 w-3.5" />
      <span>{{ t('panels.stepDetail.effort.heading') }}</span>
    </div>

    <div class="flex items-center gap-2">
      <span class="text-[12px] text-slate-300">{{ t('panels.stepDetail.effort.difficulty') }}</span>
      <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-700/60">
        <div
          class="h-full rounded-full"
          :class="difficultyClass"
          :style="{ width: `${difficultyPct}%` }"
        />
      </div>
      <span data-testid="step-effort-difficulty" class="text-[12px] font-medium text-slate-200">
        {{ t('panels.stepDetail.effort.outOfTen', { value: report.difficulty }) }}
      </span>
    </div>

    <p
      v-if="report.summary"
      class="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-slate-300"
    >
      {{ report.summary }}
    </p>

    <div v-if="report.reducedEffectiveness" class="mt-3">
      <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {{ t('panels.stepDetail.effort.reduced') }}
      </p>
      <p class="mt-0.5 whitespace-pre-wrap text-[12px] text-slate-300">
        {{ report.reducedEffectiveness }}
      </p>
    </div>

    <div v-if="report.obstacles?.length" class="mt-3">
      <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {{ t('panels.stepDetail.effort.obstacles') }}
      </p>
      <ul class="mt-0.5 space-y-1">
        <li
          v-for="(obstacle, i) in report.obstacles"
          :key="i"
          class="flex items-start gap-1.5 text-[12px] text-slate-300"
        >
          <UIcon
            name="i-lucide-alert-triangle"
            class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400/80"
          />
          <span>{{ obstacle }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>
