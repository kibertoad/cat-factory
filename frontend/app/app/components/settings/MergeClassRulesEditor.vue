<script setup lang="ts">
// Per-change-class auto-merge rules for one merge preset, shown NEXT TO each class's accumulated
// track record — the number that justifies widening a rule. That pairing is the whole point: an
// operator flips `docs` to "always auto-merge" because the history says humans found nothing to
// say about docs changes, not on a hunch.
//
// `unknown` is deliberately not listed: no rule may ever match it (an unclassifiable diff must
// fall back to the score ceilings), so offering one would be a lie. See
// backend/docs/adr/0046-merge-track-record.md.
import { computed } from 'vue'
import { autoMergeShare, frictionlessShare, RULEABLE_CHANGE_CLASSES } from '@cat-factory/contracts'
import type { MergeClassRule, MergeClassRules } from '~/types/merge'

const props = defineProps<{
  /** The preset's current rules; an absent class means "use the score ceilings". */
  modelValue: MergeClassRules
  /** Whether the preset auto-merges at all — a rule can never override `autoMergeEnabled: false`. */
  autoMergeEnabled: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [MergeClassRules] }>()

const { t, n } = useI18n()
const trackRecords = useMergeTrackRecordsStore()

// Load the rollups once when the editor mounts. ONE request returns every class (a single SQL
// aggregate server-side), so this never fans out per class.
onMounted(() => {
  if (!trackRecords.loaded && !trackRecords.loading) void trackRecords.load()
})

// Per-class + per-rule labels. Exhaustive Records keyed off the unions (a missing member fails the
// typecheck) with LITERAL catalog keys so the typed-message-keys check sees them.
const CLASS_LABEL_KEYS: Record<(typeof RULEABLE_CHANGE_CLASSES)[number], string> = {
  docs: 'merge.changeClass.docs',
  test: 'merge.changeClass.test',
  dependency: 'merge.changeClass.dependency',
  config: 'merge.changeClass.config',
  source: 'merge.changeClass.source',
  schema: 'merge.changeClass.schema',
}
const RULE_LABEL_KEYS: Record<MergeClassRule, string> = {
  thresholds: 'settings.riskPolicy.classRules.rule.thresholds',
  always: 'settings.riskPolicy.classRules.rule.always',
  never: 'settings.riskPolicy.classRules.rule.never',
}

const RULE_OPTIONS = computed<{ value: MergeClassRule; label: string }[]>(() => [
  { value: 'thresholds', label: t(RULE_LABEL_KEYS.thresholds) },
  { value: 'always', label: t(RULE_LABEL_KEYS.always) },
  { value: 'never', label: t(RULE_LABEL_KEYS.never) },
])

/** One row: the class, its current rule, and the evidence behind it. */
const rows = computed(() =>
  RULEABLE_CHANGE_CLASSES.map((changeClass) => {
    const rollup = trackRecords.byClass[changeClass]
    const auto = autoMergeShare(rollup)
    const frictionless = frictionlessShare(rollup)
    return {
      changeClass,
      label: t(CLASS_LABEL_KEYS[changeClass]),
      rule: props.modelValue[changeClass] ?? ('thresholds' as MergeClassRule),
      merged: rollup.merged,
      // Null until something has landed / been tagged, so a fresh workspace shows "no data yet"
      // rather than a misleading 0%.
      autoShare: auto,
      frictionlessShare: frictionless,
    }
  }),
)

/** Set (or clear) a class's rule. `thresholds` is stored as an OMISSION — it IS the default. */
function setRule(changeClass: (typeof RULEABLE_CHANGE_CLASSES)[number], rule: MergeClassRule) {
  const next: MergeClassRules = { ...props.modelValue }
  if (rule === 'thresholds') delete next[changeClass]
  else next[changeClass] = rule
  emit('update:modelValue', next)
}
</script>

<template>
  <div data-testid="merge-class-rules" class="space-y-2">
    <div>
      <span class="block text-[10px] uppercase tracking-wide text-slate-500">
        {{ t('settings.riskPolicy.classRules.heading') }}
      </span>
      <p class="mt-0.5 text-[11px] leading-snug text-slate-500">
        {{ t('settings.riskPolicy.classRules.help') }}
      </p>
      <p v-if="!autoMergeEnabled" class="mt-1 text-[11px] leading-snug text-amber-400/90">
        {{ t('settings.riskPolicy.classRules.autoMergeOffWarning') }}
      </p>
    </div>

    <div
      v-for="row in rows"
      :key="row.changeClass"
      class="flex flex-wrap items-center gap-2 rounded-md border border-slate-700/50 bg-slate-900/30 px-2 py-1.5"
      :data-testid="`merge-class-row-${row.changeClass}`"
    >
      <span class="min-w-[7rem] text-xs text-slate-300">{{ row.label }}</span>
      <USelect
        :model-value="row.rule"
        :items="RULE_OPTIONS"
        value-key="value"
        size="sm"
        class="w-44"
        :disabled="disabled"
        :data-testid="`merge-class-rule-${row.changeClass}`"
        @update:model-value="setRule(row.changeClass, $event as MergeClassRule)"
      />
      <span
        class="text-[11px] text-slate-500"
        :data-testid="`merge-class-record-${row.changeClass}`"
      >
        <template v-if="row.merged === 0">
          {{ t('settings.riskPolicy.classRules.noData') }}
        </template>
        <template v-else>
          {{
            t('settings.riskPolicy.classRules.record', {
              merged: row.merged,
              autoShare: n(row.autoShare ?? 0, 'percent'),
            })
          }}
          <template v-if="row.frictionlessShare !== null">
            &middot;
            {{
              t('settings.riskPolicy.classRules.frictionless', {
                share: n(row.frictionlessShare, 'percent'),
              })
            }}
          </template>
        </template>
      </span>
    </div>
  </div>
</template>
