<script setup lang="ts">
import TaskCard from './TaskCard.vue'
import { useBlockDrag } from '~/composables/useBlockDrag'

/**
 * One task card in a swimlane.
 *
 * Replaces the old `DraggableTask`, and the difference is the whole point of the lanes: a card
 * no longer carries coordinates. It sits where its lane's order puts it, so this wrapper is an
 * ordinary flow item and the drag it starts is REPARENT-ONLY (`positioned: false`) — moving work
 * between services, and into or out of a module, which is what a task drag was always actually
 * for. Nothing is previewed while dragging, because there is nowhere to preview to.
 *
 * It also renders merged tasks, where `DraggableTask` returned nothing for them. That is what
 * the Done lane needed: a finished task used to vanish from the board entirely, so a service's
 * own history was invisible on it.
 */
const props = defineProps<{ taskId: string }>()

const board = useBoardStore()
const access = useWorkspaceAccess()
const expansion = useTaskExpansionStore()
const { t } = useI18n()
const { draggingId, startDrag } = useBlockDrag()

const task = computed(() => board.getBlock(props.taskId))
const dragging = computed(() => draggingId.value === props.taskId)

// An expanded pipeline overlays its neighbours, so it must stack above the compact cards
// around it. Reads the same predicate the pipeline itself renders on.
const expanded = computed(() => expansion.isExpanded(props.taskId))

function onHandle(e: PointerEvent) {
  if (task.value) startDrag(task.value, e, { reparent: true, positioned: false })
}
</script>

<template>
  <div
    v-if="task"
    class="relative"
    :style="{
      zIndex: dragging ? 60 : expanded ? 20 : 10,
      // While this card is being dragged it must not capture hit-tests, so the drop zone
      // beneath the cursor (a lane, or a module's group) resolves on release. The handle sits
      // in this wrapper above the card and would otherwise mask the zone under it.
      pointerEvents: dragging ? 'none' : undefined,
    }"
    :class="{ 'opacity-40': dragging }"
  >
    <!-- Drag handle. `nopan` so a start-drag from here moves the card, not the pane. Hidden
         for read-only viewers, for whom the drag is a no-op anyway (see useBlockDrag). -->
    <div
      v-if="access.canWriteBoard.value"
      class="nodrag nopan flex cursor-grab touch-none items-center justify-center rounded-t-lg border border-b-0 border-slate-700 bg-slate-800/80 py-px active:cursor-grabbing pointer-coarse:py-2"
      :title="t('board.frame.dragTask')"
      @pointerdown="onHandle"
    >
      <UIcon
        name="i-lucide-grip-horizontal"
        class="h-3 w-3 text-slate-500 pointer-coarse:h-5 pointer-coarse:w-5"
      />
    </div>
    <TaskCard :task-id="taskId" :class="access.canWriteBoard.value ? '!rounded-t-none' : ''" />
  </div>
</template>
