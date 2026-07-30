<script setup lang="ts">
import type { Block } from '~/types/domain'
import { RESIZE_EDGES, type ResizeEdge, useFrameResize } from '~/composables/useFrameResize'

// The eight border/corner grips of a resizable container (a service frame or a module), shared so
// the two node components can't drift in hit area, geometry, or which borders exist.
//
// Each grip STRADDLES the border it moves — half outside the box, half inside — giving a 12px hit
// band on a fine pointer (24px on a coarse one) while the DRAWN affordance stays a 2px bar on the
// border itself. The grips used to live on the frame's inner drop zone, 16px inside the visible
// border and flush against the content, where two thin strips read as scrollbars rather than as
// the box's edge.
//
// Corners are rendered LAST so they win the overlap with both of their edges. `RESIZE_EDGES` is
// ordered accordingly (edges first), and the whole set comes from the composable, so adding a
// direction is one entry there rather than markup here.
const props = defineProps<{
  /** The container being resized. Its position/size are what the drag writes. */
  block: Block
  /** Which palette to draw in — a frame's grips are sky, a module's violet. */
  tone: 'frame' | 'module'
}>()

const access = useWorkspaceAccess()
const { resizingId, startResize } = useFrameResize()
const resizing = computed(() => resizingId.value === props.block.id)

// Which grip the pointer rests on, and which one it grabbed. The lit bar is a CHILD of the grip's
// hit band, so a plain `hover:` utility on the bar is wrong (the pointer is over the band, not the
// 2px bar); tracking it in state instead of a `group-hover/<name>:` variant means ONE predicate
// lights the border whether the pointer is resting on it or dragging it. The drag reads `dragEdge`
// rather than `hoverEdge` on purpose: the pointer routinely leaves the band mid-drag, and the
// border it is moving must stay lit until the drag ends.
const hoverEdge = ref<ResizeEdge | null>(null)
const dragEdge = ref<ResizeEdge | null>(null)
const lit = (edge: ResizeEdge) =>
  resizing.value ? dragEdge.value === edge : hoverEdge.value === edge

function onPointerDown(e: PointerEvent, edge: ResizeEdge) {
  dragEdge.value = edge
  startResize(props.block, e, edge)
}

// Tailwind needs literal class names, so the geometry is a static table rather than interpolated
// strings. `box` positions the hit band (straddling, widened for a coarse pointer); `mark` draws
// the lit affordance — a bar along an edge, an L at a corner, each anchored ON the border by
// matching the box's own negative offset.
interface GripStyle {
  box: string
  mark: string
  /** Corners keep a faint mark at rest, so the gesture is discoverable without a hover. */
  idle?: boolean
}
const GRIPS: Record<ResizeEdge, GripStyle> = {
  n: {
    box: '-top-1.5 left-0 h-3 w-full cursor-ns-resize pointer-coarse:-top-3 pointer-coarse:h-6',
    mark: 'inset-x-3 top-1/2 h-0.5 -translate-y-1/2 rounded-full',
  },
  s: {
    box: '-bottom-1.5 left-0 h-3 w-full cursor-ns-resize pointer-coarse:-bottom-3 pointer-coarse:h-6',
    mark: 'inset-x-3 top-1/2 h-0.5 -translate-y-1/2 rounded-full',
  },
  e: {
    box: '-right-1.5 top-0 h-full w-3 cursor-ew-resize pointer-coarse:-right-3 pointer-coarse:w-6',
    mark: 'inset-y-3 left-1/2 w-0.5 -translate-x-1/2 rounded-full',
  },
  w: {
    box: '-left-1.5 top-0 h-full w-3 cursor-ew-resize pointer-coarse:-left-3 pointer-coarse:w-6',
    mark: 'inset-y-3 left-1/2 w-0.5 -translate-x-1/2 rounded-full',
  },
  ne: {
    box: '-top-1.5 -right-1.5 h-5 w-5 cursor-nesw-resize pointer-coarse:-top-3 pointer-coarse:-right-3 pointer-coarse:h-11 pointer-coarse:w-11',
    mark: 'right-1.5 top-1.5 h-2 w-2 rounded-sm border-r-2 border-t-2 pointer-coarse:right-3 pointer-coarse:top-3',
  },
  nw: {
    box: '-left-1.5 -top-1.5 h-5 w-5 cursor-nwse-resize pointer-coarse:-left-3 pointer-coarse:-top-3 pointer-coarse:h-11 pointer-coarse:w-11',
    mark: 'left-1.5 top-1.5 h-2 w-2 rounded-sm border-l-2 border-t-2 pointer-coarse:left-3 pointer-coarse:top-3',
  },
  se: {
    box: '-bottom-1.5 -right-1.5 h-5 w-5 cursor-nwse-resize pointer-coarse:-bottom-3 pointer-coarse:-right-3 pointer-coarse:h-11 pointer-coarse:w-11',
    mark: 'bottom-1.5 right-1.5 h-2 w-2 rounded-sm border-b-2 border-r-2 pointer-coarse:bottom-3 pointer-coarse:right-3',
    idle: true,
  },
  sw: {
    box: '-bottom-1.5 -left-1.5 h-5 w-5 cursor-nesw-resize pointer-coarse:-bottom-3 pointer-coarse:-left-3 pointer-coarse:h-11 pointer-coarse:w-11',
    mark: 'bottom-1.5 left-1.5 h-2 w-2 rounded-sm border-b-2 border-l-2 pointer-coarse:bottom-3 pointer-coarse:left-3',
  },
}

// A bar is filled, an L-shaped corner mark is drawn in border colour — so the lit/idle classes
// differ per shape as well as per tone.
const TONES = {
  frame: { barLit: 'bg-sky-400', markLit: 'border-sky-400', markIdle: 'border-slate-500' },
  module: {
    barLit: 'bg-violet-300',
    markLit: 'border-violet-300',
    markIdle: 'border-violet-400/60',
  },
} as const

function markClass(edge: ResizeEdge): string {
  const tone = TONES[props.tone]
  const isCorner = edge.length === 2
  if (!isCorner) return lit(edge) ? tone.barLit : 'bg-transparent'
  if (lit(edge)) return tone.markLit
  return GRIPS[edge].idle ? tone.markIdle : 'border-transparent'
}
</script>

<template>
  <!-- Resizing persists geometry, so it is a `board.write` mutation: a read-only viewer gets no
       grips at all rather than borders that light up and no-op (which is what `startResize`'s own
       permission check then backs up rather than carries alone). `nopan` alongside `nodrag` so the
       pane doesn't pan while resizing, same reason as the node's own drag handle. -->
  <template v-if="access.canWriteBoard.value">
    <div
      v-for="edge in RESIZE_EDGES"
      :key="edge"
      class="nodrag nopan absolute z-10 touch-none"
      :class="GRIPS[edge].box"
      :title="$t('board.frame.dragToResize')"
      :data-testid="`resize-${edge}`"
      @pointerenter="hoverEdge = edge"
      @pointerleave="hoverEdge = null"
      @pointerdown="onPointerDown($event, edge)"
    >
      <span class="absolute transition-colors" :class="[GRIPS[edge].mark, markClass(edge)]" />
    </div>
  </template>
</template>
