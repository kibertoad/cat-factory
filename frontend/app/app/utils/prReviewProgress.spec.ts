import { describe, it, expect } from 'vitest'
import type { PrReviewStepState, StepSubtasks } from '~/types/execution'
import {
  activeChunkLabels,
  chunkReviewPercent,
  isSlicingChunks,
  prReviewPhase,
} from './prReviewProgress'

const subtasks = (over: Partial<StepSubtasks>): StepSubtasks => ({
  completed: 0,
  inProgress: 0,
  total: 0,
  ...over,
})

describe('isSlicingChunks', () => {
  it('is slicing when there is no todo list yet (null/undefined or empty)', () => {
    // No plan committed → the reviewer is still grouping the diff into chunks.
    expect(isSlicingChunks(null)).toBe(true)
    expect(isSlicingChunks(undefined)).toBe(true)
    expect(isSlicingChunks(subtasks({ total: 0 }))).toBe(true)
  })

  it('is not slicing once the todo list exists (slicing is done)', () => {
    expect(isSlicingChunks(subtasks({ total: 3, completed: 1 }))).toBe(false)
    // A single-chunk plan still counts as sliced — a plan of size 1 is a committed plan.
    expect(isSlicingChunks(subtasks({ total: 1 }))).toBe(false)
  })
})

describe('chunkReviewPercent', () => {
  it('is 0 with no plan (avoids 0/0 → NaN)', () => {
    expect(chunkReviewPercent(null)).toBe(0)
    expect(chunkReviewPercent(subtasks({ total: 0, completed: 0 }))).toBe(0)
  })

  it('rounds completion to an integer percent', () => {
    expect(chunkReviewPercent(subtasks({ total: 4, completed: 1 }))).toBe(25)
    // 1/3 → 33.33… rounds to 33 (the old inline math emitted a fractional width).
    expect(chunkReviewPercent(subtasks({ total: 3, completed: 1 }))).toBe(33)
  })

  it('clamps to 0..100 even if counts are inconsistent', () => {
    expect(chunkReviewPercent(subtasks({ total: 2, completed: 5 }))).toBe(100)
    expect(chunkReviewPercent(subtasks({ total: 2, completed: -1 }))).toBe(0)
  })
})

describe('activeChunkLabels', () => {
  it('returns only the in-progress chunk labels, in order', () => {
    const s = subtasks({
      total: 3,
      completed: 1,
      inProgress: 1,
      items: [
        { label: 'auth', status: 'completed' },
        { label: 'db layer', status: 'in_progress' },
        { label: 'ui', status: 'pending' },
      ],
    })
    expect(activeChunkLabels(s)).toEqual(['db layer'])
  })

  it('is empty with no items or no in-progress chunk', () => {
    expect(activeChunkLabels(null)).toEqual([])
    expect(activeChunkLabels(subtasks({ total: 2 }))).toEqual([])
    expect(
      activeChunkLabels(
        subtasks({
          total: 1,
          completed: 1,
          items: [{ label: 'only', status: 'completed' }],
        }),
      ),
    ).toEqual([])
  })
})

// `prReviewPhase` reads only `status`; the other PrReviewStepState fields are irrelevant here.
const state = (status: PrReviewStepState['status']): PrReviewStepState =>
  ({ status }) as PrReviewStepState

describe('prReviewPhase', () => {
  it('is null with no live review or a terminal/passed-through status', () => {
    expect(prReviewPhase(null, null)).toBeNull()
    expect(prReviewPhase(undefined, subtasks({ total: 3, completed: 3 }))).toBeNull()
    expect(prReviewPhase(state('done'), subtasks({ total: 3, completed: 3 }))).toBeNull()
    expect(prReviewPhase(state('skipped'), null)).toBeNull()
  })

  it('is slicing while reviewing with no todo list yet (counts zeroed)', () => {
    // No plan committed → don't leak a misleading 0/0 slice count.
    expect(prReviewPhase(state('reviewing'), null)).toEqual({
      kind: 'slicing',
      completed: 0,
      total: 0,
    })
    expect(prReviewPhase(state('reviewing'), subtasks({ total: 0 }))).toEqual({
      kind: 'slicing',
      completed: 0,
      total: 0,
    })
  })

  it('is reviewing with the slice counts once the todo list exists', () => {
    expect(prReviewPhase(state('reviewing'), subtasks({ total: 4, completed: 1 }))).toEqual({
      kind: 'reviewing',
      completed: 1,
      total: 4,
    })
  })

  it('maps the parked / resolving statuses to their phase', () => {
    expect(
      prReviewPhase(state('awaiting_selection'), subtasks({ total: 4, completed: 4 }))?.kind,
    ).toBe('awaiting')
    expect(prReviewPhase(state('challenging'), null)?.kind).toBe('challenging')
    expect(prReviewPhase(state('fixing'), null)?.kind).toBe('fixing')
    expect(prReviewPhase(state('posting'), null)?.kind).toBe('posting')
  })
})
