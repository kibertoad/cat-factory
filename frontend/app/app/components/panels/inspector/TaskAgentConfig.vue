<script setup lang="ts">
import { computed } from 'vue'
import type { Block } from '~/types/domain'
import { useAgentConfigStore } from '~/stores/agentConfig'
import { useExecutionStore } from '~/stores/execution'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'

// Task-level configuration contributed by the agents in this task's selected
// pipeline (e.g. the Playwright agent's e2e target: CI vs ephemeral). Each value is
// editable until its contributing agent's step starts, then it freezes (the run is
// already consuming it). Persisted as a sparse id→value map on the block.
const props = defineProps<{ block: Block }>()

const board = useBoardStore()
const agentConfig = useAgentConfigStore()
const execution = useExecutionStore()
const { t } = useI18n()

// The descriptors that apply: those contributed by the task's pinned pipeline, plus
// any whose value is already set (so an existing choice always stays visible/editable
// even if the pinned pipeline changed).
const descriptors = computed(() => {
  const byPipeline = agentConfig.forPipeline(props.block.pipelineId)
  const seen = new Set(byPipeline.map((d) => d.id))
  const fromValues = Object.keys(props.block.agentConfig ?? {})
    .filter((id) => !seen.has(id))
    .map((id) => agentConfig.descriptors.find((d) => d.id === id))
    .filter((d): d is NonNullable<typeof d> => Boolean(d))
  return [...byPipeline, ...fromValues]
})

const run = computed(() => execution.getByBlock(props.block.id))

/** A descriptor freezes once its contributing agent's step has left `pending`. */
function isFrozen(agentKind: string): boolean {
  const steps = run.value?.steps
  if (!steps) return false
  const step = steps.find((s) => s.agentKind === agentKind)
  return Boolean(step && step.state !== 'pending')
}

function valueOf(id: string, fallback: string): string {
  return props.block.agentConfig?.[id] ?? fallback
}

function setValue(id: string, value: string) {
  const next = { ...props.block.agentConfig, [id]: value }
  board.updateBlock(props.block.id, { agentConfig: next })
}
</script>

<template>
  <InspectorSection
    v-if="descriptors.length"
    :title="t('inspector.agentConfig.title')"
    :hint="t('inspector.agentConfig.hint')"
    :count="descriptors.length"
  >
    <div v-for="d in descriptors" :key="d.id" class="space-y-1">
      <div class="flex items-center justify-between">
        <span class="text-[11px] text-slate-400">{{ d.label }}</span>
        <div class="flex items-center gap-1.5">
          <UIcon
            v-if="isFrozen(d.agentKind)"
            name="i-lucide-lock"
            class="h-3 w-3 text-slate-500"
            :title="t('inspector.agentConfig.frozen')"
          />
        </div>
      </div>
      <div class="flex flex-wrap gap-1">
        <UButton
          v-for="opt in d.options"
          :key="opt.value"
          :color="valueOf(d.id, d.default) === opt.value ? 'primary' : 'neutral'"
          :variant="valueOf(d.id, d.default) === opt.value ? 'soft' : 'ghost'"
          size="xs"
          :disabled="isFrozen(d.agentKind)"
          @click="setValue(d.id, opt.value)"
        >
          {{ opt.label }}
        </UButton>
      </div>
      <p class="text-[11px] leading-snug text-slate-500">{{ d.description }}</p>
    </div>
  </InspectorSection>
</template>
