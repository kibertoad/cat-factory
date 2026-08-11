<script setup lang="ts">
// Workspace settings: the merge-threshold preset library a task picks its
// auto-merge policy from (the `merger` step compares a PR's assessment against the
// resolved preset). Full CRUD over the riskPolicies store — the same library the
// task inspector's "Merge policy" dropdown selects from. Exactly one preset is the
// default; it cannot be deleted or un-defaulted (the backend enforces this too).
import { computed, reactive, ref, watch } from 'vue'
import type {
  ClassRulesByRole,
  DryRunRoles,
  MergeClassRules,
  RiskPolicy,
  RequirementConcernLevel,
  SubmissionClassesByRole,
} from '~/types/merge'
import type { StepGating } from '@cat-factory/contracts'
import {
  RISK_POLICY_AXES,
  RISK_POLICY_CEILING_FIELD,
  type RiskPolicyAxis,
} from '~/utils/riskPolicy'
import MergeClassRulesEditor from '~/components/settings/MergeClassRulesEditor.vue'
import MergeRolePolicyEditor from '~/components/settings/MergeRolePolicyEditor.vue'

const { t } = useI18n()

// Both axis groups below iterate the SHARED presentation order rather than hard-coding one,
// so this editor can't drift from the order the picker's preview and the inspector's summary
// line use (it used to read complexity-first while they read risk-first).
const CEILING_LABEL_KEYS: Record<RiskPolicyAxis, string> = {
  risk: 'settings.riskPolicy.field.maxRisk',
  impact: 'settings.riskPolicy.field.maxImpact',
  complexity: 'settings.riskPolicy.field.maxComplexity',
}

// The fork-decision group is the same three axes read as FLOORS (how big an estimate has to
// be before the coder stops to propose implementations), so it shares the order but not the
// fields.
const FORK_FLOOR_FIELD: Record<
  RiskPolicyAxis,
  'forkMinRisk' | 'forkMinImpact' | 'forkMinComplexity'
> = {
  risk: 'forkMinRisk',
  impact: 'forkMinImpact',
  complexity: 'forkMinComplexity',
}
const FORK_FLOOR_LABEL_KEYS: Record<RiskPolicyAxis, string> = {
  risk: 'settings.riskPolicy.forkDecision.minRisk',
  impact: 'settings.riskPolicy.forkDecision.minImpact',
  complexity: 'settings.riskPolicy.forkDecision.minComplexity',
}

// Per-concern-level label. An exhaustive Record keyed off the union (a missing member fails
// the typecheck); each value is a LITERAL catalog key so the typed-message-keys check sees
// it. Leaf keys mirror the enum value verbatim.
const CONCERN_LABEL_KEYS: Record<RequirementConcernLevel, string> = {
  none: 'settings.riskPolicy.concern.none',
  low: 'settings.riskPolicy.concern.low',
  medium: 'settings.riskPolicy.concern.medium',
  high: 'settings.riskPolicy.concern.high',
}

// Concern-level options for the requirements auto-pass threshold (none < low < medium < high).
const CONCERN_LEVELS = computed<{ value: RequirementConcernLevel; label: string }[]>(() => [
  { value: 'none', label: t(CONCERN_LABEL_KEYS.none) },
  { value: 'low', label: t(CONCERN_LABEL_KEYS.low) },
  { value: 'medium', label: t(CONCERN_LABEL_KEYS.medium) },
  { value: 'high', label: t(CONCERN_LABEL_KEYS.high) },
])

const store = useRiskPoliciesStore()
const toast = useToast()
const { present } = usePipelineErrorToast()
const { confirm } = useConfirm()

// Local editable copy per preset, kept in sync with the store. Percentages are
// edited 0..100 and stored 0..1.
interface Draft {
  name: string
  maxComplexity: number
  maxRisk: number
  maxImpact: number
  ciMaxAttempts: number
  maxRequirementIterations: number
  maxRequirementConcernAllowed: RequirementConcernLevel
  autoMergeEnabled: boolean
  // Whether a run under this policy answers the parks its own automatic loops raise when they give
  // up, rather than stopping for a person. Edited as a switch because the vocabulary is two-valued
  // and the OFF state is the historical behaviour.
  unattended: boolean
  // Per-change-class auto-merge rules. An OMITTED class means "use the score ceilings above",
  // so `{}` is the identity — the editor stores `thresholds` as an omission for that reason.
  classRules: MergeClassRules
  // The ROLE layer over those rules: per-role narrowing (narrow-only, so `{}` is the identity)
  // and the roles whose runs are sandboxed. Both replace the stored value wholesale on save,
  // which is why clearing one in the editor is a plain omission.
  classRulesByRole: ClassRulesByRole
  dryRunRoles: DryRunRoles
  // Which classes each role may LAND at all. A role with no entry is unrestricted, so `{}` is the
  // identity; an entry with no classes is the different policy that the role lands nothing.
  submissionClassesByRole: SubmissionClassesByRole
  // Implementation-fork decision gating (edited 0..100, stored 0..1); disabled ⇒ off in `auto`.
  forkEnabled: boolean
  forkMinComplexity: number
  forkMinRisk: number
  forkMinImpact: number
  forkOnMissing: 'run' | 'skip'
}
const drafts = reactive<Record<string, Draft>>({})

// On-missing-estimate options for the fork gating group (fail toward asking / skipping).
const ON_MISSING_OPTIONS = computed<{ value: 'run' | 'skip'; label: string }[]>(() => [
  { value: 'run', label: t('settings.riskPolicy.forkDecision.onMissing.run') },
  { value: 'skip', label: t('settings.riskPolicy.forkDecision.onMissing.skip') },
])

/** Build the `StepGating` payload for the fork-decision gate from a draft (or null when off). */
function forkGating(d: Draft): StepGating {
  return {
    enabled: d.forkEnabled,
    minComplexity: d.forkMinComplexity / 100,
    minRisk: d.forkMinRisk / 100,
    minImpact: d.forkMinImpact / 100,
    onMissingEstimate: d.forkOnMissing,
  }
}

function toDraft(p: RiskPolicy): Draft {
  return {
    name: p.name,
    maxComplexity: Math.round(p.maxComplexity * 100),
    maxRisk: Math.round(p.maxRisk * 100),
    maxImpact: Math.round(p.maxImpact * 100),
    ciMaxAttempts: p.ciMaxAttempts,
    maxRequirementIterations: p.maxRequirementIterations,
    maxRequirementConcernAllowed: p.maxRequirementConcernAllowed,
    autoMergeEnabled: p.autoMergeEnabled,
    unattended: p.autonomy === 'unattended',
    classRules: { ...p.classRules },
    classRulesByRole: { ...p.classRulesByRole },
    dryRunRoles: [...p.dryRunRoles],
    submissionClassesByRole: { ...p.submissionClassesByRole },
    forkEnabled: p.forkDecision?.enabled ?? false,
    forkMinComplexity: Math.round((p.forkDecision?.minComplexity ?? 0.5) * 100),
    forkMinRisk: Math.round((p.forkDecision?.minRisk ?? 0.4) * 100),
    forkMinImpact: Math.round((p.forkDecision?.minImpact ?? 0.4) * 100),
    forkOnMissing: p.forkDecision?.onMissingEstimate ?? 'run',
  }
}

watch(
  () => store.presets,
  (presets) => {
    for (const p of presets) if (!drafts[p.id]) drafts[p.id] = toDraft(p)
    for (const id of Object.keys(drafts)) if (!presets.some((p) => p.id === id)) delete drafts[id]
  },
  { immediate: true, deep: false },
)

const busy = ref<string | null>(null)

async function save(p: RiskPolicy) {
  const d = drafts[p.id]
  if (!d) return
  busy.value = p.id
  try {
    await store.update(p.id, {
      name: d.name.trim() || p.name,
      maxComplexity: d.maxComplexity / 100,
      maxRisk: d.maxRisk / 100,
      maxImpact: d.maxImpact / 100,
      ciMaxAttempts: d.ciMaxAttempts,
      maxRequirementIterations: d.maxRequirementIterations,
      maxRequirementConcernAllowed: d.maxRequirementConcernAllowed,
      autoMergeEnabled: d.autoMergeEnabled,
      autonomy: d.unattended ? 'unattended' : 'attended',
      classRules: d.classRules,
      classRulesByRole: d.classRulesByRole,
      dryRunRoles: d.dryRunRoles,
      submissionClassesByRole: d.submissionClassesByRole,
      forkDecision: forkGating(d),
    })
    toast.add({
      title: t('settings.riskPolicy.toast.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'settings.riskPolicy.toast.saveFailed')
  } finally {
    busy.value = null
  }
}

async function makeDefault(p: RiskPolicy) {
  busy.value = p.id
  try {
    await store.update(p.id, { isDefault: true })
  } catch (e) {
    present(e, 'settings.riskPolicy.toast.defaultFailed')
  } finally {
    busy.value = null
  }
}

/**
 * Promote this policy to the UNATTENDED default: the one a task that pins none resolves when
 * nothing is watching the run (a start over the public API, a tracker dispatch, a schedule fire).
 *
 * Its own action rather than a second meaning for the button above, because the two defaults are
 * independent: a board can run one posture in the app and another for the work it never sees, and
 * flagging one policy both ways is a deliberate choice rather than the only option.
 */
async function makeUnattendedDefault(p: RiskPolicy) {
  busy.value = p.id
  try {
    await store.update(p.id, { isUnattendedDefault: true })
  } catch (e) {
    present(e, 'settings.riskPolicy.toast.defaultFailed')
  } finally {
    busy.value = null
  }
}

async function remove(p: RiskPolicy) {
  const ok = await confirm({
    title: t('settings.riskPolicy.confirmDelete.title'),
    description: t('settings.riskPolicy.confirmDelete.body', { name: p.name }),
    variant: 'destructive',
    confirmLabel: t('common.delete'),
    icon: 'i-lucide-trash-2',
  })
  if (!ok) return
  busy.value = p.id
  try {
    await store.remove(p.id)
  } catch (e) {
    present(e, 'settings.riskPolicy.toast.deleteFailed')
  } finally {
    busy.value = null
  }
}

// ---- create form ----------------------------------------------------------
const creating = ref(false)
const draft = reactive<Draft>({
  name: '',
  maxComplexity: 50,
  maxRisk: 40,
  maxImpact: 50,
  ciMaxAttempts: 10,
  maxRequirementIterations: 6,
  maxRequirementConcernAllowed: 'none',
  autoMergeEnabled: true,
  // A new policy parks on its own caps, matching every built-in but the unattended default: a
  // licence to answer them is a posture somebody grants, never one a blank form assumes.
  unattended: false,
  // The create row authors the numbers only. Class and role rules start at their identity and
  // are edited on the saved preset, where each rule can be shown beside the base rule (and the
  // track record) it narrows — neither reads as anything on a policy that does not exist yet.
  classRules: {},
  classRulesByRole: {},
  dryRunRoles: [],
  submissionClassesByRole: {},
  forkEnabled: false,
  forkMinComplexity: 50,
  forkMinRisk: 40,
  forkMinImpact: 40,
  forkOnMissing: 'run',
})

async function create() {
  if (!draft.name.trim()) return
  creating.value = true
  try {
    await store.create({
      name: draft.name.trim(),
      maxComplexity: draft.maxComplexity / 100,
      maxRisk: draft.maxRisk / 100,
      maxImpact: draft.maxImpact / 100,
      ciMaxAttempts: draft.ciMaxAttempts,
      maxRequirementIterations: draft.maxRequirementIterations,
      maxRequirementConcernAllowed: draft.maxRequirementConcernAllowed,
      autoMergeEnabled: draft.autoMergeEnabled,
      autonomy: draft.unattended ? 'unattended' : 'attended',
      classRules: draft.classRules,
      forkDecision: forkGating(draft),
    })
    draft.name = ''
    draft.autoMergeEnabled = true
    draft.unattended = false
    draft.classRules = {}
    toast.add({
      title: t('settings.riskPolicy.toast.created'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'settings.riskPolicy.toast.createFailed')
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="space-y-4" data-testid="risk-policy-panel">
    <i18n-t
      keypath="settings.riskPolicy.intro"
      tag="p"
      class="text-xs text-slate-400"
      scope="global"
    >
      <template #merger>
        <span class="text-slate-300">{{ t('settings.riskPolicy.mergerAgent') }}</span>
      </template>
    </i18n-t>

    <div
      v-for="p in store.presets"
      :key="p.id"
      class="rounded-lg border border-slate-700 bg-slate-800/40 p-3"
      data-testid="risk-policy-row"
      :data-policy-id="p.id"
    >
      <div class="mb-3 flex items-center gap-2">
        <UInput
          v-model="drafts[p.id]!.name"
          size="sm"
          class="flex-1"
          :placeholder="t('settings.riskPolicy.presetNamePlaceholder')"
        />
        <UBadge v-if="p.isUnattendedDefault" color="info" variant="subtle" size="sm">
          {{ t('settings.riskPolicy.unattendedDefault') }}
        </UBadge>
        <UButton
          v-else
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-bot"
          :loading="busy === p.id"
          :title="t('settings.riskPolicy.makeUnattendedDefault')"
          @click="makeUnattendedDefault(p)"
        />
        <UBadge v-if="p.isDefault" color="primary" variant="subtle" size="sm">
          {{ t('settings.riskPolicy.default') }}
        </UBadge>
        <UButton
          v-else
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-star"
          :loading="busy === p.id"
          @click="makeDefault(p)"
        >
          {{ t('settings.riskPolicy.makeDefault') }}
        </UButton>
        <UButton
          color="error"
          variant="ghost"
          size="xs"
          icon="i-lucide-trash-2"
          :disabled="p.isDefault || p.isUnattendedDefault || busy === p.id"
          :title="
            p.isDefault || p.isUnattendedDefault
              ? t('settings.riskPolicy.deleteDefaultBlocked')
              : t('settings.riskPolicy.deletePreset')
          "
          @click="remove(p)"
        />
      </div>

      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label v-for="axis in RISK_POLICY_AXES" :key="axis" class="block">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ t(CEILING_LABEL_KEYS[axis]) }}
          </span>
          <UInput
            v-model.number="drafts[p.id]![RISK_POLICY_CEILING_FIELD[axis]]"
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
          <UInput
            v-model.number="drafts[p.id]!.ciMaxAttempts"
            type="number"
            :min="0"
            :max="50"
            size="sm"
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('settings.riskPolicy.field.maxRequirementIterations') }}
          </span>
          <UInput
            v-model.number="drafts[p.id]!.maxRequirementIterations"
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
            v-model="drafts[p.id]!.maxRequirementConcernAllowed"
            :items="CONCERN_LEVELS"
            value-key="value"
            size="sm"
          />
        </label>
      </div>

      <!-- Per-change-class auto-merge rules, each shown beside that class's accumulated track
           record — the number that justifies widening the rule. -->
      <div class="mt-3 rounded-md border border-slate-800 bg-slate-900/40 p-3">
        <MergeClassRulesEditor
          v-model="drafts[p.id]!.classRules"
          :auto-merge-enabled="drafts[p.id]!.autoMergeEnabled"
          :disabled="busy === p.id"
        />
      </div>

      <!-- The role layer over those rules: what a run may do depending on WHO started it, up to
           and including a full sandbox. Directly under the base rules it narrows, since a role
           rule is only readable against the rule it applies to. -->
      <div class="mt-3 rounded-md border border-slate-800 bg-slate-900/40 p-3">
        <MergeRolePolicyEditor
          v-model:class-rules-by-role="drafts[p.id]!.classRulesByRole"
          v-model:dry-run-roles="drafts[p.id]!.dryRunRoles"
          v-model:submission-classes-by-role="drafts[p.id]!.submissionClassesByRole"
          :class-rules="drafts[p.id]!.classRules"
          :auto-merge-enabled="drafts[p.id]!.autoMergeEnabled"
          :disabled="busy === p.id"
        />
      </div>

      <!-- Implementation-fork decision gate: propose materially different approaches before the
           Coder writes code (in `auto` tri-state, gated on the task estimate). -->
      <div class="mt-3 rounded-md border border-slate-800 bg-slate-900/40 p-3">
        <USwitch
          v-model="drafts[p.id]!.forkEnabled"
          size="sm"
          :label="t('settings.riskPolicy.forkDecision.label')"
          :description="t('settings.riskPolicy.forkDecision.hint')"
        />
        <div v-if="drafts[p.id]!.forkEnabled" class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label v-for="axis in RISK_POLICY_AXES" :key="axis" class="block">
            <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
              {{ t(FORK_FLOOR_LABEL_KEYS[axis]) }}
            </span>
            <UInput
              v-model.number="drafts[p.id]![FORK_FLOOR_FIELD[axis]]"
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
            <USelect v-model="drafts[p.id]!.forkOnMissing" :items="ON_MISSING_OPTIONS" size="sm" />
          </label>
        </div>
      </div>

      <!-- The autonomy posture: whether the parks the engine's own quality loops raise when they
           give up wait for a person, or are answered on the record so the run finishes. Never
           touches a gate the PIPELINE asked for. -->
      <div class="mt-3 rounded-md border border-slate-800 bg-slate-900/40 p-3">
        <USwitch
          v-model="drafts[p.id]!.unattended"
          size="sm"
          :label="t('settings.riskPolicy.autonomy.label')"
          :description="
            drafts[p.id]!.unattended
              ? t('settings.riskPolicy.autonomy.unattendedHint')
              : t('settings.riskPolicy.autonomy.attendedHint')
          "
        />
      </div>

      <div class="mt-3 flex items-center justify-between gap-3">
        <USwitch
          v-model="drafts[p.id]!.autoMergeEnabled"
          size="sm"
          :label="t('settings.riskPolicy.field.autoMerge')"
          :description="
            drafts[p.id]!.autoMergeEnabled
              ? t('settings.riskPolicy.autoMergeOnHint')
              : t('settings.riskPolicy.autoMergeOffHint')
          "
        />
        <UButton
          color="primary"
          variant="soft"
          size="xs"
          icon="i-lucide-save"
          :loading="busy === p.id"
          @click="save(p)"
        >
          {{ t('common.save') }}
        </UButton>
      </div>
    </div>

    <!-- create -->
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
            :items="CONCERN_LEVELS"
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
          :loading="creating"
          :disabled="!draft.name.trim()"
          data-testid="risk-policy-create-submit"
          @click="create"
        >
          {{ t('settings.riskPolicy.add') }}
        </UButton>
      </div>
    </div>
  </div>
</template>
