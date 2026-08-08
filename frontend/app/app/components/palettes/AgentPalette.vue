<script setup lang="ts">
import { computed } from 'vue'
import { useLocalStorage } from '@vueuse/core'
import type { AgentKind, PipelinePurpose } from '~/types/domain'
import AgentTierSelect from '~/components/palettes/AgentTierSelect.vue'
import PipelinePurposeSelect from '~/components/palettes/PipelinePurposeSelect.vue'
import { groupAgentPalette, narrowAgentPalette } from '~/utils/agentPalette'
import { AGENT_CATEGORIES, OBSERVABILITY_GATE_ARCHETYPE } from '~/utils/catalog'

const { t } = useI18n()
const agents = useAgentsStore()
const agentTier = useAgentTierStore()
const releaseHealth = useReleaseHealthStore()
defineEmits<{
  (e: 'add', kind: AgentKind): void
  (e: 'update:purpose', purpose: PipelinePurpose): void
}>()
// The purpose of the pipeline being built, edited right here by the control above the catalog.
// It narrows the palette to the categories that purpose has any use for (a review pipeline
// designs nothing and builds nothing, see `purposeSuggestsAgentCategory`); `null` shows all.
const props = defineProps<{ purpose?: PipelinePurpose | null }>()

// The post-release-health gate is only meaningful — and only accepted by the backend —
// with an observability integration connected, so it appears in the palette ONLY then.
const connected = computed(() =>
  releaseHealth.connection.connected
    ? [...agents.archetypes, OBSERVABILITY_GATE_ARCHETYPE]
    : agents.archetypes,
)

// Then narrow on the two dials above the catalog, each hint counting what relaxing THAT dial
// alone would reveal. `narrowAgentPalette` owns that rule so it is unit-testable, and so neither
// count can be quietly re-derived here as a subtraction that measures the wrong population.
const narrowed = computed(() => narrowAgentPalette(connected.value, props.purpose, agentTier.tier))
const palette = computed(() => narrowed.value.offered)

// Group the palette into the ordered catalog categories, plus a trailing "Custom" bucket for
// whatever none of them claimed. `groupAgentPalette` owns the placement rule for the same reason
// `narrowAgentPalette` owns the counting one: it decides what is VISIBLE, and the version living
// here as an inline computed dropped a kind whose category had no section outright.
const groups = computed(() =>
  groupAgentPalette(palette.value, AGENT_CATEGORIES, t('palette.customAgents')),
)

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
    <!-- The two catalog dials, one above the other: what this pipeline is for, and how deep into
         the agent catalog to look. Both narrow the sections below, and each states its own count.
         Stacked rather than side by side because the palette column is a third of the slideover:
         two half-width buttons truncate to "Purpose: Doc…", which is the one thing a filter
         control may not do. -->
    <div class="space-y-2">
      <PipelinePurposeSelect
        :purpose="props.purpose"
        :hidden-count="narrowed.hiddenByPurpose"
        @update:purpose="$emit('update:purpose', $event)"
      />
      <AgentTierSelect :hidden-count="narrowed.hiddenByTier" />
    </div>
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
            :data-testid="`palette-agent-${a.kind}`"
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
