<script setup lang="ts">
import DraggableTask from './DraggableTask.vue'
import { MODULE_META } from '~/utils/catalog'
import { useBlockDrag } from '~/composables/useBlockDrag'

const props = defineProps<{ moduleId: string }>()
const board = useBoardStore()
const ui = useUiStore()

const mod = computed(() => board.getBlock(props.moduleId))
const tasks = computed(() => board.tasksOf(props.moduleId))
const size = computed(() => board.containerSize(props.moduleId))
const selected = computed(() => ui.selectedBlockId === props.moduleId)

// A module groups the features left behind by its merged tasks. We label it by
// feature count once any work has merged, falling back to a task count while
// work is still in flight inside it.
const featureCount = computed(() =>
  tasks.value.filter((t) => t.status === 'done').reduce((n, t) => n + (t.features?.length ?? 0), 0),
)
const inflight = computed(() => tasks.value.filter((t) => t.status !== 'done').length)

const { draggingId, startDrag } = useBlockDrag()

// modules move within their service but don't get reparented
function onHandle(e: PointerEvent) {
  if (mod.value) startDrag(mod.value, e)
}
</script>

<template>
  <div
    v-if="mod"
    :data-block-id="mod.id"
    class="absolute rounded-xl border border-violet-500/40 bg-violet-500/[0.06]"
    :class="{ 'ring-1 ring-white': selected }"
    :style="{ left: mod.position.x + 'px', top: mod.position.y + 'px', width: size.w + 'px', height: size.h + 'px', zIndex: draggingId === moduleId ? 50 : 5 }"
  >
    <!-- module header / drag handle -->
    <div
      class="nodrag flex h-[30px] cursor-grab items-center gap-1 rounded-t-xl bg-violet-500/15 px-2 active:cursor-grabbing"
      @pointerdown="onHandle"
      @click.stop="ui.select(moduleId)"
    >
      <UIcon :name="MODULE_META.icon" class="h-3.5 w-3.5 shrink-0" :style="{ color: MODULE_META.color }" />
      <span class="truncate text-[11px] font-semibold text-violet-100">{{ mod.title }}</span>
      <span v-if="featureCount" class="ml-auto shrink-0 text-[9px] text-violet-300/70">
        {{ featureCount }} feature{{ featureCount === 1 ? '' : 's' }}
      </span>
      <span v-else class="ml-auto shrink-0 text-[9px] text-violet-300/70">
        {{ inflight }} task{{ inflight === 1 ? '' : 's' }}
      </span>
    </div>

    <!-- drop zone for this module's tasks -->
    <div :data-drop-zone="mod.id" class="relative" :style="{ height: size.h - 30 + 'px' }">
      <DraggableTask v-for="t in tasks" :key="t.id" :task-id="t.id" />
    </div>
  </div>
</template>
