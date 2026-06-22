<script setup lang="ts">
import type { AgentKind } from '~/types/domain'

const agents = useAgentsStore()
defineEmits<{ (e: 'add', kind: AgentKind): void }>()
</script>

<template>
  <div class="space-y-2">
    <p class="px-1 text-[11px] text-slate-500">Click an agent to append it to the pipeline.</p>
    <div class="space-y-1.5">
      <button
        v-for="a in agents.archetypes"
        :key="a.kind"
        type="button"
        class="flex w-full items-center gap-2.5 rounded-lg border border-slate-700 bg-slate-800/60 p-2 text-left transition hover:border-slate-500 hover:bg-slate-800"
        :title="a.description"
        @click="$emit('add', a.kind)"
      >
        <div
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          :style="{ backgroundColor: a.color + '22' }"
        >
          <UIcon :name="a.icon" class="h-4 w-4" :style="{ color: a.color }" />
        </div>
        <div class="min-w-0">
          <div class="text-xs font-semibold text-slate-100">{{ a.label }}</div>
          <div class="truncate text-[10px] text-slate-400">{{ a.description }}</div>
        </div>
        <UIcon name="i-lucide-plus" class="ml-auto h-4 w-4 shrink-0 text-slate-500" />
      </button>
    </div>
  </div>
</template>
