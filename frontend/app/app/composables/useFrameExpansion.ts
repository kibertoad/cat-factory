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
 * canvas once zoomed past the `close` band. A single gate, recomputed every frame
 * against live DOM rects so it follows pan / zoom / drag / resize: a frame expands
 * only while its card overlaps the board viewport, so a service that isn't on
 * screen at all never expands when you zoom in.
 *
 * There is deliberately NO overlap/centre-most denial any more. Expanded footprints
 * no longer fight for space: the canvas reserves room for each expanded frame by
 * pushing its neighbours away (compressed space — see `computeDisplacement` /
 * `BoardCanvas`), so a frame never has to collapse to make room for another. The
 * old greedy-by-distance gate is what made a service "snap out" as you scrolled
 * across it: scrolling drifted its anchor off-centre, a neighbour won the greedy
 * pass, and the overlapping footprint denied the frame you were navigating.
 *
 * The grant is **sticky within the close band**: a frame that has expanded stays
 * granted even after it scrolls off-screen, until you actually zoom back out (the
 * clear below). Were it dropped the instant it left the viewport, the rightward room
 * compressed space had reserved for it would vanish, and the service you'd scrolled
 * *into* would snap left under the fixed camera — the very "thrown to the right" jump
 * this gate exists to prevent. Sticky keeps the expanded set growing-only while
 * zoomed in, so on-screen displacement never shrinks and grants never toggle (so the
 * gate can't oscillate). A frame's own expansion never moves the frame (displacement
 * excludes self).
 *
 * Writes the permitted id set into the `frameExpansion` store; `ui.isFrameExpanded`
 * reads it. Manually-expanded frames bypass this gate entirely (see the store).
 */
export function useFrameExpansion(container: Ref<HTMLElement | null>) {
  const board = useBoardStore()
  const ui = useUiStore()
  const store = useFrameExpansionStore()

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

    // Grant every frame whose card currently overlaps the board viewport, and KEEP
    // the ones already granted this zoom session (sticky — see the doc comment), so
    // the reserved space to a navigated frame's left never collapses out from under
    // the camera. The canvas spaces the expanded frames apart, so there's no overlap
    // to resolve. Stale ids (deleted frames) are pruned so the set can't grow forever.
    const ids = new Set(board.frames.map((f) => f.id))
    const next = new Set<string>()
    for (const id of store.allowed) if (ids.has(id)) next.add(id)
    for (const f of board.frames) {
      const rect = rectOf(f.id)
      if (rect && intersects(rect, view)) next.add(f.id)
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
