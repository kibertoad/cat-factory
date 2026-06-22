<script setup lang="ts">
import { VueFlow, useVueFlow, type NodeMouseEvent } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import BlockNode from './nodes/BlockNode.vue'
import TaskDependencyEdges from './TaskDependencyEdges.vue'
import { STATUS_META } from '~/utils/catalog'
import { readDndPayload, blockIdFromEvent } from '~/utils/dnd'
import { BOARD_FLOW_ID } from '~/composables/useBoardFlow'

const board = useBoardStore()
const pipelines = usePipelinesStore()
const execution = useExecutionStore()
const ui = useUiStore()
const github = useGitHubStore()
const toast = useToast()

const { onNodeDragStop, onViewportChange, screenToFlowCoordinate } = useVueFlow(BOARD_FLOW_ID)

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

const nodes = computed(() =>
  board.frames.map((b) => ({
    id: b.id,
    type: 'block',
    position: b.position,
    draggable: !frameExpanded(b.id),
    data: {},
  })),
)

onNodeDragStop(({ node }) => {
  board.moveBlock(node.id, { x: node.position.x, y: node.position.y })
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
  <div class="relative h-full w-full" @drop="onDrop" @dragover="onDragOver">
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
  </div>
</template>
