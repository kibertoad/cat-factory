import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { UpdateClarityItemStatusInput } from '@cat-factory/contracts'
import type { ClarityReview, ResolveClarityExceededChoice } from '~/types/clarity'

// A clarity item's status is the narrower set the route accepts (no `recommend_requested`).
type ClarityItemStatus = UpdateClarityItemStatusInput['status']
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Clarity-review state. On the pipeline path the reviewer runs as the first gate
 * step: the run parks while the human answers/dismisses findings about the bug report,
 * then asks to incorporate. Incorporation + the re-review run ASYNCHRONOUSLY in the
 * durable driver — the call returns at once (status `incorporating`) and the user goes
 * back to the board; they are summoned again (a notification) only if the re-review
 * yields findings or hits the cap. The store is patched both from call responses and
 * from live `clarity` stream events (see `upsert`). `available` mirrors the backend's
 * opt-in gate (a 503 hides the UI). Per-workspace; nothing is persisted client-side.
 */
export const useClarityStore = defineStore('clarity', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  /** null = unknown (not probed), true/false = feature on/off. */
  const available = ref<boolean | null>(null)
  /** The current review per block id (null = fetched, none exists). */
  const reviews = ref<Record<string, ClarityReview | null>>({})
  /** Block ids whose reviewer is currently running (review / re-review). */
  const reviewing = ref<Set<string>>(new Set())
  /** Review ids currently incorporating their answers. */
  const incorporating = ref<Set<string>>(new Set())
  /** Block ids whose current review is being fetched (the initial `load`). */
  const loadingByBlock = ref<Set<string>>(new Set())
  /**
   * In-flight `load()` promises keyed by block id, so concurrent callers for the same
   * block (the inspector's badge watch + the review window opening together) share ONE
   * request instead of each firing its own. Plain Map — internal bookkeeping, not
   * reactive. Cleared once the request settles.
   */
  const inFlight = new Map<string, Promise<void>>()

  function reviewFor(blockId: string): ClarityReview | null {
    return reviews.value[blockId] ?? null
  }
  /**
   * The async background stage a block's review is in, or null. While the driver folds the
   * answers (`incorporating`) then re-reviews the document (`reviewing`), NO human action is
   * needed — so the board suppresses the "Approval needed" gate and shows this working state
   * instead, with copy that names which of the two stages is running.
   */
  function backgroundStage(blockId: string): 'incorporating' | 'reviewing' | null {
    const status = reviews.value[blockId]?.status
    return status === 'incorporating' || status === 'reviewing' ? status : null
  }
  function isReviewing(blockId: string): boolean {
    return reviewing.value.has(blockId)
  }
  function isLoading(blockId: string): boolean {
    return loadingByBlock.value.has(blockId)
  }
  function isIncorporating(reviewId: string): boolean {
    return incorporating.value.has(reviewId)
  }

  /** Findings still needing a human (status `open`). */
  function openCount(review: ClarityReview): number {
    return review.items.filter((i) => i.status === 'open').length
  }
  /** Findings the human answered (a reply recorded), which the companion folds in. */
  function answeredCount(review: ClarityReview): number {
    return review.items.filter((i) => i.status === 'answered' || i.status === 'resolved').length
  }
  /** Every finding is settled (answered or dismissed) — none still open. */
  function allSettled(review: ClarityReview): boolean {
    return openCount(review) === 0
  }
  /** Incorporation is possible: all findings settled AND at least one was answered. */
  function canIncorporate(review: ClarityReview): boolean {
    return allSettled(review) && answeredCount(review) > 0
  }
  /** Proceed (skip the companion) is possible: all findings settled but none answered. */
  function canProceed(review: ClarityReview): boolean {
    return allSettled(review) && answeredCount(review) === 0
  }

  function store(review: ClarityReview) {
    reviews.value = { ...reviews.value, [review.blockId]: review }
  }

  function withFlag(set: typeof reviewing, key: string, on: boolean) {
    const next = new Set(set.value)
    if (on) next.add(key)
    else next.delete(key)
    set.value = next
  }

  /** Fetch the current review for a block (probing the feature's availability). */
  async function load(blockId: string) {
    if (!workspace.workspaceId) return
    // Coalesce overlapping loads of the same block onto a single request.
    const pending = inFlight.get(blockId)
    if (pending) return pending
    const promise = (async () => {
      withFlag(loadingByBlock, blockId, true)
      try {
        const review = await api.getClarityReview(workspace.requireId(), blockId)
        available.value = true
        reviews.value = { ...reviews.value, [blockId]: review }
      } catch {
        // 503 (feature off) or any error → hide the UI entry points.
        available.value = false
      } finally {
        withFlag(loadingByBlock, blockId, false)
        inFlight.delete(blockId)
      }
    })()
    inFlight.set(blockId, promise)
    return promise
  }

  /** Record a human's answer to one item. */
  async function reply(review: ClarityReview, itemId: string, text: string) {
    store(await api.replyClarityItem(workspace.requireId(), review.id, itemId, text))
  }

  /** Set an item's status (dismiss / reopen). */
  async function setItemStatus(review: ClarityReview, itemId: string, status: ClarityItemStatus) {
    store(await api.setClarityItemStatus(workspace.requireId(), review.id, itemId, status))
  }

  /**
   * Ask the driver to incorporate the answers ASYNCHRONOUSLY. Optional `feedback` is the "do
   * it differently" direction when redoing a merge. Returns at once with the `incorporating`
   * review (the fold + re-review run in the background); the caller returns the user to the
   * board. A live `clarity` event / a notification reflects the outcome later.
   */
  async function incorporate(review: ClarityReview, feedback?: string) {
    withFlag(incorporating, review.id, true)
    try {
      const updated = await api.incorporateClarity(workspace.requireId(), review.blockId, feedback)
      store(updated)
      return updated
    } finally {
      withFlag(incorporating, review.id, false)
    }
  }

  /** Re-review the clarified report (one more reviewer pass; may converge/advance). */
  async function reReview(blockId: string): Promise<ClarityReview> {
    withFlag(reviewing, blockId, true)
    try {
      const updated = await api.reReviewClarity(workspace.requireId(), blockId)
      store(updated)
      return updated
    } finally {
      withFlag(reviewing, blockId, false)
    }
  }

  /** Proceed: settle the clarity review and advance the parked run. */
  async function proceed(blockId: string): Promise<ClarityReview> {
    const updated = await api.proceedClarity(workspace.requireId(), blockId)
    store(updated)
    return updated
  }

  /** Resolve a capped review: extra-round / proceed / stop-reset. */
  async function resolveExceeded(
    blockId: string,
    choice: ResolveClarityExceededChoice,
  ): Promise<ClarityReview> {
    const updated = await api.resolveClarityExceeded(workspace.requireId(), blockId, choice)
    store(updated)
    return updated
  }

  return {
    available,
    reviews,
    reviewFor,
    backgroundStage,
    isReviewing,
    isLoading,
    isIncorporating,
    openCount,
    answeredCount,
    allSettled,
    canIncorporate,
    canProceed,
    load,
    reply,
    setItemStatus,
    incorporate,
    reReview,
    proceed,
    resolveExceeded,
    // Patch the cache from a live `clarity` stream event.
    upsert: store,
  }
})
