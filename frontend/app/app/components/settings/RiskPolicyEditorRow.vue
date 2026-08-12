<script setup lang="ts">
// ONE editable risk policy: the ceilings, the loop budgets, the per-class and per-role rules, the
// fork gate and the autonomy posture.
//
// Extracted out of `RiskPolicyPanel.vue` because the same form now serves two tiers (a board's own
// policies and an account's, ADR 0055). It owns only the FORM state and emits intent — the panel
// that mounts it knows which tier it is writing to, so nothing here has to.
import { computed, reactive, watch } from 'vue'
import type {
  RiskPolicyLibraryEntry,
  RequirementConcernLevel,
  UpdateRiskPolicyInput,
} from '~/types/merge'
import {
  CEILING_LABEL_KEYS,
  CONCERN_LABEL_KEYS,
  CONCERN_LEVELS,
  FORK_FLOOR_FIELD,
  FORK_FLOOR_LABEL_KEYS,
  riskPolicyPatchFromDraft,
  toRiskPolicyDraft,
} from '~/utils/riskPolicyDraft'
import { RISK_POLICY_AXES, RISK_POLICY_CEILING_FIELD } from '~/utils/riskPolicy'
import MergeClassRulesEditor from '~/components/settings/MergeClassRulesEditor.vue'
import MergeRolePolicyEditor from '~/components/settings/MergeRolePolicyEditor.vue'

const props = defineProps<{
  policy: RiskPolicyLibraryEntry
  /** Which single control is mid-request, keyed `<policyId>[:<action>]` by the owning panel. */
  busy: string | null
  /**
   * Whether this tier carries the two per-scope DEFAULT claims. False at the ACCOUNT tier, which
   * holds none: which policy governs a task that pinned none is a per-board question, so the badges
   * and promote buttons would be controls over a decision this tier never makes.
   */
  showDefaults: boolean
}>()

const emit = defineEmits<{
  save: [patch: UpdateRiskPolicyInput]
  promote: []
  promoteUnattended: []
  remove: []
}>()

const { t } = useI18n()

const draft = reactive(toRiskPolicyDraft(props.policy))

// Re-seed the form when the stored policy changes underneath it (a save elsewhere, a snapshot
// refresh). Keyed on the id as well as the row, so recycling this component for a different policy
// cannot leave the previous one's numbers in the fields.
watch(
  () => props.policy,
  (next) => Object.assign(draft, toRiskPolicyDraft(next)),
  { deep: false },
)

const concernOptions = computed<{ value: RequirementConcernLevel; label: string }[]>(() =>
  CONCERN_LEVELS.map((value) => ({ value, label: t(CONCERN_LABEL_KEYS[value]) })),
)

const onMissingOptions = computed<{ value: 'run' | 'skip'; label: string }[]>(() => [
  { value: 'run', label: t('settings.riskPolicy.forkDecision.onMissing.run') },
  { value: 'skip', label: t('settings.riskPolicy.forkDecision.onMissing.skip') },
])

/**
 * Why the delete button is disabled, naming the flag that actually blocks it.
 *
 * The two defaults are promoted by DIFFERENT buttons, so collapsing them into one "promote another
 * preset first" message sends an operator to re-point the in-app default and come back to a delete
 * that is still refused, with nothing on screen saying why.
 */
const deleteBlockedReason = computed(() => {
  if (!props.showDefaults) return t('settings.riskPolicy.deletePreset')
  if (props.policy.isDefault && props.policy.isUnattendedDefault)
    return t('settings.riskPolicy.deleteBothDefaultsBlocked')
  if (props.policy.isDefault) return t('settings.riskPolicy.deleteDefaultBlocked')
  if (props.policy.isUnattendedDefault)
    return t('settings.riskPolicy.deleteUnattendedDefaultBlocked')
  return t('settings.riskPolicy.deletePreset')
})

const deleteBlocked = computed(
  () => props.showDefaults && (props.policy.isDefault || props.policy.isUnattendedDefault),
)
</script>

<template>
  <div
    class="rounded-lg border border-slate-700 bg-slate-800/40 p-3"
    data-testid="risk-policy-row"
    :data-policy-id="policy.id"
    :data-policy-tier="policy.tier"
  >
    <div class="mb-3 flex items-center gap-2">
      <UInput
        v-model="draft.name"
        size="sm"
        class="flex-1"
        :placeholder="t('settings.riskPolicy.presetNamePlaceholder')"
      />
      <template v-if="showDefaults">
        <UBadge v-if="policy.isUnattendedDefault" color="info" variant="subtle" size="sm">
          {{ t('settings.riskPolicy.unattendedDefault') }}
        </UBadge>
        <!--
          Visibly labelled, like its `makeDefault` sibling below. `title` is a tooltip, NOT an
          accessible name: icon-only, this was announced as an unlabelled button, and a sighted
          user had to hover a bare glyph to discover it re-points which policy governs every
          unwatched run. `busy` is compared to a per-BUTTON key so promoting one default does not
          spin the other's button too.
        -->
        <UButton
          v-else
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-bot"
          :loading="busy === `${policy.id}:unattended`"
          :title="t('settings.riskPolicy.makeUnattendedDefault')"
          @click="emit('promoteUnattended')"
        >
          {{ t('settings.riskPolicy.makeUnattendedDefaultShort') }}
        </UButton>
        <UBadge v-if="policy.isDefault" color="primary" variant="subtle" size="sm">
          {{ t('settings.riskPolicy.default') }}
        </UBadge>
        <UButton
          v-else
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-star"
          :loading="busy === `${policy.id}:default`"
          @click="emit('promote')"
        >
          {{ t('settings.riskPolicy.makeDefault') }}
        </UButton>
      </template>
      <UButton
        color="error"
        variant="ghost"
        size="xs"
        icon="i-lucide-trash-2"
        :disabled="deleteBlocked || busy?.startsWith(policy.id)"
        :title="deleteBlockedReason"
        @click="emit('remove')"
      />
    </div>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-4">
      <label v-for="axis in RISK_POLICY_AXES" :key="axis" class="block">
        <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
          {{ t(CEILING_LABEL_KEYS[axis]) }}
        </span>
        <UInput
          v-model.number="draft[RISK_POLICY_CEILING_FIELD[axis]]"
          type="number"
          :min="0"
          :max="100"
          size="sm"
        />
      </label>
      <label class="block">
        <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
          {{ t('settings.riskPolicy.field.ciMaxAttempts') }}
        </span>
        <UInput v-model.number="draft.ciMaxAttempts" type="number" :min="0" :max="50" size="sm" />
      </label>
      <label class="block">
        <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
          {{ t('settings.riskPolicy.field.maxRequirementIterations') }}
        </span>
        <UInput
          v-model.number="draft.maxRequirementIterations"
          type="number"
          :min="1"
          :max="20"
          size="sm"
        />
      </label>
      <label class="block">
        <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
          {{ t('settings.riskPolicy.field.maxRequirementConcernAllowed') }}
        </span>
        <USelect
          v-model="draft.maxRequirementConcernAllowed"
          :items="concernOptions"
          value-key="value"
          size="sm"
        />
      </label>
    </div>

    <!-- Per-change-class auto-merge rules, each shown beside that class's accumulated track
         record — the number that justifies widening the rule. -->
    <div class="mt-3 rounded-md border border-slate-800 bg-slate-900/40 p-3">
      <MergeClassRulesEditor
        v-model="draft.classRules"
        :auto-merge-enabled="draft.autoMergeEnabled"
        :disabled="busy === policy.id"
      />
    </div>

    <!-- The role layer over those rules: what a run may do depending on WHO started it, up to and
         including a full sandbox. Directly under the base rules it narrows, since a role rule is
         only readable against the rule it applies to. -->
    <div class="mt-3 rounded-md border border-slate-800 bg-slate-900/40 p-3">
      <MergeRolePolicyEditor
        v-model:class-rules-by-role="draft.classRulesByRole"
        v-model:dry-run-roles="draft.dryRunRoles"
        v-model:submission-classes-by-role="draft.submissionClassesByRole"
        :class-rules="draft.classRules"
        :auto-merge-enabled="draft.autoMergeEnabled"
        :disabled="busy === policy.id"
      />
    </div>

    <!-- Implementation-fork decision gate: propose materially different approaches before the
         Coder writes code (in `auto` tri-state, gated on the task estimate). -->
    <div class="mt-3 rounded-md border border-slate-800 bg-slate-900/40 p-3">
      <USwitch
        v-model="draft.forkEnabled"
        size="sm"
        :label="t('settings.riskPolicy.forkDecision.label')"
        :description="t('settings.riskPolicy.forkDecision.hint')"
      />
      <div v-if="draft.forkEnabled" class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
        <label v-for="axis in RISK_POLICY_AXES" :key="axis" class="block">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ t(FORK_FLOOR_LABEL_KEYS[axis]) }}
          </span>
          <UInput
            v-model.number="draft[FORK_FLOOR_FIELD[axis]]"
            type="number"
            size="sm"
            :min="0"
            :max="100"
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('settings.riskPolicy.forkDecision.onMissingLabel') }}
          </span>
          <USelect v-model="draft.forkOnMissing" :items="onMissingOptions" size="sm" />
        </label>
      </div>
    </div>

    <!-- The autonomy posture: whether the parks the engine's own quality loops raise when they give
         up wait for a person, or are answered on the record so the run finishes. Never touches a
         gate the PIPELINE asked for. -->
    <div class="mt-3 rounded-md border border-slate-800 bg-slate-900/40 p-3">
      <USwitch
        v-model="draft.unattended"
        size="sm"
        :label="t('settings.riskPolicy.autonomy.label')"
        :description="
          draft.unattended
            ? t('settings.riskPolicy.autonomy.unattendedHint')
            : t('settings.riskPolicy.autonomy.attendedHint')
        "
      />
      <!-- Shown only while the posture is on, because that is the only state that reads it: a floor
           on an attended policy would be a control over a decision this policy never makes. It is
           not hidden as an "advanced override" — it is inert, which is a different thing. -->
      <label v-if="draft.unattended" class="mt-3 block">
        <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
          {{ t('settings.riskPolicy.autoAnswer.label') }}
        </span>
        <UInput
          v-model.number="draft.minAutoAnswerConfidence"
          type="number"
          min="0"
          max="100"
          size="sm"
          data-testid="risk-policy-auto-answer-floor"
        />
        <span class="mt-1 block text-[11px] text-slate-500">
          {{ t('settings.riskPolicy.autoAnswer.hint') }}
        </span>
      </label>
    </div>

    <div class="mt-3 flex items-center justify-between gap-3">
      <USwitch
        v-model="draft.autoMergeEnabled"
        size="sm"
        :label="t('settings.riskPolicy.field.autoMerge')"
        :description="
          draft.autoMergeEnabled
            ? t('settings.riskPolicy.autoMergeOnHint')
            : t('settings.riskPolicy.autoMergeOffHint')
        "
      />
      <UButton
        color="primary"
        variant="soft"
        size="xs"
        icon="i-lucide-save"
        :loading="busy === policy.id"
        data-testid="risk-policy-save"
        @click="emit('save', riskPolicyPatchFromDraft(draft, policy.name))"
      >
        {{ t('common.save') }}
      </UButton>
    </div>
  </div>
</template>
