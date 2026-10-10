import type { Ref } from 'vue'
import { onMounted, onBeforeUnmount } from 'vue'
import { lodAtLeast } from '~/composables/useSemanticZoom'
import { onBoardActivity, type BoardActivity } from '~/composables/useBoardActivity'
import { useSettlingRaf } from '~/composables/useSettlingRaf'
import { measureBlocks, type BlockMeasurements } from '~/utils/blockRects'
import { headerDistanceSq, type Rect } from '~/utils/taskExpansionRanking'

function intersects(a: Rect, b: Rect) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

function sameSet(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

/**
 * Board-level driver deciding which task cards expand their full pipeline list.
 * Recomputed every frame against live DOM rects so it follows pan / zoom / drag / resize,
 * and writes two independent grants into the `taskExpansion` store (which combines them —
 * see the store for how they resolve):
 *
 *  - hover: the task directly under the pointer, at ANY zoom level. "Under the pointer"
 *    is the TOPMOST card at the cursor (document.elementFromPoint), so hovering a region
 *    already covered by another open pipeline keeps that pipeline, not the card beneath.
 *  - zoom: at the deep `steps`/`subtasks` bands, every on-screen card, minus overlaps —
 *    two sub-gates:
 *      - visibility: a task expands only while its card overlaps the board viewport.
 *      - overlap: walking the visible candidates nearest-header-to-screen-centre first, a
 *        task expands only if its footprint doesn't collide with one already granted, so
 *        the card you're looking at wins an overlap and the rest stay compact. The hovered
 *        card is granted first, so it wins every overlap it's part of.
 *
 * Only tasks with a running pipeline (steps to show) are candidates for either grant — a
 * task that wouldn't expand never blocks a neighbour and never lifts an empty card.
 *
 * Deciding costs a rect per candidate plus an `elementFromPoint`, so it runs only while the
 * board is moving: the canvas activity pulse wakes it and `useSettlingRaf` parks it again once
 * the two grants stop changing.
 */
export function useTaskExpansion(container: Ref<HTMLElement | null>, activity: BoardActivity) {
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

  // The task whose card is topmost at the pointer, or null. Using elementFromPoint (not a
  // rect test) means an open pipeline stacked above a neighbour wins the hit, so hovering
  // a region obscured by another pipeline doesn't switch to the card hidden beneath it.
  //
  // Blocks with no pipeline to show are filtered out here rather than left to the card:
  // a frame, a module, or a task with no run expands to nothing, and granting it would
  // still lift an empty card over its neighbours (see LaneTask's z-index).
  function hoveredTaskId(): string | null {
    // Where the pointer is comes from the pulse, which already listens for the same gestures on
    // the same element (see `BoardActivity.pointer`).
    const pointer = activity.pointer()
    if (!pointer) return null
    const hit = document.elementFromPoint(pointer.x, pointer.y)
    const id = hit?.closest('[data-block-id]')?.getAttribute('data-block-id') ?? null
    if (!id || !execution.getByBlock(id)?.steps.length) return null
    return id
  }

  /** Re-decide both grants; reports whether either of them changed. */
  function recompute(): boolean {
    // Hover expands a card at ANY zoom band, so the pointer hit is resolved BEFORE the
    // zoom gate below — resolving it after would collapse the hovered card the moment the
    // user zoomed back out past the `steps` band.
    const hovered = hoveredTaskId()
    let changed = false
    if (store.hoveredId !== hovered) {
      store.setHovered(hovered)
      changed = true
    }

    // The zoom-driven expansion (every on-screen card, overlap-resolved) is deep-band
    // only; clear its grants otherwise. The hover grant above stands on its own.
    if (!lodAtLeast(ui.lod, 'steps')) {
      if (store.allowed.size) {
        store.setAllowed(new Set())
        changed = true
      }
      return changed
    }
    const view = container.value?.getBoundingClientRect()
    if (!view) return changed
    // One DOM query for the whole sweep instead of one per candidate task (see `measureBlocks`).
    const blocks: BlockMeasurements = measureBlocks()
    const cx = view.left + view.width / 2
    const cy = view.top + view.height / 2

    const candidates: { id: string; rect: Rect; dist: number }[] = []
    const liveIds = new Set<string>()
    for (const t of board.allTasks) {
      // Only tasks whose run actually has steps would expand a pipeline list.
      if (!execution.getByBlock(t.id)?.steps.length) continue
      const el = blocks.elementFor(t.id)
      if (!el) continue
      const rect = blocks.rectFor(el)
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
      // Rank by the screen centre's distance to the card's stable header (top edge),
      // so the card you're looking at wins and a tall card's expanded body can't claim
      // the centre just by covering it. See utils/taskExpansionRanking.ts.
      candidates.push({ id: t.id, rect: footprint, dist: headerDistanceSq(footprint, cx, cy) })
    }
    // Drop cached heights for cards that are gone, so the map can't grow unbounded.
    for (const id of expandedHeight.keys()) if (!liveIds.has(id)) expandedHeight.delete(id)
    candidates.sort((a, b) => a.dist - b.dist)

    // Greedy by header distance: a candidate is granted only if its projected footprint
    // clears every footprint already granted, so the centre-most card wins any overlap.
    // The hovered card is granted FIRST, so hovering a card expands it regardless of its
    // distance from the centre (and a centre-most neighbour it overlaps yields to it).
    const claimed: Rect[] = []
    const next = new Set<string>()
    const hoveredCard = hovered ? candidates.find((c) => c.id === hovered) : undefined
    if (hoveredCard) {
      next.add(hoveredCard.id)
      claimed.push(hoveredCard.rect)
    }
    for (const c of candidates) {
      if (c.id === hoveredCard?.id) continue
      if (claimed.some((r) => intersects(c.rect, r))) continue
      next.add(c.id)
      claimed.push(c.rect)
    }
    if (!sameSet(next, store.allowed)) {
      store.setAllowed(next)
      changed = true
    }
    return changed
  }

  const { poke } = useSettlingRaf(recompute)
  // The pulse both records where the pointer is and schedules the frame that acts on it.
  onBoardActivity(activity, poke)
  onMounted(() => {
    store.setDriverActive(true)
  })
  onBeforeUnmount(() => {
    store.setDriverActive(false)
  })
}
