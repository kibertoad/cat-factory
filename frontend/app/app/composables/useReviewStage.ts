import { useRequirementsStore } from '~/stores/requirements'
import { useClarityStore } from '~/stores/clarity'

/** The async stage an iterative reviewer gate is mid-cycle in, or null. */
export type ReviewStage = 'incorporating' | 'reviewing' | null

// Both iterative reviewer gates (`requirements-review` over a feature brief and
// `clarity-review` over a bug report) drive the same answer → incorporate → re-review
// loop, and while a review is folding answers / re-reviewing in the durable driver it
// needs NO human — so its parked approval must be SUPPRESSED on the board/inspector and a
// working indicator shown instead. This composable maps a review gate to the store that
// tracks its loop, so the board surfaces (BlockNode / TaskCard / TaskExecution) handle
// both review kinds through one helper rather than special-casing each kind separately.

export function useReviewStage() {
  const requirements = useRequirementsStore()
  const clarity = useClarityStore()

  /**
   * The background stage for a block regardless of which review kind drives it. A task is
   * either a feature task (requirements review) or a bug task (clarity review), so at most
   * one store has a live stage for it.
   */
  function stageForBlock(blockId: string): ReviewStage {
    return requirements.backgroundStage(blockId) ?? clarity.backgroundStage(blockId)
  }

  /**
   * Whether a specific review-gate approval is mid-cycle background work — keyed off the
   * approval's own `agentKind` so a non-review approval on the same block is never
   * suppressed by a coincidental review stage.
   */
  function isBackground(agentKind: string | undefined, blockId: string): boolean {
    if (agentKind === 'requirements-review') return requirements.backgroundStage(blockId) != null
    if (agentKind === 'clarity-review') return clarity.backgroundStage(blockId) != null
    return false
  }

  return { stageForBlock, isBackground }
}
