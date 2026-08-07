import type { Block, ExecutionInstance, PipelineStep } from '~/types/domain'
import type { LaneReason, TaskLane } from '~/utils/swimlanes'

// ---------------------------------------------------------------------------
// Ordering and grouping WITHIN a swimlane.
//
// Two rules shape every comparator here.
//
// An UNKNOWN value sorts last, in both directions. A task whose run reported no
// activity timestamp is not "very stale" and not "just active" — it is unknown,
// and ranking it as either end of the scale is the platform inventing a fact it
// does not have. `nullsLast` is the one place that is enforced.
//
// Every comparator ends on the board's own insertion order. Live board events
// re-run these on every push, so a comparator that leaves ties unresolved lets
// equal-ranked cards swap places whenever anything upstream changes, which reads
// as the lane shuffling itself for no reason.
// ---------------------------------------------------------------------------

/**
 * How a lane's cards are ordered.
 *
 * `smart` is the default and is per-lane (see {@link SMART_ORDER_BY_LANE}): the order that
 * is actionable differs by column, and one global key is wrong for at least two of them.
 * The explicit keys exist to override that when a reader is doing something specific
 * (triaging bugs by severity, sweeping a backlog alphabetically).
 */
export const LANE_SORT_KEYS = [
  'smart',
  'title',
  'oldest_activity',
  'newest_activity',
  'longest_wait',
  'severity_desc',
  'impact_desc',
  'task_type',
] as const
export type LaneSortKey = (typeof LANE_SORT_KEYS)[number]

/**
 * How a lane's cards are divided into labelled groups.
 *
 * `module` is the one that replaces a structural affordance: module sub-frames no longer
 * render as boxes on the canvas, so grouping by module is how a service's modules are seen
 * on the board, and a module group header is a drop target for reparenting into it.
 */
export const LANE_GROUP_KEYS = [
  'none',
  'module',
  'task_type',
  'initiative',
  'epic',
  'blocking_reason',
] as const
export type LaneGroupKey = (typeof LANE_GROUP_KEYS)[number]

/**
 * Narrow an untrusted value to a sort/group key.
 *
 * Both are derived from the key lists themselves rather than hand-listed, so retiring a key
 * cannot leave a predicate still admitting it. They exist because the reader's choice is
 * PERSISTED in their browser: a blob written by an older build can name a key this one has
 * dropped, and handing that to the comparator lookup would resolve `undefined` and throw
 * while sorting — taking the whole board down over a stale preference.
 */
export function isLaneSortKey(value: unknown): value is LaneSortKey {
  return (LANE_SORT_KEYS as readonly unknown[]).includes(value)
}

export function isLaneGroupKey(value: unknown): value is LaneGroupKey {
  return (LANE_GROUP_KEYS as readonly unknown[]).includes(value)
}

/** Bug severity, ranked so `critical` sorts first. Absent severity is unknown, not `low`. */
const SEVERITY_RANK: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 }

/**
 * One task, plus everything the comparators and groupers need, resolved once by the caller.
 *
 * Assembled in the component layer (which can reach the stores) and consumed only by the
 * pure functions below, so ordering stays unit-testable without a Pinia instance.
 */
export interface LaneTaskEntry {
  readonly task: Block
  /** Why this task is in its lane, from `classifyTask`. */
  readonly reason: LaneReason
  /** The task's index in its frame's block list: the stable final tiebreak. */
  readonly order: number
  /** Epoch ms of the run's last observed sign of life, or null when not derivable. */
  readonly activityAt: number | null
  /** Epoch ms the task started waiting on a human, or null when not derivable. */
  readonly waitingSince: number | null
  /** The module this task belongs to, by name. Null when it belongs to none. */
  readonly moduleName: string | null
  /** The initiative this task belongs to, by title. Null when it belongs to none. */
  readonly initiativeName: string | null
  /** The epic this task belongs to, by title. Null when it belongs to none. */
  readonly epicName: string | null
}

/**
 * The run's last observed sign of life.
 *
 * `lastActivityAt` is the truthful answer but is only ever stamped on CONTAINER steps by a
 * harness new enough to send heartbeats, so it is absent for inline steps, unpolled steps
 * and older images. `startedAt` is the next best evidence the step is moving, and the run's
 * `createdAt` is the floor. Returns null rather than 0 when none of the three is present:
 * see the module header on why unknown may not be spelled as a number.
 */
export function runActivityAt(
  run: Pick<ExecutionInstance, 'steps' | 'createdAt'> | null,
): number | null {
  if (!run) return null
  let latest: number | null = null
  for (const step of run.steps) {
    for (const stamp of [step.lastActivityAt, step.startedAt]) {
      if (stamp != null && (latest == null || stamp > latest)) latest = stamp
    }
  }
  return latest ?? run.createdAt ?? null
}

/**
 * When the run started waiting on a human.
 *
 * `step.pausedAt` is the engine's own park clock — set once when a step parks on an
 * approval, a raised decision or an iteration-cap gate, and cleared when it resumes — so it
 * is exact where it exists. It is absent until a step has parked at least once, and not
 * every park surface stamps it, which is why this returns null rather than falling back to
 * the run's start: a run that has been ALIVE for three days has not been WAITING for three
 * days, and conflating the two would sort a busy run to the top of the queue.
 *
 * The caller may supply `notificationWaitingSince` — the earliest open review-wait
 * notification for the block, which `collectReviewDebt` already derives in contracts — as
 * an independent second source for the parks that stamp no `pausedAt`.
 */
export function runWaitingSince(
  run: Pick<ExecutionInstance, 'steps'> | null,
  notificationWaitingSince?: number | null,
): number | null {
  const parked = run?.steps.reduce<number | null>((earliest, step: PipelineStep) => {
    const at = step.pausedAt
    if (at == null) return earliest
    return earliest == null || at < earliest ? at : earliest
  }, null)
  return parked ?? notificationWaitingSince ?? null
}

/** Compare two possibly-unknown numbers, always ranking unknown last. */
function nullsLast(a: number | null, b: number | null, cmp: (x: number, y: number) => number) {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  return cmp(a, b)
}

const ascending = (x: number, y: number) => x - y
const descending = (x: number, y: number) => y - x

function severityRank(task: Block): number | null {
  const severity = task.taskTypeFields?.severity
  return severity == null ? null : (SEVERITY_RANK[severity] ?? null)
}

/**
 * How urgently a `needs_you` task's reason reads, lowest first.
 *
 * `failed` and `budget_paused` lead because they are BROKEN rather than queued: no wait
 * clock is running on them (a failure raises no review-wait card and stamps no `pausedAt`),
 * so a pure wait-time order would file them last, behind gates that are merely patient.
 * `unclassified` sits with them because a task the board cannot describe is the one most
 * likely to be silently stuck.
 */
const NEEDS_YOU_TIER: Partial<Record<LaneReason, number>> = {
  failed: 0,
  budget_paused: 0,
  unclassified: 0,
}

type Comparator = (a: LaneTaskEntry, b: LaneTaskEntry) => number

const EXPLICIT_COMPARATORS: Record<Exclude<LaneSortKey, 'smart'>, Comparator> = {
  title: (a, b) => a.task.title.localeCompare(b.task.title),
  oldest_activity: (a, b) => nullsLast(a.activityAt, b.activityAt, ascending),
  newest_activity: (a, b) => nullsLast(a.activityAt, b.activityAt, descending),
  longest_wait: (a, b) => nullsLast(a.waitingSince, b.waitingSince, ascending),
  severity_desc: (a, b) => nullsLast(severityRank(a.task), severityRank(b.task), descending),
  impact_desc: (a, b) =>
    nullsLast(a.task.estimate?.impact ?? null, b.task.estimate?.impact ?? null, descending),
  task_type: (a, b) =>
    (a.task.taskType ?? '').localeCompare(b.task.taskType ?? '') ||
    a.task.title.localeCompare(b.task.title),
}

/**
 * The `smart` order per lane, and why each column wants its own.
 *
 * - **not_started** — what can be started RIGHT NOW, so a task blocked on an unmerged
 *   dependency sinks below one that is ready. Within each half, board order: the author's
 *   own sequence is the best available statement of intent for work nothing has touched.
 * - **in_progress** — quietest first. A healthy run needs nothing from anyone; the reason
 *   to look at this column at all is to find the run that has stopped making noise.
 * - **needs_you** — broken things first (see {@link NEEDS_YOU_TIER}), then longest wait, so
 *   the queue is fair and the escalation the workspace already applies to a waiting
 *   notification is reflected in the order.
 * - **done** — newest completion first; recency is the only useful order for an archive
 *   (and `selectDoneLaneTasks` has already sorted on it).
 */
export const SMART_ORDER_BY_LANE: Record<TaskLane, Comparator> = {
  not_started: (a, b) => Number(a.reason === 'dependencies') - Number(b.reason === 'dependencies'),
  in_progress: (a, b) => nullsLast(a.activityAt, b.activityAt, ascending),
  needs_you: (a, b) =>
    (NEEDS_YOU_TIER[a.reason] ?? 1) - (NEEDS_YOU_TIER[b.reason] ?? 1) ||
    nullsLast(a.waitingSince, b.waitingSince, ascending),
  done: (a, b) => nullsLast(a.task.completedAt ?? null, b.task.completedAt ?? null, descending),
}

/**
 * Order a lane's entries. Non-mutating.
 *
 * Every key ends on `order`, so the result is fully determined and a live board event
 * cannot make equal-ranked cards trade places.
 */
export function sortLaneTasks(
  entries: readonly LaneTaskEntry[],
  key: LaneSortKey,
  lane: TaskLane,
): LaneTaskEntry[] {
  const primary = key === 'smart' ? SMART_ORDER_BY_LANE[lane] : EXPLICIT_COMPARATORS[key]
  return [...entries].sort((a, b) => primary(a, b) || a.order - b.order)
}

/** One labelled run of cards inside a lane. */
export interface LaneGroup {
  /**
   * Stable identity for the `v-for` key and, when grouping by `module`, the module BLOCK's
   * id — which is what makes the header a drop target. Null for the catch-all group.
   */
  readonly id: string | null
  /** Null ⇒ the catch-all group ("no module", "not in an initiative", …). */
  readonly label: string | null
  readonly entries: LaneTaskEntry[]
}

/**
 * The value a task is grouped under, or null for the catch-all group.
 *
 * `module` reads the module NAME rather than the parent block id because a task declares
 * its module (`moduleName`) long before the module block exists: the engine materialises
 * that block lazily, on merge (`PostMergeBoardController.applyModuleAssignment`). Keying on
 * the parent alone would leave every unmerged task in "no module" while the board shows the
 * module it is destined for, so grouping would appear to ignore what the author wrote.
 */
function groupLabelOf(entry: LaneTaskEntry, key: Exclude<LaneGroupKey, 'none'>): string | null {
  switch (key) {
    case 'module':
      return entry.moduleName
    case 'task_type':
      return entry.task.taskType ?? null
    case 'initiative':
      return entry.initiativeName
    case 'epic':
      return entry.epicName
    case 'blocking_reason':
      return entry.reason
  }
}

/**
 * Divide a lane's (already ordered) entries into groups, preserving that order both within
 * each group and between groups: a group appears where its first member does, so the sort
 * key still governs what a reader meets first. The catch-all group is forced last, because
 * "everything else" reading before a named group inverts the hierarchy the grouping states.
 *
 * `moduleBlockIdByName` maps a module name to the block id that materialises it, so a
 * module group header can act as a reparent drop zone. A module that has no block yet is
 * still grouped and labelled; it simply is not a drop target.
 */
export function groupLaneTasks(
  ordered: readonly LaneTaskEntry[],
  key: LaneGroupKey,
  moduleBlockIdByName?: ReadonlyMap<string, string>,
): LaneGroup[] {
  if (key === 'none') return [{ id: null, label: null, entries: [...ordered] }]

  const byLabel = new Map<string, LaneTaskEntry[]>()
  const catchAll: LaneTaskEntry[] = []
  for (const entry of ordered) {
    const label = groupLabelOf(entry, key)
    if (label == null) {
      catchAll.push(entry)
      continue
    }
    const bucket = byLabel.get(label)
    if (bucket) bucket.push(entry)
    else byLabel.set(label, [entry])
  }

  const groups: LaneGroup[] = [...byLabel].map(([label, entries]) => ({
    id: key === 'module' ? (moduleBlockIdByName?.get(label) ?? null) : label,
    label,
    entries,
  }))
  if (catchAll.length > 0) groups.push({ id: null, label: null, entries: catchAll })
  return groups
}
