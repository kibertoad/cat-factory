<script setup lang="ts">
// The reviewer-effort tag picker: ONE TAP, not a form. Shown on a merge-decision card (and the
// external-merge nudge) so the human who confirms a merge also records how much review the PR
// actually needed — the ground truth the auto-merge score thresholds are trying to approximate.
//
// Tagging is never mandatory: the parent can always act without a selection, and an untagged
// merge records a null tag. This component only chooses; the parent performs the action.
//
// See backend/docs/adr/0046-merge-track-record.md.
import { computed } from 'vue'
import { REVIEW_EFFORTS } from '@cat-factory/contracts'
import type { ChangeClass, MergeClassRollup, ReviewEffort } from '~/types/merge'

const props = defineProps<{
  /** The currently picked effort, or null for "not chosen". */
  modelValue: ReviewEffort | null
  /** The run's change class, when classification resolved one — shown as context. */
  changeClass?: ChangeClass
  /** That class's accumulated track record, so the human sees what the class usually needs. */
  rollup?: MergeClassRollup | null
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [ReviewEffort | null] }>()

const { t, n } = useI18n()

// Per-effort label + icon. Exhaustive Records keyed off the union (a missing member fails the
// typecheck) with LITERAL catalog keys so the typed-message-keys check sees them; leaf keys
// mirror the enum value verbatim.
const EFFORT_LABEL_KEYS: Record<ReviewEffort, string> = {
  none: 'merge.effort.none',
  minor: 'merge.effort.minor',
  major: 'merge.effort.major',
}
const EFFORT_ICONS: Record<ReviewEffort, string> = {
  none: 'i-lucide-check',
  minor: 'i-lucide-pencil-line',
  major: 'i-lucide-hammer',
}

// Per-class label. Same exhaustive-Record discipline; `unknown` is included because a card can
// carry no class at all (classification unavailable) and the caller may still render context.
const CLASS_LABEL_KEYS: Record<ChangeClass, string> = {
  docs: 'merge.changeClass.docs',
  test: 'merge.changeClass.test',
  dependency: 'merge.changeClass.dependency',
  config: 'merge.changeClass.config',
  source: 'merge.changeClass.source',
  schema: 'merge.changeClass.schema',
  unknown: 'merge.changeClass.unknown',
}

const chips = computed(() =>
  REVIEW_EFFORTS.map((effort) => ({
    effort,
    label: t(EFFORT_LABEL_KEYS[effort]),
    icon: EFFORT_ICONS[effort],
  })),
)

const classLabel = computed(() =>
  props.changeClass ? t(CLASS_LABEL_KEYS[props.changeClass]) : null,
)

/**
 * The class's history line — how many of this class have landed and what share auto-merged. Null
 * until the class has at least one landed record, so a fresh workspace shows nothing rather than
 * a misleading "0%".
 */
const history = computed(() => {
  const r = props.rollup
  if (!r || r.merged === 0) return null
  // Percentages go through vue-i18n's named `percent` format, never a hand-rolled `* 100 + '%'`.
  return t('merge.effort.classHistory', {
    merged: r.merged,
    autoShare: n(r.autoMerged / r.merged, 'percent'),
  })
})

/** Toggle: tapping the picked chip clears the tag (back to untagged). */
function pick(effort: ReviewEffort) {
  emit('update:modelValue', props.modelValue === effort ? null : effort)
}
</script>

<template>
  <div data-testid="merge-effort-chips" class="mt-2">
    <div class="flex items-center gap-1.5">
      <span
        class="text-[10px] uppercase tracking-wide text-slate-500"
        :title="t('merge.effort.promptHint')"
      >
        {{ t('merge.effort.prompt') }}
      </span>
      <UBadge
        v-if="classLabel"
        data-testid="merge-effort-class"
        color="neutral"
        variant="subtle"
        size="sm"
        :title="t('merge.changeClass.hint')"
      >
        {{ classLabel }}
      </UBadge>
    </div>
    <div class="mt-1 flex flex-wrap items-center gap-1">
      <UButton
        v-for="chip in chips"
        :key="chip.effort"
        :data-testid="`merge-effort-${chip.effort}`"
        :color="modelValue === chip.effort ? 'primary' : 'neutral'"
        :variant="modelValue === chip.effort ? 'solid' : 'outline'"
        size="xs"
        :icon="chip.icon"
        :disabled="disabled"
        @click="pick(chip.effort)"
      >
        {{ chip.label }}
      </UButton>
    </div>
    <p v-if="history" data-testid="merge-effort-history" class="mt-1 text-[10px] text-slate-500">
      {{ history }}
    </p>
  </div>
</template>
