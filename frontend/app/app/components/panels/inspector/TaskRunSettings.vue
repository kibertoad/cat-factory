<script setup lang="ts">
import { computed, onMounted } from 'vue'
import type { Block } from '~/types/domain'
import type { WritebackOverride } from '~/types/tracker'

const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const mergePresets = useMergePresetsStore()
const modelPresets = useModelPresetsStore()
const pipelines = usePipelinesStore()
const accounts = useAccountsStore()
const tracker = useTrackerStore()

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
    { label: 'Unassigned', icon: 'i-lucide-user-x', onSelect: () => setResponsible('') },
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

// ---- merge policy preset ---------------------------------------------------
// Which merge threshold preset governs this task's auto-merge decision + CI-fixer
// budget. None selected → the workspace default preset. (The old confidence-based
// auto-merge threshold is gone; the `merger` step gates on this policy instead.)
const selectedPreset = computed(() => mergePresets.resolve(props.block.mergePresetId))
const presetMenu = computed(() => [
  [
    {
      label: mergePresets.defaultPreset
        ? `Default (${mergePresets.defaultPreset.name})`
        : 'Workspace default',
      icon: 'i-lucide-rotate-ccw',
      onSelect: () => setPreset(''),
    },
    ...mergePresets.presets.map((p) => ({
      label: p.name,
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
const modelPresetMenu = computed(() => [
  [
    {
      label: modelPresets.defaultPreset
        ? `Default (${modelPresets.defaultPreset.name})`
        : 'Workspace default',
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
      label: 'No default',
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
      { label: 'Inherit workspace', icon: 'i-lucide-rotate-ccw', onSelect: () => set(null) },
      { label: 'On', icon: 'i-lucide-check', onSelect: () => set('on') },
      { label: 'Off', icon: 'i-lucide-x', onSelect: () => set('off') },
    ],
  ]
}

function writebackLabel(
  override: WritebackOverride | null | undefined,
  wsDefault: boolean,
): string {
  if (override === 'on') return 'On'
  if (override === 'off') return 'Off'
  return `Inherit (${wsDefault ? 'on' : 'off'})`
}

const commentOnPrOpenLabel = computed(() =>
  writebackLabel(props.block.trackerCommentOnPrOpen, tracker.settings.writebackCommentOnPrOpen),
)
const resolveOnMergeLabel = computed(() =>
  writebackLabel(props.block.trackerResolveOnMerge, tracker.settings.writebackResolveOnMerge),
)
</script>

<template>
  <div class="space-y-4">
    <!-- pipeline -->
    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Pipeline
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
        No default — pick a pipeline when you run this task.
      </div>
    </div>

    <!-- merge policy preset -->
    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Merge policy
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
        <span class="text-slate-300">{{ selectedPreset.name }}</span>
        — auto-merge when complexity ≤ {{ Math.round(selectedPreset.maxComplexity * 100) }}%, risk ≤
        {{ Math.round(selectedPreset.maxRisk * 100) }}%, impact ≤
        {{ Math.round(selectedPreset.maxImpact * 100) }}%; up to
        {{ selectedPreset.ciMaxAttempts }} CI-fix attempts.
        <span v-if="!block.mergePresetId" class="text-slate-500">(workspace default)</span>
      </div>
      <div v-else class="text-[11px] text-slate-500">
        No preset configured — the merger raises a review notification for every PR.
      </div>
    </div>

    <!-- model preset -->
    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Model preset
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
        — base {{ selectedModelPreset.baseModelId
        }}<span v-if="Object.keys(selectedModelPreset.overrides).length">
          , {{ Object.keys(selectedModelPreset.overrides).length }} override(s)</span
        >.
        <span v-if="!block.modelPresetId" class="text-slate-500">(workspace default)</span>
      </div>
      <div v-else class="text-[11px] text-slate-500">
        No preset configured — agents run on the deployment's default routing.
      </div>
      <p class="mt-1 text-[11px] text-slate-500">
        Changing this affects only steps that haven't started yet.
      </p>
    </div>

    <!-- issue-tracker writeback overrides -->
    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Issue writeback
        </span>
      </div>
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-slate-400">Comment on PR open</span>
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
          <span class="text-[11px] text-slate-400">Close on merge</span>
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
        Writes back to this task's linked tracker issue. Overrides the workspace default.
      </div>
    </div>

    <!-- responsible product person -->
    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Responsible product
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
        Unassigned — set a product owner to notify them when requirement review flags this task.
      </div>
    </div>
  </div>
</template>
