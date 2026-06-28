<script setup lang="ts">
import { computed, onMounted } from 'vue'
import type { Block } from '~/types/domain'
import type { WritebackOverride } from '~/types/tracker'
import { mergePresetOptionLabel, mergePresetThresholds } from '~/utils/mergePreset'

const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const mergePresets = useMergePresetsStore()
const modelPresets = useModelPresetsStore()
const models = useModelsStore()
const pipelines = usePipelinesStore()
const accounts = useAccountsStore()
const tracker = useTrackerStore()
const ui = useUiStore()
const { ready, unavailableInPreset } = useAiReadiness()
const { t, n } = useI18n()

// ---- responsible product person --------------------------------------------
// The account member (a `product` role-holder) accountable for this task; they are
// notified when requirement review flags findings. Picks from the account roster.
onMounted(() => {
  const id = accounts.activeAccountId
  if (id && accounts.members.length === 0) void accounts.loadRoster(id).catch(() => {})
})
const productMembers = computed(() => accounts.members.filter((m) => m.roles.includes('product')))
const responsible = computed(() =>
  accounts.members.find((m) => m.userId === props.block.responsibleProductUserId),
)
const responsibleLabel = computed(() => {
  const m = responsible.value
  if (!m) return undefined
  return m.name || m.email || m.userId
})
const responsibleMenu = computed(() => [
  [
    {
      label: t('inspector.runSettings.unassigned'),
      icon: 'i-lucide-user-x',
      onSelect: () => setResponsible(''),
    },
    ...productMembers.value.map((m) => ({
      label: m.name || m.email || m.userId,
      icon: 'i-lucide-user',
      onSelect: () => setResponsible(m.userId),
    })),
  ],
])
function setResponsible(userId: string) {
  board.updateBlock(props.block.id, { responsibleProductUserId: userId })
}

// ---- auto-start dependents -------------------------------------------------
// Preceding-task toggle: when this task merges, the engine auto-starts the tasks that
// depend on it (skipping any on an individual-usage model, which can't unlock unattended).
function setAutoStartDependents(value: boolean) {
  board.updateBlock(props.block.id, { autoStartDependents: value })
}

// ---- merge policy preset ---------------------------------------------------
// Which merge threshold preset governs this task's auto-merge decision + CI-fixer
// budget. None selected → the workspace default preset. (The old confidence-based
// auto-merge threshold is gone; the `merger` step gates on this policy instead.)
const selectedPreset = computed(() => mergePresets.resolve(props.block.mergePresetId))
const presetMenu = computed(() => [
  [
    {
      label: mergePresets.defaultPreset
        ? t('inspector.runSettings.defaultPresetThresholds', {
            name: mergePresets.defaultPreset.name,
            thresholds: mergePresetThresholds(mergePresets.defaultPreset),
          })
        : t('inspector.runSettings.workspaceDefault'),
      icon: 'i-lucide-rotate-ccw',
      onSelect: () => setPreset(''),
    },
    ...mergePresets.presets.map((p) => ({
      label: mergePresetOptionLabel(p),
      icon: 'i-lucide-git-merge',
      onSelect: () => setPreset(p.id),
    })),
  ],
])
function setPreset(id: string) {
  board.updateBlock(props.block.id, { mergePresetId: id })
}

// ---- model preset ----------------------------------------------------------
// Which model preset decides the model each agent step runs on. None selected → the
// workspace default preset. Changing it affects only steps that haven't started yet
// (a running step keeps the model it was dispatched with). A model pinned directly on
// the task still overrides the preset.
const selectedModelPreset = computed(() => modelPresets.resolve(props.block.modelPresetId))

// Model ids in the chosen preset that aren't usable under the current configuration — the
// task would fail when a step dispatches onto one. Labelled for the inline warning below.
// Gated on `ready`: until the per-workspace catalog has loaded, `isUsableId` reports every
// model unusable, which would surface a spurious "this task would fail" warning (e.g. while
// the catalog fetch is in flight, or if it failed) — so only flag once the catalog is known.
const unavailablePresetModels = computed(() =>
  ready.value
    ? unavailableInPreset(selectedModelPreset.value).map((id) => models.labelForId(id))
    : [],
)
const modelPresetMenu = computed(() => [
  [
    {
      label: modelPresets.defaultPreset
        ? t('inspector.runSettings.defaultPreset', { name: modelPresets.defaultPreset.name })
        : t('inspector.runSettings.workspaceDefault'),
      icon: 'i-lucide-rotate-ccw',
      onSelect: () => setModelPreset(''),
    },
    ...modelPresets.presets.map((p) => ({
      label: p.name,
      icon: 'i-lucide-cpu',
      onSelect: () => setModelPreset(p.id),
    })),
  ],
])
function setModelPreset(id: string) {
  board.updateBlock(props.block.id, { modelPresetId: id })
}

// ---- pipeline --------------------------------------------------------------
// The pipeline this task's Run controls default to. None selected → the user picks
// at run time (the board falls back to the first defined pipeline).
const selectedPipeline = computed(() =>
  props.block.pipelineId ? pipelines.getPipeline(props.block.pipelineId) : undefined,
)
const pipelineMenu = computed(() => [
  [
    {
      label: t('inspector.runSettings.noDefault'),
      icon: 'i-lucide-rotate-ccw',
      onSelect: () => setPipeline(''),
    },
    ...pipelines.pipelines.map((p) => ({
      label: p.name,
      icon: 'i-lucide-workflow',
      onSelect: () => setPipeline(p.id),
    })),
  ],
])
function setPipeline(id: string) {
  board.updateBlock(props.block.id, { pipelineId: id })
}

// ---- issue-tracker writeback overrides -------------------------------------
// Per-task overrides for the two workspace writeback toggles (comment on PR open,
// close linked issue on merge). null override ⇒ inherit the workspace default.
function setCommentOnPrOpen(value: WritebackOverride | null) {
  board.updateBlock(props.block.id, { trackerCommentOnPrOpen: value })
}
function setResolveOnMerge(value: WritebackOverride | null) {
  board.updateBlock(props.block.id, { trackerResolveOnMerge: value })
}
function writebackMenu(set: (value: WritebackOverride | null) => void) {
  return [
    [
      {
        label: t('inspector.runSettings.inheritWorkspace'),
        icon: 'i-lucide-rotate-ccw',
        onSelect: () => set(null),
      },
      { label: t('inspector.runSettings.on'), icon: 'i-lucide-check', onSelect: () => set('on') },
      { label: t('inspector.runSettings.off'), icon: 'i-lucide-x', onSelect: () => set('off') },
    ],
  ]
}

function writebackLabel(
  override: WritebackOverride | null | undefined,
  wsDefault: boolean,
): string {
  if (override === 'on') return t('inspector.runSettings.on')
  if (override === 'off') return t('inspector.runSettings.off')
  return wsDefault ? t('inspector.runSettings.inheritOn') : t('inspector.runSettings.inheritOff')
}

const commentOnPrOpenLabel = computed(() =>
  writebackLabel(props.block.trackerCommentOnPrOpen, tracker.settings.writebackCommentOnPrOpen),
)
const resolveOnMergeLabel = computed(() =>
  writebackLabel(props.block.trackerResolveOnMerge, tracker.settings.writebackResolveOnMerge),
)

// ---- technical label (tri-state) -------------------------------------------
// Whether this is a purely technical task (the implementer then treats the task
// definition as primary and the spec as a regression reference). Tri-state: Unset lets
// the engine infer it from the spec phase; Technical / Business are authoritative human
// choices the engine never overrides. `null` clears back to Unset.
function setTechnical(value: boolean | null) {
  board.updateBlock(props.block.id, { technical: value })
}
const technicalMenu = computed(() => [
  [
    {
      label: t('inspector.runSettings.technical.unset'),
      icon: 'i-lucide-rotate-ccw',
      onSelect: () => setTechnical(null),
    },
    {
      label: t('inspector.runSettings.technical.technical'),
      icon: 'i-lucide-wrench',
      onSelect: () => setTechnical(true),
    },
    {
      label: t('inspector.runSettings.technical.business'),
      icon: 'i-lucide-briefcase',
      onSelect: () => setTechnical(false),
    },
  ],
])
const technicalLabel = computed(() => {
  if (props.block.technical === true) return t('inspector.runSettings.technical.technical')
  if (props.block.technical === false) return t('inspector.runSettings.technical.business')
  return t('inspector.runSettings.technical.unset')
})
</script>

<template>
  <div class="space-y-4">
    <!-- pipeline -->
    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('inspector.runSettings.pipeline') }}
        </span>
        <UDropdownMenu :items="pipelineMenu">
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-workflow"
            trailing-icon="i-lucide-chevron-down"
          />
        </UDropdownMenu>
      </div>
      <div v-if="selectedPipeline" class="flex items-center gap-1">
        <UBadge
          color="primary"
          variant="subtle"
          size="sm"
          class="cursor-pointer"
          @click="setPipeline('')"
        >
          {{ selectedPipeline.name }}<UIcon name="i-lucide-x" class="ml-0.5 h-3 w-3" />
        </UBadge>
      </div>
      <div v-else class="text-[11px] text-slate-500">
        {{ t('inspector.runSettings.pipelineEmpty') }}
      </div>
    </div>

    <!-- merge policy preset -->
    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('inspector.runSettings.mergePolicy') }}
        </span>
        <UDropdownMenu :items="presetMenu">
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-git-merge"
            trailing-icon="i-lucide-chevron-down"
          />
        </UDropdownMenu>
      </div>
      <div v-if="selectedPreset" class="text-[11px] text-slate-400">
        <i18n-t keypath="inspector.runSettings.mergePresetDetail" tag="span" scope="global">
          <template #name>
            <span class="text-slate-300">{{ selectedPreset.name }}</span>
          </template>
          <template #complexity>{{ n(selectedPreset.maxComplexity, { key: 'percent' }) }}</template>
          <template #risk>{{ n(selectedPreset.maxRisk, { key: 'percent' }) }}</template>
          <template #impact>{{ n(selectedPreset.maxImpact, { key: 'percent' }) }}</template>
          <template #attempts>{{ selectedPreset.ciMaxAttempts }}</template>
        </i18n-t>
        <span v-if="!block.mergePresetId" class="text-slate-500">{{
          t('inspector.runSettings.workspaceDefaultParen')
        }}</span>
      </div>
      <div v-else class="text-[11px] text-slate-500">
        {{ t('inspector.runSettings.mergePresetEmpty') }}
      </div>
    </div>

    <!-- model preset -->
    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('inspector.runSettings.modelPreset') }}
        </span>
        <UDropdownMenu :items="modelPresetMenu">
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-cpu"
            trailing-icon="i-lucide-chevron-down"
          />
        </UDropdownMenu>
      </div>
      <div v-if="selectedModelPreset" class="text-[11px] text-slate-400">
        <span class="text-slate-300">{{ selectedModelPreset.name }}</span>
        {{ t('inspector.runSettings.modelPresetBase', { model: selectedModelPreset.baseModelId })
        }}<span v-if="Object.keys(selectedModelPreset.overrides).length">{{
          t(
            'inspector.runSettings.modelPresetOverrides',
            { count: Object.keys(selectedModelPreset.overrides).length },
            Object.keys(selectedModelPreset.overrides).length,
          )
        }}</span
        >.
        <span v-if="!block.modelPresetId" class="text-slate-500">{{
          t('inspector.runSettings.workspaceDefaultParen')
        }}</span>
      </div>
      <div v-else class="text-[11px] text-slate-500">
        {{ t('inspector.runSettings.modelPresetEmpty') }}
      </div>
      <div
        v-if="unavailablePresetModels.length"
        class="mt-2 rounded-md border border-amber-500/40 bg-amber-950/40 p-2 text-[11px] text-amber-200/90"
      >
        <div class="flex items-start gap-1.5">
          <UIcon
            name="i-lucide-triangle-alert"
            class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400"
          />
          <div class="min-w-0">
            <p>
              <i18n-t keypath="inspector.runSettings.unavailableModels" tag="span" scope="global">
                <template #models>
                  <span class="text-amber-100">{{ unavailablePresetModels.join(', ') }}</span>
                </template>
              </i18n-t>
            </p>
            <div class="mt-1.5 flex flex-wrap gap-2">
              <button
                class="font-medium text-amber-100 underline-offset-2 hover:underline"
                @click="ui.openModelConfig()"
              >
                {{ t('inspector.runSettings.editPresets') }}
              </button>
              <button
                class="font-medium text-amber-100 underline-offset-2 hover:underline"
                @click="ui.openVendorCredentials()"
              >
                {{ t('inspector.runSettings.configureVendors') }}
              </button>
            </div>
          </div>
        </div>
      </div>
      <p class="mt-1 text-[11px] text-slate-500">
        {{ t('inspector.runSettings.modelPresetChangeHint') }}
      </p>
    </div>

    <!-- technical label (tri-state) -->
    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('inspector.runSettings.taskKind') }}
        </span>
        <UDropdownMenu :items="technicalMenu">
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-wrench"
            trailing-icon="i-lucide-chevron-down"
          >
            {{ technicalLabel }}
          </UButton>
        </UDropdownMenu>
      </div>
      <div class="text-[11px] text-slate-500">
        <template v-if="block.technical === true">
          {{ t('inspector.runSettings.technicalHint.technical') }}
        </template>
        <template v-else-if="block.technical === false">
          {{ t('inspector.runSettings.technicalHint.business') }}
        </template>
        <template v-else>
          {{ t('inspector.runSettings.technicalHint.unset') }}
        </template>
      </div>
    </div>

    <!-- issue-tracker writeback overrides -->
    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('inspector.runSettings.issueWriteback') }}
        </span>
      </div>
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-slate-400">{{
            t('inspector.runSettings.commentOnPrOpen')
          }}</span>
          <UDropdownMenu :items="writebackMenu(setCommentOnPrOpen)">
            <UButton
              size="xs"
              variant="ghost"
              color="neutral"
              trailing-icon="i-lucide-chevron-down"
            >
              {{ commentOnPrOpenLabel }}
            </UButton>
          </UDropdownMenu>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-slate-400">{{
            t('inspector.runSettings.closeOnMerge')
          }}</span>
          <UDropdownMenu :items="writebackMenu(setResolveOnMerge)">
            <UButton
              size="xs"
              variant="ghost"
              color="neutral"
              trailing-icon="i-lucide-chevron-down"
            >
              {{ resolveOnMergeLabel }}
            </UButton>
          </UDropdownMenu>
        </div>
      </div>
      <div class="mt-1 text-[11px] text-slate-500">
        {{ t('inspector.runSettings.writebackHint') }}
      </div>
    </div>

    <!-- responsible product person -->
    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('inspector.runSettings.responsibleProduct') }}
        </span>
        <UDropdownMenu :items="responsibleMenu">
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-user"
            trailing-icon="i-lucide-chevron-down"
          />
        </UDropdownMenu>
      </div>
      <div v-if="responsibleLabel" class="flex items-center gap-1">
        <UBadge
          color="primary"
          variant="subtle"
          size="sm"
          class="cursor-pointer"
          @click="setResponsible('')"
        >
          {{ responsibleLabel }}<UIcon name="i-lucide-x" class="ml-0.5 h-3 w-3" />
        </UBadge>
      </div>
      <div v-else class="text-[11px] text-slate-500">
        {{ t('inspector.runSettings.responsibleEmpty') }}
      </div>
    </div>

    <!-- auto-start dependents: when this task merges, start the tasks that depend on it -->
    <div>
      <div class="flex items-center justify-between gap-2">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('inspector.runSettings.autoStartDependents') }}
        </span>
        <USwitch
          size="sm"
          :model-value="block.autoStartDependents ?? false"
          @update:model-value="setAutoStartDependents"
        />
      </div>
      <div class="mt-1 text-[11px] text-slate-500">
        {{ t('inspector.runSettings.autoStartHint') }}
      </div>
    </div>
  </div>
</template>
