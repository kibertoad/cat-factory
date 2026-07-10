<script setup lang="ts">
// Workspace settings: the merge-threshold preset library a task picks its
// auto-merge policy from (the `merger` step compares a PR's assessment against the
// resolved preset). Full CRUD over the riskPolicies store — the same library the
// task inspector's "Merge policy" dropdown selects from. Exactly one preset is the
// default; it cannot be deleted or un-defaulted (the backend enforces this too).
import { computed, reactive, ref, watch } from 'vue'
import type { RiskPolicy, RequirementConcernLevel } from '~/types/merge'
import type { StepGating } from '@cat-factory/contracts'

const { t } = useI18n()

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

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

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
      forkDecision: forkGating(d),
    })
    toast.add({
      title: t('settings.riskPolicy.toast.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    notifyError(t('settings.riskPolicy.toast.saveFailed'), e)
  } finally {
    busy.value = null
  }
}

async function makeDefault(p: RiskPolicy) {
  busy.value = p.id
  try {
    await store.update(p.id, { isDefault: true })
  } catch (e) {
    notifyError(t('settings.riskPolicy.toast.defaultFailed'), e)
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
    notifyError(t('settings.riskPolicy.toast.deleteFailed'), e)
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
      forkDecision: forkGating(draft),
    })
    draft.name = ''
    draft.autoMergeEnabled = true
    toast.add({
      title: t('settings.riskPolicy.toast.created'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    notifyError(t('settings.riskPolicy.toast.createFailed'), e)
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
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
    >
      <div class="mb-3 flex items-center gap-2">
        <UInput
          v-model="drafts[p.id]!.name"
          size="sm"
          class="flex-1"
          :placeholder="t('settings.riskPolicy.presetNamePlaceholder')"
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
          :disabled="p.isDefault || busy === p.id"
          :title="
            p.isDefault
              ? t('settings.riskPolicy.deleteDefaultBlocked')
              : t('settings.riskPolicy.deletePreset')
          "
          @click="remove(p)"
        />
      </div>

      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label class="block">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('settings.riskPolicy.field.maxComplexity') }}
          </span>
          <UInput
            v-model.number="drafts[p.id]!.maxComplexity"
            type="number"
            :min="0"
            :max="100"
            size="sm"
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('settings.riskPolicy.field.maxRisk') }}
          </span>
          <UInput
            v-model.number="drafts[p.id]!.maxRisk"
            type="number"
            :min="0"
            :max="100"
            size="sm"
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('settings.riskPolicy.field.maxImpact') }}
          </span>
          <UInput
            v-model.number="drafts[p.id]!.maxImpact"
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
          <label class="block">
            <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
              {{ t('settings.riskPolicy.forkDecision.minComplexity') }}
            </span>
            <UInput
              v-model.number="drafts[p.id]!.forkMinComplexity"
              type="number"
              size="sm"
              :min="0"
              :max="100"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
              {{ t('settings.riskPolicy.forkDecision.minRisk') }}
            </span>
            <UInput
              v-model.number="drafts[p.id]!.forkMinRisk"
              type="number"
              size="sm"
              :min="0"
              :max="100"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
              {{ t('settings.riskPolicy.forkDecision.minImpact') }}
            </span>
            <UInput
              v-model.number="drafts[p.id]!.forkMinImpact"
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
          />
        </label>
        <label class="block w-20">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('settings.riskPolicy.create.risk') }}
          </span>
          <UInput v-model.number="draft.maxRisk" type="number" :min="0" :max="100" size="sm" />
        </label>
        <label class="block w-20">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('settings.riskPolicy.create.impact') }}
          </span>
          <UInput v-model.number="draft.maxImpact" type="number" :min="0" :max="100" size="sm" />
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
          @click="create"
        >
          {{ t('settings.riskPolicy.add') }}
        </UButton>
      </div>
    </div>
  </div>
</template>
