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
})
