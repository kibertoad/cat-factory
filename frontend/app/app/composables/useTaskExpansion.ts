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
 * Board-level driver deciding which task cards may expand their full build-pipeline
 * list once zoomed in (the deep `steps`/`subtasks` bands). A single gate, recomputed
 * every frame against live DOM rects so it follows pan / zoom / drag / resize: a task
 * expands only while its card overlaps the board viewport. A task card only renders
 * inside an expanded service frame, so this visibility test also gates it on its
 * parent frame being open.
 *
 * As at the frame level (see `useFrameExpansion`) there is NO overlap/centre-most
 * denial: an expanded card pushes the sibling cards below it down (compressed space —
 * see `useTaskDisplacement`), so cards never have to collapse to avoid piling up, and
 * a card you're navigating no longer "snaps out" as a neighbour drifts toward centre.
 *
 * Writes the permitted id set into the `taskExpansion` store; `TaskPipelineMini` reads
 * it. Only tasks with a running pipeline (steps to show) are candidates — a task that
 * wouldn't expand never needs space reserved for it.
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

    const next = new Set<string>()
    for (const t of board.allTasks) {
      // Only tasks whose run actually has steps would expand a pipeline list.
      if (!execution.getByBlock(t.id)?.steps.length) continue
      const rect = rectOf(t.id)
      if (rect && intersects(rect, view)) next.add(t.id)
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
