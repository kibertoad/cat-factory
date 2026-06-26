import type { Ref } from 'vue'
import { onMounted, onBeforeUnmount } from 'vue'
import { useRafFn } from '@vueuse/core'
import { lodAtLeast } from '~/composables/useSemanticZoom'
import {
  centreOwnership,
  compareOwnership,
  type Ownership,
  type Rect,
} from '~/utils/taskExpansionRanking'

function intersects(a: Rect, b: Rect) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

function sameSet(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

/**
 * Board-level driver deciding which task cards may expand their full pipeline list
 * once zoomed in (the deep `steps`/`subtasks` bands). Two gates, recomputed every
 * frame against live DOM rects so they follow pan / zoom / drag / resize:
 *
 *  - visibility: a task expands only while its card overlaps the board viewport.
 *  - overlap: walking the visible candidates centre-owner-first (the card whose band
 *    holds the screen centre, then nearest), a task expands only if its footprint
 *    doesn't collide with one already granted, so the card you're looking at wins an
 *    overlap and the rest stay compact.
 *
 * Writes the permitted id set into the `taskExpansion` store; `TaskPipelineMini` reads it.
 * Only tasks with a running pipeline (steps to show) are candidates — a task that
 * wouldn't expand never blocks a neighbour.
 */
export function useTaskExpansion(container: Ref<HTMLElement | null>) {
  const board = useBoardStore()
  const execution = useExecutionStore()
  const ui = useUiStore()
  const store = useTaskExpansionStore()

  // Last-known expanded height per task. A card grows downward only while it's
  // granted (its pipeline list is rendered), so its live height collapses the
  // moment it's denied. Testing overlap with that collapsed height is what causes
  // the flashing: a denied card no longer overlaps its neighbour, gets re-granted,
  // expands, overlaps again, gets denied — every frame. We cache the expanded
  // height while a card is granted and project the footprint with it, so a denied
  // card is still tested at its expanded extent and stays denied. Stable.
  const expandedHeight = new Map<string, number>()

  function rectOf(id: string): DOMRect | null {
    const el = document.querySelector(`[data-block-id="${id}"]`) as HTMLElement | null
    return el ? el.getBoundingClientRect() : null
  }

  function recompute() {
    // Task cards only expand at the deep zoom bands; clear everything otherwise.
    if (!lodAtLeast(ui.lod, 'steps')) {
      if (store.allowed.size) store.setAllowed(new Set())
      return
    }
    const view = container.value?.getBoundingClientRect()
    if (!view) return
    const cx = view.left + view.width / 2
    const cy = view.top + view.height / 2

    const candidates: ({ id: string; rect: Rect } & Ownership)[] = []
    const liveIds = new Set<string>()
    for (const t of board.allTasks) {
      // Only tasks whose run actually has steps would expand a pipeline list.
      if (!execution.getByBlock(t.id)?.steps.length) continue
      const rect = rectOf(t.id)
      if (!rect) continue
      liveIds.add(t.id)
      // While a card is granted it's rendered expanded, so its live height is its
      // expanded footprint — cache it. A denied card keeps its last cached value.
      if (store.allowed.has(t.id)) expandedHeight.set(t.id, rect.height)
      // Visibility: the card must intersect the board viewport (live rect).
      if (!intersects(rect, view)) continue
      // Project the footprint downward to the expanded extent so the overlap test
      // is independent of the card's current (possibly collapsed) state.
      const height = Math.max(rect.height, expandedHeight.get(t.id) ?? 0)
      const footprint: Rect = {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.top + height,
      }
      // Rank by which card "owns" the screen centre (centreOwnership): the card whose
      // band the centre sits in wins, so a stacked neighbour bleeding down from above
      // can't steal the grant just by being earlier in document order, and a card you've
      // scrolled into keeps it. See utils/taskExpansionRanking.ts.
      candidates.push({ id: t.id, rect: footprint, ...centreOwnership(footprint, cx, cy) })
    }
    // Drop cached heights for cards that are gone, so the map can't grow unbounded.
    for (const id of expandedHeight.keys()) if (!liveIds.has(id)) expandedHeight.delete(id)
    candidates.sort(compareOwnership)

    // Greedy by distance to centre: a candidate is granted only if its projected
    // footprint clears every footprint already granted, so the centre-most card
    // wins any overlap.
    const claimed: Rect[] = []
    const next = new Set<string>()
    for (const c of candidates) {
      if (claimed.some((r) => intersects(c.rect, r))) continue
      next.add(c.id)
      claimed.push(c.rect)
    }
    if (!sameSet(next, store.allowed)) store.setAllowed(next)
  }

  const { pause, resume } = useRafFn(recompute, { immediate: false })
  onMounted(() => {
    store.setDriverActive(true)
    resume()
  })
  onBeforeUnmount(() => {
    pause()
    store.setDriverActive(false)
  })
}
