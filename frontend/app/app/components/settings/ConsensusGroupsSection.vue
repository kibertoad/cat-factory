<script setup lang="ts">
// The workspace's CONSENSUS-GROUP library, rendered as a section of the Model Configuration
// screen. A group is a reusable review panel — participants (role + perspective framing +
// model), the strategy that runs them, a synthesizer — plus the ESTIMATE BAR a task must clear
// to earn it. A pipeline step names a SET of groups and the engine runs the most demanding tier
// the task clears, so the library is where "which models review our risky work" is decided once
// instead of per pipeline.
//
// It lives beside the model presets rather than in its own destination because it answers the
// same question those do — which models do the work — and splitting them is what sends people
// hunting through Integrations for a model setting.
import { computed, ref } from 'vue'
import type { ConsensusGroup, ConsensusStrategy } from '~/types/consensus'
import { isSelectable } from '~/stores/models'

const { t } = useI18n()
const groups = useConsensusGroupsStore()
const models = useModelsStore()
const creds = useVendorCredentialsStore()
const uiMode = useUiModeStore()
const { present } = usePipelineErrorToast()
const { confirm } = useConfirm()

/**
 * Advanced-tier authoring that REVEALS itself once the workspace has a library. Hiding a
 * populated library in basic mode would leave a basic-mode user looking at tier chips in the
 * pipeline builder with no way to find out what they contain — the same failure the override
 * rules exist to prevent.
 */
const visible = computed(() => uiMode.isAdvanced || groups.hasGroups)

const STRATEGIES = computed<{ value: ConsensusStrategy; label: string }[]>(() => [
  { value: 'specialist-panel', label: t('pipeline.builder.strategyOption.specialist-panel') },
  { value: 'debate', label: t('pipeline.builder.strategyOption.debate') },
  { value: 'ranked-voting', label: t('pipeline.builder.strategyOption.ranked-voting') },
])

interface EditorState {
  id?: string
  name: string
  description: string
  strategy: ConsensusStrategy
  participants: { id: string; role: string; systemFraming?: string; modelId?: string }[]
  synthesizerModelId: string
  rounds: number | null
  gated: boolean
  minComplexity: number | null
  minRisk: number | null
  minImpact: number | null
}

const editor = ref<EditorState | null>(null)
const busy = ref(false)

function uid(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`
}

/** A fresh group starts as a gated two-model panel — the shape the feature is for. */
function startCreate() {
  editor.value = {
    name: '',
    description: '',
    strategy: 'specialist-panel',
    participants: [
      { id: uid('cnp'), role: 'Pragmatist', systemFraming: 'Favour the simplest viable approach.' },
      {
        id: uid('cnp'),
        role: 'Skeptic',
        systemFraming: 'Probe risks, edge cases and failure modes.',
      },
    ],
    synthesizerModelId: '',
    rounds: null,
    gated: true,
    minComplexity: null,
    minRisk: 0.7,
    minImpact: null,
  }
}

function startEdit(group: ConsensusGroup) {
  editor.value = {
    id: group.id,
    name: group.name,
    description: group.description ?? '',
    strategy: group.strategy,
    participants: group.participants.map((p) => ({ ...p })),
    synthesizerModelId: group.synthesizerModelId ?? '',
    rounds: group.rounds ?? null,
    gated: group.gating.enabled,
    minComplexity: group.gating.minComplexity ?? null,
    minRisk: group.gating.minRisk ?? null,
    minImpact: group.gating.minImpact ?? null,
  }
}

function addParticipant() {
  editor.value?.participants.push({ id: uid('cnp'), role: '' })
}

function removeParticipant(index: number) {
  editor.value?.participants.splice(index, 1)
}

/** The bar a stored group sets, for the list rows. */
function barLabel(group: ConsensusGroup): string {
  const bar = groups.barFor(group)
  return bar === null
    ? t('settings.consensusGroups.list.always')
    : t('settings.consensusGroups.list.bar', { bar })
}

const selectableModelIds = computed(() => {
  const configured = creds.configuredVendors
  return models.models
    .filter((m) => isSelectable(m, configured))
    .map((m) => ({ id: m.id, label: m.label }))
})

/**
 * A threshold field's value as the contract wants it, or undefined when the author left it blank.
 *
 * `v-model.number` does NOT yield null for an emptied input: Vue's coercion returns the RAW value
 * when it cannot parse a number, so clearing a box a user had typed in leaves `''` behind. Read
 * back with a `!== null` test that empty string passes every guard, reaches the wire as
 * `minRisk: ''`, and comes back a 422 behind a generic "could not save" toast. Anything that is
 * not a finite number is therefore treated as absent, at the one place the value crosses out of
 * the editor.
 */
function threshold(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The thresholds the author actually set, in contract shape. */
function thresholds(e: EditorState) {
  return {
    ...(threshold(e.minComplexity) !== undefined
      ? { minComplexity: threshold(e.minComplexity) }
      : {}),
    ...(threshold(e.minRisk) !== undefined ? { minRisk: threshold(e.minRisk) } : {}),
    ...(threshold(e.minImpact) !== undefined ? { minImpact: threshold(e.minImpact) } : {}),
  }
}

/**
 * The gating payload. A gated group with no threshold is refused by the backend (it could never
 * be selected), so surface that here rather than as a save failure.
 */
function gatingPayload(e: EditorState) {
  if (!e.gated) return { enabled: false as const, onMissingEstimate: 'consensus' as const }
  return {
    enabled: true as const,
    ...thresholds(e),
    onMissingEstimate: 'consensus' as const,
  }
}

const gatingIncomplete = computed(
  () => !!editor.value?.gated && Object.keys(thresholds(editor.value)).length === 0,
)

async function save() {
  const e = editor.value
  if (!e) return
  if (!e.name.trim() || gatingIncomplete.value) return
  const body = {
    name: e.name.trim(),
    ...(e.description.trim() ? { description: e.description.trim() } : {}),
    strategy: e.strategy,
    participants: e.participants.map((p) => ({
      id: p.id,
      role: p.role.trim() || t('settings.consensusGroups.editor.unnamedRole'),
      ...(p.systemFraming?.trim() ? { systemFraming: p.systemFraming.trim() } : {}),
      ...(p.modelId?.trim() ? { modelId: p.modelId.trim() } : {}),
    })),
    ...(e.synthesizerModelId.trim() ? { synthesizerModelId: e.synthesizerModelId.trim() } : {}),
    ...(e.rounds !== null ? { rounds: e.rounds } : {}),
    gating: gatingPayload(e),
  }
  busy.value = true
  try {
    if (e.id) await groups.update(e.id, body)
    else await groups.create(body)
    editor.value = null
  } catch (err) {
    present(err, 'settings.consensusGroups.toast.saveFailed')
  } finally {
    busy.value = false
  }
}

async function remove(group: ConsensusGroup) {
  const ok = await confirm({
    title: t('settings.consensusGroups.confirmDelete.title'),
    description: t('settings.consensusGroups.confirmDelete.body', { name: group.name }),
    variant: 'destructive',
    confirmLabel: t('common.delete'),
    icon: 'i-lucide-trash-2',
  })
  if (!ok) return
  busy.value = true
  try {
    await groups.remove(group.id)
  } catch (err) {
    present(err, 'settings.consensusGroups.toast.deleteFailed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="visible" class="space-y-3 border-t border-slate-800 pt-5">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-slate-100">
          {{ t('settings.consensusGroups.title') }}
        </h2>
        <p class="mt-1 text-xs leading-relaxed text-slate-500">
          {{ t('settings.consensusGroups.intro') }}
        </p>
      </div>
      <UButton
        v-if="!editor"
        icon="i-lucide-plus"
        color="neutral"
        variant="soft"
        size="sm"
        class="shrink-0"
        data-testid="consensus-group-new"
        @click="startCreate"
      >
        {{ t('settings.consensusGroups.new') }}
      </UButton>
    </div>

    <!-- ===== list ===== -->
    <template v-if="!editor">
      <div v-if="groups.groups.length" class="space-y-2">
        <div
          v-for="g in groups.groups"
          :key="g.id"
          class="rounded-xl border border-slate-800 bg-slate-900/50 p-3"
          data-testid="consensus-group-row"
        >
          <div class="flex items-center gap-2">
            <span class="truncate text-sm font-semibold text-slate-100">{{ g.name }}</span>
            <UBadge color="neutral" variant="subtle" size="xs">{{ barLabel(g) }}</UBadge>
            <div class="ms-auto flex items-center gap-1">
              <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                icon="i-lucide-pencil"
                :title="t('settings.consensusGroups.list.editTitle')"
                @click="startEdit(g)"
              />
              <UButton
                size="xs"
                variant="ghost"
                color="error"
                icon="i-lucide-trash-2"
                :loading="busy"
                :title="t('settings.consensusGroups.list.deleteTitle')"
                @click="remove(g)"
              />
            </div>
          </div>
          <p v-if="g.description" class="mt-1 text-[11px] text-slate-400">{{ g.description }}</p>
          <div class="mt-1.5 text-[11px] text-slate-400">
            {{ t(`pipeline.builder.strategyOption.${g.strategy}`) }}
            ·
            {{
              t(
                'settings.consensusGroups.list.participantCount',
                { count: g.participants.length },
                g.participants.length,
              )
            }}
          </div>
        </div>
      </div>
      <p v-else class="py-4 text-center text-sm text-slate-500">
        {{ t('settings.consensusGroups.list.empty') }}
      </p>
    </template>

    <!-- ===== editor ===== -->
    <div v-else class="space-y-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label
            class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400"
          >
            {{ t('settings.consensusGroups.editor.nameLabel') }}
          </label>
          <UInput
            v-model="editor.name"
            size="sm"
            class="w-full"
            :placeholder="t('settings.consensusGroups.editor.namePlaceholder')"
          />
        </div>
        <div>
          <label
            class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400"
          >
            {{ t('settings.consensusGroups.editor.strategyLabel') }}
          </label>
          <select
            v-model="editor.strategy"
            class="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
          >
            <option v-for="s in STRATEGIES" :key="s.value" :value="s.value">{{ s.label }}</option>
          </select>
        </div>
      </div>

      <div>
        <label class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('settings.consensusGroups.editor.descriptionLabel') }}
        </label>
        <UInput
          v-model="editor.description"
          size="sm"
          class="w-full"
          :placeholder="t('settings.consensusGroups.editor.descriptionPlaceholder')"
        />
      </div>

      <!-- participants -->
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ t('settings.consensusGroups.editor.participantsLabel') }}
          </span>
          <UButton
            icon="i-lucide-plus"
            color="neutral"
            variant="ghost"
            size="xs"
            :label="t('settings.consensusGroups.editor.addParticipant')"
            @click="addParticipant"
          />
        </div>
        <p class="text-[11px] text-slate-500">
          {{ t('settings.consensusGroups.editor.participantsHint') }}
        </p>
        <div
          v-for="(p, index) in editor.participants"
          :key="p.id"
          class="flex flex-wrap items-center gap-1.5"
        >
          <UInput
            v-model="p.role"
            size="xs"
            class="w-32"
            :placeholder="t('pipeline.builder.rolePlaceholder')"
          />
          <UInput
            v-model="p.systemFraming"
            size="xs"
            class="min-w-40 flex-1"
            :placeholder="t('settings.consensusGroups.editor.framingPlaceholder')"
          />
          <select
            v-model="p.modelId"
            class="w-44 rounded border border-slate-700 bg-slate-900 px-1.5 py-1 text-xs text-slate-300"
          >
            <option :value="undefined">{{ t('settings.consensusGroups.editor.stepModel') }}</option>
            <option v-for="m in selectableModelIds" :key="m.id" :value="m.id">{{ m.label }}</option>
          </select>
          <UButton
            icon="i-lucide-x"
            color="error"
            variant="ghost"
            size="xs"
            :disabled="editor.participants.length <= 2"
            :title="t('pipeline.builder.removeParticipant')"
            @click="removeParticipant(index)"
          />
        </div>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label
            class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400"
          >
            {{ t('settings.consensusGroups.editor.synthesizerLabel') }}
          </label>
          <select
            v-model="editor.synthesizerModelId"
            class="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
          >
            <option value="">{{ t('settings.consensusGroups.editor.stepModel') }}</option>
            <option v-for="m in selectableModelIds" :key="m.id" :value="m.id">{{ m.label }}</option>
          </select>
        </div>
        <div v-if="editor.strategy === 'debate'">
          <label
            class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400"
          >
            {{ t('pipeline.builder.rounds') }}
          </label>
          <UInput v-model.number="editor.rounds" type="number" min="1" max="5" size="sm" />
        </div>
      </div>

      <!-- the estimate bar -->
      <div class="space-y-2 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
        <label class="flex items-center gap-2 text-xs text-slate-300">
          <input v-model="editor.gated" type="checkbox" class="accent-emerald-500" />
          {{ t('settings.consensusGroups.editor.gatedLabel') }}
        </label>
        <p class="text-[11px] text-slate-500">
          {{ t('settings.consensusGroups.editor.gatedHint') }}
        </p>
        <div v-if="editor.gated" class="flex flex-wrap items-center gap-3 text-xs">
          <label
            class="flex items-center gap-1.5 text-slate-400"
            :title="t('pipeline.builder.riskThresholdHint')"
          >
            {{ t('pipeline.builder.riskThreshold') }}
            <UInput
              v-model.number="editor.minRisk"
              type="number"
              min="0"
              max="1"
              step="0.1"
              size="xs"
              class="w-20"
            />
          </label>
          <label
            class="flex items-center gap-1.5 text-slate-400"
            :title="t('pipeline.builder.impactThresholdHint')"
          >
            {{ t('pipeline.builder.impactThreshold') }}
            <UInput
              v-model.number="editor.minImpact"
              type="number"
              min="0"
              max="1"
              step="0.1"
              size="xs"
              class="w-20"
            />
          </label>
          <label
            class="flex items-center gap-1.5 text-slate-400"
            :title="t('pipeline.builder.complexityThresholdHint')"
          >
            {{ t('settings.consensusGroups.editor.complexityThreshold') }}
            <UInput
              v-model.number="editor.minComplexity"
              type="number"
              min="0"
              max="1"
              step="0.1"
              size="xs"
              class="w-20"
            />
          </label>
        </div>
        <p v-if="gatingIncomplete" class="text-[11px] text-amber-400">
          {{ t('settings.consensusGroups.editor.gatingIncomplete') }}
        </p>
      </div>

      <div class="flex items-center justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          @click="
            () => {
              editor = null
            }
          "
        >
          {{ t('settings.consensusGroups.editor.cancel') }}
        </UButton>
        <UButton
          color="primary"
          size="sm"
          :loading="busy"
          :disabled="!editor.name.trim() || gatingIncomplete"
          data-testid="consensus-group-save"
          @click="save"
        >
          {{ t('settings.consensusGroups.editor.save') }}
        </UButton>
      </div>
    </div>
  </section>
</template>
