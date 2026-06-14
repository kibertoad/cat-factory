<script setup lang="ts">
import type { Block } from '~/types/domain'
import { DEFAULT_CONFIDENCE_THRESHOLD } from '~/utils/catalog'

const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const models = useModelsStore()

// ---- model selection -------------------------------------------------------
// The model picked for this block (resolved against the deployment's effective
// catalog); when none is selected the backend runs it with the default model.
const selectedModel = computed(() => models.getModel(props.block.modelId))

// Picker menu: a "Default" reset plus each catalog model. Each label shows the
// active flavour (Cloudflare vs the direct provider) so it's clear what will run.
const modelMenu = computed(() => [
  [
    {
      label: 'Default (Qwen)',
      icon: 'i-lucide-rotate-ccw',
      onSelect: () => setModel(''),
    },
    ...models.models.map((m) => ({
      label: `${m.label} · ${m.providerLabel}`,
      icon: m.flavor === 'direct' ? 'i-lucide-zap' : 'i-lucide-cloud',
      onSelect: () => setModel(m.id),
    })),
  ],
])

function setModel(id: string) {
  board.updateBlock(props.block.id, { modelId: id })
}

// ---- confidence threshold (percent <-> 0..1) -------------------------------
const thresholdPct = computed({
  get: () => Math.round((props.block.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD) * 100),
  set: (v: number) =>
    board.updateBlock(props.block.id, {
      confidenceThreshold: Math.min(100, Math.max(0, v)) / 100,
    }),
})
const confidencePct = computed(() =>
  props.block.confidence != null ? Math.round(props.block.confidence * 100) : null,
)
</script>

<template>
  <div class="space-y-4">
    <!-- model selection -->
    <div>
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Model
        </span>
        <UDropdownMenu :items="modelMenu">
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-cpu"
            trailing-icon="i-lucide-chevron-down"
          />
        </UDropdownMenu>
      </div>
      <div v-if="selectedModel" class="flex items-center gap-1">
        <UBadge
          color="primary"
          variant="subtle"
          size="sm"
          class="cursor-pointer"
          :title="selectedModel.description"
          @click="setModel('')"
        >
          {{ selectedModel.label }}<UIcon name="i-lucide-x" class="ml-0.5 h-3 w-3" />
        </UBadge>
        <UBadge
          :color="selectedModel.flavor === 'direct' ? 'success' : 'neutral'"
          variant="subtle"
          size="sm"
          :title="
            selectedModel.flavor === 'direct'
              ? `Direct via ${selectedModel.providerLabel}`
              : 'Cloudflare Workers AI'
          "
        >
          {{ selectedModel.providerLabel }}
        </UBadge>
      </div>
      <div v-else class="text-[11px] text-slate-500">
        Default — runs the Qwen model ({{
          models.getModel('qwen')?.providerLabel ?? 'Cloudflare'
        }}).
      </div>
    </div>

    <!-- confidence threshold -->
    <div>
      <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Auto-merge threshold
      </div>
      <div class="flex items-center gap-2">
        <UInput
          v-model.number="thresholdPct"
          type="number"
          min="0"
          max="100"
          size="sm"
          class="w-20"
        />
        <span class="text-[11px] text-slate-400">% confidence</span>
      </div>
      <div v-if="confidencePct != null" class="mt-1 text-[11px]">
        Last run scored
        <span
          :class="
            block.confidence! >= (block.confidenceThreshold ?? 0.8)
              ? 'text-emerald-400'
              : 'text-amber-400'
          "
        >
          {{ confidencePct }}%
        </span>
      </div>
    </div>
  </div>
</template>
