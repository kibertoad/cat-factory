import { describe, expect, it } from 'vitest'
import { parseSubtasks, sameSubtaskItems, sameSubtasks } from './subtasks.logic.js'
import type { StepSubtasks } from './types.js'

// The poll path writes and broadcasts a step's progress only when it CHANGED, so a comparison
// that answers "same" too eagerly freezes the live progress bar, and one that answers "different"
// too eagerly re-writes the row and re-broadcasts on every poll of a quiet job.

const snapshot = (over: Partial<StepSubtasks> = {}): StepSubtasks => ({
  completed: 1,
  inProgress: 1,
  total: 3,
  items: [
    { label: 'read the code', status: 'completed' },
    { label: 'write the fix', status: 'in_progress' },
  ],
  ...over,
})

describe('sameSubtasks', () => {
  it('reports an identical snapshot as unchanged', () => {
    expect(sameSubtasks(snapshot(), snapshot())).toBe(true)
  })

  it('treats a never-seen previous snapshot as a change', () => {
    expect(sameSubtasks(null, snapshot())).toBe(false)
    expect(sameSubtasks(undefined, snapshot())).toBe(false)
  })

  it('notices a move in ANY of the three counts', () => {
    expect(sameSubtasks(snapshot({ completed: 2 }), snapshot())).toBe(false)
    expect(sameSubtasks(snapshot({ inProgress: 0 }), snapshot())).toBe(false)
    expect(sameSubtasks(snapshot({ total: 4 }), snapshot())).toBe(false)
  })

  it('notices an item moving even when the counts have not', () => {
    // The counts are a fold of the items, so a rename or a status flip that keeps the totals
    // steady is exactly the update a count-only comparison would swallow.
    const renamed = snapshot({
      items: [
        { label: 'read the code', status: 'completed' },
        { label: 'write the FIX', status: 'in_progress' },
      ],
    })
    expect(sameSubtasks(renamed, snapshot())).toBe(false)
  })
})

describe('sameSubtaskItems', () => {
  it('compares by label, status and ORDER', () => {
    const items = snapshot().items
    expect(sameSubtaskItems(items, [...(items ?? [])])).toBe(true)
    expect(sameSubtaskItems(items, [...(items ?? [])].reverse())).toBe(false)
  })

  it('short-circuits on the same reference and on a length change', () => {
    const items = snapshot().items
    expect(sameSubtaskItems(items, items)).toBe(true)
    expect(sameSubtaskItems(items, [...(items ?? []), { label: 'ship', status: 'pending' }])).toBe(
      false,
    )
  })

  it('treats a missing list on either side as different from a present one', () => {
    expect(sameSubtaskItems(undefined, snapshot().items)).toBe(false)
    expect(sameSubtaskItems(snapshot().items, undefined)).toBe(false)
    // Two absent lists ARE the same reference, so no re-emit is provoked by a job that reports
    // no todo list at all.
    expect(sameSubtaskItems(undefined, undefined)).toBe(true)
  })
})

describe('parseSubtasks', () => {
  it('reads the persisted counts and items back', () => {
    const parsed = parseSubtasks(JSON.stringify(snapshot()))
    expect(parsed).toEqual(snapshot())
  })

  it('reports an absent or malformed column as no progress rather than throwing', () => {
    expect(parseSubtasks(null)).toBeNull()
    expect(parseSubtasks('')).toBeNull()
    expect(parseSubtasks('not json at all')).toBeNull()
    expect(parseSubtasks('"a string"')).toBeNull()
  })

  it('requires all three counts to be numbers', () => {
    expect(parseSubtasks(JSON.stringify({ completed: 1, inProgress: 1 }))).toBeNull()
    expect(parseSubtasks(JSON.stringify({ completed: '1', inProgress: 1, total: 3 }))).toBeNull()
    expect(parseSubtasks(JSON.stringify({ completed: 1, inProgress: null, total: 3 }))).toBeNull()
  })

  it('keeps the counts when the item list is absent or not a list', () => {
    expect(parseSubtasks(JSON.stringify({ completed: 1, inProgress: 1, total: 3 }))).toEqual({
      completed: 1,
      inProgress: 1,
      total: 3,
      items: undefined,
    })
    expect(
      parseSubtasks(JSON.stringify({ completed: 1, inProgress: 1, total: 3, items: 'nope' }))
        ?.items,
    ).toBeUndefined()
  })

  it('drops only the item entries it cannot trust, keeping the rest', () => {
    const parsed = parseSubtasks(
      JSON.stringify({
        completed: 1,
        inProgress: 0,
        total: 1,
        items: [
          { label: 'kept', status: 'completed' },
          { label: 'kept too', status: 'pending' },
          { label: 'kept as well', status: 'in_progress' },
          { label: 'no status' },
          { label: 'bad status', status: 'halfway' },
          { status: 'pending' },
          null,
          'a string',
        ],
      }),
    )
    expect(parsed?.items).toEqual([
      { label: 'kept', status: 'completed' },
      { label: 'kept too', status: 'pending' },
      { label: 'kept as well', status: 'in_progress' },
    ])
  })
})
