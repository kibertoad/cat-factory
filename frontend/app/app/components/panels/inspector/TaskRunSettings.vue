<script setup lang="ts">
import type { Block } from '~/types/domain'

const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const mergePresets = useMergePresetsStore()
const pipelines = usePipelinesStore()

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
  </div>
</template>
