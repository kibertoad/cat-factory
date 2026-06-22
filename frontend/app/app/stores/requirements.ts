import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  RequirementReview,
  ResolveRequirementsExceededChoice,
  ReviewItemStatus,
} from '~/types/requirements'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Requirements-review state. On the pipeline path the reviewer runs as the first gate
 * step: the run parks while the human drives an iterative loop — answer/dismiss findings →
 * incorporate (companion) → re-review — until the reviewer converges or the task's
 * iteration cap is hit (then the human picks: extra round / proceed / reset). Every call
 * runs an LLM inline server-side and returns the updated review, so there is no real-time
 * stream; we patch the local cache from each response. `available` mirrors the backend's
 * opt-in gate (a 503 hides the UI). Per-workspace; nothing is persisted client-side.
 */
export const useRequirementsStore = defineStore('requirements', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  /** null = unknown (not probed), true/false = feature on/off. */
  const available = ref<boolean | null>(null)
  /** The current review per block id (null = fetched, none exists). */
  const reviews = ref<Record<string, RequirementReview | null>>({})
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

  function reviewFor(blockId: string): RequirementReview | null {
    return reviews.value[blockId] ?? null
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
  function openCount(review: RequirementReview): number {
    return review.items.filter((i) => i.status === 'open').length
  }
  /** Findings the human answered (a reply recorded), which the companion folds in. */
  function answeredCount(review: RequirementReview): number {
    return review.items.filter((i) => i.status === 'answered' || i.status === 'resolved').length
  }
  /** Every finding is settled (answered or dismissed) — none still open. */
  function allSettled(review: RequirementReview): boolean {
    return openCount(review) === 0
  }
  /** Incorporation is possible: all findings settled AND at least one was answered. */
  function canIncorporate(review: RequirementReview): boolean {
    return allSettled(review) && answeredCount(review) > 0
  }
  /** Proceed (skip the companion) is possible: all findings settled but none answered. */
  function canProceed(review: RequirementReview): boolean {
    return allSettled(review) && answeredCount(review) === 0
  }

  function store(review: RequirementReview) {
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
        const review = await api.getRequirementReview(workspace.requireId(), blockId)
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

  /** Run a fresh review of a block's collected requirements (off-path / inspector). */
  async function review(blockId: string): Promise<RequirementReview> {
    withFlag(reviewing, blockId, true)
    try {
      const result = await api.reviewRequirements(workspace.requireId(), blockId)
      available.value = true
      store(result)
      return result
    } finally {
      withFlag(reviewing, blockId, false)
    }
  }

  /** Record a human's answer to one item. */
  async function reply(review: RequirementReview, itemId: string, text: string) {
    store(await api.replyRequirementItem(workspace.requireId(), review.id, itemId, text))
  }

  /** Set an item's status (dismiss / reopen). */
  async function setItemStatus(
    review: RequirementReview,
    itemId: string,
    status: ReviewItemStatus,
  ) {
    store(await api.setRequirementItemStatus(workspace.requireId(), review.id, itemId, status))
  }

  /**
   * Incorporate the answers into one standard-format document (the companion). Optional
   * `feedback` is the "do it differently" direction when redoing a merge. The run stays
   * parked; the review moves to `merged` for the human to re-review or redo.
   */
  async function incorporate(review: RequirementReview, feedback?: string) {
    withFlag(incorporating, review.id, true)
    try {
      const { review: updated } = await api.incorporateRequirements(
        workspace.requireId(),
        review.id,
        feedback,
      )
      store(updated)
      return updated
    } finally {
      withFlag(incorporating, review.id, false)
    }
  }

  /** Re-review the incorporated document (one more reviewer pass; may converge/advance). */
  async function reReview(blockId: string): Promise<RequirementReview> {
    withFlag(reviewing, blockId, true)
    try {
      const updated = await api.reReviewRequirements(workspace.requireId(), blockId)
      store(updated)
      return updated
    } finally {
      withFlag(reviewing, blockId, false)
    }
  }

  /** Proceed: settle the requirements and advance the parked run. */
  async function proceed(blockId: string): Promise<RequirementReview> {
    const updated = await api.proceedRequirements(workspace.requireId(), blockId)
    store(updated)
    return updated
  }

  /** Resolve a capped review: extra-round / proceed / stop-reset. */
  async function resolveExceeded(
    blockId: string,
    choice: ResolveRequirementsExceededChoice,
  ): Promise<RequirementReview> {
    const updated = await api.resolveRequirementsExceeded(workspace.requireId(), blockId, choice)
    store(updated)
    return updated
  }

  return {
    available,
    reviews,
    reviewFor,
    isReviewing,
    isLoading,
    isIncorporating,
    openCount,
    answeredCount,
    allSettled,
    canIncorporate,
    canProceed,
    load,
    review,
    reply,
    setItemStatus,
    incorporate,
    reReview,
    proceed,
    resolveExceeded,
  }
})
