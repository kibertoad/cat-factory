<script setup lang="ts">
// Workspace settings: the merge-threshold preset library a task picks its
// auto-merge policy from (the `merger` step compares a PR's assessment against the
// resolved preset). Full CRUD over the mergePresets store — the same library the
// task inspector's "Merge policy" dropdown selects from. Exactly one preset is the
// default; it cannot be deleted or un-defaulted (the backend enforces this too).
import { reactive, ref, watch } from 'vue'
import type { MergeThresholdPreset, RequirementConcernLevel } from '~/types/merge'

// Concern-level options for the requirements auto-pass threshold (none < low < medium < high).
const CONCERN_LEVELS: { value: RequirementConcernLevel; label: string }[] = [
  { value: 'none', label: 'None (always stop)' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High (never stop)' },
]

const store = useMergePresetsStore()
const toast = useToast()

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
    })
    toast.add({ title: 'Preset saved', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    notifyError('Could not save preset', e)
  } finally {
    busy.value = null
  }
}

async function makeDefault(p: MergeThresholdPreset) {
  busy.value = p.id
  try {
    await store.update(p.id, { isDefault: true })
  } catch (e) {
    notifyError('Could not set default', e)
  } finally {
    busy.value = null
  }
}

async function remove(p: MergeThresholdPreset) {
  busy.value = p.id
  try {
    await store.remove(p.id)
  } catch (e) {
    notifyError('Could not delete preset', e)
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
    })
    draft.name = ''
    toast.add({ title: 'Preset created', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    notifyError('Could not create preset', e)
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-xs text-slate-400">
      Named auto-merge policies a task can choose. After CI passes, the
      <span class="text-slate-300">merger</span> agent scores the PR on complexity, risk and impact
      (0–100%); the PR auto-merges only when every score is at or below the preset's ceilings —
      otherwise a review notification is raised. The default preset governs any task that picks
      none.
    </p>

    <div
      v-for="p in store.presets"
      :key="p.id"
      class="rounded-lg border border-slate-700 bg-slate-800/40 p-3"
    >
      <div class="mb-3 flex items-center gap-2">
        <UInput v-model="drafts[p.id]!.name" size="sm" class="flex-1" placeholder="Preset name" />
        <UBadge v-if="p.isDefault" color="primary" variant="subtle" size="sm">Default</UBadge>
        <UButton
          v-else
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-star"
          :loading="busy === p.id"
          @click="makeDefault(p)"
        >
          Make default
        </UButton>
        <UButton
          color="error"
          variant="ghost"
          size="xs"
          icon="i-lucide-trash-2"
          :disabled="p.isDefault || busy === p.id"
          :title="p.isDefault ? 'The default preset cannot be deleted' : 'Delete preset'"
          @click="remove(p)"
        />
      </div>

      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label class="block">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            Max complexity %
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
            Max risk %
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
            Max impact %
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
            CI-fix attempts
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
            Requirement iterations
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
            Auto-pass concerns ≤
          </span>
          <USelect
            v-model="drafts[p.id]!.maxRequirementConcernAllowed"
            :items="CONCERN_LEVELS"
            value-key="value"
            size="sm"
          />
        </label>
      </div>

      <div class="mt-3 flex justify-end">
        <UButton
          color="primary"
          variant="soft"
          size="xs"
          icon="i-lucide-save"
          :loading="busy === p.id"
          @click="save(p)"
        >
          Save
        </UButton>
      </div>
    </div>

    <!-- create -->
    <div class="rounded-lg border border-dashed border-slate-700 p-3">
      <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        New preset
      </p>
      <div class="flex flex-wrap items-end gap-3">
        <label class="block min-w-40 flex-1">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">Name</span>
          <UInput v-model="draft.name" size="sm" placeholder="e.g. Cautious" />
        </label>
        <label class="block w-20">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">Cmplx%</span>
          <UInput
            v-model.number="draft.maxComplexity"
            type="number"
            :min="0"
            :max="100"
            size="sm"
          />
        </label>
        <label class="block w-20">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">Risk%</span>
          <UInput v-model.number="draft.maxRisk" type="number" :min="0" :max="100" size="sm" />
        </label>
        <label class="block w-20">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">Impact%</span>
          <UInput v-model.number="draft.maxImpact" type="number" :min="0" :max="100" size="sm" />
        </label>
        <label class="block w-20">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">CI-fix</span>
          <UInput v-model.number="draft.ciMaxAttempts" type="number" :min="0" :max="50" size="sm" />
        </label>
        <label class="block w-20">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500"
            >Req iter</span
          >
          <UInput
            v-model.number="draft.maxRequirementIterations"
            type="number"
            :min="1"
            :max="20"
            size="sm"
          />
        </label>
        <label class="block w-32">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500"
            >Auto-pass ≤</span
          >
          <USelect
            v-model="draft.maxRequirementConcernAllowed"
            :items="CONCERN_LEVELS"
            value-key="value"
            size="sm"
          />
        </label>
        <UButton
          color="primary"
          size="sm"
          icon="i-lucide-plus"
          :loading="creating"
          :disabled="!draft.name.trim()"
          @click="create"
        >
          Add
        </UButton>
      </div>
    </div>
  </div>
</template>
