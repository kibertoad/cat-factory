<script setup lang="ts">
import { VueFlow, useVueFlow, type NodeMouseEvent } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { MiniMap } from '@vue-flow/minimap'
import BlockNode from './nodes/BlockNode.vue'
import EpicNode from './nodes/EpicNode.vue'
import TaskDependencyEdges from './TaskDependencyEdges.vue'
import DependencyConnectOverlay from './DependencyConnectOverlay.vue'
import { STATUS_META } from '~/utils/catalog'
import { readDndPayload, blockIdFromEvent } from '~/utils/dnd'
import { BOARD_FLOW_ID } from '~/composables/useBoardFlow'
import { useTaskExpansion } from '~/composables/useTaskExpansion'
import { useBlockDrag } from '~/composables/useBlockDrag'
import { useFrameStacking } from '~/composables/useFrameStacking'
import { useViewport } from '~/composables/useViewport'

const board = useBoardStore()
const pipelines = usePipelinesStore()
const execution = useExecutionStore()
const ui = useUiStore()
const github = useGitHubStore()
const toast = useToast()

const { onNodeDragStop, onViewportChange, screenToFlowCoordinate } = useVueFlow(BOARD_FLOW_ID)
const { draggingId } = useBlockDrag()
const { hoveredFrameId } = useFrameStacking()
// Touch drives the canvas gestures: a coarse pointer needs one-finger pan, and the
// minimap is too small to hit (and steals scarce width) on phones. `isCompact`
// (< lg) hides the minimap; `isTouch` switches the pan modality below.
const { isCompact, isTouch } = useViewport()

// Vue Flow's d3-zoom filter restricts `panOnDrag` to the listed mouse buttons, and a
// touch `touchstart` carries no `event.button` — so the button-array form ([0, 2] =
// left/right-drag, never middle) blocks one-finger touch panning. On a coarse pointer
// we therefore widen it to `true` (any pointer pans the pane; pinch-zoom is on by
// default), keeping the precise-pointer button restriction on mouse desktops.
const panOnDrag = computed<boolean | number[]>(() => (isTouch.value ? true : [0, 2]))

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

function onNodeDoubleClick({ node }: NodeMouseEvent) {
  // Frames are containers: double-click expands to reveal their tasks.
  ui.toggleFrame(node.id)
}

function onPaneClick() {
  ui.select(null)
}

function minimapColor(node: { id: string }) {
  const b = board.getBlock(node.id)
  return b ? STATUS_META[board.frameStatus(b.id)].color : '#475569'
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
    const position = screenToFlowCoordinate({ x: event.clientX, y: event.clientY })
    try {
      const block = await board.addBlock(payload.blockType, position)
      ui.select(block.id)
    } catch {
      toast.add({
        title: 'Could not add block',
        description: 'The backend rejected the request.',
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
    if (!target || !pipeline) return
    if (target.level !== 'task') {
      toast.add({
        title: 'Drop onto a task',
        description: 'Pipelines run against tasks, not services.',
      })
      return
    }
    if (!board.isRunnable(target.id)) {
      toast.add({ title: 'Task is blocked', description: 'Its dependencies haven’t merged yet.' })
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
      :min-zoom="0.2"
      :max-zoom="3"
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
      <!-- The minimap is a precise-pointer affordance: it's too small to hit on a
           phone and eats scarce width, so it's hidden below `lg`. The toolbar's
           zoom-in/out + fit-view controls remain the camera fallback on mobile. -->
      <MiniMap
        v-if="!isCompact"
        pannable
        zoomable
        :node-color="minimapColor"
        class="!bg-slate-900/80"
        data-testid="board-minimap"
      />

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
        <h2 class="text-base font-semibold text-slate-300">Your board is empty</h2>
        <p class="mt-1 max-w-sm text-sm text-slate-500">
          Add a service to get started: bootstrap a fresh repo or pull in one you already have.
        </p>
      </div>
      <div class="pointer-events-auto flex flex-wrap items-center justify-center gap-2">
        <UButton color="primary" icon="i-lucide-git-branch-plus" @click="ui.openBootstrap()">
          Bootstrap repo
        </UButton>
        <UButton
          v-if="github.available"
          color="primary"
          variant="soft"
          icon="i-lucide-folder-git-2"
          @click="ui.openAddService()"
        >
          Add from existing repo
        </UButton>
      </div>
    </div>

    <!-- task dependency arrows, overlaid in screen space -->
    <TaskDependencyEdges />

    <!-- live preview line while drag-to-connecting a dependency -->
    <DependencyConnectOverlay />
  </div>
</template>
