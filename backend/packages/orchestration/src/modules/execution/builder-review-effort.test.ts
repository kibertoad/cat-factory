import { describe, expect, it } from 'vitest'
import type { Block, ExecutionInstance } from '@cat-factory/kernel'
import { reviewEffortSlice } from './builder-review-effort.js'

const run = { id: 'exe_1', intakeOrigin: null } as unknown as ExecutionInstance
const block = (fields?: Block['taskTypeFields']) =>
  ({ id: 'blk_1', taskTypeFields: fields }) as Block

describe('reviewEffortSlice', () => {
  it("gives the pr-reviewer the review task's own pick", async () => {
    const slice = await reviewEffortSlice(
      undefined,
      'ws',
      'pr-reviewer',
      block({ reviewEffort: 'low' }),
      run,
    )
    expect(slice).toEqual({ reviewEffort: 'low' })
  })

  it('defaults a review task with no pick to high', async () => {
    expect(await reviewEffortSlice(undefined, 'ws', 'pr-reviewer', block(), run)).toEqual({
      reviewEffort: 'high',
    })
  })

  it("gives the post-implementation reviewer the run's risk policy level", async () => {
    const asked: string[] = []
    const slice = await reviewEffortSlice(
      async (ws) => {
        asked.push(ws)
        return 'max'
      },
      'ws',
      'reviewer',
      block({ reviewEffort: 'low' }),
      run,
    )
    // The task's own pick is a review-task field and never governs the post-implementation review.
    expect(slice).toEqual({ reviewEffort: 'max' })
    expect(asked).toEqual(['ws'])
  })

  it('reads nothing and sets nothing for a kind that does not review code', async () => {
    let read = false
    const slice = await reviewEffortSlice(
      async () => {
        read = true
        return 'max'
      },
      'ws',
      'challenge-investigator',
      block({ reviewEffort: 'low' }),
      run,
    )
    expect(slice).toEqual({})
    expect(read).toBe(false)
  })
})
