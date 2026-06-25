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
 * Testing visibility with the frame's *expanded* live rect (its full card while
 * granted) is what keeps it expanded while any part of it is still on screen, so
 * you can pan across the whole service without it collapsing. A frame's own
 * expansion never moves the frame (displacement excludes self), so granting every
 * visible frame can't oscillate.
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

    // Grant every frame whose card currently overlaps the board viewport. The
    // canvas spaces the expanded frames apart, so there's no overlap to resolve.
    const next = new Set<string>()
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
