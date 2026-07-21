<script setup lang="ts">
import { computed } from 'vue'
import type { PipelineStep } from '~/types/execution'
import { prReviewPhase, type PrReviewPhaseKind } from '~/utils/prReviewProgress'

// Compact, at-a-glance phase label for a live `pr-reviewer` step, so the BOARD surfaces (the
// task-card mini pipeline + the focus-view timeline) tell the reviewer's sub-phase apart —
// "Slicing…" while it groups the diff, "Reviewing X/Y slices" while it works through the chunks
// — instead of a bare N/M count that reads the same as any other agent. Self-hides when the step
// has no live review (terminal / not-a-pr-reviewer), so a host can drop it in unconditionally.
// The precise phase derivation is the pure `prReviewPhase` helper (unit-tested).
const props = defineProps<{
  step: PipelineStep
  /** The run has failed — freeze the phase (no spinner), matching the surrounding step visuals. */
  runFailed?: boolean
}>()

const { t } = useI18n()

const phase = computed(() => prReviewPhase(props.step.prReview, props.step.subtasks))

// Per-phase icon + accent. `spin` drives the loader animation while the phase is actively
// working (suppressed on a failed run). `awaiting` is the parked "findings ready" state — a
// steady amber prompt, not a spinner.
const PHASE_META: Record<PrReviewPhaseKind, { icon: string; spin: boolean; class: string }> = {
  planning: { icon: 'i-lucide-loader-circle', spin: true, class: 'text-indigo-300' },
  reviewing: { icon: 'i-lucide-loader-circle', spin: true, class: 'text-indigo-300' },
  awaiting: { icon: 'i-lucide-clipboard-check', spin: false, class: 'text-amber-300' },
  challenging: { icon: 'i-lucide-gavel', spin: true, class: 'text-indigo-300' },
  fixing: { icon: 'i-lucide-wrench', spin: true, class: 'text-indigo-300' },
  posting: { icon: 'i-lucide-send', spin: true, class: 'text-indigo-300' },
}

// Phase → i18n key. Exhaustive Record over the phase-kind union, so adding a kind without a
// label fails the typecheck (the sanctioned dynamic enum→key guard — tier 1 can't see a
// runtime-built key), matching the `CHUNK_STATUS_KEY` pattern in PrReviewWindow.vue.
const PHASE_LABEL_KEY: Record<PrReviewPhaseKind, string> = {
  planning: 'prReview.phase.planning',
  reviewing: 'prReview.phase.reviewing',
  awaiting: 'prReview.phase.awaiting',
  challenging: 'prReview.phase.challenging',
  fixing: 'prReview.phase.fixing',
  posting: 'prReview.phase.posting',
}

const label = computed(() => {
  const p = phase.value
  if (!p) return null
  // `reviewing` carries the live slice counts; the rest are static status copy.
  if (p.kind === 'reviewing')
    return t(PHASE_LABEL_KEY.reviewing, { completed: p.completed, total: p.total })
  return t(PHASE_LABEL_KEY[p.kind])
})

const spinning = computed(
  () => !!phase.value && PHASE_META[phase.value.kind].spin && !props.runFailed,
)
</script>

<template>
  <span
    v-if="phase && label"
    data-testid="pr-review-phase"
    class="inline-flex items-center gap-1"
    :class="runFailed ? 'text-rose-400' : PHASE_META[phase.kind].class"
  >
    <UIcon
      :name="runFailed ? 'i-lucide-circle-x' : PHASE_META[phase.kind].icon"
      class="h-3 w-3 shrink-0"
      :class="spinning ? 'animate-spin' : ''"
    />
    <span class="truncate">{{ label }}</span>
  </span>
</template>
