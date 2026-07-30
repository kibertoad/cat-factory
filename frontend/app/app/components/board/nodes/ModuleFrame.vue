<script setup lang="ts">
import DraggableTask from './DraggableTask.vue'
import { MODULE_META } from '~/utils/catalog'
import { useBlockDrag } from '~/composables/useBlockDrag'
import { useFrameResize } from '~/composables/useFrameResize'

const props = defineProps<{ moduleId: string }>()
const board = useBoardStore()
const ui = useUiStore()
const access = useWorkspaceAccess()
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

// Miro-style resizing, same as a service frame: drag the right / bottom border or
// the corner. The composable clamps to the module's content extent and persists
// the size on release.
type ResizeEdge = 'e' | 's' | 'se'
const { resizingId, startResize } = useFrameResize()
const resizing = computed(() => resizingId.value === props.moduleId)
// The same state-driven border highlight as the service frame's (BlockNode explains why the
// lit state isn't a `hover:` utility, and why the drag reads `dragEdge`).
const hoverEdge = ref<ResizeEdge | null>(null)
const dragEdge = ref<ResizeEdge | null>(null)
const gripLit = (edge: ResizeEdge) =>
  resizing.value ? dragEdge.value === edge : hoverEdge.value === edge
function onResize(e: PointerEvent, edge: ResizeEdge) {
  if (!mod.value) return
  dragEdge.value = edge
  startResize(mod.value, e, edge)
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

    <!-- Resize grips, mirroring the service frame's (BlockNode): each one STRADDLES the
         module's border for a 12px hit target while the drawn affordance stays a 2px bar
         on the border itself, so the gesture is "drag the edge" rather than "find the
         thin strip inside". `nopan` (with `nodrag`) so resizing doesn't pan the pane.
         Kept PHYSICAL (`right-0`, not `end-0`) for the same reason as BlockNode's: the
         resize delta is unmirrored, so a logical grip would sit on the opposite edge
         from the one the drag moves. Hidden for a read-only viewer, whose resize would
         no-op in `startResize` anyway. -->
    <template v-if="access.canWriteBoard.value">
      <div
        class="nodrag nopan absolute -right-1.5 top-0 z-10 h-full w-3 cursor-ew-resize touch-none pointer-coarse:-right-3 pointer-coarse:w-6"
        :title="t('board.frame.dragToResize')"
        data-testid="module-resize-e"
        @pointerenter="hoverEdge = 'e'"
        @pointerleave="hoverEdge = null"
        @pointerdown="onResize($event, 'e')"
      >
        <span
          class="absolute inset-y-2 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-colors"
          :class="gripLit('e') ? 'bg-violet-300' : 'bg-transparent'"
        />
      </div>
      <div
        class="nodrag nopan absolute -bottom-1.5 left-0 z-10 h-3 w-full cursor-ns-resize touch-none pointer-coarse:-bottom-3 pointer-coarse:h-6"
        :title="t('board.frame.dragToResize')"
        data-testid="module-resize-s"
        @pointerenter="hoverEdge = 's'"
        @pointerleave="hoverEdge = null"
        @pointerdown="onResize($event, 's')"
      >
        <span
          class="absolute inset-x-2 top-1/2 h-0.5 -translate-y-1/2 rounded-full transition-colors"
          :class="gripLit('s') ? 'bg-violet-300' : 'bg-transparent'"
        />
      </div>
      <!-- Last of the three, so the corner wins the overlap with both edge grips. -->
      <div
        class="nodrag nopan absolute -bottom-1.5 -right-1.5 z-10 h-5 w-5 cursor-nwse-resize touch-none pointer-coarse:-bottom-3 pointer-coarse:-right-3 pointer-coarse:h-11 pointer-coarse:w-11"
        :title="t('board.frame.dragToResize')"
        data-testid="module-resize-se"
        @pointerenter="hoverEdge = 'se'"
        @pointerleave="hoverEdge = null"
        @pointerdown="onResize($event, 'se')"
      >
        <span
          class="absolute bottom-1.5 right-1.5 h-2 w-2 rounded-sm border-b-2 border-r-2 transition-colors pointer-coarse:bottom-3 pointer-coarse:right-3"
          :class="gripLit('se') ? 'border-violet-300' : 'border-violet-400/60'"
        />
      </div>
    </template>
  </div>
</template>
