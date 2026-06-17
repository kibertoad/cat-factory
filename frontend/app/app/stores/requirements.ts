import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { RequirementReview, ReviewItemStatus } from '~/types/requirements'
import { useWorkspaceStore } from '~/stores/workspace'
import { useBoardStore } from '~/stores/board'

/**
 * Requirements-review state: the stateless reviewer agent's findings per block.
 * A review is generated synchronously (the LLM runs inline server-side and the
 * items come back in the response), so — unlike executions/bootstraps — there is
 * no real-time stream; every mutation returns the updated review and we patch the
 * local cache from it. `available` mirrors the backend's opt-in gate: a 503 from
 * the review probe means the feature is off and the UI hides its entry points.
 * Per-workspace; nothing is persisted client-side.
 */
export const useRequirementsStore = defineStore('requirements', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()
  const board = useBoardStore()

  /** null = unknown (not probed), true/false = feature on/off. */
  const available = ref<boolean | null>(null)
  /** The current review per block id (null = fetched, none exists). */
  const reviews = ref<Record<string, RequirementReview | null>>({})
  /** Block ids whose review is being (re)generated. */
  const reviewing = ref<Set<string>>(new Set())
  /** Review ids currently incorporating their answers. */
  const incorporating = ref<Set<string>>(new Set())

  function reviewFor(blockId: string): RequirementReview | null {
    return reviews.value[blockId] ?? null
  }
  function isReviewing(blockId: string): boolean {
    return reviewing.value.has(blockId)
  }
  function isIncorporating(reviewId: string): boolean {
    return incorporating.value.has(reviewId)
  }

  /** Open items still needing a human (everything not resolved/dismissed). */
  function openCount(review: RequirementReview): number {
    return review.items.filter((i) => i.status !== 'resolved' && i.status !== 'dismissed').length
  }
  /** Whether every item is settled, so the answers can be incorporated. */
  function allSettled(review: RequirementReview): boolean {
    return review.items.length > 0 && openCount(review) === 0
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
    try {
      const review = await api.getRequirementReview(workspace.requireId(), blockId)
      available.value = true
      reviews.value = { ...reviews.value, [blockId]: review }
    } catch {
      // 503 (feature off) or any error → hide the UI entry points.
      available.value = false
    }
  }

  /** Run a fresh review of a block's collected requirements. */
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

  /** Set an item's status (resolve / dismiss / reopen). */
  async function setItemStatus(
    review: RequirementReview,
    itemId: string,
    status: ReviewItemStatus,
  ) {
    store(await api.setRequirementItemStatus(workspace.requireId(), review.id, itemId, status))
  }

  /**
   * Fold the answers back into the block's requirements. Patches the board with
   * the returned (rewritten) block so the inspector/description reflect it.
   */
  async function incorporate(review: RequirementReview) {
    withFlag(incorporating, review.id, true)
    try {
      const { review: updated, block } = await api.incorporateRequirements(
        workspace.requireId(),
        review.id,
      )
      store(updated)
      board.upsert(block)
      return { review: updated, block }
    } finally {
      withFlag(incorporating, review.id, false)
    }
  }

  return {
    available,
    reviews,
    reviewFor,
    isReviewing,
    isIncorporating,
    openCount,
    allSettled,
    load,
    review,
    reply,
    setItemStatus,
    incorporate,
  }
})
