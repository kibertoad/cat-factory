<script setup lang="ts">
import { computed } from 'vue'
import type { Block } from '~/types/domain'
import { useAgentConfigStore } from '~/stores/agentConfig'
import { useExecutionStore } from '~/stores/execution'

// Task-level configuration contributed by the agents in this task's selected
// pipeline (e.g. the Tester's environment: local vs ephemeral). Each value is
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

// The Tester's environment descriptor inherits its default from the service frame this
// task lives under (set in the service inspector); a task only overrides it by clicking.
// Walk up the parent chain (frame → module → task) to find that default.
const serviceDefaultTestEnv = computed<'local' | 'ephemeral' | undefined>(() => {
  let cur: Block | undefined = props.block
  for (let i = 0; i < 8 && cur; i++) {
    if (cur.level === 'frame') return cur.defaultTestEnvironment
    if (!cur.parentId) break
    cur = board.getBlock(cur.parentId)
  }
  return undefined
})

/** The effective default for a descriptor — the inherited service value for the Tester's
 *  environment, otherwise the descriptor's own static default. */
function effectiveDefault(d: { id: string; default: string }): string {
  if (d.id === 'tester.environment' && serviceDefaultTestEnv.value) {
    return serviceDefaultTestEnv.value
  }
  return d.default
}

/** Whether a descriptor's shown value is inherited (not explicitly pinned on this task). */
function isInherited(d: { id: string }): boolean {
  return d.id === 'tester.environment' && props.block.agentConfig?.[d.id] === undefined
}

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
  <div v-if="descriptors.length" class="space-y-3">
    <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
      {{ t('inspector.agentConfig.title') }}
    </div>
    <div v-for="d in descriptors" :key="d.id" class="space-y-1">
      <div class="flex items-center justify-between">
        <span class="text-[11px] text-slate-400">{{ d.label }}</span>
        <div class="flex items-center gap-1.5">
          <span v-if="isInherited(d)" class="text-[10px] text-slate-500">{{
            t('inspector.agentConfig.inherited')
          }}</span>
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
          :color="valueOf(d.id, effectiveDefault(d)) === opt.value ? 'primary' : 'neutral'"
          :variant="valueOf(d.id, effectiveDefault(d)) === opt.value ? 'soft' : 'ghost'"
          size="xs"
          :disabled="isFrozen(d.agentKind)"
          @click="setValue(d.id, opt.value)"
        >
          {{ opt.label }}
        </UButton>
      </div>
      <p class="text-[11px] leading-snug text-slate-500">{{ d.description }}</p>
    </div>
  </div>
</template>
