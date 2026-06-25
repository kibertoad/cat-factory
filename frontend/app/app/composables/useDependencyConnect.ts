import { ref } from 'vue'

/**
 * Drag-to-connect for board dependencies. A small connector handle on a task card calls
 * {@link start} on pointerdown; we then track the pointer (a live preview line drawn by
 * `DependencyConnectOverlay`) and, on release over another task card, create the edge
 * "dropped-on dependsOn dragged-from" — i.e. you drag from the prerequisite onto the task
 * that should wait for it. Module-level state so the handle and the overlay share one drag.
 *
 * Coordinates are client (screen) space, so the overlay is a fixed full-viewport SVG and
 * the gesture follows pan/zoom for free (the cards move under the cursor, the line tracks
 * the cursor). Target resolution uses `elementFromPoint` → nearest `[data-block-id]`.
 */
export interface ConnectState {
  sourceId: string
  x1: number
  y1: number
  x2: number
  y2: number
}

const connecting = ref<ConnectState | null>(null)

export function useDependencyConnect() {
  const board = useBoardStore()

  function onMove(ev: PointerEvent) {
    if (!connecting.value) return
    connecting.value.x2 = ev.clientX
    connecting.value.y2 = ev.clientY
  }

  async function onUp(ev: PointerEvent) {
    const state = connecting.value
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    connecting.value = null
    if (!state) return
    // Resolve the task under the cursor on release.
    const el = document.elementFromPoint(ev.clientX, ev.clientY)
    const card = el?.closest('[data-block-id]') as HTMLElement | null
    const targetId = card?.getAttribute('data-block-id') ?? null
    if (!targetId || targetId === state.sourceId) return
    const target = board.getBlock(targetId)
    const source = board.getBlock(state.sourceId)
    if (!target || target.level !== 'task' || !source || source.level !== 'task') return
    // Dropped-on task depends on the dragged-from (prerequisite) task.
    await board.toggleDependency(targetId, state.sourceId)
  }

  /** Begin a connect drag from `sourceId`'s handle. */
  function start(sourceId: string, ev: PointerEvent) {
    ev.preventDefault()
    ev.stopPropagation()
    connecting.value = { sourceId, x1: ev.clientX, y1: ev.clientY, x2: ev.clientX, y2: ev.clientY }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return { connecting, start }
}
