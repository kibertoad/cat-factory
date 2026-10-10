import { computed, type Ref } from 'vue'
import { createLaneMemo } from '~/utils/laneIdentity'
import {
  groupLaneTasks,
  sortLaneTasks,
  type LaneTaskEntry,
  type RenderedLane,
} from '~/utils/laneSort'
import { useTaskLaneClassifier } from '~/composables/useTaskLaneClassifier'
import {
  selectDoneLaneTasks,
  TASK_LANES,
  type DoneLaneSelection,
  type TaskLane,
} from '~/utils/swimlanes'

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
  const settings = useWorkspaceSettingsStore()
  const laneView = useLaneViewStore()
  const { classify } = useTaskLaneClassifier()

  /** Tasks directly in the frame plus those inside its modules: a module renders no box now. */
  const tasks = computed(() => board.allTasksUnder(frameId.value))

  /** Module name → the module BLOCK that materialises it, so a group header can be a drop zone. */
  const moduleBlockIdByName = computed(
    () => new Map(board.modulesOf(frameId.value).map((m) => [m.title, m.id])),
  )

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
