import { describe, it, expect } from 'vitest'
import type { ClarityReview } from '~/types/clarity'
import { useClarityStore } from '~/stores/clarity'

/** Minimal review factory — only the fields the upsert guard touches. */
function review(over: Partial<ClarityReview> = {}): ClarityReview {
  return {
    id: 'cr1',
    blockId: 'b1',
    status: 'ready',
    items: [],
    updatedAt: 1000,
    ...over,
  } as ClarityReview
}

describe('clarity store live-event upsert guard', () => {
  it('an out-of-order stream event cannot revert a newer cached review', () => {
    const store = useClarityStore()
    store.upsert(review({ updatedAt: 2000, status: 'merged' }))
    store.upsert(review({ updatedAt: 1000, status: 'ready' })) // stale event → ignored
    expect(store.reviewFor('b1')?.status).toBe('merged')
    store.upsert(review({ updatedAt: 3000, status: 'incorporated' }))
    expect(store.reviewFor('b1')?.status).toBe('incorporated')
  })

  it('a NEW review (different id) for the block replaces regardless of updatedAt', () => {
    const store = useClarityStore()
    store.upsert(review({ updatedAt: 2000 }))
    store.upsert(review({ id: 'cr2', updatedAt: 1000 }))
    expect(store.reviewFor('b1')?.id).toBe('cr2')
  })
})
