<script setup lang="ts">
import { computed } from 'vue'
import { useLocalStorage } from '@vueuse/core'
import { purposeAllowsAgentCategory } from '@cat-factory/contracts'
import type { AgentKind, PipelinePurpose } from '~/types/domain'
import { AGENT_CATEGORIES, OBSERVABILITY_GATE_ARCHETYPE } from '~/utils/catalog'

const { t } = useI18n()
const agents = useAgentsStore()
const releaseHealth = useReleaseHealthStore()
defineEmits<{ (e: 'add', kind: AgentKind): void }>()
// The purpose of the pipeline being built. When set to a non-`build` classifier, the
// Implementation (`build`) and Testing (`test`) categories are hidden — such a pipeline writes
// no product code and runs no tests (see `purposeAllowsAgentCategory`). `null`/`build` shows all.
const props = defineProps<{ purpose?: PipelinePurpose | null }>()

// The post-release-health gate is only meaningful — and only accepted by the backend —
// with an observability integration connected, so it appears in the palette ONLY then.
const palette = computed(() => {
  const all = releaseHealth.connection.connected
    ? [...agents.archetypes, OBSERVABILITY_GATE_ARCHETYPE]
    : agents.archetypes
  // Hide the categories the pipeline's purpose doesn't build from (an uncategorized custom kind
  // has no category to gate, so it always shows).
  return all.filter((a) => !a.category || purposeAllowsAgentCategory(props.purpose, a.category))
})

// Group the palette into the ordered catalog categories, plus a trailing "Custom" bucket
// for runtime-added agents that carry no category. Empty groups are dropped.
const groups = computed(() => {
  const ordered = AGENT_CATEGORIES.map((cat) => ({
    id: cat.id as string,
    label: cat.label,
    agents: palette.value.filter((a) => a.category === cat.id),
  }))
  const custom = palette.value.filter((a) => !a.category)
  if (custom.length)
    ordered.push({ id: 'custom', label: t('palette.customAgents'), agents: custom })
  return ordered.filter((g) => g.agents.length)
})

// Persist which category sections are collapsed across builder opens.
const collapsed = useLocalStorage<string[]>('cf.pipelineBuilder.collapsedAgentCategories', [])
function isCollapsed(id: string) {
  return collapsed.value.includes(id)
}
function toggle(id: string) {
  collapsed.value = isCollapsed(id)
    ? collapsed.value.filter((c) => c !== id)
    : [...collapsed.value, id]
}
</script>

<template>
  <div class="space-y-2">
    <p class="px-1 text-[11px] text-slate-500">{{ t('palette.hint') }}</p>
    <div class="space-y-2">
      <section v-for="g in groups" :key="g.id">
        <button
          type="button"
          class="flex w-full items-center gap-1.5 rounded px-1 py-1 text-start text-[11px] font-semibold uppercase tracking-wide text-slate-400 transition hover:text-slate-200"
          @click="toggle(g.id)"
        >
          <UIcon
            :name="isCollapsed(g.id) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
            class="h-3.5 w-3.5 shrink-0"
          />
          <span>{{ g.label }}</span>
          <span class="ms-auto text-slate-600">{{ g.agents.length }}</span>
        </button>
        <div v-if="!isCollapsed(g.id)" class="mt-1 space-y-1.5">
          <button
            v-for="a in g.agents"
            :key="a.kind"
            type="button"
            class="flex w-full items-center gap-2.5 rounded-lg border border-slate-700 bg-slate-800/60 p-2 text-start transition hover:border-slate-500 hover:bg-slate-800"
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
            <UIcon name="i-lucide-plus" class="ms-auto h-4 w-4 shrink-0 text-slate-500" />
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
