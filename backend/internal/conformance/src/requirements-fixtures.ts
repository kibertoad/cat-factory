import type { RequirementReview } from '@cat-factory/kernel'

/**
 * Build an already-"incorporated" requirements review for a block — the persisted
 * outcome of a human reacting to the reviewer's findings and running the rework
 * agent. The conformance suite seeds this straight into each facade's real review
 * store (via {@link ConformanceApp.seedIncorporatedReview}) so the engine's
 * substitution of the reworked requirements into the agent context is asserted on
 * EVERY runtime, without driving the (real-LLM) review/rework calls themselves.
 *
 * No open items: a settled, incorporated review carrying only the reworked document.
 */
export function makeIncorporatedReview(blockId: string, requirements: string): RequirementReview {
  return {
    id: `rrv_seed_${blockId}`,
    blockId,
    status: 'incorporated',
    items: [],
    model: 'fake:fake',
    incorporatedRequirements: requirements,
    iteration: 1,
    maxIterations: 3,
    recommendations: [],
    createdAt: 1,
    updatedAt: 2,
  }
}

/**
 * The canned findings {@link makeReadyReviewWithOpenItem} draws from, in order. The first is the
 * historical single item (its id is unchanged, so every existing caller is byte-for-byte
 * unaffected); the rest exist so a suite can seed a review that CANNOT be fully answered by one
 * command — the tracker-webhook suite needs exactly that, because answering the last open finding
 * legitimately triggers incorporation, which calls a real model the conformance harnesses do not
 * have.
 */
const OPEN_ITEMS = [
  {
    title: 'Unspecified session lifetime',
    detail: 'How long should an authenticated session stay valid?',
  },
  {
    title: 'Unspecified refresh behaviour',
    detail: 'Should activity extend an existing session, or is the lifetime absolute?',
  },
] as const

/**
 * Build a `ready` review carrying `openItems` still-open findings (one by default). The conformance suite seeds this
 * to assert the async-incorporate route's pre-LLM guard on EVERY runtime: incorporation is
 * refused (no findings folded, no run signalled) while any finding is unanswered — a
 * deterministic check that needs no live reviewer model, mirroring the re-review guard test.
 */
export function makeReadyReviewWithOpenItem(blockId: string, openItems = 1): RequirementReview {
  return {
    id: `rrv_seed_${blockId}`,
    blockId,
    status: 'ready',
    items: OPEN_ITEMS.slice(0, Math.max(1, openItems)).map((item, index) => ({
      id: index === 0 ? `rri_seed_${blockId}` : `rri_seed_${blockId}_${index}`,
      category: 'gap' as const,
      severity: 'high' as const,
      title: item.title,
      detail: item.detail,
      status: 'open' as const,
      reply: null,
      createdAt: 1,
      updatedAt: 1,
    })),
    model: 'fake:fake',
    incorporatedRequirements: null,
    iteration: 1,
    maxIterations: 3,
    recommendations: [],
    createdAt: 1,
    updatedAt: 2,
  }
}
