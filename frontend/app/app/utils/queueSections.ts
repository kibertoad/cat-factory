import type { Block } from '~/types/domain'
import { sortLaneTasks, type LaneTaskEntry } from '~/utils/laneSort'
import {
  selectDoneLaneTasks,
  type DoneLaneCaps,
  type LaneReason,
  type TaskLane,
} from '~/utils/swimlanes'

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
 * to look at first. Done takes the Done lane's own selection and order (below).
 */
const SORT_LANE_BY_SECTION: Record<Exclude<QueueSection, 'done'>, TaskLane> = {
  needs_you: 'needs_you',
  in_flight: 'in_progress',
  waiting: 'not_started',
  ready_to_merge: 'needs_you',
}

/** One queue entry: the lane entry plus the service the task belongs to. */
export interface QueueEntry extends LaneTaskEntry {
  /** The enclosing service frame, or null for a task the board holds outside any service. */
  readonly service: Pick<Block, 'id' | 'title'> | null
}

/** The assembled queue. */
export interface QueueAssembly {
  readonly sections: Record<QueueSection, QueueEntry[]>
  /** Every merged task inside the retention window, before the item cap. */
  readonly doneInWindow: number
}

/**
 * Bucket and order classified entries into queue sections. Pure, so the ordering rules are
 * testable without a Pinia instance.
 *
 * The Done section is the frames' Done lane over every service: the same selection
 * (`selectDoneLaneTasks`) under the same workspace caps, so the queue and a frame never disagree
 * about which merges are recent.
 */
export function assembleQueue(
  entries: readonly QueueEntry[],
  now: number,
  doneCaps: DoneLaneCaps,
): QueueAssembly {
  const sections = Object.fromEntries(QUEUE_SECTIONS.map((s) => [s, [] as QueueEntry[]])) as Record<
    QueueSection,
    QueueEntry[]
  >
  for (const entry of entries) sections[QUEUE_SECTION_BY_REASON[entry.reason]].push(entry)

  const byId = new Map(sections.done.map((e) => [e.task.id, e]))
  const done = selectDoneLaneTasks(
    sections.done.map((e) => e.task),
    doneCaps,
    now,
  )

  for (const section of QUEUE_SECTIONS) {
    if (section === 'done') continue
    sections[section] = sortLaneTasks(
      sections[section],
      'smart',
      SORT_LANE_BY_SECTION[section],
    ) as QueueEntry[]
  }
  // Newest completion first, as the frame's Done lane orders it.
  sections.done = done.shown.map((task) => byId.get(task.id)!)

  return { sections, doneInWindow: done.shown.length + done.hiddenByCap }
}
