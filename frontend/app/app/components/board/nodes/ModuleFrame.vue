<script setup lang="ts">
import DraggableTask from './DraggableTask.vue'
import { MODULE_META } from '~/utils/catalog'
import { useBlockDrag } from '~/composables/useBlockDrag'
import { useFrameResize } from '~/composables/useFrameResize'

const props = defineProps<{ moduleId: string }>()
const board = useBoardStore()
const ui = useUiStore()
const { t } = useI18n()

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
    <!-- module header / drag handle (`nopan` so a start-drag moves it, not the pane) -->
    <div
      class="nodrag nopan flex h-[30px] cursor-grab touch-none items-center gap-1 rounded-t-xl bg-violet-500/15 px-2 active:cursor-grabbing"
      @pointerdown="onHandle"
      @click.stop="ui.select(moduleId)"
    >
      <UIcon
        :name="MODULE_META.icon"
        class="h-3.5 w-3.5 shrink-0"
        :style="{ color: MODULE_META.color }"
      />
      <span class="truncate text-[11px] font-semibold text-violet-100">{{ mod.title }}</span>
      <span v-if="inflight" class="ms-auto shrink-0 text-[9px] text-violet-300/70">
        {{ t('board.frame.taskCount', { count: inflight }, inflight) }}
      </span>
      <span v-else-if="total" class="ms-auto shrink-0 text-[9px] text-violet-300/70">
        {{ t('board.frame.taskCount', { count: total }, total) }}
      </span>
    </div>

    <!-- drop zone for this module's tasks -->
    <div :data-drop-zone="mod.id" class="relative" :style="{ height: size.h - 30 + 'px' }">
      <DraggableTask v-for="t in tasks" :key="t.id" :task-id="t.id" />
    </div>

    <!-- resize handles (drag the borders to resize the module, Miro-style).
         `nopan` (with `nodrag`) so resizing doesn't pan the pane. -->
    <div
      class="nodrag nopan absolute end-0 top-0 h-full w-2 cursor-ew-resize touch-none hover:bg-violet-400/20 pointer-coarse:w-4"
      :title="t('board.frame.dragToResize')"
      @pointerdown="onResize($event, 'e')"
    />
    <div
      class="nodrag nopan absolute bottom-0 start-0 h-2 w-full cursor-ns-resize touch-none hover:bg-violet-400/20 pointer-coarse:h-4"
      :title="t('board.frame.dragToResize')"
      @pointerdown="onResize($event, 's')"
    />
    <div
      class="nodrag nopan absolute bottom-0 end-0 h-4 w-4 cursor-nwse-resize touch-none pointer-coarse:h-11 pointer-coarse:w-11"
      :title="t('board.frame.dragToResize')"
      @pointerdown="onResize($event, 'se')"
    >
      <span
        class="absolute bottom-1 end-1 h-2 w-2 rounded-sm border-b-2 border-e-2 border-violet-400/60"
      />
    </div>
  </div>
</template>
