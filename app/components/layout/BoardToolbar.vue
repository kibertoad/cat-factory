<script setup lang="ts">
import { useBoardFlow } from '~/composables/useBoardFlow'

const ui = useUiStore()
const board = useBoardStore()
const execution = useExecutionStore()
const workspace = useWorkspaceStore()
const { fitView, zoomIn, zoomOut } = useBoardFlow()

const zoomPct = computed(() => Math.round(ui.zoom * 100))
const lodLabel = computed(() => ({ far: 'Overview', mid: 'Summary', close: 'Detail' })[ui.lod])

const decisionItems = computed(() =>
  execution.openDecisions.map((d) => {
    const b = board.getBlock(d.blockId)
    return {
      label: b?.title ?? 'Block',
      description: d.decision.question,
      icon: 'i-lucide-circle-help',
      onSelect: () => ui.openDecision(d.instanceId, d.decision.id),
    }
  }),
)

async function resetBoard() {
  await workspace.reset()
  ui.select(null)
  ui.focus(null)
  setTimeout(() => fitView({ padding: 0.2 }), 50)
}
</script>

<template>
  <div
    class="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-slate-700 bg-slate-900/90 px-2 py-1.5 shadow-xl backdrop-blur"
  >
    <!-- zoom controls -->
    <UButton icon="i-lucide-zoom-out" color="neutral" variant="ghost" size="sm" @click="zoomOut()" />
    <div class="w-20 text-center text-xs tabular-nums text-slate-300">
      {{ zoomPct }}%
      <div class="text-[9px] uppercase tracking-wide text-slate-500">{{ lodLabel }}</div>
    </div>
    <UButton icon="i-lucide-zoom-in" color="neutral" variant="ghost" size="sm" @click="zoomIn()" />
    <UButton
      icon="i-lucide-maximize"
      color="neutral"
      variant="ghost"
      size="sm"
      @click="fitView({ padding: 0.2 })"
    />

    <USeparator orientation="vertical" class="mx-1 h-6" />

    <!-- simulation -->
    <UButton
      :icon="ui.simRunning ? 'i-lucide-pause' : 'i-lucide-play'"
      :color="ui.simRunning ? 'primary' : 'neutral'"
      variant="soft"
      size="sm"
      @click="ui.toggleSim()"
    >
      {{ ui.simRunning ? 'Simulating' : 'Paused' }}
    </UButton>

    <!-- decisions queue -->
    <UDropdownMenu v-if="execution.pendingDecisionCount" :items="decisionItems">
      <UButton color="warning" variant="soft" size="sm" icon="i-lucide-circle-help">
        {{ execution.pendingDecisionCount }} decision{{ execution.pendingDecisionCount === 1 ? '' : 's' }}
      </UButton>
    </UDropdownMenu>

    <USeparator orientation="vertical" class="mx-1 h-6" />

    <UButton
      icon="i-lucide-rotate-ccw"
      color="neutral"
      variant="ghost"
      size="sm"
      title="Reset board to sample"
      @click="resetBoard"
    />
  </div>
</template>
