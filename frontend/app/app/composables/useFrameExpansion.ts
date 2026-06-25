import type { Ref } from 'vue'
import { onMounted, onBeforeUnmount } from 'vue'
import { useRafFn } from '@vueuse/core'
import { lodAtLeast } from '~/composables/useSemanticZoom'

type Rect = { left: number; right: number; top: number; bottom: number }

function intersects(a: Rect, b: Rect) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

function sameSet(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

/**
 * Board-level driver deciding which service frames may auto-expand to their task
 * canvas once zoomed past the `close` band. The frame analogue of
 * `useTaskExpansion`: two gates, recomputed every frame against live DOM rects so
 * they follow pan / zoom / drag / resize:
 *
 *  - visibility: a frame expands only while its card overlaps the board viewport,
 *    so a service that isn't on screen at all never expands when you zoom in.
 *  - overlap: walking the visible frames nearest-to-screen-centre first, a frame
 *    expands only if its (expanded) footprint doesn't collide with one already
 *    granted — so the small service the user centred on wins, and a larger
 *    neighbour can't "snap out" over it.
 *
 * Writes the permitted id set into the `frameExpansion` store; `ui.isFrameExpanded`
 * reads it. Manually-expanded frames bypass this gate entirely (see the store).
 */
export function useFrameExpansion(container: Ref<HTMLElement | null>) {
  const board = useBoardStore()
  const ui = useUiStore()
  const store = useFrameExpansionStore()

  // Last-known expanded size per frame. A frame's card balloons from a chip to its
  // full task canvas only while it's granted, so its live rect collapses the moment
  // it's denied. Testing overlap with the collapsed chip is what would cause
  // flashing: a denied frame no longer overlaps its neighbour, gets re-granted,
  // expands, overlaps again, gets denied — every frame. We cache the expanded
  // extent while a frame is granted and project the footprint with it, so a denied
  // frame is still tested at its expanded size and stays denied. Stable.
  const expandedSize = new Map<string, { w: number; h: number }>()

  function rectOf(id: string): DOMRect | null {
    const el = document.querySelector(`[data-block-id="${id}"]`) as HTMLElement | null
    return el ? el.getBoundingClientRect() : null
  }

  function recompute() {
    // Frames only auto-expand at the `close` band and deeper; clear otherwise.
    if (!lodAtLeast(ui.lod, 'close')) {
      if (store.allowed.size) store.setAllowed(new Set())
      return
    }
    const view = container.value?.getBoundingClientRect()
    if (!view) return
    const cx = view.left + view.width / 2
    const cy = view.top + view.height / 2

    const candidates: { id: string; rect: Rect; dist: number }[] = []
    const liveIds = new Set<string>()
    for (const f of board.frames) {
      const rect = rectOf(f.id)
      if (!rect) continue
      liveIds.add(f.id)
      // While granted the frame is rendered expanded, so its live rect is its
      // expanded footprint — cache it. A denied frame keeps its last cached value.
      if (store.allowed.has(f.id)) expandedSize.set(f.id, { w: rect.width, h: rect.height })
      // Visibility: the card must intersect the board viewport (live rect).
      if (!intersects(rect, view)) continue
      // Project to the cached expanded extent so the overlap test is independent of
      // the card's current (possibly collapsed-chip) state. A frame grows rightward
      // and downward from its top-left, which stays put as it expands.
      const cached = expandedSize.get(f.id)
      const width = Math.max(rect.width, cached?.w ?? 0)
      const height = Math.max(rect.height, cached?.h ?? 0)
      const footprint: Rect = {
        left: rect.left,
        right: rect.left + width,
        top: rect.top,
        bottom: rect.top + height,
      }
      // Stable anchor: the card's top-left. It doesn't move as the frame grows, so
      // the ordering can't oscillate as frames expand / collapse.
      const dist = (rect.left - cx) ** 2 + (rect.top - cy) ** 2
      candidates.push({ id: f.id, rect: footprint, dist })
    }
    // Drop cached sizes for frames that are gone, so the map can't grow unbounded.
    for (const id of expandedSize.keys()) if (!liveIds.has(id)) expandedSize.delete(id)
    candidates.sort((a, b) => a.dist - b.dist)

    // Greedy by distance to centre: a frame is granted only if its projected
    // footprint clears every footprint already granted, so the centre-most frame
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
