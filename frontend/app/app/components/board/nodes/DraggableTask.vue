<script setup lang="ts">
import TaskCard from './TaskCard.vue'
import { useBlockDrag } from '~/composables/useBlockDrag'

const props = defineProps<{ taskId: string }>()
const board = useBoardStore()
const { t } = useI18n()
const expansion = useTaskExpansionStore()
const task = computed(() => board.getBlock(props.taskId))
const { draggingId, startDrag } = useBlockDrag()

// An expanded pipeline grows downward over its neighbours, so it must stack above the
// other (compact) task cards — never let a neighbour render on top of the pipeline.
const expanded = computed(() => expansion.allowed.has(props.taskId))

// Once a task is merged it stops being a unit of work and becomes part of the
// architecture: it no longer renders as a draggable card (arrows fall back to its
// container), so we never leave a zero-size anchor behind.
const merged = computed(() => task.value?.status === 'done')

function onHandle(e: PointerEvent) {
  if (task.value) startDrag(task.value, e, { reparent: true })
}
</script>

<template>
  <template v-if="task">
    <!-- in-flight task → draggable work card (merged tasks render nothing) -->
    <div
      v-if="!merged"
      class="absolute w-[210px]"
      :style="{
        left: task.position.x + 'px',
        top: task.position.y + 'px',
        zIndex: draggingId === taskId ? 60 : expanded ? 20 : 10,
        // While this task is being dragged it must not capture hit-tests, so the
        // drop-zone (service or module) beneath the cursor can be resolved on
        // release — including the drag handle, which lives in this wrapper above
        // the card and would otherwise mask the zone under it.
        pointerEvents: draggingId === taskId ? 'none' : undefined,
      }"
    >
      <!-- drag handle (`nopan` so the pane doesn't pan on a start-drag from here) -->
      <div
        class="nodrag nopan flex cursor-grab touch-none items-center justify-center rounded-t-lg border border-b-0 border-slate-700 bg-slate-800/80 py-px active:cursor-grabbing pointer-coarse:py-2"
        :title="t('board.frame.dragTask')"
        @pointerdown="onHandle"
      >
        <UIcon
          name="i-lucide-grip-horizontal"
          class="h-3 w-3 text-slate-500 pointer-coarse:h-5 pointer-coarse:w-5"
        />
      </div>
      <TaskCard :task-id="taskId" class="!rounded-t-none" />
    </div>
  </template>
</template>
