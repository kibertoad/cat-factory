<script setup lang="ts">
// The estimate-gate threshold row, shared by every gate editor in the pipeline builder: a
// companion step's own gate, a consensus step's escalation gate, and the Tester QC companion's
// gate. One component because the three rendered the same 0..1 inputs from three copies of the
// markup — and, more to the point, because the explanation these numbers need has to be worded
// once. A bare "risk >=" label says nothing about where the score comes from, what its scale is,
// or how the axes combine, and the scale is the trap: every other score the product shows a user
// (judge verdicts, effort difficulty, adherence ratings) is out of ten, so an unlabelled 0..1
// field reads as "risk 1 out of 10" and gates a step that was meant to run on everything.
//
// The gate itself is edited by the parent (the builder mutates store drafts in place), so this
// component only renders and reports: it never writes through the `gating` prop.
import type { EstimateAxis } from '~/utils/estimateGating'
import {
  ESTIMATE_AXIS_FIELD,
  ESTIMATE_AXIS_HINT_KEYS,
  ESTIMATE_AXIS_LABEL_KEYS,
  parseAxisThreshold,
} from '~/utils/estimateGating'

const props = defineProps<{
  /** The gate being edited. Read-only here — changes go back through `update`. */
  gating: { minComplexity?: number; minRisk?: number; minImpact?: number }
  /** Which axes this gate exposes, in render order. */
  axes: readonly EstimateAxis[]
  /** What clearing the gate DOES, which differs per gate and is half the explanation. */
  outcome: 'step' | 'consensus'
}>()

const emit = defineEmits<{ update: [axis: EstimateAxis, value: number | undefined] }>()

const { t } = useI18n()

// Exhaustive Record over the two outcomes with LITERAL keys, so the typed-message-key check sees
// them and a third outcome fails the typecheck rather than falling back to the step wording.
const OUTCOME_HINT_KEYS: Record<'step' | 'consensus', string> = {
  step: 'pipeline.builder.gatingRunWhenAnyHint',
  consensus: 'pipeline.builder.gatingRunWhenAnyConsensusHint',
}

const fields = computed(() =>
  props.axes.map((axis) => ({
    axis,
    label: t(ESTIMATE_AXIS_LABEL_KEYS[axis]),
    hint: t(ESTIMATE_AXIS_HINT_KEYS[axis]),
    value: props.gating[ESTIMATE_AXIS_FIELD[axis]],
  })),
)

// The control hands back a number (or nothing when cleared); the shared parser still owns the
// clamping, so the value that leaves here is the same one the text input used to produce.
function commit(axis: EstimateAxis, raw: number | undefined) {
  emit('update', axis, raw == null ? undefined : parseAxisThreshold(String(raw)))
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 border-t border-default pt-2">
    <span class="text-3xs text-dimmed" :title="t(OUTCOME_HINT_KEYS[outcome])">
      {{ t('pipeline.builder.runWhenAny') }}
    </span>
    <template v-for="f in fields" :key="f.axis">
      <label class="text-muted" :title="f.hint">{{ f.label }}</label>
      <UInputNumber
        :model-value="f.value"
        :title="f.hint"
        :min="0"
        :max="1"
        :step="0.1"
        size="xs"
        class="w-28"
        @update:model-value="commit(f.axis, $event ?? undefined)"
      />
    </template>
  </div>
</template>
