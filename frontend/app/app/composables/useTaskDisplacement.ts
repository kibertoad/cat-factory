import { computed, type Ref } from 'vue'
import type { Block } from '~/types/domain'
import { computeDisplacement } from '~/utils/boardDisplacement'
import { lodAtLeast } from '~/composables/useSemanticZoom'

// Nominal collapsed footprint of a task card, in flow units. The width is fixed
// (`w-[180px]` in DraggableTask); the height is the layout slot the board reserves
// per task (`TASK_H` in useBlockQueries.contentSize), which is what decides whether
// a sibling counts as "below" this card.
const TASK_W = 180
const TASK_SLOT_H = 160

// Rough heights of the pipeline list that appears below an expanded task card, in
// flow units. Over-estimated a little so a card always reserves at least as much
// room as it actually grows into (over-reserving only adds spacing; under-reserving
// would let the list overlap the card below).
const LIST_HEADER = 24
const STEP_ROW = 28
const ITEM_ROW = 14

/**
 * Compressed space for the task cards inside one container (a service's drop zone or
 * a module's). When a card expands its build-pipeline list (deep zoom), it grows
 * downward and would pile onto the cards beneath it. This pushes those cards down by
 * the list's height instead, so an expanded card never overlaps a sibling it wasn't
 * already overlapping and a card stays open while you pan across it. Render-only: the
 * stored task positions are untouched (the returned `dy` is added to the card's `top`).
 */
export function useTaskDisplacement(tasks: Ref<Block[]>) {
  const expansion = useTaskExpansionStore()
  const execution = useExecutionStore()
  const ui = useUiStore()

  /** Estimated height the expanded pipeline list adds below a task card. */
  function growY(id: string): number {
    const steps = execution.getByBlock(id)?.steps ?? []
    if (!steps.length) return 0
    let h = LIST_HEADER + steps.length * STEP_ROW
    if (lodAtLeast(ui.lod, 'subtasks')) {
      for (const s of steps) h += (s.subtasks?.items?.length ?? 0) * ITEM_ROW
    }
    return h
  }

  const offsets = computed(() => {
    const stepsBand = lodAtLeast(ui.lod, 'steps')
    const boxes = tasks.value.map((t) => {
      // Mirror TaskPipelineMini.showSteps: expanded only at the steps band, with
      // steps to show, and permitted by the board driver.
      const expanded =
        stepsBand &&
        (execution.getByBlock(t.id)?.steps.length ?? 0) > 0 &&
        expansion.canExpand(t.id)
      return {
        id: t.id,
        x: t.position.x,
        y: t.position.y,
        w: TASK_W,
        h: TASK_SLOT_H,
        growX: 0,
        growY: expanded ? growY(t.id) : 0,
      }
    })
    return computeDisplacement(boxes)
  })

  function dyOf(id: string): number {
    return offsets.value.get(id)?.dy ?? 0
  }

  return { dyOf }
}
