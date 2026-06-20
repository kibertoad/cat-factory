<script setup lang="ts">
import type { AgentState, PipelineStep } from '~/types/domain'
import { agentKindMeta } from '~/utils/catalog'

const props = defineProps<{
  step: PipelineStep
  active?: boolean
  size?: 'sm' | 'md'
}>()

const archetype = computed(() => agentKindMeta(props.step.agentKind))

const stateRing: Record<AgentState, string> = {
  pending: 'ring-slate-600/60 opacity-60',
  working: 'ring-indigo-400',
  waiting_decision: 'ring-amber-400 board-pulse',
  done: 'ring-emerald-400',
}

const stateIcon: Record<AgentState, string | null> = {
  pending: null,
  working: 'i-lucide-loader',
  waiting_decision: 'i-lucide-circle-help',
  done: 'i-lucide-check',
}

const dim = computed(() => (props.size === 'sm' ? 'h-7 w-7' : 'h-9 w-9'))
</script>

<template>
  <div class="flex flex-col items-center gap-1" :title="archetype.label">
    <div
      class="relative flex items-center justify-center rounded-full ring-2 transition"
      :class="[dim, stateRing[step.state], active ? 'scale-110' : '']"
      :style="{ backgroundColor: archetype.color + '22' }"
    >
      <UIcon :name="archetype.icon" class="text-base" :style="{ color: archetype.color }" />
      <span
        v-if="step.state === 'working'"
        class="absolute -bottom-1 -right-1 rounded-full bg-slate-900 p-0.5"
      >
        <UIcon :name="stateIcon.working!" class="h-3 w-3 animate-spin text-indigo-300" />
      </span>
      <span
        v-else-if="stateIcon[step.state]"
        class="absolute -bottom-1 -right-1 rounded-full bg-slate-900 p-0.5"
      >
        <UIcon
          :name="stateIcon[step.state]!"
          class="h-3 w-3"
          :class="step.state === 'done' ? 'text-emerald-300' : 'text-amber-300'"
        />
      </span>
    </div>
    <span v-if="size !== 'sm'" class="text-[10px] leading-none text-slate-300">
      {{ archetype.label }}
    </span>
  </div>
</template>
