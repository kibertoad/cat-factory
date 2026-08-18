<script setup lang="ts">
import { ref, shallowRef, computed, watch } from 'vue'
import { useBoardActivity } from '~/composables/useBoardActivity'
import { useSettlingRaf } from '~/composables/useSettlingRaf'
import { commitSegments, type EdgeSegment } from '~/utils/edgeSegments'
import { measureBlocks, type BlockMeasurements } from '~/utils/blockRects'

/**
 * Draws dependency arrows between task cards as an SVG overlay on top of the
 * board. Tasks are plain DOM nodes (inside frame cards), so we resolve their
 * on-screen rectangles by `[data-block-id]` — this makes arrows follow pan /
 * zoom / drag / expand for free. When a task's frame is collapsed (its card
 * isn't rendered), the arrow anchors to the frame card instead.
 *
 * Measuring costs forced layout reads, so it runs only while something is actually
 * moving: the board's activity pulse wakes it and `useSettlingRaf` parks it again
 * once the resolved segments hold still. Within one pass the cards are resolved and
 * measured through a single shared snapshot (`measureBlocks`), so a task with five
 * dependencies is found and measured once rather than five times.
 */
const board = useBoardStore()

const svg = ref<SVGSVGElement | null>(null)

const segments = shallowRef<EdgeSegment[]>([])
// Epic→member membership links (distinct style from dependency edges).
const memberSegments = shallowRef<EdgeSegment[]>([])
// Frontend frame → bound service frame links (from a frontend's backend bindings).
const frontendSegments = shallowRef<EdgeSegment[]>([])
// Service frame → connected provider service frame links (from serviceConnections).
const connectionSegments = shallowRef<EdgeSegment[]>([])

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

// epic → each of its member tasks (membership, drawn as a soft violet link).
const epicLinks = computed(() => {
  const out: { id: string; source: string; target: string }[] = []
  for (const e of board.epics) {
    for (const m of board.epicMembers(e.id)) {
      out.push({ id: `${e.id}__${m.id}`, source: e.id, target: m.id })
    }
  }
  return out
})

// frontend frame → each service it binds a backend upstream to (its ephemeral env is the
// "service under test"). The link IS a `service`-sourced backend binding on the frontend's
// config; deduped so multiple env vars bound to the same service draw one edge.
const frontendLinks = computed(() => {
  const out: { id: string; source: string; target: string }[] = []
  for (const f of board.frames) {
    if (f.type !== 'frontend') continue
    const seen = new Set<string>()
    for (const binding of f.frontendConfig?.backendBindings ?? []) {
      if (binding.source.kind !== 'service') continue
      const serviceId = binding.source.serviceBlockId
      if (seen.has(serviceId)) continue
      seen.add(serviceId)
      if (board.getBlock(serviceId))
        out.push({ id: `${f.id}__fe__${serviceId}`, source: f.id, target: serviceId })
    }
  }
  return out
})

// consumer service frame → each provider service it connects to (a serviceConnections
// entry, stored on the consumer end). Deduped; a target deleted out of band draws nothing.
const connectionLinks = computed(() => {
  const out: { id: string; source: string; target: string }[] = []
  for (const f of board.frames) {
    if (f.type !== 'service') continue
    const seen = new Set<string>()
    for (const connection of f.serviceConnections ?? []) {
      const providerId = connection.serviceBlockId
      if (seen.has(providerId)) continue
      seen.add(providerId)
      if (board.getBlock(providerId))
        out.push({ id: `${f.id}__conn__${providerId}`, source: f.id, target: providerId })
    }
  }
  return out
})

/** Resolve a task's anchor: walk up task → module → service to the first card
 * that's actually rendered (a container may be collapsed). */
function anchorEl(taskId: string, blocks: BlockMeasurements): HTMLElement | null {
  let cur = board.getBlock(taskId)
  while (cur) {
    const el = blocks.elementFor(cur.id)
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

/** Resolve the on-screen, origin-relative border-to-border segment between two blocks,
 * or null when either end is missing or both collapsed into the same frame. */
function segmentBetween(
  sourceId: string,
  targetId: string,
  origin: DOMRect,
  blocks: BlockMeasurements,
) {
  const a = anchorEl(sourceId, blocks)
  const b = anchorEl(targetId, blocks)
  if (!a || !b || a === b) return null // missing, or both collapsed into the same frame
  const ra = blocks.rectFor(a)
  const rb = blocks.rectFor(b)
  const ax = ra.left + ra.width / 2 - origin.left
  const ay = ra.top + ra.height / 2 - origin.top
  const bx = rb.left + rb.width / 2 - origin.left
  const by = rb.top + rb.height / 2 - origin.top
  const start = border(ax, ay, ra.width / 2, ra.height / 2, bx, by)
  const end = border(bx, by, rb.width / 2, rb.height / 2, ax, ay)
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y }
}

/** Map a list of {id, source, target} links to their drawable (arrowhead-agnostic) segments. */
function linkSegments(
  links: { id: string; source: string; target: string }[],
  origin: DOMRect,
  blocks: BlockMeasurements,
): EdgeSegment[] {
  const out: EdgeSegment[] = []
  for (const link of links) {
    const seg = segmentBetween(link.source, link.target, origin, blocks)
    if (seg) out.push({ id: link.id, ...seg })
  }
  return out
}

/** Re-measure every overlay link; reports whether any of them moved. */
function recompute(): boolean {
  const el = svg.value
  if (!el) return false
  const origin = el.getBoundingClientRect()
  // One snapshot for the whole pass: every overlay below resolves and measures through it.
  const blocks = measureBlocks()

  const deps: EdgeSegment[] = []
  for (const d of taskDeps.value) {
    const seg = segmentBetween(d.source, d.target, origin, blocks)
    if (!seg) continue
    deps.push({ id: d.id, ...seg, done: board.getBlock(d.source)?.status === 'done' })
  }

  // An array literal, so every list is committed before the result is reduced: a `||` chain
  // would short-circuit and leave the later overlays drawn at stale coordinates.
  return [
    commitSegments(segments, deps),
    commitSegments(memberSegments, linkSegments(epicLinks.value, origin, blocks)),
    commitSegments(frontendSegments, linkSegments(frontendLinks.value, origin, blocks)),
    commitSegments(connectionSegments, linkSegments(connectionLinks.value, origin, blocks)),
  ].some(Boolean)
}

const { poke } = useSettlingRaf(recompute)
useBoardActivity(poke)
// A link set can change with no visible change to any card (toggling a dependency between two
// tasks draws an arrow and nothing else), which the DOM-level pulse would never see.
watch([taskDeps, epicLinks, frontendLinks, connectionLinks], poke)
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
      <marker
        id="frontend-arrow"
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M0,0 L10,5 L0,10 z" fill="#22d3ee" />
      </marker>
      <marker
        id="service-connection-arrow"
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M0,0 L10,5 L0,10 z" fill="#34d399" />
      </marker>
    </defs>

    <!-- consumer service → provider service connection links (emerald, arrow toward the provider) -->
    <line
      v-for="s in connectionSegments"
      :key="s.id"
      :x1="s.x1"
      :y1="s.y1"
      :x2="s.x2"
      :y2="s.y2"
      stroke="#34d399"
      :stroke-width="1.5"
      stroke-dasharray="3 4"
      :stroke-opacity="0.55"
      marker-end="url(#service-connection-arrow)"
    />

    <!-- frontend frame → bound service frame links (cyan, arrow toward the service under test) -->
    <line
      v-for="s in frontendSegments"
      :key="s.id"
      :x1="s.x1"
      :y1="s.y1"
      :x2="s.x2"
      :y2="s.y2"
      stroke="#22d3ee"
      :stroke-width="1.5"
      stroke-dasharray="1 4"
      :stroke-opacity="0.6"
      marker-end="url(#frontend-arrow)"
    />

    <!-- epic → member membership links (soft violet, no arrowhead) -->
    <line
      v-for="s in memberSegments"
      :key="s.id"
      :x1="s.x1"
      :y1="s.y1"
      :x2="s.x2"
      :y2="s.y2"
      stroke="#8b5cf6"
      :stroke-width="1.5"
      stroke-dasharray="2 5"
      :stroke-opacity="0.5"
    />

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
