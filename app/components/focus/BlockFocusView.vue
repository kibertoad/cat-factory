<script setup lang="ts">
import { onKeyStroke } from '@vueuse/core'
import type { AgentState, Block } from '~/types/domain'
import { AGENT_BY_KIND, BLOCK_TYPE_META, STATUS_META } from '~/utils/catalog'

const board = useBoardStore()
const pipelines = usePipelinesStore()
const execution = useExecutionStore()
const ui = useUiStore()
const models = useModelsStore()

onMounted(() => models.ensureLoaded())

const block = computed<Block | undefined>(() =>
  ui.focusBlockId ? board.getBlock(ui.focusBlockId) : undefined,
)
const instance = computed(() => execution.getInstance(block.value?.executionId))
const statusMeta = computed(() => (block.value ? STATUS_META[block.value.status] : null))
const typeMeta = computed(() => (block.value ? BLOCK_TYPE_META[block.value.type] : null))

const deps = computed(() =>
  (block.value?.dependsOn ?? []).map((id) => board.getBlock(id)).filter((b): b is Block => !!b),
)

const runMenu = computed(() =>
  pipelines.pipelines.map((p) => ({
    label: p.name,
    icon: 'i-lucide-play',
    onSelect: () => block.value && execution.start(block.value.id, p),
  })),
)

const stateMeta: Record<AgentState, { label: string; color: string }> = {
  pending: { label: 'Pending', color: '#64748b' },
  working: { label: 'Working', color: '#6366f1' },
  waiting_decision: { label: 'Needs decision', color: '#f59e0b' },
  done: { label: 'Done', color: '#22c55e' },
}

function close() {
  ui.focus(null)
}

onKeyStroke('Escape', () => {
  if (ui.focusBlockId) close()
})

function openDecisionFor(decisionId: string) {
  if (instance.value) ui.openDecision(instance.value.id, decisionId)
}
</script>

<template>
  <Transition name="focus-fade">
    <div
      v-if="block && statusMeta && typeMeta"
      class="absolute inset-0 z-30 flex flex-col bg-slate-950/95 backdrop-blur"
    >
      <!-- header / breadcrumb -->
      <header class="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
        <UButton
          icon="i-lucide-arrow-left"
          color="neutral"
          variant="ghost"
          size="sm"
          @click="close"
        >
          Board
        </UButton>
        <UIcon name="i-lucide-chevron-right" class="h-4 w-4 text-slate-600" />
        <div
          class="flex h-9 w-9 items-center justify-center rounded-lg"
          :style="{ backgroundColor: typeMeta.accent + '22' }"
        >
          <UIcon :name="typeMeta.icon" class="h-5 w-5" :style="{ color: typeMeta.accent }" />
        </div>
        <div>
          <h1 class="text-lg font-semibold text-white">{{ block.title }}</h1>
          <div class="text-xs text-slate-500">{{ typeMeta.label }} · focus view</div>
        </div>
        <UBadge :color="statusMeta.chip as any" variant="subtle" class="ml-2">
          {{ statusMeta.label }}
        </UBadge>
        <div class="ml-auto flex items-center gap-2">
          <UDropdownMenu :items="runMenu">
            <UButton
              color="primary"
              variant="soft"
              size="sm"
              icon="i-lucide-play"
              trailing-icon="i-lucide-chevron-down"
            >
              {{ instance ? 'Re-run pipeline' : 'Run pipeline' }}
            </UButton>
          </UDropdownMenu>
          <UButton icon="i-lucide-x" color="neutral" variant="ghost" @click="close" />
        </div>
      </header>

      <div class="grid flex-1 grid-cols-[1fr_300px] gap-6 overflow-hidden p-6">
        <!-- main: pipeline flow -->
        <section
          class="flex flex-col overflow-auto rounded-2xl border border-slate-800 bg-slate-900/60 p-6"
        >
          <h2 class="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">
            {{ instance ? instance.pipelineName : 'No pipeline running' }}
          </h2>

          <div v-if="instance" class="flex flex-wrap items-stretch gap-2">
            <template v-for="(s, i) in instance.steps" :key="i">
              <div
                class="relative w-44 rounded-xl border bg-slate-900 p-4 transition"
                :class="
                  i === instance.currentStep
                    ? 'border-indigo-500 shadow-lg shadow-indigo-500/10'
                    : 'border-slate-700'
                "
              >
                <div
                  v-if="s.decision && !s.decision.chosen"
                  class="absolute -top-2.5 left-1/2 -translate-x-1/2"
                >
                  <button
                    class="board-pulse rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-semibold text-amber-950"
                    @click="openDecisionFor(s.decision.id)"
                  >
                    Decision
                  </button>
                </div>
                <div class="mb-2 flex items-center gap-2">
                  <div
                    class="flex h-9 w-9 items-center justify-center rounded-lg"
                    :style="{ backgroundColor: AGENT_BY_KIND[s.agentKind].color + '22' }"
                  >
                    <UIcon
                      :name="AGENT_BY_KIND[s.agentKind].icon"
                      class="h-5 w-5"
                      :style="{ color: AGENT_BY_KIND[s.agentKind].color }"
                    />
                  </div>
                  <div class="min-w-0">
                    <div class="truncate text-sm font-semibold text-white">
                      {{ AGENT_BY_KIND[s.agentKind].label }}
                    </div>
                    <div class="text-[10px]" :style="{ color: stateMeta[s.state].color }">
                      {{ stateMeta[s.state].label }}
                    </div>
                  </div>
                </div>
                <UProgress
                  :model-value="Math.round((s.state === 'done' ? 1 : s.progress) * 100)"
                  size="xs"
                />
                <p
                  v-if="s.model"
                  class="mt-2 flex items-center gap-1 truncate text-[10px] text-slate-500"
                  :title="s.model"
                >
                  <UIcon name="i-lucide-cpu" class="h-3 w-3 shrink-0" />
                  {{ models.labelForRef(s.model) }}
                </p>
                <p
                  v-if="s.decision?.chosen"
                  class="mt-2 truncate text-[10px] text-slate-400"
                  :title="s.decision.chosen"
                >
                  ✓ {{ s.decision.chosen }}
                </p>
              </div>
              <div v-if="i < instance.steps.length - 1" class="flex items-center">
                <UIcon name="i-lucide-chevron-right" class="h-6 w-6 text-slate-600" />
              </div>
            </template>
          </div>

          <div
            v-else
            class="flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-700 text-sm text-slate-500"
          >
            Run a pipeline to visualize the agents working on this block.
          </div>
        </section>

        <!-- side: details -->
        <aside
          class="space-y-4 overflow-auto rounded-2xl border border-slate-800 bg-slate-900/60 p-5"
        >
          <div>
            <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Description
            </div>
            <p class="text-sm text-slate-300">{{ block.description }}</p>
          </div>
          <div v-if="instance">
            <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Overall progress
            </div>
            <UProgress :model-value="Math.round(block.progress * 100)" />
            <div class="mt-1 text-[11px] text-slate-400">
              {{ Math.round(block.progress * 100) }}%
            </div>
          </div>
          <div>
            <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Dependencies
            </div>
            <div v-if="deps.length" class="flex flex-wrap gap-1">
              <UBadge v-for="d in deps" :key="d.id" color="neutral" variant="subtle" size="sm">
                {{ d.title }}
              </UBadge>
            </div>
            <div v-else class="text-[11px] text-slate-500">None</div>
          </div>
        </aside>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.focus-fade-enter-active,
.focus-fade-leave-active {
  transition: opacity 0.18s ease;
}
.focus-fade-enter-from,
.focus-fade-leave-to {
  opacity: 0;
}
</style>
