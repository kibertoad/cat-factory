<script setup lang="ts">
import { VueFlow, useVueFlow, type NodeMouseEvent } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import BlockNode from './nodes/BlockNode.vue'
import EpicNode from './nodes/EpicNode.vue'
import TaskDependencyEdges from './TaskDependencyEdges.vue'
import DependencyConnectOverlay from './DependencyConnectOverlay.vue'
import { STATUS_META } from '~/utils/catalog'
import { readDndPayload, blockIdFromEvent } from '~/utils/dnd'
import { BOARD_FLOW_ID } from '~/composables/useBoardFlow'
import { useTaskExpansion } from '~/composables/useTaskExpansion'
import { useFrameExpansion } from '~/composables/useFrameExpansion'
import { computeDisplacement } from '~/utils/boardDisplacement'

const board = useBoardStore()
const pipelines = usePipelinesStore()
const execution = useExecutionStore()
const ui = useUiStore()
const github = useGitHubStore()
const toast = useToast()

const { onNodeDragStop, onViewportChange, screenToFlowCoordinate } = useVueFlow(BOARD_FLOW_ID)

// Gate which task cards expand their pipeline list on deep zoom: only on-screen
// cards, and only the centre-most of any that would overlap (see useTaskExpansion).
// The frame-level gate is the same idea one level up: which service frames may
// auto-expand to their task canvas once zoomed in (see useFrameExpansion).
const boardEl = ref<HTMLElement | null>(null)
useTaskExpansion(boardEl)
useFrameExpansion(boardEl)

// Only frames are board nodes. Dependencies live on tasks (rendered inside the
// frames), so there are no frame-to-frame edges on the canvas.
//
// Vue Flow tags every *draggable* node with the `nopan` class, which makes the
// pane refuse to pan while the pointer is over it. An expanded frame fills much
// of the viewport, so leaving it draggable turns the whole canvas into a dead
// zone once tasks appear. We therefore make expanded frames non-draggable (the
// pane pans straight through them) and move them via their header handle
// instead — collapsed chips stay node-draggable since they're small.
function frameExpanded(id: string) {
  return ui.isFrameExpanded(id) && ui.lod !== 'far'
}

// Compressed space: an expanded frame grows rightward / downward from its stored
// top-left and would overlap its neighbours. Rather than collapsing one to resolve
// the clash (the old behaviour, which made a service "snap out" as you scrolled
// across it), we push the neighbours away by the growth so the expanded footprint
// never overlaps a neighbour it wasn't already overlapping. This is a render-only
// offset added to each node's position; stored block positions are never mutated.
const FRAME_COLLAPSED_W = 224 // the compact `w-56` card
const FRAME_COLLAPSED_H = 150
const FRAME_CHROME_W = 40 // border + padding around the inner task canvas
const FRAME_CHROME_H = 120 // top bar + header row + paddings above the canvas

const frameOffsets = computed(() => {
  const boxes = [
    ...board.frames.map((b) => {
      let growX = 0
      let growY = 0
      if (frameExpanded(b.id)) {
        const c = board.containerSize(b.id)
        growX = Math.max(0, c.w + FRAME_CHROME_W - FRAME_COLLAPSED_W)
        growY = Math.max(0, c.h + FRAME_CHROME_H - FRAME_COLLAPSED_H)
      }
      return {
        id: b.id,
        x: b.position.x,
        y: b.position.y,
        w: FRAME_COLLAPSED_W,
        h: FRAME_COLLAPSED_H,
        growX,
        growY,
      }
    }),
    // Epics never expand, but they're pushed aside like any other box so an expanded
    // frame doesn't end up rendered on top of one.
    ...board.epics.map((b) => ({
      id: b.id,
      x: b.position.x,
      y: b.position.y,
      w: FRAME_COLLAPSED_W,
      h: FRAME_COLLAPSED_H,
      growX: 0,
      growY: 0,
    })),
  ]
  return computeDisplacement(boxes)
})

function offsetOf(id: string) {
  return frameOffsets.value.get(id) ?? { dx: 0, dy: 0 }
}

const nodes = computed(() => [
  ...board.frames.map((b) => {
    const o = offsetOf(b.id)
    return {
      id: b.id,
      type: 'block',
      position: { x: b.position.x + o.dx, y: b.position.y + o.dy },
      draggable: !frameExpanded(b.id),
      data: {},
    }
  }),
  // Epics are top-level grouping nodes (non-structural), drawn alongside frames and
  // linked to their member tasks by the dependency-edge overlay.
  ...board.epics.map((b) => {
    const o = offsetOf(b.id)
    return {
      id: b.id,
      type: 'epic',
      position: { x: b.position.x + o.dx, y: b.position.y + o.dy },
      draggable: true,
      data: {},
    }
  }),
])

onNodeDragStop(({ node }) => {
  // node.position carries the render offset (a dragged collapsed frame can be one a
  // neighbour pushed aside); subtract it so we persist the un-displaced position.
  const o = offsetOf(node.id)
  board.moveBlock(node.id, { x: node.position.x - o.dx, y: node.position.y - o.dy })
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
  <div ref="boardEl" class="relative h-full w-full" @drop="onDrop" @dragover="onDragOver">
    <VueFlow
      :id="BOARD_FLOW_ID"
      :nodes="nodes"
      :min-zoom="0.2"
      :max-zoom="3"
      :default-viewport="{ x: 40, y: 20, zoom: 0.85 }"
      :pan-on-drag="[0, 2]"
      fit-view-on-init
      @node-click="onNodeClick"
      @node-double-click="onNodeDoubleClick"
      @pane-click="onPaneClick"
      @contextmenu.prevent
    >
      <Background pattern-color="#1e293b" :gap="22" :size="1.4" />
      <MiniMap pannable zoomable :node-color="minimapColor" class="!bg-slate-900/80" />
      <Controls position="bottom-left" />

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
