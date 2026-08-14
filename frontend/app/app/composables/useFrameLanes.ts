import { computed, type Ref } from 'vue'
import type { Block } from '~/types/domain'
import { createLaneMemo } from '~/utils/laneIdentity'
import {
  groupLaneTasks,
  runActivityAt,
  runWaitingSince,
  sortLaneTasks,
  type LaneTaskEntry,
  type RenderedLane,
} from '~/utils/laneSort'
import {
  classifyTask,
  selectDoneLaneTasks,
  TASK_LANES,
  type DoneLaneSelection,
  type TaskLane,
} from '~/utils/swimlanes'

/** A lane entry plus the lane it was classified into. */
interface ClassifiedEntry {
  readonly entry: LaneTaskEntry
  readonly lane: TaskLane
}

/**
 * Assemble a service frame's tasks into swimlanes.
 *
 * This is the store-facing half of the lane model: it resolves every input the pure
 * `classifyTask` / `sortLaneTasks` / `groupLaneTasks` functions need and nothing more, so the
 * classification and ordering rules stay testable without a Pinia instance. It also keeps the
 * per-frame cost linear in the frame's tasks: every cross-block lookup below is a Map read off
 * an index the stores already maintain, never a scan per task.
 */
export function useFrameLanes(frameId: Ref<string>) {
  const board = useBoardStore()
  const execution = useExecutionStore()
  const agentRuns = useAgentRunsStore()
  const notifications = useNotificationsStore()
  const settings = useWorkspaceSettingsStore()
  const laneView = useLaneViewStore()
  const reviews = useReviewStage()

  /** Tasks directly in the frame plus those inside its modules: a module renders no box now. */
  const tasks = computed(() => board.allTasksUnder(frameId.value))

  /** Module name → the module BLOCK that materialises it, so a group header can be a drop zone. */
  const moduleBlockIdByName = computed(
    () => new Map(board.modulesOf(frameId.value).map((m) => [m.title, m.id])),
  )

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

  /**
   * One task's lane, reason and rendered entry.
   *
   * Every cross-block lookup here is a Map read off an index a STORE maintains, never a reduction
   * of its own: this composable runs ONE INSTANCE PER MOUNTED FRAME, so deriving a workspace-wide
   * fact here makes a board with n frames pay for it n times on every change. The review-debt map
   * (`notifications.reviewDebtByBlock`) is the worked example: a reduction over the whole
   * workspace's open notifications, and it belongs on the store that owns its input. The rule for
   * anything else this assembly needs: a per-FRAME derivation belongs here, a workspace-wide one
   * belongs on that store.
   */
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

  /** Every task bucketed by lane, in board order, before sorting. */
  const byLane = computed(() => {
    const buckets = new Map<TaskLane, LaneTaskEntry[]>(TASK_LANES.map((lane) => [lane, []]))
    tasks.value.forEach((task, order) => {
      const { lane, entry } = classify(task, order)
      buckets.get(lane)!.push(entry)
    })
    return buckets
  })

  /**
   * What the Done lane renders, and a full account of what it withheld.
   *
   * Computed even while the lane is collapsed, because the collapsed header states the TOTAL:
   * "this service has finished 312 tasks" is the fact the lane exists to carry, and a header
   * counting only what it happens to render would understate it by two orders of magnitude.
   *
   * `Date.now()` is read non-reactively, as `useReviewDebt` does. The cutoff is re-evaluated
   * whenever the board, the runs or the settings change, which on a live board is constantly; a
   * ticking clock purely so a card could vanish mid-session would be motion nobody asked for.
   */
  const doneSelection = computed<DoneLaneSelection>(() =>
    selectDoneLaneTasks(
      (byLane.value.get('done') ?? []).map((e) => e.task),
      {
        maxItems: settings.settings.doneLaneMaxItems,
        retentionDays: settings.settings.doneLaneRetentionDays,
      },
      Date.now(),
    ),
  )

  /**
   * Identity preservation for the assembled output, so an event that changed nothing in a lane
   * hands `TaskLane`/`LaneGroup` the SAME objects it had and their diffs short-circuit on `===`.
   * Every execution event invalidates this whole chain for every mounted frame, and most of them
   * (a subtask tick, a progress fold) move no card at all. See `utils/laneIdentity.ts`.
   */
  const shareLanes = createLaneMemo()

  const lanes = computed<RenderedLane[]>(() =>
    shareLanes(
      TASK_LANES.map((lane) => {
        const bucket = byLane.value.get(lane) ?? []
        // Only the Done lane is capped; every other lane renders everything in it.
        const visible = lane === 'done' ? admittedByCaps(bucket, doneSelection.value) : bucket
        const ordered = sortLaneTasks(visible, laneView.sortKey, lane)
        return {
          lane,
          groups: groupLaneTasks(ordered, laneView.groupKey, moduleBlockIdByName.value),
          total: bucket.length,
        }
      }),
    ),
  )

  return { lanes, doneSelection }
}

/** The entries whose task survived the Done lane's caps. */
function admittedByCaps(entries: LaneTaskEntry[], selection: DoneLaneSelection): LaneTaskEntry[] {
  const admitted = new Set(selection.shown.map((task) => task.id))
  return entries.filter((e) => admitted.has(e.task.id))
}
