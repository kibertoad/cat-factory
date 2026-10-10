import type { Block } from '~/types/domain'
import { sortLaneTasks, type LaneTaskEntry } from '~/utils/laneSort'
import type { LaneReason, TaskLane } from '~/utils/swimlanes'

// ---------------------------------------------------------------------------
// The workspace queue: the swimlane model lifted out of the service frames.
//
// A frame's lanes answer "what is the state of THIS service". The queue answers "what needs
// me, across every service", which is the question a person asks first when they open the
// app. It reads the SAME `classifyTask` verdict the frame does (see
// `useTaskLaneClassifier`), so a task never sits in one column here and another lane there.
//
// It splits the verdict differently in one place, on purpose: a pull request waiting to be
// merged is in the frame's `needs_you` lane, and here it has its own column. Answering a
// decision and landing a finished change are different jobs done at different moments (one
// unblocks an agent within minutes, the other is a review session), and a single column that
// mixed them would put "merge this" between two questions an agent is parked on.
// ---------------------------------------------------------------------------

/** The queue's sections, in reading order. */
export const QUEUE_SECTIONS = [
  'needs_you',
  'in_flight',
  'waiting',
  'ready_to_merge',
  'done',
] as const
export type QueueSection = (typeof QUEUE_SECTIONS)[number]

/**
 * Each lane reason's queue section. Exhaustive, so a new reason cannot ship without deciding
 * where the queue files it.
 */
export const QUEUE_SECTION_BY_REASON: Record<LaneReason, QueueSection> = {
  unstarted: 'waiting',
  dependencies: 'waiting',
  running: 'in_flight',
  background_review: 'in_flight',
  decision: 'needs_you',
  approval: 'needs_you',
  failed: 'needs_you',
  budget_paused: 'needs_you',
  parked: 'needs_you',
  unclassified: 'needs_you',
  pr_awaiting_merge: 'ready_to_merge',
  merged: 'done',
}

/**
 * The frame lane whose `smart` order each section borrows. The queue adds no comparator of its
 * own: an order that differed from the frame's would make the two surfaces disagree about what
 * to look at first.
 */
const SORT_LANE_BY_SECTION: Record<QueueSection, TaskLane> = {
  needs_you: 'needs_you',
  in_flight: 'in_progress',
  waiting: 'not_started',
  ready_to_merge: 'needs_you',
  done: 'done',
}

/** How far back the Done section reaches. The queue is about now, not the archive. */
export const QUEUE_DONE_WINDOW_DAYS = 7
/** Most merged tasks the Done section lists when opened. The count above it is never capped. */
export const QUEUE_DONE_MAX_ITEMS = 20

/** One queue entry: the lane entry plus the service the task belongs to. */
export interface QueueEntry extends LaneTaskEntry {
  /** The enclosing service frame, or null for a task the board holds outside any service. */
  readonly service: Pick<Block, 'id' | 'title'> | null
}

/** The assembled queue. */
export interface QueueAssembly {
  readonly sections: Record<QueueSection, QueueEntry[]>
  /** Every merged task inside the window, before {@link QUEUE_DONE_MAX_ITEMS}. */
  readonly doneInWindow: number
  /**
   * Merged tasks with no `completedAt`. They have no honest age, so the window cannot place
   * them; they are counted here and left out of the section rather than guessed into it.
   */
  readonly doneUndated: number
}

/**
 * Bucket and order classified entries into queue sections. Pure, so the ordering rules are
 * testable without a Pinia instance.
 */
export function assembleQueue(entries: readonly QueueEntry[], now: number): QueueAssembly {
  const sections = Object.fromEntries(QUEUE_SECTIONS.map((s) => [s, [] as QueueEntry[]])) as Record<
    QueueSection,
    QueueEntry[]
  >
  for (const entry of entries) sections[QUEUE_SECTION_BY_REASON[entry.reason]].push(entry)

  const cutoff = now - QUEUE_DONE_WINDOW_DAYS * 86_400_000
  const merged = sections.done
  const inWindow = merged.filter((e) => e.task.completedAt != null && e.task.completedAt >= cutoff)

  for (const section of QUEUE_SECTIONS) {
    const pool = section === 'done' ? inWindow : sections[section]
    const ordered = sortLaneTasks(pool, 'smart', SORT_LANE_BY_SECTION[section]) as QueueEntry[]
    sections[section] = section === 'done' ? ordered.slice(0, QUEUE_DONE_MAX_ITEMS) : ordered
  }

  return {
    sections,
    doneInWindow: inWindow.length,
    doneUndated: merged.filter((e) => e.task.completedAt == null).length,
  }
}
