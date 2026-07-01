<script setup lang="ts">
// Workspace settings: the merge-threshold preset library a task picks its
// auto-merge policy from (the `merger` step compares a PR's assessment against the
// resolved preset). Full CRUD over the mergePresets store — the same library the
// task inspector's "Merge policy" dropdown selects from. Exactly one preset is the
// default; it cannot be deleted or un-defaulted (the backend enforces this too).
import { computed, reactive, ref, watch } from 'vue'
import type { MergeThresholdPreset, RequirementConcernLevel } from '~/types/merge'

const { t } = useI18n()

// Per-concern-level label. An exhaustive Record keyed off the union (a missing member fails
// the typecheck); each value is a LITERAL catalog key so the typed-message-keys check sees
// it. Leaf keys mirror the enum value verbatim.
const CONCERN_LABEL_KEYS: Record<RequirementConcernLevel, string> = {
  none: 'settings.mergeThresholds.concern.none',
  low: 'settings.mergeThresholds.concern.low',
  medium: 'settings.mergeThresholds.concern.medium',
  high: 'settings.mergeThresholds.concern.high',
}

// Concern-level options for the requirements auto-pass threshold (none < low < medium < high).
const CONCERN_LEVELS = computed<{ value: RequirementConcernLevel; label: string }[]>(() => [
  { value: 'none', label: t(CONCERN_LABEL_KEYS.none) },
  { value: 'low', label: t(CONCERN_LABEL_KEYS.low) },
  { value: 'medium', label: t(CONCERN_LABEL_KEYS.medium) },
  { value: 'high', label: t(CONCERN_LABEL_KEYS.high) },
])

const store = useMergePresetsStore()
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
}
const drafts = reactive<Record<string, Draft>>({})

function toDraft(p: MergeThresholdPreset): Draft {
  return {
    name: p.name,
    maxComplexity: Math.round(p.maxComplexity * 100),
    maxRisk: Math.round(p.maxRisk * 100),
    maxImpact: Math.round(p.maxImpact * 100),
    ciMaxAttempts: p.ciMaxAttempts,
    maxRequirementIterations: p.maxRequirementIterations,
    maxRequirementConcernAllowed: p.maxRequirementConcernAllowed,
    autoMergeEnabled: p.autoMergeEnabled,
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

async function save(p: MergeThresholdPreset) {
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
    })
    toast.add({
      title: t('settings.mergeThresholds.toast.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    notifyError(t('settings.mergeThresholds.toast.saveFailed'), e)
  } finally {
    busy.value = null
  }
}

async function makeDefault(p: MergeThresholdPreset) {
  busy.value = p.id
  try {
    await store.update(p.id, { isDefault: true })
  } catch (e) {
    notifyError(t('settings.mergeThresholds.toast.defaultFailed'), e)
  } finally {
    busy.value = null
  }
}

async function remove(p: MergeThresholdPreset) {
  const ok = await confirm({
    title: t('settings.mergeThresholds.confirmDelete.title'),
    description: t('settings.mergeThresholds.confirmDelete.body', { name: p.name }),
    variant: 'destructive',
    confirmLabel: t('common.delete'),
    icon: 'i-lucide-trash-2',
  })
  if (!ok) return
  busy.value = p.id
  try {
    await store.remove(p.id)
  } catch (e) {
    notifyError(t('settings.mergeThresholds.toast.deleteFailed'), e)
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
    })
    draft.name = ''
    draft.autoMergeEnabled = true
    toast.add({
      title: t('settings.mergeThresholds.toast.created'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    notifyError(t('settings.mergeThresholds.toast.createFailed'), e)
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <i18n-t
      keypath="settings.mergeThresholds.intro"
      tag="p"
      class="text-xs text-slate-400"
      scope="global"
    >
      <template #merger>
        <span class="text-slate-300">{{ t('settings.mergeThresholds.mergerAgent') }}</span>
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
          :placeholder="t('settings.mergeThresholds.presetNamePlaceholder')"
        />
        <UBadge v-if="p.isDefault" color="primary" variant="subtle" size="sm">
          {{ t('settings.mergeThresholds.default') }}
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
          {{ t('settings.mergeThresholds.makeDefault') }}
        </UButton>
        <UButton
          color="error"
          variant="ghost"
          size="xs"
          icon="i-lucide-trash-2"
          :disabled="p.isDefault || busy === p.id"
          :title="
            p.isDefault
              ? t('settings.mergeThresholds.deleteDefaultBlocked')
              : t('settings.mergeThresholds.deletePreset')
          "
          @click="remove(p)"
        />
      </div>

      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label class="block">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('settings.mergeThresholds.field.maxComplexity') }}
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
            {{ t('settings.mergeThresholds.field.maxRisk') }}
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
            {{ t('settings.mergeThresholds.field.maxImpact') }}
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
            {{ t('settings.mergeThresholds.field.ciMaxAttempts') }}
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
            {{ t('settings.mergeThresholds.field.maxRequirementIterations') }}
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
            {{ t('settings.mergeThresholds.field.maxRequirementConcernAllowed') }}
          </span>
          <USelect
            v-model="drafts[p.id]!.maxRequirementConcernAllowed"
            :items="CONCERN_LEVELS"
            value-key="value"
            size="sm"
          />
        </label>
      </div>

      <div class="mt-3 flex items-center justify-between gap-3">
        <USwitch
          v-model="drafts[p.id]!.autoMergeEnabled"
          size="sm"
          :label="t('settings.mergeThresholds.field.autoMerge')"
          :description="
            drafts[p.id]!.autoMergeEnabled
              ? t('settings.mergeThresholds.autoMergeOnHint')
              : t('settings.mergeThresholds.autoMergeOffHint')
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
        {{ t('settings.mergeThresholds.newPreset') }}
      </p>
      <div class="flex flex-wrap items-end gap-3">
        <label class="block min-w-40 flex-1">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('settings.mergeThresholds.create.name') }}
          </span>
          <UInput
            v-model="draft.name"
            size="sm"
            :placeholder="t('settings.mergeThresholds.create.namePlaceholder')"
          />
        </label>
        <label class="block w-20">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('settings.mergeThresholds.create.complexity') }}
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
            {{ t('settings.mergeThresholds.create.risk') }}
          </span>
          <UInput v-model.number="draft.maxRisk" type="number" :min="0" :max="100" size="sm" />
        </label>
        <label class="block w-20">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('settings.mergeThresholds.create.impact') }}
          </span>
          <UInput v-model.number="draft.maxImpact" type="number" :min="0" :max="100" size="sm" />
        </label>
        <label class="block w-20">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('settings.mergeThresholds.create.ciFix') }}
          </span>
          <UInput v-model.number="draft.ciMaxAttempts" type="number" :min="0" :max="50" size="sm" />
        </label>
        <label class="block w-20">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('settings.mergeThresholds.create.reqIter') }}
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
            {{ t('settings.mergeThresholds.create.autoPass') }}
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
          :label="t('settings.mergeThresholds.field.autoMerge')"
        />
        <UButton
          color="primary"
          size="sm"
          icon="i-lucide-plus"
          :loading="creating"
          :disabled="!draft.name.trim()"
          @click="create"
        >
          {{ t('settings.mergeThresholds.add') }}
        </UButton>
      </div>
    </div>
  </div>
</template>
