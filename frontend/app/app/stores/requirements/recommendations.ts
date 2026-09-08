import type { Ref } from 'vue'
import type { RequestRecommendationItem, RequirementReview } from '~/types/requirements'

/**
 * Shared state + injected dependencies the recommendation slice closes over. Created once in the
 * `requirements` store setup and threaded into {@link createRecommendationCommands} so the split
 * operations stay behaviourally identical to the original single-closure store — a size-only
 * extraction, not a new seam.
 */
export interface RecommendationCommandContext {
  api: ReturnType<typeof useApi>
  workspace: ReturnType<typeof useWorkspaceStore>
  /** Block ids whose Requirement Writer is currently producing recommendations. */
  recommending: Ref<Set<string>>
  /** Toggle a block/review id in one of the store's flag sets. */
  withFlag: (set: Ref<Set<string>>, key: string, on: boolean) => void
  /** Commit a server-returned review into the cache. */
  store: (review: RequirementReview) => void
  /** Whether a `pending` recommendation placeholder still exists for the block (server-derived). */
  hasPendingRecommendations: (blockId: string) => boolean
}

/**
 * Whether the Requirement Writer is still producing recommendations for THIS review: a `pending`
 * placeholder exists. Server-derived, so the "Recommending…" state survives the window closing
 * and a page reload; the client-local `recommending` set only covers the request round-trip.
 *
 * Memoised on the review OBJECT, like the settlement tallies next door, and for the same reason:
 * the store REPLACES the review on every write, so identity self-invalidates and a superseded
 * review is collected along with its answer.
 *
 * Per REVIEW rather than per record, which is the whole point. `backgroundStage` asks this on the
 * per-CARD path, and a `computed` over the `reviews` record tracks the ref plus every key in it,
 * so one review event would re-evaluate every card's stage, the fan-out the per-key write exists
 * to remove. Reading one key depends on one key.
 */
const pendingByReview = new WeakMap<RequirementReview, boolean>()

export function awaitsRecommendations(review: RequirementReview): boolean {
  let pending = pendingByReview.get(review)
  if (pending === undefined) {
    pending = (review.recommendations ?? []).some((r) => r.status === 'pending')
    pendingByReview.set(review, pending)
  }
  return pending
}

/** Ask for, accept, reject and re-request the Requirement Writer's suggested answers. */
export function createRecommendationCommands(ctx: RecommendationCommandContext) {
  const { api, workspace, recommending, withFlag, store, hasPendingRecommendations } = ctx

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

  return {
    isRecommending,
    requestRecommendations,
    acceptRecommendation,
    rejectRecommendation,
    reRequestRecommendation,
  }
}
