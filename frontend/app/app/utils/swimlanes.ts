import type { Block, BlockStatus, ExecutionInstance } from '~/types/domain'

// ---------------------------------------------------------------------------
// The swimlane model: which lane a task belongs in, and WHY.
//
// A service frame lays its tasks out in lanes rather than at hand-placed
// coordinates, so the lane a card sits in is a CLAIM the board makes about that
// task. That raises the bar over a badge: a mislabelled badge is noise beside
// the truth, while a card filed in the wrong lane states something false and
// hides the card from the column its reader was scanning. Two consequences run
// through everything below.
//
// First, the classification is TOTAL. `BASE_REASON_BY_STATUS` is a
// `Record<BlockStatus, …>` so a new block status fails the build until it is
// given a lane, and a status the type says is impossible but the DATABASE still
// holds (a retired picklist member on an old row) resolves to `unclassified`
// rather than to `undefined`, which would drop the card out of every lane with
// nothing left to say it was ever there.
//
// Second, an imprecise reason beats a wrong lane. The SPA models only DECISIONS
// and APPROVALS as global per-block selectors; the other park surfaces (a judge,
// a human-test, a visual confirmation, a fork choice, follow-up triage, the
// pre-dispatch input gate) are reachable only by drilling into a step or
// following a notification. But every one of them parks the RUN at
// `status: 'blocked'`, and that coarse marker is enough to place the card in
// `needs_you` even when this module cannot name which surface is asking. So a
// park it cannot classify is reported as `parked`, never demoted to work in
// flight.
// ---------------------------------------------------------------------------

/**
 * The lanes a frame's tasks are laid out in, in display order.
 *
 * Deliberately four, not the three states of work: `done` exists because a board whose
 * terminal column is missing reads as if finished work evaporated. It is capped (by count
 * and by age, both per-workspace) and collapsed by default, which is what keeps a service
 * that has merged hundreds of tasks cheap to render. See {@link selectDoneLaneTasks}.
 */
export const TASK_LANES = ['not_started', 'in_progress', 'needs_you', 'done'] as const
export type TaskLane = (typeof TASK_LANES)[number]

/**
 * Why a task is in its lane.
 *
 * The lane answers "should I be looking at this"; the reason answers "what would I do".
 * Those are different questions and collapsing them loses the second: `failed`,
 * `budget_paused` and `approval` all stop work dead and need three unrelated actions. So
 * the reason is what the `blocking_reason` grouping splits a lane by, and what a lane
 * header or card states in words.
 */
export const LANE_REASONS = [
  // -- not_started ---------------------------------------------------------
  /** Authored, runnable, nothing has been dispatched against it yet. */
  'unstarted',
  /** Not runnable: at least one dependency has not merged. Starting it is not offered. */
  'dependencies',
  // -- in_progress ---------------------------------------------------------
  /** A run is live. */
  'running',
  /**
   * The run is parked, but on an iterative reviewer mid-cycle (folding answers in,
   * re-reviewing). That is background work needing no human, so it is IN FLIGHT: the
   * board must not ask for an answer nobody is waiting on.
   */
  'background_review',
  // -- needs_you -----------------------------------------------------------
  /** An agent raised a question with options and nobody has chosen. */
  'decision',
  /** A human approval gate is pending. */
  'approval',
  /** The run failed. Nothing advances until someone retries it or fixes the cause. */
  'failed',
  /** The spend budget paused the run. It resumes when the budget is raised. */
  'budget_paused',
  /**
   * The pipeline finished with a pull request still open: the work is done and a human
   * has to land it. Distinct from `pr_ready` mid-run, where CI and the merger are still
   * to come.
   */
  'pr_awaiting_merge',
  /**
   * The run is parked on a human, and which surface is asking is not derivable here (see
   * the module header). A named-but-imprecise wait, never a silent omission.
   */
  'parked',
  /**
   * The task's stored status is not a member of the status vocabulary this build knows.
   * Only reachable from data written by another version, and reported rather than
   * guessed onto a current member: nothing here knows which one was meant.
   */
  'unclassified',
  // -- done ----------------------------------------------------------------
  /** Merged. Terminal. */
  'merged',
] as const
export type LaneReason = (typeof LANE_REASONS)[number]

/**
 * Each reason's lane. Exhaustive, so a new reason cannot be added without deciding which
 * column it is scanned in.
 */
export const LANE_BY_REASON: Record<LaneReason, TaskLane> = {
  unstarted: 'not_started',
  dependencies: 'not_started',
  running: 'in_progress',
  background_review: 'in_progress',
  decision: 'needs_you',
  approval: 'needs_you',
  failed: 'needs_you',
  budget_paused: 'needs_you',
  pr_awaiting_merge: 'needs_you',
  parked: 'needs_you',
  unclassified: 'needs_you',
  merged: 'done',
}

/**
 * The reason a task's OWN status implies, before any run signal refines it.
 *
 * Exhaustive over `BlockStatus`: adding a status fails the typecheck here first. Note
 * `blocked` maps to `parked` rather than to a failure — the status is overloaded across
 * park, failure and terminal-failure (see `STATUS_META` in `utils/catalog.ts`), so the run
 * is what tells those apart and {@link classifyTask} consults it before falling back here.
 */
const BASE_REASON_BY_STATUS: Record<BlockStatus, LaneReason> = {
  planned: 'unstarted',
  ready: 'unstarted',
  in_progress: 'running',
  blocked: 'parked',
  pr_ready: 'running',
  done: 'merged',
}

/**
 * Per-lane presentation. Copy lives in the i18n catalog, so these are KEYS.
 *
 * The colours deliberately reuse the status palette's meanings (`STATUS_META` in
 * `utils/catalog.ts`): slate for not-started, indigo for in-flight, amber for "needs
 * attention", green for done. A lane that coloured itself independently would put an amber
 * card in a lane with a different accent and make the reader arbitrate between two claims.
 */
export const LANE_META: Record<
  TaskLane,
  { labelKey: string; emptyKey: string; icon: string; color: string }
> = {
  not_started: {
    labelKey: 'board.lanes.notStarted.label',
    emptyKey: 'board.lanes.notStarted.empty',
    icon: 'i-lucide-circle-dashed',
    color: '#64748b',
  },
  in_progress: {
    labelKey: 'board.lanes.inProgress.label',
    emptyKey: 'board.lanes.inProgress.empty',
    icon: 'i-lucide-loader',
    color: '#6366f1',
  },
  needs_you: {
    labelKey: 'board.lanes.needsYou.label',
    emptyKey: 'board.lanes.needsYou.empty',
    icon: 'i-lucide-hand',
    color: '#f59e0b',
  },
  done: {
    labelKey: 'board.lanes.done.label',
    emptyKey: 'board.lanes.done.empty',
    icon: 'i-lucide-circle-check',
    color: '#16a34a',
  },
}

/**
 * A short phrase naming each reason, for the card's lane hint and for the header of a
 * `blocking_reason` group. Exhaustive, so a new reason cannot ship with a raw enum member
 * leaking into the UI as its own label.
 */
export const LANE_REASON_LABEL_KEYS: Record<LaneReason, string> = {
  unstarted: 'board.lanes.reason.unstarted',
  dependencies: 'board.lanes.reason.dependencies',
  running: 'board.lanes.reason.running',
  background_review: 'board.lanes.reason.backgroundReview',
  decision: 'board.lanes.reason.decision',
  approval: 'board.lanes.reason.approval',
  failed: 'board.lanes.reason.failed',
  budget_paused: 'board.lanes.reason.budgetPaused',
  pr_awaiting_merge: 'board.lanes.reason.prAwaitingMerge',
  parked: 'board.lanes.reason.parked',
  unclassified: 'board.lanes.reason.unclassified',
  merged: 'board.lanes.reason.merged',
}

/** What {@link classifyTask} needs to know about a task and its run. */
export interface TaskLaneInput {
  /** The task block. */
  readonly status: BlockStatus
  /**
   * The task's current run, or null when there is none (never started) or the store has
   * not hydrated it. Both are legitimately "no live run": a block's `executionId` is
   * never cleared when a run finishes, so its presence proves nothing.
   */
  readonly run: Pick<ExecutionInstance, 'status'> | null
  /**
   * Whether the run FAILED. Read from the `agentRuns` per-block summary rather than from
   * the instance, because that summary also covers a bootstrap run, so a frame-level
   * failure classifies through the same path.
   */
  readonly runFailed: boolean
  /**
   * Whether every park on this run is an iterative reviewer mid-cycle. Computed by the
   * caller through `useReviewStage().isBackground`, which keys off the parked approval's
   * own `agentKind` so an unrelated approval on the same block is never suppressed.
   */
  readonly parkIsBackground: boolean
  /** Whether an agent decision is open on this task. */
  readonly pendingDecision: boolean
  /** Whether a (non-background) human approval gate is pending on this task. */
  readonly pendingApproval: boolean
  /** Whether at least one of the task's dependencies has not merged. */
  readonly hasUnmetDeps: boolean
}

export interface TaskLaneVerdict {
  readonly lane: TaskLane
  readonly reason: LaneReason
}

function verdict(reason: LaneReason): TaskLaneVerdict {
  return { lane: LANE_BY_REASON[reason], reason }
}

/**
 * Place a task in a lane and say why.
 *
 * Precedence, and the reason each step comes where it does:
 *
 * 1. **Merged** wins outright. The block status is the authority because the run that
 *    merged it may already have been pruned, so no run signal can contradict it.
 * 2. **Failure** outranks every park: a failed run has nothing to answer, and what a
 *    human does about it is unrelated to answering a gate.
 * 3. **Budget pause** is a human's call but not a failure — the run is intact and resumes
 *    when the budget is raised. Nothing on the board renders this state today, which is
 *    why a spend-paused task currently reads as if it were still working.
 * 4. **A parked run** is a human wait, whichever surface is asking (module header).
 * 5. **A finished pipeline with an open PR** is a human wait too, and the only one whose
 *    run is already terminal.
 * 6. **A live run** outranks a stale block status: the engine writes the block after the
 *    run advances, so the two disagree for one round trip mid-transition.
 * 7. Otherwise the task's own status decides, refined by whether it can actually start.
 */
export function classifyTask(input: TaskLaneInput): TaskLaneVerdict {
  const { run } = input

  if (input.status === 'done') return verdict('merged')
  if (input.runFailed) return verdict('failed')
  if (run?.status === 'paused') return verdict('budget_paused')

  if (run?.status === 'blocked') {
    if (input.parkIsBackground) return verdict('background_review')
    if (input.pendingDecision) return verdict('decision')
    if (input.pendingApproval) return verdict('approval')
    return verdict('parked')
  }

  if (input.status === 'pr_ready' && (run == null || run.status === 'done')) {
    return verdict('pr_awaiting_merge')
  }

  if (run?.status === 'running') return verdict('running')

  // The cast is deliberate. The Record above is TOTAL against `BlockStatus` and PARTIAL
  // against the rows in the database: a status this build has retired still sits on old
  // blocks, and reading one back would otherwise hand `undefined` to `LANE_BY_REASON` and
  // drop the card out of every lane, with no card left to say a task went missing.
  const base = (BASE_REASON_BY_STATUS as Partial<Record<string, LaneReason>>)[input.status]
  if (base === undefined) return verdict('unclassified')
  if (base === 'unstarted' && input.hasUnmetDeps) return verdict('dependencies')
  return verdict(base)
}

// ---------------------------------------------------------------------------
// The Done lane's two caps
// ---------------------------------------------------------------------------

/** The per-workspace caps bounding what the Done lane renders. */
export interface DoneLaneCaps {
  /** Most cards the lane will render. `0` ⇒ the lane counts its tasks and shows none. */
  readonly maxItems: number
  /**
   * Hide a task that completed more than this many days ago. `null` ⇒ no age cap, so the
   * count cap alone bounds the lane.
   */
  readonly retentionDays: number | null
}

/**
 * What the Done lane renders, plus a full account of what it withheld.
 *
 * Both drop counts are reported separately because the two caps mean different things to
 * a reader: `hiddenByAge` says "this service has older history, look further back if you
 * need it", while `hiddenByCap` says "there is more from this same period". A single
 * "N hidden" would answer neither, and reporting nothing would make a truncated lane read
 * exactly like a complete one.
 */
export interface DoneLaneSelection {
  /** The tasks to render, newest completion first; undated tasks last. */
  readonly shown: Block[]
  /** Completed tasks older than the retention window. */
  readonly hiddenByAge: number
  /** Completed tasks dropped by the count cap after the age filter ran. */
  readonly hiddenByCap: number
  /**
   * How many of {@link shown} carry no completion timestamp. Blocks written before
   * `completedAt` existed have no honest age, and this states how much of the lane is
   * therefore exempt from the age cap rather than letting the cap look total.
   */
  readonly undatedShown: number
  /** Every completed task, before either cap. */
  readonly total: number
}

/**
 * Apply the Done lane's caps.
 *
 * A task with no `completedAt` is EXEMPT from the age cap and sorted last. It is not
 * treated as ancient (which would hide history on the strength of a timestamp nobody
 * recorded) nor as just-completed (which would pin stale rows to the top of the lane
 * forever). It is still subject to the count cap, so the exemption cannot make the lane
 * unbounded, and {@link DoneLaneSelection.undatedShown} states how many there are.
 */
export function selectDoneLaneTasks(
  done: readonly Block[],
  caps: DoneLaneCaps,
  now: number,
): DoneLaneSelection {
  const cutoff = caps.retentionDays == null ? null : now - caps.retentionDays * 86_400_000

  const withinWindow =
    cutoff == null
      ? [...done]
      : done.filter((b) => b.completedAt == null || b.completedAt >= cutoff)
  const hiddenByAge = done.length - withinWindow.length

  // Newest completion first; undated last. `Number.NEGATIVE_INFINITY` is a SORT position,
  // not an age: the age filter above has already run and skipped these rows entirely.
  withinWindow.sort((a, b) => (b.completedAt ?? -Infinity) - (a.completedAt ?? -Infinity))

  const shown = withinWindow.slice(0, Math.max(0, caps.maxItems))
  return {
    shown,
    hiddenByAge,
    hiddenByCap: withinWindow.length - shown.length,
    undatedShown: shown.reduce((n, b) => n + (b.completedAt == null ? 1 : 0), 0),
    total: done.length,
  }
}
