import { describe, expect, it } from 'vitest'
import { reviewQueueDirty, reviewSkillQueuePatch } from './TaskReviewTarget.logic'
import type { TaskTypeFields } from '~/types/domain'

const stored: TaskTypeFields = {
  prNumber: 42,
  prUrl: 'https://github.com/acme/app/pull/42',
  reviewFocus: 'the auth changes',
  reviewSkillIds: ['src:s:security', 'src:s:perf'],
  custom: { ticket: 'OPS-1' },
}

describe('reviewSkillQueuePatch', () => {
  it('carries every other built-in key, so editing the queue cannot clear the target PR', () => {
    // The write replaces the built-in half whole. A key left out of this payload is a key erased.
    const patch = reviewSkillQueuePatch(stored, ['src:s:perf'])
    expect(patch.prNumber).toBe(42)
    expect(patch.prUrl).toBe(stored.prUrl)
    expect(patch.reviewFocus).toBe(stored.reviewFocus)
    expect(patch.reviewSkillIds).toEqual(['src:s:perf'])
  })

  it('CLEARS the queue when the last skill is removed', () => {
    // The case that un-wedges a task whose queued skill left the catalog: every dispatch fails on
    // that id, and removing it is the fix. Carrying the stored ids through would make this a
    // silent no-op, which reads to the user as "the platform ignored me".
    const patch = reviewSkillQueuePatch(stored, [])
    expect(patch).not.toHaveProperty('reviewSkillIds')
    expect(patch.prNumber).toBe(42)
  })

  it('never sends the custom half, which travels under its own request key', () => {
    expect(reviewSkillQueuePatch(stored, ['src:s:security'])).not.toHaveProperty('custom')
  })

  it('starts a queue on a task that stored no fields at all', () => {
    expect(reviewSkillQueuePatch(null, ['src:s:security'])).toEqual({
      reviewSkillIds: ['src:s:security'],
    })
    expect(reviewSkillQueuePatch(undefined, [])).toEqual({})
  })
})

describe('reviewQueueDirty', () => {
  it('sees a REORDER, because the reviewer applies the queue in order', () => {
    expect(reviewQueueDirty(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(reviewQueueDirty(['a', 'b'], ['a', 'b'])).toBe(false)
  })

  it('sees an addition, a removal, and an emptied queue', () => {
    expect(reviewQueueDirty(['a'], ['a', 'b'])).toBe(true)
    expect(reviewQueueDirty(['a', 'b'], ['a'])).toBe(true)
    expect(reviewQueueDirty(['a'], [])).toBe(true)
    expect(reviewQueueDirty([], [])).toBe(false)
  })
})
