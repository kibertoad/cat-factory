<script setup lang="ts">
import TaskCard from './TaskCard.vue'
import { useBlockDrag } from '~/composables/useBlockDrag'
import { FEATURE_META } from '~/utils/catalog'

const props = defineProps<{ taskId: string }>()
const board = useBoardStore()
const task = computed(() => board.getBlock(props.taskId))
const { draggingId, startDrag } = useBlockDrag()

// Once a task is merged it stops being a unit of work and becomes part of the
// architecture: we no longer show it as a "Done" card with a status, just the
// features it left behind (a merged task with no features simply disappears).
const merged = computed(() => task.value?.status === 'done')
const features = computed(() => task.value?.features ?? [])

function onHandle(e: PointerEvent) {
  if (task.value) startDrag(task.value, e, { reparent: true })
}
</script>

<template>
  <template v-if="task">
    <!-- merged → statusless features that "just exist" (no card, not draggable).
         A merged task with no features renders nothing at all (arrows fall back
         to its container), so we never leave a zero-size anchor behind. -->
    <div
      v-if="merged && features.length"
      :data-block-id="task.id"
      class="absolute flex w-[180px] flex-col gap-1"
      :style="{ left: task.position.x + 'px', top: task.position.y + 'px', zIndex: 10 }"
    >
      <span
        v-for="f in features"
        :key="f"
        class="inline-flex items-center gap-1 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-100"
        :title="`Feature: ${f}`"
      >
        <UIcon :name="FEATURE_META.icon" class="h-3 w-3 shrink-0" :style="{ color: FEATURE_META.color }" />
        <span class="truncate">{{ f }}</span>
      </span>
    </div>

    <!-- in-flight task → draggable work card -->
    <div
      v-else-if="!merged"
      class="absolute w-[180px]"
      :style="{ left: task.position.x + 'px', top: task.position.y + 'px', zIndex: draggingId === taskId ? 60 : 10 }"
    >
      <!-- drag handle -->
      <div
        class="nodrag flex cursor-grab items-center justify-center rounded-t-lg border border-b-0 border-slate-700 bg-slate-800/80 py-px active:cursor-grabbing"
        title="Drag task"
        @pointerdown="onHandle"
      >
        <UIcon name="i-lucide-grip-horizontal" class="h-3 w-3 text-slate-500" />
      </div>
      <TaskCard :task-id="taskId" class="!rounded-t-none" />
    </div>
  </template>
</template>
