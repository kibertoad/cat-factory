<script setup lang="ts">
// The steps a bootstrap run is made of, with the one it reached marked.
//
// A monorepo bootstrap is three moves around a human decision (survey → your adoption
// decisions → write the service and open the PR), and it was rendered as a single
// "bootstrapping…" bar. That bar cannot say which move a stopped run got to, so "retry" read
// as "start the whole thing again" when what the platform actually does is resume from the
// step reached, the survey's paid-for reads and the reviewer's settled decisions included.
//
// The steps and their states come from `@cat-factory/contracts`, which is also what
// `BootstrapService.retry` branches on: the label on the button and the behaviour behind it
// are one rule, not two.
import type { BootstrapStepId, BootstrapStepState } from '@cat-factory/contracts'

const props = defineProps<{ runId: string }>()

const { t } = useI18n()
// A ONE-step run renders nothing: a new-repo bootstrap is a single move, which the banner around
// this already names, and a one-row checklist restating it is noise rather than information.
const { steps: allSteps, multiStep } = useBootstrapRunSteps(() => props.runId)
const steps = computed(() => (multiStep.value ? allSteps.value : []))

const STEP_ICON: Record<BootstrapStepState, string> = {
  pending: 'i-lucide-circle',
  running: 'i-lucide-loader-circle',
  awaiting_review: 'i-lucide-user-check',
  done: 'i-lucide-check-circle-2',
  failed: 'i-lucide-alert-triangle',
  unknown: 'i-lucide-help-circle',
}
const STEP_TONE: Record<BootstrapStepState, string> = {
  pending: 'text-slate-500',
  running: 'animate-spin text-amber-400',
  awaiting_review: 'text-amber-400',
  done: 'text-emerald-400',
  failed: 'text-rose-400',
  unknown: 'text-slate-400',
}
const LABEL_TONE: Record<BootstrapStepState, string> = {
  pending: 'text-slate-500',
  running: 'text-amber-100',
  awaiting_review: 'text-amber-100',
  done: 'text-slate-400',
  failed: 'text-rose-200',
  unknown: 'text-slate-400',
}

function stepLabel(id: BootstrapStepId): string {
  return t(`bootstrap.steps.name.${id}`)
}
function stateLabel(state: BootstrapStepState): string {
  return t(`bootstrap.steps.state.${state}`)
}
</script>

<template>
  <ol v-if="steps.length" class="space-y-1" data-testid="bootstrap-run-steps">
    <li
      v-for="step in steps"
      :key="step.id"
      class="flex items-start gap-1.5 text-[11px]"
      :data-step="step.id"
      :data-state="step.state"
    >
      <UIcon
        :name="STEP_ICON[step.state]"
        class="mt-px h-3 w-3 shrink-0"
        :class="STEP_TONE[step.state]"
      />
      <span :class="LABEL_TONE[step.state]">{{ stepLabel(step.id) }}</span>
      <span class="ms-auto shrink-0 text-slate-500">{{ stateLabel(step.state) }}</span>
    </li>
  </ol>
</template>
