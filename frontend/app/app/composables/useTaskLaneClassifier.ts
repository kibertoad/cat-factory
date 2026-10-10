import type { Block } from '~/types/domain'
import { runActivityAt, runWaitingSince, type LaneTaskEntry } from '~/utils/laneSort'
import { classifyTask, type TaskLane } from '~/utils/swimlanes'

/** A lane entry plus the lane it was classified into. */
export interface ClassifiedEntry {
  readonly entry: LaneTaskEntry
  readonly lane: TaskLane
}

/**
 * The store-facing half of `classifyTask`: resolve one task's lane, reason and rendered entry.
 *
 * Shared by the two surfaces that lay tasks out in lanes, a service frame's swimlanes
 * (`useFrameLanes`) and the workspace-wide queue (`useWorkspaceQueue`), so both state the SAME
 * claim about a task. A card in "Needs you" on the board and in "In flight" in the queue would
 * make the reader arbitrate between two answers to one question.
 *
 * Every cross-block lookup here is a Map read off an index a STORE maintains, never a reduction
 * of its own: `useFrameLanes` runs one instance per mounted frame, so deriving a workspace-wide
 * fact here makes a board with n frames pay for it n times on every change. The review-debt map
 * (`notifications.reviewDebtByBlock`) is the worked example: a reduction over the whole
 * workspace's open notifications, and it belongs on the store that owns its input.
 */
export function useTaskLaneClassifier() {
  const board = useBoardStore()
  const execution = useExecutionStore()
  const agentRuns = useAgentRunsStore()
  const notifications = useNotificationsStore()
  const reviews = useReviewStage()

  /**
   * The module a task belongs to: the module BLOCK's title when it already lives in one, else
   * the module it DECLARES. The engine only materialises the block on merge
   * (`applyModuleAssignment`), so keying on the parent alone would leave every unmerged task in
   * "no module" while its own card names one.
   */
  function moduleNameOf(task: Block): string | null {
    const parent = task.parentId ? board.getBlock(task.parentId) : undefined
    if (parent?.level === 'module') return parent.title
    return task.moduleName?.trim() || null
  }

  /** One task's lane, reason and rendered entry. `order` is the caller's stable tiebreak. */
  function classify(task: Block, order: number): ClassifiedEntry {
    const run = execution.getByBlock(task.id) ?? null
    const decisions = execution.decisionsByBlock.get(task.id) ?? []
    const allApprovals = execution.approvalsByBlock.get(task.id) ?? []
    // The same suppression the card and the frame badge apply: an iterative reviewer mid-cycle
    // holds a pending approval while the driver folds answers in, and nobody is waiting on it.
    const humanApprovals = allApprovals.filter((a) => !reviews.isBackground(a.agentKind, a.blockId))

    const { lane, reason } = classifyTask({
      status: task.status,
      // Read from the coarse per-block summary, which also covers a bootstrap run.
      runFailed: agentRuns.byBlock[task.id]?.status === 'failed',
      run,
      // A park is background exactly when everything asking was suppressed AND nothing else
      // asks. With no approvals at all it is NOT background: it is a park on a surface this
      // layer cannot name, which `classifyTask` reports as `parked` rather than as work.
      parkIsBackground:
        decisions.length === 0 &&
        humanApprovals.length === 0 &&
        allApprovals.length > humanApprovals.length,
      pendingDecision: decisions.length > 0,
      pendingApproval: humanApprovals.length > 0,
      hasUnmetDeps: board.unmetDeps(task.id).length > 0,
    })

    return {
      lane,
      entry: {
        task,
        reason,
        order,
        activityAt: runActivityAt(run),
        waitingSince: runWaitingSince(run, notifications.reviewDebtByBlock.get(task.id) ?? null),
        moduleName: moduleNameOf(task),
        initiativeName: task.initiativeId
          ? (board.getBlock(task.initiativeId)?.title ?? null)
          : null,
        epicName: board.epicOf(task)?.title ?? null,
      },
    }
  }

  return { classify }
}
