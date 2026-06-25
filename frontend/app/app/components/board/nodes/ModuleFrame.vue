<script setup lang="ts">
import DraggableTask from './DraggableTask.vue'
import { MODULE_META } from '~/utils/catalog'
import { useBlockDrag } from '~/composables/useBlockDrag'
import { useFrameResize } from '~/composables/useFrameResize'

const props = defineProps<{ moduleId: string }>()
const board = useBoardStore()
const ui = useUiStore()

const mod = computed(() => board.getBlock(props.moduleId))
const tasks = computed(() => board.tasksOf(props.moduleId))
const size = computed(() => board.containerSize(props.moduleId))
const selected = computed(() => ui.selectedBlockId === props.moduleId)

// A module groups the tasks inside it. We label it by how many tasks are still in
// flight, falling back to the total task count once everything inside has merged.
const inflight = computed(() => tasks.value.filter((t) => t.status !== 'done').length)
const total = computed(() => tasks.value.length)

const { draggingId, startDrag } = useBlockDrag()

// modules move within their service but don't get reparented
function onHandle(e: PointerEvent) {
  if (mod.value) startDrag(mod.value, e)
}

// Miro-style resizing, same as a service frame: drag the right / bottom edges or
// the corner. The composable clamps to the module's content extent and persists
// the size on release.
const { startResize } = useFrameResize()
function onResize(e: PointerEvent, edge: 'e' | 's' | 'se') {
  if (mod.value) startResize(mod.value, e, edge)
}
</script>

<template>
  <div
    v-if="mod"
    :data-block-id="mod.id"
    class="absolute rounded-xl border border-violet-500/40 bg-violet-500/[0.06]"
    :class="{ 'ring-1 ring-white': selected }"
    :style="{
      left: mod.position.x + 'px',
      top: mod.position.y + 'px',
      width: size.w + 'px',
      height: size.h + 'px',
      zIndex: draggingId === moduleId ? 50 : 5,
    }"
  >
    <!-- module header / drag handle -->
    <div
      class="nodrag flex h-[30px] cursor-grab items-center gap-1 rounded-t-xl bg-violet-500/15 px-2 active:cursor-grabbing"
      @pointerdown="onHandle"
      @click.stop="ui.select(moduleId)"
    >
      <UIcon
        :name="MODULE_META.icon"
        class="h-3.5 w-3.5 shrink-0"
        :style="{ color: MODULE_META.color }"
      />
      <span class="truncate text-[11px] font-semibold text-violet-100">{{ mod.title }}</span>
      <span v-if="inflight" class="ml-auto shrink-0 text-[9px] text-violet-300/70">
        {{ inflight }} task{{ inflight === 1 ? '' : 's' }}
      </span>
      <span v-else-if="total" class="ml-auto shrink-0 text-[9px] text-violet-300/70">
        {{ total }} task{{ total === 1 ? '' : 's' }}
      </span>
    </div>

    <!-- drop zone for this module's tasks -->
    <div :data-drop-zone="mod.id" class="relative" :style="{ height: size.h - 30 + 'px' }">
      <DraggableTask v-for="t in tasks" :key="t.id" :task-id="t.id" />
    </div>

    <!-- resize handles (drag the borders to resize the module, Miro-style) -->
    <div
      class="nodrag absolute right-0 top-0 h-full w-2 cursor-ew-resize hover:bg-violet-400/20"
      title="Drag to resize"
      @pointerdown="onResize($event, 'e')"
    />
    <div
      class="nodrag absolute bottom-0 left-0 h-2 w-full cursor-ns-resize hover:bg-violet-400/20"
      title="Drag to resize"
      @pointerdown="onResize($event, 's')"
    />
    <div
      class="nodrag absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
      title="Drag to resize"
      @pointerdown="onResize($event, 'se')"
    >
      <span
        class="absolute bottom-1 right-1 h-2 w-2 rounded-sm border-b-2 border-r-2 border-violet-400/60"
      />
    </div>
  </div>
</template>
