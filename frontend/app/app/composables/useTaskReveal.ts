import { useFramePlacement } from '~/composables/useFramePlacement'
import { useBoardStore } from '~/stores/board'
import { useUiStore } from '~/stores/ui'
import { useWorkViewStore } from '~/stores/workView'

/**
 * Bring a task in front of the person: the canvas rather than the queue, the task selected, and
 * the camera centred on its card at the zoom where its pipeline steps render. What the queue's
 * "show on board" does, and what a deep link naming a task does.
 */
export function useTaskReveal() {
  const board = useBoardStore()
  const ui = useUiStore()
  const views = useWorkViewStore()
  const { focusTaskWhenRendered } = useFramePlacement()

  function revealTask(taskId: string): void {
    views.show('board')
    ui.select(taskId)
    const task = board.getBlock(taskId)
    if (!task) return
    void focusTaskWhenRendered(taskId, board.serviceOf(task)?.id ?? taskId)
  }

  return { revealTask }
}
