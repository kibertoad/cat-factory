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
 * Board-level driver deciding which task cards may expand their full pipeline list
 * once zoomed in (the deep `steps`/`subtasks` bands). Two gates, recomputed every
 * frame against live DOM rects so they follow pan / zoom / drag / resize:
 *
 *  - visibility: a task expands only while its card overlaps the board viewport.
 *  - overlap: walking the visible candidates nearest-to-screen-centre first, a task
 *    expands only if its footprint doesn't collide with one already granted, so the
 *    centre-most task wins an overlap and the rest stay compact.
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

    const candidates: { id: string; rect: DOMRect; dist: number }[] = []
    for (const t of board.allTasks) {
      // Only tasks whose run actually has steps would expand a pipeline list.
      if (!(execution.getByBlock(t.id)?.steps.length)) continue
      const rect = rectOf(t.id)
      if (!rect) continue
      // Visibility: the card must intersect the board viewport.
      if (!intersects(rect, view)) continue
      // Stable anchor: the card's top-centre. It doesn't move as the card grows
      // downward, so the ordering can't oscillate as cards expand / collapse.
      const ax = rect.left + rect.width / 2
      const ay = rect.top
      const dist = (ax - cx) ** 2 + (ay - cy) ** 2
      candidates.push({ id: t.id, rect, dist })
    }
    candidates.sort((a, b) => a.dist - b.dist)

    // Greedy by distance to centre: a candidate is granted only if its rect clears
    // every rect already granted, so the centre-most card wins any overlap.
    const claimed: DOMRect[] = []
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
