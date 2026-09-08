import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed } from 'vue'
import type { RequirementRecommendation, RequirementReview } from '~/types/requirements'
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

/** A `pending` Writer placeholder: the state `backgroundStage` reads as "recommending". */
function pendingRecommendation(id: string): RequirementRecommendation {
  return {
    id,
    sourceFinding: { title: 'f', detail: 'd', itemId: 'i1' },
    recommendedText: '',
    status: 'pending',
    note: null,
    groundedInFragment: null,
    createdAt: 1,
    updatedAt: 1,
  } as RequirementRecommendation
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

describe('requirements store per-key writes', () => {
  it('an event for one block does not invalidate a consumer reading another', () => {
    // Every card on the board reads its OWN block's review (the "Recommending…"/gate badge), so
    // one review event used to wake every card: the store replaced the whole record, which is a
    // write to the ref itself and therefore a dependency every reader shares. Writing the key
    // keeps the invalidation on the block that changed.
    const store = useRequirementsStore()
    store.upsert(review({ id: 'rr-a', blockId: 'blk-a', updatedAt: 1 }))

    let evaluations = 0
    const forA = computed(() => {
      evaluations++
      return store.reviewFor('blk-a')?.id ?? null
    })
    expect(forA.value).toBe('rr-a')
    expect(evaluations).toBe(1)

    // A brand-new key, then a rewrite of an existing one: neither is about `blk-a`.
    store.upsert(review({ id: 'rr-b', blockId: 'blk-b', updatedAt: 1 }))
    expect(forA.value).toBe('rr-a')
    store.upsert(review({ id: 'rr-b', blockId: 'blk-b', updatedAt: 2 }))
    expect(forA.value).toBe('rr-a')
    expect(evaluations).toBe(1)

    // The block's OWN event still reaches it.
    store.upsert(review({ id: 'rr-a2', blockId: 'blk-a', updatedAt: 2 }))
    expect(forA.value).toBe('rr-a2')
    expect(evaluations).toBe(2)
  })

  it('the per-card STAGE read depends on one block too, pending recommendations included', () => {
    // `backgroundStage` is the read every card actually makes (TaskCard/BlockNode via
    // `useReviewStage`), and it is the one the per-key write alone does not fix: while the pending
    // -recommendation answer came from a `computed` over the whole `reviews` record, that computed
    // tracked every key, so one event still re-evaluated the stage of every card on the board.
    // Answering off the block's own review object is what closes it.
    const store = useRequirementsStore()
    store.upsert(review({ id: 'rr-a', blockId: 'blk-a', updatedAt: 1 }))

    let evaluations = 0
    const stageForA = computed(() => {
      evaluations++
      return store.backgroundStage('blk-a')
    })
    expect(stageForA.value).toBeNull()
    expect(evaluations).toBe(1)

    // Another block starts recommending: not this card's business.
    store.upsert(
      review({
        id: 'rr-b',
        blockId: 'blk-b',
        updatedAt: 1,
        recommendations: [pendingRecommendation('rec-1')],
      }),
    )
    expect(stageForA.value).toBeNull()
    expect(evaluations).toBe(1)

    // This block's own placeholder still surfaces the working state.
    store.upsert(
      review({
        id: 'rr-a2',
        blockId: 'blk-a',
        updatedAt: 2,
        recommendations: [pendingRecommendation('rec-2')],
      }),
    )
    expect(stageForA.value).toBe('recommending')
    expect(evaluations).toBe(2)
  })
})
