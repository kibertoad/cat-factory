import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  RequestRecommendationItem,
  RequirementReview,
  ResolveRequirementsExceededChoice,
  ReviewItemStatus,
} from '~/types/requirements'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Requirements-review state. On the pipeline path the reviewer runs as the first gate
 * step: the run parks while the human answers/dismisses findings, then asks to incorporate.
 * Incorporation + the re-review run ASYNCHRONOUSLY in the durable driver — the call returns
 * at once (status `incorporating`) and the user goes back to the board; they are summoned
 * again (a notification) only if the re-review yields findings or hits the cap. The store is
 * patched both from call responses and from live `requirements` stream events (see
 * `upsert`). `available` mirrors the backend's opt-in gate (a 503 hides the UI).
 * Per-workspace; nothing is persisted client-side.
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
  /** Block ids whose Requirement Writer is currently producing recommendations. */
  const recommending = ref<Set<string>>(new Set())
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
  /** Whether the Requirement Writer is still producing recommendations for a block (a `pending`
   * placeholder exists). Server-derived, so the "Recommending…" state survives the window closing
   * and a page reload — the client-local `recommending` set only covers the request round-trip. */
  function hasPendingRecommendations(blockId: string): boolean {
    return (reviews.value[blockId]?.recommendations ?? []).some((r) => r.status === 'pending')
  }
  /**
   * The async background stage a block's review is in, or null. While the driver folds the
   * answers (`incorporating`) then re-reviews the document (`reviewing`), or the Requirement
   * Writer is producing recommendations (`recommending`), NO human action is needed — so the
   * board suppresses the "Approval needed" gate and shows this working state instead, with copy
   * that names which stage is running.
   */
  function backgroundStage(blockId: string): 'incorporating' | 'reviewing' | 'recommending' | null {
    if (recommending.value.has(blockId) || hasPendingRecommendations(blockId)) return 'recommending'
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

  /** Patch the cache from a live `requirements` stream event (newest wins per block). */
  function upsert(review: RequirementReview) {
    const existing = reviews.value[review.blockId]
    // Keep the freshest by updatedAt (the consensus-store guard): `store()` also runs on
    // API responses, so a slightly-older event racing a just-submitted answer over the
    // separate WS transport must not revert the review the response already delivered.
    if (existing && existing.id === review.id && existing.updatedAt > review.updatedAt) return
    store(review)
  }

  /** Drop all cached reviews + in-flight state (called on workspace switch). */
  function reset() {
    available.value = null
    reviews.value = {}
    reviewing.value = new Set()
    incorporating.value = new Set()
    recommending.value = new Set()
    loadingByBlock.value = new Set()
    inFlight.clear()
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
   * Ask the driver to incorporate the answers ASYNCHRONOUSLY. Optional `feedback` is the "do
   * it differently" direction when redoing a merge. Returns at once with the `incorporating`
   * review (the fold + re-review run in the background); the caller returns the user to the
   * board. A live `requirements` event / a notification reflects the outcome later.
   */
  async function incorporate(review: RequirementReview, feedback?: string) {
    withFlag(incorporating, review.id, true)
    try {
      const updated = await api.incorporateRequirements(
        workspace.requireId(),
        review.blockId,
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

  function isRecommending(blockId: string): boolean {
    return recommending.value.has(blockId) || hasPendingRecommendations(blockId)
  }

  /**
   * Ask the Requirement Writer to recommend answers for a batch of findings. Each item carries
   * its finding id plus optional per-finding guidance (the note the human typed before choosing
   * "recommend something"). ASYNCHRONOUS: returns at once with `pending` placeholder
   * recommendations (the Writer runs per finding in the durable driver), which fill in (`ready`)
   * via live `requirements` stream events; a notification calls the user back when the batch is
   * ready. The board shows the `recommending` background stage while any placeholder is pending.
   */
  async function requestRecommendations(blockId: string, items: RequestRecommendationItem[]) {
    withFlag(recommending, blockId, true)
    try {
      const updated = await api.requestRecommendations(workspace.requireId(), blockId, items)
      if (updated) store(updated)
      return updated
    } finally {
      withFlag(recommending, blockId, false)
    }
  }

  /** Accept a recommendation (becomes the finding's answer, folded into the next incorporation). */
  async function acceptRecommendation(review: RequirementReview, recId: string) {
    store(await api.acceptRecommendation(workspace.requireId(), review.id, recId))
  }

  /** Reject a recommendation (the human then dismisses / answers manually / re-requests). */
  async function rejectRecommendation(review: RequirementReview, recId: string) {
    store(await api.rejectRecommendation(workspace.requireId(), review.id, recId))
  }

  /** Re-request a recommendation with a "do it differently" note. */
  async function reRequestRecommendation(review: RequirementReview, recId: string, note: string) {
    withFlag(recommending, review.blockId, true)
    try {
      store(await api.reRequestRecommendation(workspace.requireId(), review.id, recId, note))
    } finally {
      withFlag(recommending, review.blockId, false)
    }
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
    backgroundStage,
    isReviewing,
    isLoading,
    isIncorporating,
    isRecommending,
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
    requestRecommendations,
    acceptRecommendation,
    rejectRecommendation,
    reRequestRecommendation,
    reset,
    upsert,
  }
})
