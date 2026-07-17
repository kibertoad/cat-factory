<script setup lang="ts">
import { VueFlow, useVueFlow, type NodeMouseEvent } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import BlockNode from './nodes/BlockNode.vue'
import EpicNode from './nodes/EpicNode.vue'
import TaskDependencyEdges from './TaskDependencyEdges.vue'
import DependencyConnectOverlay from './DependencyConnectOverlay.vue'
import { readDndPayload, blockIdFromEvent } from '~/utils/dnd'
import { BOARD_FLOW_ID, BOARD_MIN_ZOOM, BOARD_MAX_ZOOM } from '~/composables/useBoardFlow'
import { useTaskExpansion } from '~/composables/useTaskExpansion'
import { useBlockDrag } from '~/composables/useBlockDrag'
import { useFrameStacking } from '~/composables/useFrameStacking'
import { useFramePlacement } from '~/composables/useFramePlacement'
import { useViewport } from '~/composables/useViewport'
import { boardPanMode } from '~/utils/boardPanMode'

const board = useBoardStore()
const pipelines = usePipelinesStore()
const execution = useExecutionStore()
const ui = useUiStore()
const github = useGitHubStore()
const toast = useToast()
const access = useWorkspaceAccess()
const { t } = useI18n()

const { onNodeDragStop, onViewportChange, screenToFlowCoordinate } = useVueFlow(BOARD_FLOW_ID)
const { draggingId } = useBlockDrag()
const { hoveredFrameId } = useFrameStacking()
const { freeFramePosition, focusFrame } = useFramePlacement()
// Touch drives the canvas gestures: a touch-capable surface needs one-finger pan.
// We gate on `hasTouch` (any-pointer: coarse), not `isTouch` (the *primary* pointer),
// so a touchscreen laptop / 2-in-1 — whose primary pointer is the trackpad — still
// gets finger-panning.
const { hasTouch } = useViewport()

// See `boardPanMode`: the button-array form ([0, 2]) silently blocks one-finger
// touch panning (a touch `touchstart` has no `event.button`), so we widen it to
// `true` on any touch-capable surface and keep the precise-pointer restriction on
// pure-mouse desktops. Extracted as a pure helper so the fix has a unit guard.
const panOnDrag = computed<boolean | number[]>(() => boardPanMode(hasTouch.value))

// Gate which task cards expand their pipeline list on deep zoom: on-screen, and the
// centre-most of any that would overlap (see useTaskExpansion). Service frames have no
// such gate — they are always expanded to their task canvas.
const boardEl = ref<HTMLElement | null>(null)
useTaskExpansion(boardEl)

// Only frames are board nodes. Dependencies live on tasks (rendered inside the
// frames), so there are no frame-to-frame edges on the canvas.
//
// Vue Flow tags every *draggable* node with the `nopan` class, which makes the
// pane refuse to pan while the pointer is over it. Service frames are always expanded
// and fill much of the viewport, so leaving them draggable would turn the whole canvas
// into a dead zone. We therefore make every frame non-draggable (the pane pans straight
// through it) and move it via its header handle instead.
//
// Frames are rendered exactly at their stored position and may overlap freely —
// moving one never shifts another. The frame being dragged is lifted to the top,
// then the hovered frame (the un-obscured one under the pointer), so overlapping
// services can always be reached and reordered. See useFrameStacking.
//
// `elevate-nodes-on-select` is turned OFF on <VueFlow> for this to work: Vue Flow's
// default adds +1000 to a selected node's z-index, so a frame stayed pinned on top
// after a click and no amount of hovering another frame could surface it. Stacking
// is driven purely by hover/drag here; the selection highlight is the ring, not z.
function frameZIndex(id: string) {
  if (draggingId.value === id) return 1000
  if (hoveredFrameId.value === id) return 100
  return 1
}

const nodes = computed(() => [
  ...board.frames.map((b) => ({
    id: b.id,
    type: 'block',
    position: { x: b.position.x, y: b.position.y },
    // Always-expanded frames fill the viewport; keep them non-draggable so the pane
    // pans through them (they move via their header handle, see BlockNode).
    draggable: false,
    zIndex: frameZIndex(b.id),
    data: {},
  })),
  // Epics are top-level grouping nodes (non-structural), drawn alongside frames and
  // linked to their member tasks by the dependency-edge overlay.
  ...board.epics.map((b) => ({
    id: b.id,
    type: 'epic',
    position: { x: b.position.x, y: b.position.y },
    draggable: true,
    data: {},
  })),
])

onNodeDragStop(({ node }) => {
  board.moveBlock(node.id, node.position)
})

onViewportChange((vp) => {
  ui.zoom = vp.zoom
})

function onNodeClick({ node }: NodeMouseEvent) {
  ui.select(node.id)
}

function onNodeDoubleClick({ event, node }: NodeMouseEvent) {
  // Task cards live *inside* their frame node, so Vue Flow reports the frame here even
  // when the double-click landed on a task. Resolve the real target from the DOM: a
  // double-click on a task opens its focus view (the same "open this task" gesture as the
  // card's review action), while a double-click on frame chrome centres the camera on the
  // frame and zooms it in. Epics aren't containers, so their double-click stays a no-op.
  const targetId = blockIdFromEvent(event)
  const target = targetId ? board.getBlock(targetId) : undefined
  if (target?.level === 'task') {
    ui.select(target.id)
    ui.focus(target.id)
    return
  }
  if (node.type === 'block') void focusFrame(node.id)
}

function onPaneClick() {
  ui.select(null)
}

// ---- palette drag & drop onto the canvas ----------------------------------
function onDragOver(event: DragEvent) {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

async function onDrop(event: DragEvent) {
  event.preventDefault()
  const payload = readDndPayload(event)
  if (!payload) return

  if (payload.kind === 'block') {
    // Drop where the cursor is, but nudge off any existing frame it lands on so a new
    // frame never overlaps a neighbour; then centre the camera on it.
    const dropped = screenToFlowCoordinate({ x: event.clientX, y: event.clientY })
    const position = freeFramePosition({ near: dropped })
    try {
      const block = await board.addBlock(payload.blockType, position)
      ui.select(block.id)
      await focusFrame(block.id)
    } catch {
      toast.add({
        title: t('board.canvas.addBlockFailedTitle'),
        description: t('board.canvas.addBlockFailedBody'),
        color: 'error',
      })
    }
    return
  }

  if (payload.kind === 'pipeline') {
    // Pipelines run against tasks, not frames. The nearest [data-block-id] under
    // the cursor is the task card when dropped inside an expanded frame.
    const blockId = blockIdFromEvent(event)
    const target = blockId ? board.getBlock(blockId) : undefined
    const pipeline = pipelines.getPipeline(payload.pipelineId)
    // Unknown pipeline id is an internal glitch (nothing the user can act on); a drop
    // onto blank canvas / a non-block, though, needs the same "aim at a task" nudge the
    // wrong-level path gives — otherwise the drop just vanishes (UX-07).
    if (!pipeline) return
    if (!target) {
      toast.add({
        title: t('board.canvas.dropOntoTaskTitle'),
        description: t('board.canvas.dropOntoTaskBody'),
      })
      return
    }
    if (target.level !== 'task') {
      toast.add({
        title: t('board.canvas.dropOntoTaskTitle'),
        description: t('board.canvas.dropOntoTaskBody'),
      })
      return
    }
    if (!board.isRunnable(target.id)) {
      toast.add({
        title: t('board.canvas.taskBlockedTitle'),
        description: t('board.canvas.taskBlockedBody'),
      })
      return
    }
    execution.start(target.id, pipeline)
    ui.select(target.id)
  }
}
</script>

<template>
  <div
    ref="boardEl"
    data-testid="board-canvas"
    class="relative h-full w-full"
    @drop="onDrop"
    @dragover="onDragOver"
  >
    <VueFlow
      :id="BOARD_FLOW_ID"
      :nodes="nodes"
      :min-zoom="BOARD_MIN_ZOOM"
      :max-zoom="BOARD_MAX_ZOOM"
      :default-viewport="{ x: 40, y: 20, zoom: 0.85 }"
      :pan-on-drag="panOnDrag"
      :elevate-nodes-on-select="false"
      fit-view-on-init
      @node-click="onNodeClick"
      @node-double-click="onNodeDoubleClick"
      @pane-click="onPaneClick"
      @contextmenu.prevent
    >
      <Background pattern-color="#1e293b" :gap="22" :size="1.4" />
      <!-- No minimap: it's a precise-pointer affordance (too small to hit on touch,
           eats scarce width on narrow windows) that earned its keep on neither
           desktop nor mobile. The toolbar's zoom-in/out + fit-view controls are the
           camera navigation on every viewport. -->

      <template #node-block="props">
        <BlockNode :id="props.id" />
      </template>

      <template #node-epic="props">
        <EpicNode :id="props.id" />
      </template>
    </VueFlow>

    <!-- An empty board reads as broken; invite the user to add a service. The
         overlay lets pointer events through (so the pane still pans) except on
         the buttons themselves. -->
    <div
      v-if="board.frames.length === 0"
      class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 text-center"
    >
      <UIcon name="i-lucide-layout-dashboard" class="h-10 w-10 text-slate-600" />
      <div>
        <h2 class="text-base font-semibold text-slate-300">{{ t('board.canvas.emptyTitle') }}</h2>
        <p class="mt-1 max-w-sm text-sm text-slate-500">
          {{ t('board.canvas.emptyBody') }}
        </p>
      </div>
      <div
        v-if="
          access.canManageIntegrations.value || (github.available && access.canWriteBoard.value)
        "
        class="pointer-events-auto flex flex-wrap items-center justify-center gap-2"
      >
        <UButton
          v-if="access.canManageIntegrations.value"
          color="primary"
          icon="i-lucide-git-branch-plus"
          @click="ui.openBootstrap()"
        >
          {{ t('nav.bootstrapRepo') }}
        </UButton>
        <UButton
          v-if="github.available && access.canWriteBoard.value"
          color="primary"
          variant="soft"
          icon="i-lucide-folder-git-2"
          @click="ui.openAddService()"
        >
          {{ t('nav.addFromRepo') }}
        </UButton>
      </div>
      <!-- A read-only viewer sees the empty state but no create affordances. -->
      <p v-else class="max-w-sm text-xs text-slate-600">{{ t('access.noBoardWrite') }}</p>
    </div>

    <!-- task dependency arrows, overlaid in screen space -->
    <TaskDependencyEdges />

    <!-- live preview line while drag-to-connecting a dependency -->
    <DependencyConnectOverlay />
  </div>
</template>
