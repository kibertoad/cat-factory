import { describe, expect, it } from 'vitest'
import type { Block } from '~/types/domain'
import { LANE_BY_REASON, LANE_REASONS, type LaneReason } from '~/utils/swimlanes'
import {
  assembleQueue,
  QUEUE_DONE_MAX_ITEMS,
  QUEUE_DONE_WINDOW_DAYS,
  QUEUE_SECTION_BY_REASON,
  type QueueEntry,
} from '~/utils/queueSections'

// The queue reads the frame lanes' verdict and must never contradict it. The one place it
// splits differently (a PR waiting to merge gets its own column) is a regrouping INSIDE the
// frame's `needs_you` lane, never a move across lanes.

const NOW = 1_800_000_000_000
const DAY = 86_400_000

function entry(id: string, reason: LaneReason, overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    task: { id, title: id, status: 'ready', level: 'task' } as Block,
    reason,
    order: 0,
    activityAt: null,
    waitingSince: null,
    moduleName: null,
    initiativeName: null,
    epicName: null,
    service: { id: 'svc', title: 'Service' },
    ...overrides,
  }
}

describe('QUEUE_SECTION_BY_REASON', () => {
  it('files every reason, and never across the lane the frame put it in', () => {
    const laneOfSection = {
      needs_you: 'needs_you',
      ready_to_merge: 'needs_you',
      in_flight: 'in_progress',
      waiting: 'not_started',
      done: 'done',
    } as const
    for (const reason of LANE_REASONS) {
      expect(laneOfSection[QUEUE_SECTION_BY_REASON[reason]], reason).toBe(LANE_BY_REASON[reason])
    }
  })
})

describe('assembleQueue', () => {
  it('puts a decision, a failure and a parked run in Needs you, and a waiting PR beside it', () => {
    const { sections } = assembleQueue(
      [
        entry('decide', 'decision'),
        entry('broken', 'failed'),
        entry('parked', 'parked'),
        entry('pr', 'pr_awaiting_merge'),
      ],
      NOW,
    )
    expect(sections.needs_you.map((e) => e.task.id).sort()).toEqual(['broken', 'decide', 'parked'])
    expect(sections.ready_to_merge.map((e) => e.task.id)).toEqual(['pr'])
  })

  it('orders Needs you as the frame lane does: broken first, then the longest wait', () => {
    const { sections } = assembleQueue(
      [
        entry('recent', 'decision', { waitingSince: NOW - 1000, order: 0 }),
        entry('old', 'decision', { waitingSince: NOW - 5000, order: 1 }),
        entry('broken', 'failed', { order: 2 }),
      ],
      NOW,
    )
    expect(sections.needs_you.map((e) => e.task.id)).toEqual(['broken', 'old', 'recent'])
  })

  it('lists only merges inside the window, newest first, and counts the undated ones apart', () => {
    const merged = (id: string, completedAt: number | undefined) =>
      entry(id, 'merged', {
        task: { id, title: id, status: 'done', level: 'task', completedAt } as Block,
      })
    const queue = assembleQueue(
      [
        merged('yesterday', NOW - DAY),
        merged('today', NOW - 1000),
        merged('ancient', NOW - (QUEUE_DONE_WINDOW_DAYS + 1) * DAY),
        merged('undated', undefined),
      ],
      NOW,
    )
    expect(queue.sections.done.map((e) => e.task.id)).toEqual(['today', 'yesterday'])
    expect(queue.doneInWindow).toBe(2)
    expect(queue.doneUndated).toBe(1)
  })

  it('caps the Done list but never the count above it', () => {
    const many = Array.from({ length: QUEUE_DONE_MAX_ITEMS + 3 }, (_, i) =>
      entry(`m${i}`, 'merged', {
        order: i,
        task: {
          id: `m${i}`,
          title: '',
          status: 'done',
          level: 'task',
          completedAt: NOW - i,
        } as Block,
      }),
    )
    const queue = assembleQueue(many, NOW)
    expect(queue.sections.done).toHaveLength(QUEUE_DONE_MAX_ITEMS)
    expect(queue.doneInWindow).toBe(many.length)
  })
})
