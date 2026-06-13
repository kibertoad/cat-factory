<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRafFn } from '@vueuse/core'

/**
 * Draws dependency arrows between task cards as an SVG overlay on top of the
 * board. Tasks are plain DOM nodes (inside frame cards), so we resolve their
 * on-screen rectangles by `[data-block-id]` every frame — this makes arrows
 * follow pan / zoom / drag / expand for free. When a task's frame is collapsed
 * (its card isn't rendered), the arrow anchors to the frame card instead.
 */
const board = useBoardStore()

const svg = ref<SVGSVGElement | null>(null)

type Seg = { id: string; x1: number; y1: number; x2: number; y2: number; done: boolean }
const segments = ref<Seg[]>([])

// task → its dependencies, both ends being tasks
const taskDeps = computed(() => {
  const out: { id: string; source: string; target: string }[] = []
  for (const t of board.allTasks) {
    for (const depId of t.dependsOn) {
      const dep = board.getBlock(depId)
      if (dep && dep.level === 'task')
        out.push({ id: `${depId}__${t.id}`, source: depId, target: t.id })
    }
  }
  return out
})

/** Resolve a task's anchor: walk up task → module → service to the first card
 * that's actually rendered (a container may be collapsed). */
function anchorEl(taskId: string): HTMLElement | null {
  let cur = board.getBlock(taskId)
  while (cur) {
    const el = document.querySelector(`[data-block-id="${cur.id}"]`) as HTMLElement | null
    if (el) return el
    cur = cur.parentId ? board.getBlock(cur.parentId) : undefined
  }
  return null
}

/** Point on a rect's border along the direction toward (tx,ty). */
function border(cx: number, cy: number, hw: number, hh: number, tx: number, ty: number) {
  const dx = tx - cx
  const dy = ty - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity)
  return { x: cx + dx * t, y: cy + dy * t }
}

function recompute() {
  const el = svg.value
  if (!el) return
  const origin = el.getBoundingClientRect()
  const next: Seg[] = []

  for (const d of taskDeps.value) {
    const a = anchorEl(d.source)
    const b = anchorEl(d.target)
    if (!a || !b || a === b) continue // missing, or both collapsed into the same frame

    const ra = a.getBoundingClientRect()
    const rb = b.getBoundingClientRect()
    const ax = ra.left + ra.width / 2 - origin.left
    const ay = ra.top + ra.height / 2 - origin.top
    const bx = rb.left + rb.width / 2 - origin.left
    const by = rb.top + rb.height / 2 - origin.top

    const start = border(ax, ay, ra.width / 2, ra.height / 2, bx, by)
    const end = border(bx, by, rb.width / 2, rb.height / 2, ax, ay)

    next.push({
      id: d.id,
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      done: board.getBlock(d.source)?.status === 'done',
    })
  }
  segments.value = next
}

const { pause, resume } = useRafFn(recompute, { immediate: false })
onMounted(resume)
onBeforeUnmount(pause)
</script>

<template>
  <svg ref="svg" class="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible">
    <defs>
      <marker
        id="task-arrow-pending"
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M0,0 L10,5 L0,10 z" fill="#f59e0b" />
      </marker>
      <marker
        id="task-arrow-done"
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M0,0 L10,5 L0,10 z" fill="#64748b" />
      </marker>
    </defs>

    <line
      v-for="s in segments"
      :key="s.id"
      :x1="s.x1"
      :y1="s.y1"
      :x2="s.x2"
      :y2="s.y2"
      :stroke="s.done ? '#64748b' : '#f59e0b'"
      :stroke-width="2"
      :stroke-dasharray="s.done ? '0' : '5 4'"
      :stroke-opacity="0.85"
      :marker-end="s.done ? 'url(#task-arrow-done)' : 'url(#task-arrow-pending)'"
    />
  </svg>
</template>
