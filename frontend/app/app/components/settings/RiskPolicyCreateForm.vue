<script setup lang="ts">
// The create row for a new risk policy, shared by the board and account tiers (ADR 0055): the
// numbers only. Class and role rules start at their identity and are edited on the saved policy,
// where each rule can be shown beside the base rule (and the track record) it narrows.
import { computed, reactive } from 'vue'
import type { CreateRiskPolicyInput, RequirementConcernLevel } from '~/types/merge'
import {
  CONCERN_LABEL_KEYS,
  CONCERN_LEVELS,
  blankRiskPolicyDraft,
  forkGatingFromDraft,
} from '~/utils/riskPolicyDraft'

const props = defineProps<{ busy: boolean }>()

const emit = defineEmits<{ create: [input: CreateRiskPolicyInput] }>()

const { t } = useI18n()

const draft = reactive(blankRiskPolicyDraft())

const concernOptions = computed<{ value: RequirementConcernLevel; label: string }[]>(() =>
  CONCERN_LEVELS.map((value) => ({ value, label: t(CONCERN_LABEL_KEYS[value]) })),
)

const canSubmit = computed(() => draft.name.trim().length > 0 && !props.busy)

/**
 * Emit the create body and reset the fields a second policy should not inherit.
 *
 * The numbers are deliberately KEPT: an operator authoring two related policies edits them from the
 * first one's values, and re-typing four ceilings to make a near-identical policy is the friction
 * that leads to cloning by hand. The name is cleared because two policies with one name is the one
 * outcome nothing on screen would explain.
 */
function submit() {
  if (!canSubmit.value) return
  emit('create', {
    name: draft.name.trim(),
    maxComplexity: draft.maxComplexity / 100,
    maxRisk: draft.maxRisk / 100,
    maxImpact: draft.maxImpact / 100,
    ciMaxAttempts: draft.ciMaxAttempts,
    maxRequirementIterations: draft.maxRequirementIterations,
    maxRequirementConcernAllowed: draft.maxRequirementConcernAllowed,
    autoMergeEnabled: draft.autoMergeEnabled,
    autonomy: draft.unattended ? 'unattended' : 'attended',
    minAutoAnswerConfidence: draft.minAutoAnswerConfidence / 100,
    classRules: draft.classRules,
    forkDecision: forkGatingFromDraft(draft),
  } as CreateRiskPolicyInput)
  draft.name = ''
}
</script>

<template>
  <div class="rounded-lg border border-dashed border-slate-700 p-3">
    <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
      {{ t('settings.riskPolicy.newPreset') }}
    </p>
    <div class="flex flex-wrap items-end gap-3">
      <label class="block min-w-40 flex-1">
        <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
          {{ t('settings.riskPolicy.create.name') }}
        </span>
        <UInput
          v-model="draft.name"
          size="sm"
          :placeholder="t('settings.riskPolicy.create.namePlaceholder')"
          data-testid="risk-policy-create-name"
        />
      </label>
      <label class="block w-20">
        <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
          {{ t('settings.riskPolicy.create.complexity') }}
        </span>
        <UInput
          v-model.number="draft.maxComplexity"
          type="number"
          :min="0"
          :max="100"
          size="sm"
          data-testid="risk-policy-create-complexity"
        />
      </label>
      <label class="block w-20">
        <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
          {{ t('settings.riskPolicy.create.risk') }}
        </span>
        <UInput
          v-model.number="draft.maxRisk"
          type="number"
          :min="0"
          :max="100"
          size="sm"
          data-testid="risk-policy-create-risk"
        />
      </label>
      <label class="block w-20">
        <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
          {{ t('settings.riskPolicy.create.impact') }}
        </span>
        <UInput
          v-model.number="draft.maxImpact"
          type="number"
          :min="0"
          :max="100"
          size="sm"
          data-testid="risk-policy-create-impact"
        />
      </label>
      <label class="block w-20">
        <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
          {{ t('settings.riskPolicy.create.ciFix') }}
        </span>
        <UInput v-model.number="draft.ciMaxAttempts" type="number" :min="0" :max="50" size="sm" />
      </label>
      <label class="block w-20">
        <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
          {{ t('settings.riskPolicy.create.reqIter') }}
        </span>
        <UInput
          v-model.number="draft.maxRequirementIterations"
          type="number"
          :min="1"
          :max="20"
          size="sm"
        />
      </label>
      <label class="block w-32">
        <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
          {{ t('settings.riskPolicy.create.autoPass') }}
        </span>
        <USelect
          v-model="draft.maxRequirementConcernAllowed"
          :items="concernOptions"
          value-key="value"
          size="sm"
        />
      </label>
      <USwitch
        v-model="draft.autoMergeEnabled"
        size="sm"
        :label="t('settings.riskPolicy.field.autoMerge')"
      />
      <USwitch
        v-model="draft.forkEnabled"
        size="sm"
        :label="t('settings.riskPolicy.forkDecision.label')"
      />
      <UButton
        color="primary"
        size="sm"
        icon="i-lucide-plus"
        :loading="busy"
        :disabled="!canSubmit"
        data-testid="risk-policy-create-submit"
        @click="submit"
      >
        {{ t('settings.riskPolicy.add') }}
      </UButton>
    </div>
  </div>
</template>
