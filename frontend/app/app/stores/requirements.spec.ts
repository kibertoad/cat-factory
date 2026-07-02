import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RequirementReview } from '~/types/requirements'
import { useRequirementsStore } from '~/stores/requirements'
import { useWorkspaceStore } from '~/stores/workspace'

/** Minimal review factory — only the fields the store getters touch. */
function review(over: Partial<RequirementReview> = {}): RequirementReview {
  return {
    id: 'rr1',
    blockId: 'b1',
    status: 'ready',
    iteration: 1,
    maxIterations: 3,
    items: [],
    incorporatedRequirements: null,
    model: null,
    ...over,
  } as RequirementReview
}

describe('requirements store load() loading flag', () => {
  beforeEach(() => {
    // The store resolves its workspace id from the workspace store at call time.
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('flags the block as loading while the fetch is in flight, then clears it', async () => {
    // A deferred fetch so we can observe the in-flight window before it resolves —
    // this is the race the spinner state guards against (review null + not loading
    // would otherwise render the "no review yet" empty state on first open).
    let resolveFetch!: (r: RequirementReview) => void
    const pending = new Promise<RequirementReview>((res) => {
      resolveFetch = res
    })
    vi.stubGlobal('useApi', () => ({ getRequirementReview: () => pending }))

    const store = useRequirementsStore()
    expect(store.isLoading('b1')).toBe(false)

    const loadPromise = store.load('b1')
    // In flight: no review cached yet, but the block is flagged loading.
    expect(store.reviewFor('b1')).toBeNull()
    expect(store.isLoading('b1')).toBe(true)

    resolveFetch(review())
    await loadPromise

    expect(store.isLoading('b1')).toBe(false)
    expect(store.reviewFor('b1')?.id).toBe('rr1')
  })

  it('clears the loading flag even when the fetch rejects', async () => {
    vi.stubGlobal('useApi', () => ({
      getRequirementReview: () => Promise.reject(new Error('503')),
    }))

    const store = useRequirementsStore()
    await store.load('b1')

    expect(store.isLoading('b1')).toBe(false)
    expect(store.available).toBe(false)
    expect(store.reviewFor('b1')).toBeNull()
  })

  it('coalesces concurrent load() calls for the same block into one request', async () => {
    // Two callers open at once (the inspector badge watch + the review window). They must
    // share a single in-flight request, not each fetch their own.
    let calls = 0
    let resolveFetch!: (r: RequirementReview) => void
    const pending = new Promise<RequirementReview>((res) => {
      resolveFetch = res
    })
    vi.stubGlobal('useApi', () => ({
      getRequirementReview: () => {
        calls++
        return pending
      },
    }))

    const store = useRequirementsStore()
    const first = store.load('b1')
    const second = store.load('b1')
    expect(calls).toBe(1)

    resolveFetch(review())
    await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(store.reviewFor('b1')?.id).toBe('rr1')

    // Once the in-flight request settles, a later load fetches fresh.
    void store.load('b1')
    expect(calls).toBe(2)
  })
})

describe('requirements store live-event upsert guard', () => {
  it('an out-of-order stream event cannot revert a newer cached review', () => {
    const store = useRequirementsStore()
    // The API response for a just-submitted answer landed first (newer updatedAt)…
    store.upsert(review({ updatedAt: 2000, status: 'merged' }))
    // …then the slightly-older stream event (emitted just before) arrives late.
    store.upsert(review({ updatedAt: 1000, status: 'ready' }))
    expect(store.reviewFor('b1')?.status).toBe('merged')
    // A genuinely newer event still applies.
    store.upsert(review({ updatedAt: 3000, status: 'incorporated' }))
    expect(store.reviewFor('b1')?.status).toBe('incorporated')
  })

  it('a NEW review (different id) for the block replaces regardless of updatedAt', () => {
    const store = useRequirementsStore()
    store.upsert(review({ updatedAt: 2000 }))
    store.upsert(review({ id: 'rr2', updatedAt: 1000 }))
    expect(store.reviewFor('b1')?.id).toBe('rr2')
  })
})
